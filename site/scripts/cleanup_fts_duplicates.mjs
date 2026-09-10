/**
 * products_fts にたまった **重複行・孤児行** を掃除する（数日かけて終わらせる後始末）。
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
 *   読取 = products_fts 全行 + products 全行（fanza-0 で約33万行）… **スキャンは1DBにつき1回だけ**
 *   書込 = 消した行数ぶん（FTS行1本 ≒ 1書込。2026-09-10 実測 44,100行削除 = 44,102書込）
 * **日次の書込枠は10万行**なので `--budget`（全DB合計の削除上限）で1日ぶんに区切り、
 * 翌日以降のジョブが続きを流す。
 *
 * **消し残しの rowid は state に保存して翌日そのまま使う**（2026-09-10）。
 * 以前は毎回スキャンし直していたため、予算で刻むと「33万行読んで4.5万行消す」を毎日
 * 繰り返すことになり、09-10 は掃除だけで 60万行（読取枠の12%）を読んでいた。
 * 重複と判定した行は後から「残すべき行」に変わらない（新しい行は必ずより大きい rowid で入る）
 * ので使い回して安全。念のため STALE_DAYS を過ぎたリストは捨てて再スキャンする。
 * さらに全件スキャンは **1回の実行につき `--max-scans` DB まで**（既定1）にして、
 * 1日の読取を約33万行で頭打ちにする。
 *
 * 進捗: data/fts_cleanup_state.json（CIがコミットする）。pending は [開始rowid, 終了rowid] の区間列。
 *
 * 使い方:
 *   node scripts/cleanup_fts_duplicates.mjs --all --dry-run
 *   node scripts/cleanup_fts_duplicates.mjs --all --budget 45000
 *   node scripts/cleanup_fts_duplicates.mjs --db fanza-0 --force   # done / pending があっても再スキャン
 *   （枠がリセットされる UTC 0時＝日本時間 9:00 直後に流すこと）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');
const STATE_FILE = path.join(REPO, 'data', 'fts_cleanup_state.json');
const TARGETS = ['fanza-0', 'fanza-1', 'mgs'];
const STALE_DAYS = 14;

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = f => process.argv.includes(f);

/** 枠切れのエラーか（切れていたら黙って中断して翌日に回す） */
const isQuota = msg => /exceeded .*(daily|limit)|free tier/i.test(String(msg));

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch { return {}; }
}
function saveState(state) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

/** rowid の配列 ⇄ 連続区間 [[a,b],...]（重複行は連番で固まっているので数十分の一になる） */
function toRuns(ids) {
    const out = [];
    for (const x of [...ids].sort((a, b) => a - b)) {
        const last = out[out.length - 1];
        if (last && x === last[1] + 1) last[1] = x;
        else out.push([x, x]);
    }
    return out;
}
function fromRuns(runs) {
    const out = [];
    for (const [a, b] of runs) for (let x = a; x <= b; x++) out.push(x);
    return out;
}

async function scan(db, target) {
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
    return { doomed, ftsRows: ftsRows.length, products: alive.size };
}

