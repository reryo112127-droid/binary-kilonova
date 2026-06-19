/**
 * 投稿キュー自動充填: ジャンル別に作品を自動選定して x_post_decisions に approve 登録する。
 * これで承認作業なしに Bluesky 自動投稿 / X 自動投稿の供給が回り続ける。
 * 既にキューにある作品(product_idがPK)は INSERT OR IGNORE でスキップ=再投稿しない。
 *   node scripts/x_queue_fill.js            # 各ジャンル既定2件ずつ補充
 *   node scripts/x_queue_fill.js --per 3    # 各ジャンル3件
 *
 * 選定方針(2026-06):
 *  - X投稿はホーム予約掲載の「特定メーカー」(HOME_MAKERS)の作品に限定。
 *  - MGS動画の作品は FANZA に同一作品が無い「独占配信」のみ(cross_platform.json で判定)。
 */
require('dotenv').config({ path: './site/.env.local' });
const fs = require('fs');
const path = require('path');
const { d1, fanzaShards } = require('./lib/d1');

const PER = parseInt((process.argv.find(a => a.startsWith('--per')) || '').split(/[=\s]/)[1] || '2', 10) || 2;
const today = new Date().toISOString().slice(0, 10);
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

// 配信5年以内の作品のみ投稿対象にする(古い作品を投稿しない)。
// sale_start_date は MGS='YYYY/MM/DD' / FANZA='YYYY-MM-DD' と桁区切りが異なるため、
// MGSは REPLACE で '-' 化してから文字列比較する。NULL日付は比較で除外される(=5年以内と確認できない)。
const fiveYearsAgoDate = new Date();
fiveYearsAgoDate.setFullYear(fiveYearsAgoDate.getFullYear() - 5);
const FIVE_YEARS_AGO = fiveYearsAgoDate.toISOString().slice(0, 10);

// ホーム予約掲載の特定メーカー(generate-static-cache-local.mjs の HOME_MAKERS と一致させる)
const HOME_MAKERS = [
    ['like', 'エスワン'], ['exact', 'ムーディーズ'], ['exact', 'アイデアポケット'], ['exact', 'OPPAI'],
    ['exact', 'E-BODY'], ['exact', 'Fitch'], ['exact', 'マドンナ'], ['exact', '本中'], ['like', 'ダスッ'],
    ['exact', 'kawaii'], ['exact', 'Hunter'], ['exact', 'ワンズファクトリー'], ['exact', 'SODクリエイト'],
    ['exact', 'FALENO'], ['exact', 'TAMEIKE'], ['like', 'million'], ['exact', 'プレミアム'], ['exact', 'DAHLIA'],
];
// MGS: maker列のみ / FANZA: maker列 OR label列
const MGS_MAKER_COND = '(' + HOME_MAKERS.map(([t]) => t === 'exact' ? 'maker = ?' : 'maker LIKE ?').join(' OR ') + ')';
const MGS_MAKER_ARGS = HOME_MAKERS.map(([t, v]) => t === 'exact' ? v : `%${v}%`);
const FZ_MAKER_COND = '(' + HOME_MAKERS.map(([t]) => t === 'exact' ? '(maker = ? OR label = ?)' : '(maker LIKE ? OR label LIKE ?)').join(' OR ') + ')';
const FZ_MAKER_ARGS = HOME_MAKERS.flatMap(([t, v]) => t === 'exact' ? [v, v] : [`%${v}%`, `%${v}%`]);

// 共演(真の共演)とアンソロジー/総集編(多数女優の寄せ集め)の判別。
// アンソロジーは「女優5人以上 or 4時間以上 or 総集編系タイトル」。それらを除外する条件。
const NOT_ANTHOLOGY = `actresses NOT LIKE '%,%,%,%,%' AND (duration_min IS NULL OR duration_min < 240)`
    + ` AND title NOT LIKE '%総集編%' AND title NOT LIKE '%アンソロジー%' AND title NOT LIKE '%オムニバス%'`
    + ` AND title NOT LIKE '%ベスト%' AND title NOT LIKE '%BEST%' AND title NOT LIKE '%コレクション%'`
    + ` AND genres NOT LIKE '%総集編%' AND genres NOT LIKE '%アンソロジー%'`;

