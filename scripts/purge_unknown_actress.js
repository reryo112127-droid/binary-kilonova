/**
 * 出演者が判明していない旧作をデータから削除する（D1 + ローカルSQLite）。
 *
 * 対象条件（すべて満たすもの）:
 *   1. actresses が NULL / 空 / '----'（＝出演者不明）
 *   2. sale_start_date が「3ヶ月より前」（新しい作品は AVWIKI 等で後から出演者が埋まるため残す）
 *   3. HOME_MAKERS（索引対象の主要18ブランド）に該当しない
 *      → 主要ブランドで出演者が空なのは作品の性質ではなく「スクレイプ漏れ」の可能性が高く、
 *        後から補完される見込みがあるため削除しない（約1,333件）。
 *   ※ sale_start_date が NULL の作品は「3ヶ月より前」と確認できないので対象外
 *     （MGSは日付NULLで登録され後から backfill される既知の挙動があるため）。
 *
 * D1無料枠の書き込みは 10万行/日（アカウント全体・全DB合計）。products を1行消すと
 * FTS同期トリガが products_fts も消すので、実際の書き込みは1件あたり約2行になる。
 * そのため --limit は **MGS+FANZA の合計** 件数として扱う（既定30,000件 ≒ 6万行 < 10万行）。
 * 条件で毎回拾い直すので、日次で回せば自然に再開・完走する。
 *
 * 使い方:
 *   node scripts/purge_unknown_actress.js --dry-run     # 件数だけ確認（削除しない）
 *   node scripts/purge_unknown_actress.js               # 既定3万件/回
 *   node scripts/purge_unknown_actress.js --limit=5000  # 件数を指定
 *   node scripts/purge_unknown_actress.js --local-only  # ローカルSQLiteのみ（D1書き込み枠を使わない）
 *
 * 削除した行は data/purged/purge_YYYY-MM-DD.jsonl に全カラム保存する（復旧用）。
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
const LOCAL_ONLY = !!arg('local-only', false);
const ONLY = String(arg('only', '') || '').toLowerCase(); // 'mgs' | 'fanza' | '' (両方)
const LIMIT = parseInt(arg('limit', '30000'), 10) || 30000;
const MONTHS = parseInt(arg('months', '3'), 10) || 3;

const cutoff = new Date(Date.now() - MONTHS * 30 * 86400000).toISOString().slice(0, 10);

// 出演者不明の判定
const NO_ACTRESS = `(actresses IS NULL OR TRIM(actresses) = '' OR TRIM(actresses) = '----')`;

// 索引対象の主要18ブランド（generate-static-cache-local.mjs の HOME_MAKERS と一致させる）
const HOME_MAKERS = [
    ['like', 'エスワン'], ['exact', 'ムーディーズ'], ['exact', 'アイデアポケット'], ['exact', 'OPPAI'],
    ['exact', 'E-BODY'], ['exact', 'Fitch'], ['exact', 'マドンナ'], ['exact', '本中'], ['like', 'ダスッ'],
    ['exact', 'kawaii'], ['exact', 'Hunter'], ['exact', 'ワンズファクトリー'], ['exact', 'SODクリエイト'],
    ['exact', 'FALENO'], ['exact', 'TAMEIKE'], ['like', 'million'], ['exact', 'プレミアム'], ['exact', 'DAHLIA'],
];
// 主要ブランド「ではない」条件。MGSは maker のみ、FANZAは maker と label の両方を見る。
function notHomeMaker(isMgs) {
    const cols = isMgs ? ['maker'] : ['maker', 'label'];
    const parts = [];
    const args = [];
    for (const [type, val] of HOME_MAKERS) {
        for (const col of cols) {
            if (type === 'exact') { parts.push(`COALESCE(${col},'') = ?`); args.push(val); }
            else { parts.push(`COALESCE(${col},'') LIKE ?`); args.push(`%${val}%`); }
        }
    }
    return { cond: `NOT (${parts.join(' OR ')})`, args };
}

const DATE_COL = isMgs => (isMgs ? `REPLACE(sale_start_date,'/','-')` : `SUBSTR(sale_start_date,1,10)`);

function whereClause(isMgs) {
    const hm = notHomeMaker(isMgs);
    return {
        sql: `${NO_ACTRESS} AND sale_start_date IS NOT NULL AND TRIM(sale_start_date) <> ''`
            + ` AND ${DATE_COL(isMgs)} < ? AND ${hm.cond}`,
        args: [cutoff, ...hm.args],
    };
}

// D1のバインド変数は1クエリ100個まで。IN句は分割して実行する。
const DEL_SQL = ids => `DELETE FROM products WHERE product_id IN (${ids.map(() => '?').join(',')})`;

/**
 * D1 → ローカル の順で **同じチャンクを続けて** 消す。
 * 途中で落ちても「D1だけ消えてローカルに残る」状態で止まるので、次回の実行が同じ行を
 * 拾い直して整合する（逆順にするとローカルから消えた行を二度と選べず、D1に孤児が残る）。
 * チャンクごとに両方消すので、中断時の未処理はせいぜい1チャンク分で済む。
 */