async function cleanOne(d1, target, { dry, budget, state, force, allowScan }) {
    const db = d1(target);
    const entry = state[target] = state[target] || {};

    let doomed;
    let scanned = false;
    const pendingAge = (Date.now() - Date.parse(entry.checkedAt || 0)) / 86400000;
    if (!force && Array.isArray(entry.pending) && pendingAge <= STALE_DAYS) {
        doomed = fromRuns(entry.pending);
        console.log(`[${target}] 前回スキャン（${entry.checkedAt}）の消し残し ${doomed.length.toLocaleString()}行を使う（D1読取0行）`);
    } else {
        if (!allowScan) {
            console.log(`[${target}] 全件スキャン（読取 約33万行）は1回の実行で --max-scans DB まで。翌日に回します。`);
            return { deleted: 0, quota: false, scanned: false };
        }
        const s = await scan(db, target);
        scanned = true;
        doomed = s.doomed;
        entry.checkedAt = new Date().toISOString();
        entry.ftsRows = s.ftsRows;
        entry.products = s.products;
    }
    entry.remaining = doomed.length;

    if (doomed.length === 0) {
        entry.done = true;
        delete entry.pending;
        console.log('  重複なし。このDBは完了（以後スキップ）。');
        return { deleted: 0, quota: false, scanned };
    }
    if (dry) { console.log('  --dry-run のため削除しません'); return { deleted: 0, quota: false, scanned }; }

    const batch = doomed.slice(0, Math.max(0, budget));
    if (batch.length < doomed.length) {
        console.log(`  今回は ${batch.length.toLocaleString()}行だけ消します（--budget の残り）。続きは翌日。`);
    }
    let done = 0;
    let quota = false;
    for (let i = 0; i < batch.length; i += 100) {
        const chunk = batch.slice(i, i + 100);
        try {
            // rowid の点引きなので読取はほぼ発生しない
            await db.execute(`DELETE FROM products_fts WHERE rowid IN (${chunk.join(',')})`);
        } catch (e) {
            console.error(`\n  削除に失敗: ${e.message}`);
            quota = isQuota(e.message);
            break;
        }
        done += chunk.length;
        if (done % 5000 === 0 || done === batch.length) process.stdout.write(`\r  削除 ${done.toLocaleString()}/${batch.length.toLocaleString()}`);
    }
    const rest = doomed.slice(done);
    entry.remaining = rest.length;
    entry.deletedTotal = (entry.deletedTotal || 0) + done;
    entry.done = rest.length === 0;
    if (entry.done) delete entry.pending;
    else entry.pending = toRuns(rest);
    console.log(`\n  削除 ${done.toLocaleString()}行 / 残り ${entry.remaining.toLocaleString()}行`
        + (entry.done ? '（完了）' : ''));
    return { deleted: done, quota, scanned };
}

async function main() {
    try {
        const dotenv = (await import('dotenv')).default;
        dotenv.config({ path: path.join(REPO, '.env'), quiet: true });
    } catch { /* CI では環境変数が直接入っているので dotenv は無くてよい */ }

    const dry = has('--dry-run');
    const force = has('--force');
    let budget = parseInt(arg('budget', arg('max-deletes', '45000')), 10);
    let scansLeft = parseInt(arg('max-scans', '1'), 10);
    const targets = has('--all') ? TARGETS : [arg('db', '')];
    if (!targets.every(t => TARGETS.includes(t))) {
        console.error('--all か、--db に fanza-0 / fanza-1 / mgs のいずれかを指定してください');
        process.exitCode = 2; return;
    }

    const state = loadState();
    const { d1 } = (await import('../../scripts/lib/d1.js')).default;

    let quotaHit = false;
    for (const target of targets) {
        if (state[target]?.done && !force) {
            console.log(`[${target}] 掃除済み（${state[target].checkedAt}）。スキップ（--force で再点検）`);
            continue;
        }
        if (!dry && budget <= 0) { console.log(`[${target}] 今日の削除予算を使い切りました。翌日に持ち越し。`); continue; }
        try {
            const r = await cleanOne(d1, target, { dry, budget, state, force, allowScan: scansLeft > 0 });
            budget -= r.deleted;
            if (r.scanned) scansLeft--;
            if (r.quota) { quotaHit = true; break; }
        } catch (e) {
            console.error(`[${target}] 失敗: ${e.message}`);
            if (isQuota(e.message)) { quotaHit = true; break; }
        }
    }

    if (!dry) saveState(state);
    if (quotaHit) console.error('\nD1 の日次枠が切れています。翌日のジョブが続きから流します。');
    const left = TARGETS.filter(t => !state[t]?.done);
    console.log(left.length === 0
        ? '\n全DBの掃除が完了しました（以後このジョブは読取0行で終わります）。'
        : `\n未完了: ${left.join(', ')}`);
}

main().catch(e => { console.error('失敗:', e.message); process.exitCode = 1; });