// VR作品の判別。VR以外のジャンルに混入するとサンプル動画を平面MP4化できず毎回スキップされ、
// キュー先頭に居座って担当アカウントを塞ぐため、non-VRジャンルからは除外する。
// VR品番(dsvr/fcvr/juvr 等の '...vr...')はSQLite LIKEが大小無視なので '%vr%' で拾える。
const NOT_VR = `title NOT LIKE '%VR%' AND genres NOT LIKE '%VR%' AND product_id NOT LIKE '%vr%'`;

// cross_platform.json: キーに含まれるMGS品番=FANZAに対作品あり=独占ではない
let crossMap = {};
try { crossMap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'site', 'public', 'data', 'cross_platform.json'), 'utf-8')); } catch { /* 無ければ全て独占扱い */ }

// 各ソース: where(メーカー条件を除く本体)/order/whereArgs/limit/platform。SQLは組み立て時にメーカー条件を差し込む。
const GENRES = [
    { genre: 'new', sources: [
        // MGS独占の特定メーカー(少数)を優先。日付窓は設けず新しい順
        { platform: 'mgs', where: `actresses IS NOT NULL AND TRIM(actresses)<>'' AND (duration_min IS NULL OR duration_min<600)`,
          order: `ORDER BY REPLACE(sale_start_date,'/','-') DESC, RANDOM()`, whereArgs: () => [], limit: PER * 8 },
        // 不足分はFANZA特定メーカーの新作でカバー
        { platform: 'fanza', where: `actresses IS NOT NULL AND TRIM(actresses)<>'' AND sale_start_date >= ?`,
          order: `ORDER BY sale_start_date DESC, RANDOM()`, whereArgs: () => [ago(90)], limit: PER * 8 },
    ] },
    { genre: 'sale', sources: [
        { platform: 'fanza', where: `COALESCE(discount_pct,0) >= 30 AND actresses IS NOT NULL AND TRIM(actresses)<>''`,
          order: `ORDER BY discount_pct DESC, RANDOM()`, whereArgs: () => [], limit: PER * 8 },
    ] },
    { genre: 'vr', sources: [
        { platform: 'fanza', where: `genres LIKE '%VR専用%' AND actresses IS NOT NULL AND TRIM(actresses)<>'' AND REPLACE(sale_start_date,'/','-') <= ?`,
          order: `ORDER BY REPLACE(sale_start_date,'/','-') DESC, RANDOM()`, whereArgs: () => [today], limit: PER * 8 },
    ] },
    { genre: 'anon', sources: [
        { platform: 'fanza', where: `floor='videoc' AND actresses IS NOT NULL AND TRIM(actresses)<>''`,
          order: `ORDER BY REPLACE(sale_start_date,'/','-') DESC, RANDOM()`, whereArgs: () => [], limit: PER * 8 },
        { platform: 'mgs', where: `(genres LIKE '%素人%' OR maker LIKE '%素人%' OR maker LIKE '%ナンパ%') AND actresses IS NOT NULL AND TRIM(actresses)<>''`,
          order: `ORDER BY RANDOM()`, whereArgs: () => [], limit: PER * 8 },
    ] },
    { genre: 'lady', sources: [
        { platform: 'mgs', where: `(genres LIKE '%人妻%' OR genres LIKE '%熟女%') AND actresses IS NOT NULL AND TRIM(actresses)<>''`,
          order: `ORDER BY RANDOM()`, whereArgs: () => [], limit: PER * 8 },
        // 不足分はFANZA特定メーカー(マドンナ/プレミアム/TAMEIKE等の熟女)でカバー
        { platform: 'fanza', where: `(genres LIKE '%熟女%' OR genres LIKE '%人妻%') AND actresses IS NOT NULL AND TRIM(actresses)<>''`,
          order: `ORDER BY RANDOM()`, whereArgs: () => [], limit: PER * 8 },
    ] },
    { genre: 'collab', sources: [
        // 共演=2〜4人の本編。アンソロジー/総集編(5人以上・4時間以上・総集編系)は全ジャンル共通でSQL組み立て時に除外
        { platform: 'mgs', where: `actresses LIKE '%,%' AND TRIM(actresses)<>''`,
          order: `ORDER BY RANDOM()`, whereArgs: () => [], limit: PER * 8 },
        { platform: 'fanza', where: `actresses LIKE '%,%' AND TRIM(actresses)<>''`,
          order: `ORDER BY RANDOM()`, whereArgs: () => [], limit: PER * 8 },
    ] },
];

