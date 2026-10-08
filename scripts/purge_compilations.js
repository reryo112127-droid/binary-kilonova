/**
 * Best版・総集編をデータから削除する（D1 + ローカルSQLite）。2026-10-08
 *
 * 対象は site/lib/bestFilter.ts の判定と同じ（表示から外しているものを、DBからも消す）:
 *   1. 公式ジャンル「ベスト・総集編」が付いている（FANZA・MGS 共通の表記）
 *   2. タイトルに総集編の語（BEST/ベスト/総集編/コレクション/福袋/詰め合わせ/コンプリート/枚組）
 *   3. 収録 480分（8時間）超
 *
 * 書き込み枠: D1 無料枠は 10万行/日（全DB合計）。products を1行消すと FTS 同期トリガが products_fts も
 * 消すので1件あたり約2行。--limit は MGS+FANZA 合計の件数（既定 30,000件 ≒ 6万行）。
 * 条件で毎回拾い直すので、残りがあれば翌日もう一度流せば続きから消える。
 *
 * 候補はローカルSQLiteから選ぶ（D1 の読み取り枠を使わず、全カラムのバックアップも取れる）。
 * ローカルは D1 より古いことがあるので、D1 にしか無い新しい総集編は対象外になる。
 * 新規の総集編は日次取り込み（fanza_daily_update.js / phase3_daily_update.js）で登録しないようにした。
 *
 * 使い方:
 *   node scripts/purge_compilations.js --dry-run     # 件数だけ確認（削除しない）
 *   node scripts/purge_compilations.js               # 既定3万件/回
 *   node scripts/purge_compilations.js --limit=5000
 *
 * 削除した行は data/purged/compilations_YYYY-MM-DD.jsonl に全カラム保存する（復旧用）。
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { d1, fanzaShards } = require('./lib/d1');
const { openLocal } = require('./lib/localsqlite.cjs');

const ROOT = path.join(__dirname, '..');
const arg = (name, def) => {
    const a = process.argv.find(x => x.startsWith(`--${name}`));
    if (!a) return def;
    const v = a.split('=')[1];
    return v === undefined ? true : v;
};
const DRY = !!arg('dry-run', false);
const LIMIT = parseInt(arg('limit', '30000'), 10) || 30000;

// site/lib/bestFilter.ts と同じ条件
const TITLE_WORDS = ['BEST', 'ベスト', '総集編', 'コレクション', '福袋', '詰め合わせ', 'コンプリート', '枚組'];
const WHERE = `(COALESCE(genres,'') LIKE ? OR ${TITLE_WORDS.map(() => 'title LIKE ?').join(' OR ')} OR COALESCE(duration_min,0) > 480)`;
const WHERE_ARGS = ['%ベスト・総集編%', ...TITLE_WORDS.map(w => `%${w}%`)];

// D1のバインド変数は1クエリ100個まで。
const DEL_SQL = ids => `DELETE FROM products WHERE product_id IN (${ids.map(() => '?').join(',')})`;

/** D1 → ローカル の順で同じチャンクを消す（中断してもローカルに残った分を次回拾い直せる） */
async function deleteChunked(d1Client, local, ids, onProgress) {
    const CHUNK = 90;
    let d1Done = 0, localDone = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        await d1Client.execute({ sql: DEL_SQL(chunk), args: chunk });
        d1Done += chunk.length;
        const r = await local.execute({ sql: DEL_SQL(chunk), args: chunk });
        localDone += r.rowsAffected ?? 0;
        if (onProgress && (i / CHUNK) % 20 === 0) onProgress(d1Done, localDone);
    }
    return { d1Done, localDone };
}

function appendBackup(rows, label) {
    if (!rows.length) return null;
    const dir = path.join(ROOT, 'data', 'purged');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `compilations_${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, rows.map(r => JSON.stringify({ _src: label, ...r })).join('\n') + '\n');
    return file;
}

(async () => {
    console.log(`Best版・総集編を削除 — 上限 ${LIMIT}件${DRY ? ' [DRY RUN]' : ''}`);
    const targets = [
        { name: 'MGS',   db: path.join(ROOT, 'data', 'mgs.db'),   d1: () => d1('mgs') },
        { name: 'FANZA', db: path.join(ROOT, 'data', 'fanza.db'), d1: () => fanzaShards() },
    ];
    let grand = 0, budget = LIMIT;
    const deletedIds = new Set();
    for (const t of targets) {
        if (!fs.existsSync(t.db)) { console.warn(`  ${t.name}: ${t.db} が無いのでスキップ`); continue; }
        const local = openLocal(t.db, { readonly: DRY });
        const total = Number((await local.execute({ sql: `SELECT COUNT(*) c FROM products WHERE ${WHERE}`, args: WHERE_ARGS })).rows[0].c);
        const byTag = Number((await local.execute({ sql: `SELECT COUNT(*) c FROM products WHERE COALESCE(genres,'') LIKE ?`, args: ['%ベスト・総集編%'] })).rows[0].c);
        const take = Math.min(budget, total);
        console.log(`\n[${t.name}] 対象 ${total}件（うち公式ジャンル ${byTag}件）→ 今回 ${take}件`);
        if (!take) continue;
        const rows = (await local.execute({ sql: `SELECT * FROM products WHERE ${WHERE} LIMIT ?`, args: [...WHERE_ARGS, take] })).rows;
        console.log(`  例: ${rows.slice(0, 3).map(r => `${r.product_id}「${String(r.title).slice(0, 24)}」`).join(' / ')}`);
        if (DRY) continue;
        const ids = rows.map(r => String(r.product_id));
        console.log(`  バックアップ: ${appendBackup(rows, t.name)}`);
        const res = await deleteChunked(t.d1(), local, ids, (a, b) => console.log(`    …D1 ${a}件 / ローカル ${b}件`));
        console.log(`  削除完了: D1 ${res.d1Done}件 / ローカル ${res.localDone}件`);
        ids.forEach(id => deletedIds.add(id));
        budget -= ids.length; grand += ids.length;
    }

    // 消した作品をサイトマップから外す（残すと Google に 404 をクロールさせる）。
    // sitemap_lastmod.json は sitemap_cache.products と同じ並びの配列なので、同じ位置を一緒に落とす。
    if (!DRY && deletedIds.size > 0) {
        for (const dir of [path.join(ROOT, 'site', 'data'), path.join(ROOT, 'site', 'public', 'data')]) {
            const sp = path.join(dir, 'sitemap_cache.json'), lp = path.join(dir, 'sitemap_lastmod.json');
            if (!fs.existsSync(sp)) continue;
            const sm = JSON.parse(fs.readFileSync(sp, 'utf-8'));
            const lm = fs.existsSync(lp) ? JSON.parse(fs.readFileSync(lp, 'utf-8')) : null;
            const prods = sm.products || [];
            const keep = prods.map(id => !deletedIds.has(String(id)));
            const removed = keep.filter(k => !k).length;
            if (!removed) continue;
            sm.products = prods.filter((_, i) => keep[i]);
            fs.writeFileSync(sp, JSON.stringify(sm));
            if (lm && Array.isArray(lm.products) && lm.products.length === prods.length) {
                lm.products = lm.products.filter((_, i) => keep[i]);
                fs.writeFileSync(lp, JSON.stringify(lm));
            }
            console.log(`  サイトマップから除外: ${removed}件 (${path.relative(ROOT, dir)})`);
        }
    }
    console.log(`\n${DRY ? '[DRY RUN] 実際には削除していません' : `✅ 合計 ${grand}件を削除しました`}`);
})().catch(e => { console.error('ERR', e); process.exit(1); });