async function deleteChunked(d1Client, local, ids, onProgress) {
    const CHUNK = 90;
    let d1Done = 0, localDone = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        if (d1Client) { await d1Client.execute({ sql: DEL_SQL(chunk), args: chunk }); d1Done += chunk.length; }
        const r = await local.execute({ sql: DEL_SQL(chunk), args: chunk });
        localDone += r.rowsAffected ?? 0;
        if (onProgress && (i / CHUNK) % 20 === 0) onProgress(d1Done, localDone);
    }
    return { d1Done, localDone };
}

function appendBackup(rows, label) {
    if (!rows.length) return;
    const dir = path.join(ROOT, 'data', 'purged');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `purge_${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, rows.map(r => JSON.stringify({ _src: label, ...r })).join('\n') + '\n');
    return file;
}

(async () => {
    console.log(`出演者不明の旧作を削除 — 基準日: ${cutoff} より前 / 上限 ${LIMIT}件${DRY ? ' [DRY RUN]' : ''}`);
    console.log(`主要${HOME_MAKERS.length}ブランドは除外（スクレイプ漏れの可能性があるため残す）`);

    const targets = [
        { name: 'MGS',   isMgs: true,  db: path.join(ROOT, 'data', 'mgs.db'),   d1: () => d1('mgs') },
        { name: 'FANZA', isMgs: false, db: path.join(ROOT, 'data', 'fanza.db'), d1: () => fanzaShards() },
    ].filter(t => !ONLY || t.name.toLowerCase() === ONLY);

    let grand = 0;
    const deletedIds = new Set(); // 今回消したID（サイトマップの刈り込みに使う）
    let budget = LIMIT; // MGS と FANZA で共有する1回あたりの削除上限（D1無料枠を超えないため）
    for (const t of targets) {
        if (budget <= 0) { console.log(`\n[${t.name}] 今回の上限(${LIMIT}件)に達したのでスキップ`); continue; }
        const w = whereClause(t.isMgs);
        // 候補IDはローカルSQLiteから引く（D1の読み取り枠を使わず、全カラムのバックアップも取れる）
        if (!fs.existsSync(t.db)) { console.warn(`  ${t.name}: ${t.db} が無いのでスキップ`); continue; }
        // 削除するので書き込み可能で開く（既定の openLocal は readonly）
        const local = openLocal(t.db, { readonly: DRY });

        const cnt = await local.execute({ sql: `SELECT COUNT(*) c FROM products WHERE ${w.sql}`, args: w.args });
        const total = Number(cnt.rows[0].c);
        // 2つのDBで半分ずつ進める。片方が少なければ残りをもう片方が使う（budgetで調整）。
        const take = Math.min(budget, Math.max(1, Math.ceil(LIMIT / targets.length)));
        const res = await local.execute({
            sql: `SELECT * FROM products WHERE ${w.sql} ORDER BY ${DATE_COL(t.isMgs)} ASC LIMIT ?`,
            args: [...w.args, take],
        });
        const rows = res.rows;
        const ids = rows.map(r => String(r.product_id));
        budget -= ids.length;
        console.log(`\n[${t.name}] 削除対象 残り${total}件 → 今回 ${ids.length}件（残り予算 ${budget}件）`);
        if (!ids.length) continue;
        console.log(`  例: ${ids.slice(0, 3).join(', ')}`);

        if (DRY) continue;

        const backupFile = appendBackup(rows, t.name);
        console.log(`  バックアップ: ${backupFile}`);

        const res2 = await deleteChunked(LOCAL_ONLY ? null : t.d1(), local, ids,
            (a, b) => console.log(`    …D1 ${a}件 / ローカル ${b}件`));
        console.log(`  削除完了: D1 ${res2.d1Done}件 / ローカル ${res2.localDone}件`);
        ids.forEach(id => deletedIds.add(id));
        grand += ids.length;
    }

    // 削除した作品がサイトマップに残っていると、Googleに404をクロールさせて索引品質を落とす
    // （ソフト404対策で /product/[id] は実データが無いと404を返すため）。消した分だけ刈る。
    // ローカルDBとの差分ではなく「今回消したID」だけを消す点が重要:
    // ローカルfanza.dbはD1より古く、D1にしか無い作品を誤って落とす恐れがあるため。
    if (!DRY && deletedIds.size > 0) {
        for (const rel of [path.join('site', 'data', 'sitemap_cache.json'), path.join('site', 'public', 'data', 'sitemap_cache.json')]) {
            const p = path.join(ROOT, rel);
            if (!fs.existsSync(p)) continue;
            const sm = JSON.parse(fs.readFileSync(p, 'utf-8'));
            const before = (sm.products || []).length;
            sm.products = (sm.products || []).filter(id => !deletedIds.has(String(id)));
            if (sm.products.length !== before) {
                fs.writeFileSync(p, JSON.stringify(sm));
                console.log(`  サイトマップから除外: ${before - sm.products.length}件 (${rel})`);
            }
        }
    }

    console.log(`\n${DRY ? '[DRY RUN] 実際には削除していません' : `✅ 合計 ${grand}件を削除しました`}`);
    console.log('残りがある場合は翌日以降にもう一度実行してください（daily_main.bat に組み込み済み）。');
})().catch(e => { console.error('ERR', e); process.exit(1); });
