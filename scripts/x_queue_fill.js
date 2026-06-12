/**
 * 投稿キュー自動充填: ジャンル別に作品を自動選定して x_post_decisions に approve 登録する。
 * これで承認作業なしに Bluesky 自動投稿 / X 手動投稿準備の供給が回り続ける。
 * 既にキューにある作品(product_idがPK)は INSERT OR IGNORE でスキップ=再投稿しない。
 *   node scripts/x_queue_fill.js            # 各ジャンル既定2件ずつ補充
 *   node scripts/x_queue_fill.js --per 3    # 各ジャンル3件
 */
require('dotenv').config({ path: './site/.env.local' });
const { d1, fanzaShards } = require('./lib/d1');

const PER = parseInt((process.argv.find(a => a.startsWith('--per')) || '').split(/[=\s]/)[1] || '2', 10) || 2;
const today = new Date().toISOString().slice(0, 10);
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

// ジャンル定義: 各ジャンルは sources[] を順に消化(PER件まで)。post_type は package 固定。
// 方針: VR は作品が少ないので FANZA の VR専用(=VR専業メーカー)から。anon は FANZA C(videoc=素人フロア)＋
//       出演者が特定できた(actresses有) MGS素人作品。出演者ありを必須にして顔/紹介の質を担保。
const GENRES = [
    { genre: 'new', sources: [
        { client: () => d1('mgs'),
          sql: `SELECT product_id FROM products WHERE REPLACE(sale_start_date,'/','-') >= ? AND actresses IS NOT NULL AND TRIM(actresses)<>'' AND (duration_min IS NULL OR duration_min<600) ORDER BY REPLACE(sale_start_date,'/','-') DESC, RANDOM() LIMIT ?`,
          args: () => [ago(7), PER * 4] },
    ] },
    { genre: 'sale', sources: [
        { client: () => fanzaShards(),
          sql: `SELECT product_id FROM products WHERE COALESCE(discount_pct,0) >= 30 AND actresses IS NOT NULL AND TRIM(actresses)<>'' ORDER BY discount_pct DESC, RANDOM() LIMIT ?`,
          args: () => [PER * 4] },
    ] },
    { genre: 'vr', sources: [
        // FANZA VR専用(出演者あり)。配信済み(<=today)に限定＝予約作品のNow Printing表紙を除外。最新優先でVR専業メーカー中心
        { client: () => fanzaShards(),
          sql: `SELECT product_id FROM products WHERE genres LIKE '%VR専用%' AND actresses IS NOT NULL AND TRIM(actresses)<>'' AND REPLACE(sale_start_date,'/','-') <= ? ORDER BY REPLACE(sale_start_date,'/','-') DESC, RANDOM() LIMIT ?`,
          args: () => [today, PER * 6] },
    ] },
    { genre: 'anon', sources: [
        // ① FANZA C = videoc(素人フロア) 出演者あり
        { client: () => fanzaShards(),
          sql: `SELECT product_id FROM products WHERE floor='videoc' AND actresses IS NOT NULL AND TRIM(actresses)<>'' ORDER BY REPLACE(sale_start_date,'/','-') DESC, RANDOM() LIMIT ?`,
          args: () => [PER * 4] },
        // ② 出演者が特定できた MGS素人作品(AVWIKI等で actresses 付与済み)
        { client: () => d1('mgs'),
          sql: `SELECT product_id FROM products WHERE (genres LIKE '%素人%' OR maker LIKE '%素人%' OR maker LIKE '%シロウト%' OR maker LIKE '%ナンパ%') AND actresses IS NOT NULL AND TRIM(actresses)<>'' AND REPLACE(sale_start_date,'/','-') >= ? ORDER BY RANDOM() LIMIT ?`,
          args: () => [ago(60), PER * 4] },
    ] },
    { genre: 'lady', sources: [
        { client: () => d1('mgs'),
          sql: `SELECT product_id FROM products WHERE (genres LIKE '%人妻%' OR genres LIKE '%熟女%') AND actresses IS NOT NULL AND TRIM(actresses)<>'' AND REPLACE(sale_start_date,'/','-') >= ? ORDER BY RANDOM() LIMIT ?`,
          args: () => [ago(90), PER * 4] },
    ] },
    { genre: 'collab', sources: [
        { client: () => d1('mgs'),
          sql: `SELECT product_id FROM products WHERE actresses LIKE '%,%' AND TRIM(actresses)<>'' AND REPLACE(sale_start_date,'/','-') >= ? ORDER BY RANDOM() LIMIT ?`,
          args: () => [ago(90), PER * 4] },
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
    console.log('既存キュー:', existing.size, '件');

    let added = 0;
    for (const g of GENRES) {
        let n = 0;
        for (const src of g.sources) {
            if (n >= PER) break;
            let rows = [];
            try { rows = (await src.client().execute({ sql: src.sql, args: src.args() })).rows; }
            catch (e) { console.warn(`  ${g.genre} 選定エラー:`, e.message); continue; }
            for (const row of rows) {
                if (n >= PER) break;
                const pid = String(row.product_id);
                if (existing.has(pid)) continue;
                await site.execute({
                    sql: `INSERT OR IGNORE INTO x_post_decisions (product_id, decision, new_genre, post_type, decided_at) VALUES (?, 'approve', ?, 'package', datetime('now'))`,
                    args: [pid, g.genre],
                });
                existing.add(pid); added++; n++;
                console.log(`  + [${g.genre}] ${pid}`);
            }
        }
    }
    console.log(`✅ ${added}件をキューに追加`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