(async () => {
    const site = d1('site');
    // 既にキューにある product_id（再登録回避）
    const existing = new Set();
    for (let off = 0; ; off += 5000) {
        const r = await site.execute({ sql: `SELECT product_id FROM x_post_decisions LIMIT 5000 OFFSET ?`, args: [off] });
        r.rows.forEach(x => existing.add(String(x.product_id)));
        if (r.rows.length < 5000) break;
    }
    console.log('既存キュー:', existing.size, '件 / 特定メーカー', HOME_MAKERS.length, 'ブランド・MGSは独占のみ');

    let added = 0;
    for (const g of GENRES) {
        let n = 0;
        for (const src of g.sources) {
            if (n >= PER) break;
            const isMgs = src.platform === 'mgs';
            // anon(素人)はHOME_MAKERS(プレミアム18ブランド)に該当しない=メーカー条件を掛けると常に0件になるため除外。
            // 素人は floor='videoc'/素人ジャンルで定義され、特定メーカー縛りの対象外。
            const skipMaker = g.genre === 'anon';
            const makerCond = skipMaker ? '1=1' : (isMgs ? MGS_MAKER_COND : FZ_MAKER_COND);
            const makerArgs = skipMaker ? [] : (isMgs ? MGS_MAKER_ARGS : FZ_MAKER_ARGS);
            const client = isMgs ? d1('mgs') : fanzaShards();
            // 配信5年以内に限定(MGSは '/' を '-' に正規化して比較)
            const dateCol = isMgs ? `REPLACE(sale_start_date,'/','-')` : `sale_start_date`;
            const dateCond = `${dateCol} >= ?`;
            // VRジャンル以外はVR作品を除外(VRジャンルはそのまま)
            const vrCond = g.genre === 'vr' ? '1=1' : NOT_VR;
            // 総集編/アンソロジーは全ジャンル共通で除外
            const sql = `SELECT product_id FROM products WHERE ${src.where} AND ${makerCond} AND ${dateCond} AND ${vrCond} AND ${NOT_ANTHOLOGY} ${src.order} LIMIT ?`;
            const args = [...src.whereArgs(), ...makerArgs, FIVE_YEARS_AGO, src.limit];
            let rows = [];
            try { rows = (await client.execute({ sql, args })).rows; }
            catch (e) { console.warn(`  ${g.genre}(${src.platform}) 選定エラー:`, e.message); continue; }
            for (const row of rows) {
                if (n >= PER) break;
                const pid = String(row.product_id);
                if (existing.has(pid)) continue;
                if (isMgs && crossMap[pid]) continue; // FANZAに対作品あり=独占ではない→MGSは除外
                await site.execute({
                    sql: `INSERT OR IGNORE INTO x_post_decisions (product_id, decision, new_genre, post_type, decided_at) VALUES (?, 'approve', ?, 'package', datetime('now'))`,
                    args: [pid, g.genre],
                });
                existing.add(pid); added++; n++;
                console.log(`  + [${g.genre}/${src.platform}] ${pid}`);
            }
        }
    }
    console.log(`✅ ${added}件をキューに追加`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
