/**
 * products_fts にたまった **重複行・孤児行** を掃除する（1回きりの後始末）。
 *
 * 原因は `INSERT OR REPLACE INTO products`。SQLite は置き換え削除で AFTER DELETE
 * トリガを発火しない（recursive_triggers=off の仕様）が AFTER INSERT は発火するため、
 * 既存作品を入れ直すたびに **古い内容のFTS行が残ったまま新しい行が増えていた**。
 * 2026-09-09 実測(fanza-0): products 135,367行 / products_fts 193,832行 = 58,465行が余分。
 * 影響は「古いタイトル・古い出演者でも検索に当たる」「FTSの走査コストが4割増し」。
 *
 * 増加そのものは migrations/0012・0013 の BEFORE INSERT トリガ(products_bi)で止めてある。
 * このスクリプトは **既にたまっている分** を消すためのもの。
 *
 * コスト（1DBあたり）:
 *   読取 = products_fts 全行 + products 全行（fanza-0 で約33万行）
 *   書込 = 消す行数ぶん（fanza-0 で約5.8万行）… **日次の書込枠は10万行**なので
 *          `--max-deletes` で1日ぶんに区切り、翌日以降に続きを流すこと。
 *
 * 使い方:
 *   node scripts/cleanup_fts_duplicates.mjs --db fanza-0 --dry-run
 *   node scripts/cleanup_fts_duplicates.mjs --db fanza-0 --max-deletes 40000
 *   （枠がリセットされる UTC 0時＝日本時間 9:00 直後に流すこと）
 */
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

async function main() {
    const dotenv = (await import('dotenv')).default;
    dotenv.config({ path: path.join(REPO, '.env'), quiet: true });

    const target = arg('db', '');
    const dry = process.argv.includes('--dry-run');
    const maxDeletes = parseInt(arg('max-deletes', '40000'), 10);
    if (!['fanza-0', 'fanza-1', 'mgs'].includes(target)) {
        console.error('--db に fanza-0 / fanza-1 / mgs のいずれかを指定してください');
        process.exitCode = 2; return;
    }

    const { d1 } = (await import('../../scripts/lib/d1.js')).default;
    const db = d1(target);

    // 20万行を1レスポンスで受けるとD1 RESTの応答が数MBになるので rowid で刻んで読む。
    const PAGE = 50000;
    async function readAll(table, cols) {
        const out = [];
        let last = 0;
        for (;;) {
            const r = await db.execute(
                `SELECT ${cols} FROM ${table} WHERE rowid > ${last} ORDER BY rowid LIMIT ${PAGE}`);
            const rows = r.rows || r;
            if (rows.length === 0) break;
            out.push(...rows);
            last = Number(rows[rows.length - 1].rowid);
            process.stdout.write(`\r  ${table}: ${out.length.toLocaleString()}行`);
            if (rows.length < PAGE) break;
        }
        console.log('');
        return out;
    }

    console.log(`[${target}] 読み出し中…`);
    const ftsRows = await readAll('products_fts', 'rowid, product_id');
    const alive = new Set((await readAll('products', 'rowid, product_id')).map(r => String(r.product_id)));

    // product_id ごとに最大 rowid（＝最後に入った行）だけ残す。
    // products に存在しない product_id の行は全部消す（孤児）。
    const keep = new Map(); // product_id → 残す rowid
    for (const r of ftsRows) {
        const pid = String(r.product_id);
        const rid = Number(r.rowid);
        if (!alive.has(pid)) continue;              // 孤児は keep に入れない＝全部削除対象
        if (!keep.has(pid) || keep.get(pid) < rid) keep.set(pid, rid);
    }
    const doomed = [];
    let orphans = 0;
    for (const r of ftsRows) {
        const pid = String(r.product_id);
        const rid = Number(r.rowid);
        if (keep.get(pid) === rid) continue;
        if (!alive.has(pid)) orphans++;   // products に無い＝削除済み作品の残骸
        doomed.push(rid);
    }

    console.log(`  残す: ${keep.size.toLocaleString()}行 / 消す: ${doomed.length.toLocaleString()}行`
        + `（うち孤児 ${orphans.toLocaleString()}行 = products に無い product_id）`);
    if (dry) { console.log('  --dry-run のため削除しません'); return; }

    const batch = doomed.slice(0, maxDeletes);
    if (batch.length < doomed.length) {
        console.log(`  今回は ${batch.length.toLocaleString()}行だけ消します（--max-deletes）。残りは翌日以降に。`);
    }
    let done = 0;
    for (let i = 0; i < batch.length; i += 100) {
        const chunk = batch.slice(i, i + 100);
        // rowid の点引きなので読取はほぼ発生しない
        await db.execute(`DELETE FROM products_fts WHERE rowid IN (${chunk.join(',')})`);
        done += chunk.length;
        if (done % 5000 === 0 || done === batch.length) process.stdout.write(`\r  削除 ${done.toLocaleString()}/${batch.length.toLocaleString()}`);
    }
    console.log(`\n完了。残り ${(doomed.length - batch.length).toLocaleString()}行`);
}

main().catch(e => { console.error('失敗:', e.message); process.exitCode = 1; });
