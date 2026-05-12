/**
 * 静的JSONキャッシュ生成スクリプト
 * 使い方: node scripts/generate-static-cache.mjs
 *
 * 生成ファイル:
 *   data/products_new_cache.json       - 新着作品 (sort=new, top60)
 *   data/products_popular_cache.json   - 人気作品 (sort=wish_count, top60)
 *   data/ranking_2026_cache.json       - 作品ランキング2026 (top100)
 *   data/actress_ranking_2026_cache.json - 女優ランキング2026 (top50)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// .env.local を手動でロード（CIでは環境変数が直接設定されるためスキップ）
function loadEnv() {
    const envPath = path.join(ROOT, '.env.local');
    if (!fs.existsSync(envPath)) return; // CI: 環境変数は外部から注入済み
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); // 既存の環境変数は上書きしない
    }
}

loadEnv();

if (!process.env.TURSO_MGS_URL || !process.env.TURSO_FANZA_URL) {
    console.error('TURSO_MGS_URL / TURSO_FANZA_URL が未設定です');
    process.exit(1);
}

const mgs   = createClient({ url: process.env.TURSO_MGS_URL,   authToken: process.env.TURSO_MGS_TOKEN });
const fanza = createClient({ url: process.env.TURSO_FANZA_URL,  authToken: process.env.TURSO_FANZA_TOKEN });

// ローカルの actress_profiles.json を読み込む（Turso クエリを廃止し行読み取りを削減）
function loadLocalProfiles() {
    const p = path.join(ROOT, '..', 'data', 'actress_profiles.json');
    if (!fs.existsSync(p)) return {};
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return {}; }
}

function poster(url) {
    if (!url) return '';
    if (url.includes('pb_e_')) return url.replace('pb_e_', 'pf_e_');
    if (url.includes('/digital/amateur/') && url.endsWith('jm.jpg')) return url.replace('jm.jpg', 'jp-001.jpg');
    return url;
}

const BEST = ['%BEST%','%ベスト%','%総集編%','%コレクション%','%Best%','%リマスター%','%AIリマスター%'];
const bestConds = BEST.map(() => 'title NOT LIKE ?').join(' AND ');
const bestArgs  = BEST;

const today = new Date().toISOString().slice(0, 10);
const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// ── ホーム画面掲載メーカーリスト（予約・セール共通） ──────────────
const HOME_MAKERS = [
    'エスワン',
    'ムーディーズ',
    'アイデアポケット',
    'OPPAI',
    'E-BODY',
    'Fitch',
    'マドンナ',
    '本中',
    'ダスッ',
    'kawaii',
    'Hunter',
    'ワンズファクトリー',
    'SODクリエイト',
    'FALENO',
    'TAMEIKE',
    'million',
    'プレミアム',
    'DAHLIA',
];

// MGS用メーカー条件（maker列）
const mgsMakerCond  = HOME_MAKERS.map(() => 'maker LIKE ?').join(' OR ');
const mgsMakerArgs  = HOME_MAKERS.map(m => `%${m}%`);
// FANZA用メーカー条件（label列 OR maker列）
const fanzaMakerCond = HOME_MAKERS.map(() => '(label LIKE ? OR maker LIKE ?)').join(' OR ');
const fanzaMakerArgs = HOME_MAKERS.flatMap(m => [`%${m}%`, `%${m}%`]);

// ── 新着作品 ──────────────────────────────────────────────────────
async function genNewProducts() {
    console.log('[新着作品] 取得中...');
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, NULL AS sale_end_date
                  FROM products
                  WHERE sale_start_date IS NOT NULL
                    AND REPLACE(sale_start_date,'/','-') >= ?
                    AND REPLACE(sale_start_date,'/','-') <= ?
                    AND (duration_min IS NULL OR duration_min < 600)
                    AND ${bestConds}
                  ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT 500`,
            args: [twoWeeksAgo, today, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, sale_end_date
                  FROM products
                  WHERE sale_start_date IS NOT NULL
                    AND SUBSTR(sale_start_date,1,10) >= ?
                    AND SUBSTR(sale_start_date,1,10) <= ?
                    AND ${bestConds}
                  ORDER BY sale_start_date DESC LIMIT 500`,
            args: [twoWeeksAgo, today, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);

    const combined = [];
    const maxLen = Math.max(mgsRows.length, fanzaRows.length);
    for (let i = 0; i < maxLen; i++) {
        if (mgsRows[i])   combined.push({ ...mgsRows[i],   main_image_url: poster(mgsRows[i].main_image_url),   source: 'mgs' });
        if (fanzaRows[i]) combined.push({ ...fanzaRows[i], main_image_url: poster(fanzaRows[i].main_image_url), source: 'fanza' });
    }

    return combined;
}

// ── 人気作品 ──────────────────────────────────────────────────────
async function genPopularProducts() {
    console.log('[人気作品] 取得中...');
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, NULL AS sale_end_date
                  FROM products
                  WHERE (duration_min IS NULL OR duration_min < 600)
                    AND ${bestConds}
                  ORDER BY wish_count DESC LIMIT 400`,
            args: bestArgs,
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(review_count,0) AS review_count, COALESCE(review_average,0) AS review_average,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, sale_end_date
                  FROM products
                  WHERE ${bestConds}
                  ORDER BY review_count DESC, sale_start_date DESC LIMIT 400`,
            args: bestArgs,
        }).then(r => r.rows).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);

    const combined = [];
    const maxLen = Math.max(mgsRows.length, fanzaRows.length);
    for (let i = 0; i < maxLen; i++) {
        if (mgsRows[i])   combined.push({ ...mgsRows[i],   main_image_url: poster(mgsRows[i].main_image_url),   source: 'mgs' });
        if (fanzaRows[i]) combined.push({ ...fanzaRows[i], main_image_url: poster(fanzaRows[i].main_image_url), source: 'fanza' });
    }

    return combined;
}

// ── 作品ランキング (2026) ─────────────────────────────────────────
async function genRanking2026() {
    console.log('[作品ランキング2026] 取得中...');
    const FROM = '2026-01-01', TO = '2026-12-31';
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, NULL AS sale_end_date
                  FROM products
                  WHERE (duration_min IS NULL OR duration_min < 600)
                    AND REPLACE(sale_start_date,'/','-') >= ? AND REPLACE(sale_start_date,'/','-') <= ?
                    AND ${bestConds}
                  ORDER BY wish_count DESC LIMIT 300`,
            args: [FROM, TO, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(review_count,0) AS review_count, COALESCE(review_average,0) AS review_average,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, sale_end_date
                  FROM products
                  WHERE sale_start_date >= ? AND sale_start_date <= ?
                    AND ${bestConds}
                  ORDER BY COALESCE(review_count,0)*COALESCE(review_average,0) DESC, sale_start_date DESC LIMIT 300`,
            args: [FROM, TO, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);

    // MGS: wish_count順 / FANZA: review score順 で 2:1インターリーブ
    const mgsPool   = mgsRows.map(r => ({ ...r, main_image_url: poster(r.main_image_url), source: 'mgs' }));
    const fanzaPool = fanzaRows.map(r => ({ ...r, main_image_url: poster(r.main_image_url), source: 'fanza' }));

    const result = [];
    let mi = 0, fi = 0;
    while (result.length < 100 && (mi < mgsPool.length || fi < fanzaPool.length)) {
        for (let k = 0; k < 2 && mi < mgsPool.length && result.length < 100; k++) result.push(mgsPool[mi++]);
        if (fi < fanzaPool.length && result.length < 100) result.push(fanzaPool[fi++]);
    }
    return result;
}

// ── 作品ランキング（日付範囲なし・デフォルト） ───────────────────
async function genRankingDefault() {
    console.log('[作品ランキング デフォルト] 取得中...');
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, NULL AS sale_end_date
                  FROM products
                  WHERE (duration_min IS NULL OR duration_min < 600)
                    AND REPLACE(sale_start_date,'/','-') >= ?
                    AND ${bestConds}
                  ORDER BY wish_count DESC LIMIT 300`,
            args: [oneYearAgo, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(review_count,0) AS review_count, COALESCE(review_average,0) AS review_average,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, sale_end_date
                  FROM products
                  WHERE sale_start_date >= ?
                    AND ${bestConds}
                  ORDER BY review_count DESC, sale_start_date DESC LIMIT 300`,
            args: [oneYearAgo, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);

    const mgsPool   = mgsRows.map(r => ({ ...r, main_image_url: poster(r.main_image_url), source: 'mgs' }));
    const fanzaPool = fanzaRows.map(r => ({ ...r, main_image_url: poster(r.main_image_url), source: 'fanza' }));

    const result = [];
    let mi = 0, fi = 0;
    while (result.length < 100 && (mi < mgsPool.length || fi < fanzaPool.length)) {
        for (let k = 0; k < 2 && mi < mgsPool.length && result.length < 100; k++) result.push(mgsPool[mi++]);
        if (fi < fanzaPool.length && result.length < 100) result.push(fanzaPool[fi++]);
    }
    return result;
}

// ── 女優ランキング (2026) ─────────────────────────────────────────
async function genActressRanking2026() {
    console.log('[女優ランキング2026] 取得中...');
    const FROM = '2026-01-01', TO = '2026-12-31';

    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT actresses, main_image_url, wish_count, genres, maker, product_id
                  FROM products
                  WHERE (duration_min IS NULL OR duration_min < 600)
                    AND REPLACE(sale_start_date,'/','-') >= ? AND REPLACE(sale_start_date,'/','-') <= ?
                  ORDER BY wish_count DESC LIMIT 500`,
            args: [FROM, TO],
        }).then(r => r.rows).catch(() => []),
        fanza.execute({
            sql: `SELECT actresses, main_image_url, 0 AS wish_count, genres, maker, product_id
                  FROM products WHERE sale_start_date >= ? AND sale_start_date <= ?
                  ORDER BY sale_start_date DESC LIMIT 500`,
            args: [FROM, TO],
        }).then(r => r.rows).catch(() => []),
    ]);

    // actress_profiles はローカルJSONから読む（Tursoクエリ廃止）
    const localProfiles = loadLocalProfiles();

    const actressMap = new Map();
    const processRows = (rows, isMgs) => {
        for (const row of rows) {
            if (!row.actresses) continue;
            const names = String(row.actresses).split(/,|、/).map(s => s.trim()).filter(Boolean);
            const wishCount = Number(row.wish_count ?? 0);
            for (const name of names) {
                const e = actressMap.get(name);
                if (e) { e.wishScore += wishCount; e.workCount++; }
                else   { actressMap.set(name, { name, wishScore: wishCount, workCount: 1, sampleImage: poster(String(row.main_image_url ?? '')) }); }
            }
        }
    };
    processRows(mgsRows, true);
    processRows(fanzaRows, false);

    const profileMap = new Map(Object.entries(localProfiles).map(([n, p]) => [n, p?.image_url]).filter(([,v]) => v));

    return Array.from(actressMap.values())
        .sort((a, b) => b.wishScore - a.wishScore)
        .slice(0, 50)
        .map(e => ({
            name: e.name,
            score: e.wishScore,
            work_count: e.workCount,
            image_url: profileMap.get(e.name) || null,
            sample_image: e.sampleImage,
        }));
}

// ── 女優ランキング（日付範囲なし・デフォルト） ──────────────────
async function genActressRankingDefault() {
    console.log('[女優ランキング デフォルト] 取得中...');
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT actresses, main_image_url, wish_count, genres, maker, product_id
                  FROM products
                  WHERE (duration_min IS NULL OR duration_min < 600)
                    AND REPLACE(sale_start_date,'/','-') >= ?
                  ORDER BY wish_count DESC LIMIT 500`,
            args: [oneYearAgo],
        }).then(r => r.rows).catch(() => []),
        fanza.execute({
            sql: `SELECT actresses, main_image_url, 0 AS wish_count, genres, maker, product_id
                  FROM products WHERE sale_start_date >= ?
                  ORDER BY sale_start_date DESC LIMIT 500`,
            args: [oneYearAgo],
        }).then(r => r.rows).catch(() => []),
    ]);

    // actress_profiles はローカルJSONから読む（Tursoクエリ廃止）
    const localProfiles = loadLocalProfiles();

    const actressMap = new Map();
    const processRows = (rows) => {
        for (const row of rows) {
            if (!row.actresses) continue;
            const names = String(row.actresses).split(/,|、/).map(s => s.trim()).filter(Boolean);
            const wishCount = Number(row.wish_count ?? 0);
            for (const name of names) {
                const e = actressMap.get(name);
                if (e) { e.wishScore += wishCount; e.workCount++; }
                else   { actressMap.set(name, { name, wishScore: wishCount, workCount: 1, sampleImage: poster(String(row.main_image_url ?? '')) }); }
            }
        }
    };
    processRows(mgsRows);
    processRows(fanzaRows);

    const profileMap = new Map(Object.entries(localProfiles).map(([n, p]) => [n, p?.image_url]).filter(([,v]) => v));

    return Array.from(actressMap.values())
        .sort((a, b) => b.wishScore - a.wishScore)
        .slice(0, 50)
        .map(e => ({
            name: e.name,
            score: e.wishScore,
            work_count: e.workCount,
            image_url: profileMap.get(e.name) || null,
            sample_image: e.sampleImage,
        }));
}

// ── 予約作品・全メーカー（予約ページ用） ────────────────────────
async function genPreorderProducts() {
    console.log('[予約作品] 取得中...');
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         0 AS discount_pct, NULL AS list_price, NULL AS current_price, NULL AS series_name, NULL AS series_id, 0 AS vr_flag, NULL AS sale_end_date
                  FROM products
                  WHERE REPLACE(sale_start_date,'/','-') > ?
                    AND (duration_min IS NULL OR duration_min < 600)
                    AND ${bestConds}
                  ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT 300`,
            args: [today, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, series_name, series_id, COALESCE(vr_flag,0) AS vr_flag, sale_end_date
                  FROM products
                  WHERE SUBSTR(sale_start_date,1,10) > ?
                    AND ${bestConds}
                  ORDER BY SUBSTR(sale_start_date,1,10) DESC LIMIT 300`,
            args: [today, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);

    const combined = [];
    const maxLen = Math.max(mgsRows.length, fanzaRows.length);
    for (let i = 0; i < maxLen; i++) {
        if (mgsRows[i])   combined.push({ ...mgsRows[i],   main_image_url: poster(mgsRows[i].main_image_url),   source: 'mgs' });
        if (fanzaRows[i]) combined.push({ ...fanzaRows[i], main_image_url: poster(fanzaRows[i].main_image_url), source: 'fanza' });
    }

    return combined;
}

// ── 予約作品・厳選メーカー（ホーム画面用） ──────────────────────
async function genHomePreorderCurated() {
    console.log('[ホーム予約・厳選] 取得中...');
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         0 AS discount_pct, NULL AS list_price, NULL AS current_price, NULL AS series_name, NULL AS series_id, 0 AS vr_flag, NULL AS sale_end_date
                  FROM products
                  WHERE REPLACE(sale_start_date,'/','-') > ?
                    AND (duration_min IS NULL OR duration_min < 600)
                    AND (${mgsMakerCond})
                    AND ${bestConds}
                  ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT 60`,
            args: [today, ...mgsMakerArgs, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, series_name, series_id, COALESCE(vr_flag,0) AS vr_flag, sale_end_date
                  FROM products
                  WHERE SUBSTR(sale_start_date,1,10) > ?
                    AND (${fanzaMakerCond})
                    AND ${bestConds}
                  ORDER BY SUBSTR(sale_start_date,1,10) DESC LIMIT 60`,
            args: [today, ...fanzaMakerArgs, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);

    const combined = [];
    const maxLen = Math.max(mgsRows.length, fanzaRows.length);
    for (let i = 0; i < maxLen; i++) {
        if (mgsRows[i])   combined.push({ ...mgsRows[i],   main_image_url: poster(mgsRows[i].main_image_url),   source: 'mgs' });
        if (fanzaRows[i]) combined.push({ ...fanzaRows[i], main_image_url: poster(fanzaRows[i].main_image_url), source: 'fanza' });
    }

    return combined;
}

// ── セール作品（FANZA + MGS・Best/総集編/リマスター除外） ───────
async function genSaleProducts() {
    console.log('[セール作品] 取得中...');
    const [fanzaRows, mgsRows] = await Promise.all([
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, series_name, series_id, COALESCE(vr_flag,0) AS vr_flag, sale_end_date
                  FROM products
                  WHERE discount_pct >= 1
                    AND (${fanzaMakerCond})
                    AND ${bestConds}
                  ORDER BY discount_pct DESC, sale_start_date DESC LIMIT 120`,
            args: [...fanzaMakerArgs, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('FANZA sale error:', e.message); return []; }),
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price,
                         NULL AS series_name, NULL AS series_id, 0 AS vr_flag, sale_end_date
                  FROM products
                  WHERE discount_pct >= 1
                    AND (duration_min IS NULL OR duration_min < 600)
                    AND ${bestConds}
                  ORDER BY discount_pct DESC, REPLACE(sale_start_date,'/','-') DESC LIMIT 60`,
            args: bestArgs,
        }).then(r => r.rows).catch(e => { console.error('MGS sale error:', e.message); return []; }),
    ]);

    const combined = [
        ...fanzaRows.map(r => ({ ...r, main_image_url: poster(r.main_image_url), source: 'fanza' })),
        ...mgsRows.map(r  => ({ ...r, main_image_url: poster(r.main_image_url),  source: 'mgs'   })),
    ];
    combined.sort((a, b) => Number(b.discount_pct) - Number(a.discount_pct));
    return combined;
}

// ── メイン ────────────────────────────────────────────────────────
async function main() {
    const dataDir = path.join(ROOT, 'data');

    const [newProds, popularProds, ranking2026, rankingDefault, actressRanking2026, actressRankingDefault, preorderProds, homePreorderCurated, saleProds] = await Promise.all([
        genNewProducts(),
        genPopularProducts(),
        genRanking2026(),
        genRankingDefault(),
        genActressRanking2026(),
        genActressRankingDefault(),
        genPreorderProducts(),
        genHomePreorderCurated(),
        genSaleProducts(),
    ]);

    const write = (filename, data) => {
        const p = path.join(dataDir, filename);
        const pubP = path.join(ROOT, 'public', 'data', filename);
        fs.writeFileSync(p, JSON.stringify(data, null, 0));
        // public/data/ は Cloudflare ASSETS に含めるため常に書き込む
        fs.mkdirSync(path.dirname(pubP), { recursive: true });
        fs.writeFileSync(pubP, JSON.stringify(data, null, 0));
        console.log(`✓ ${filename} (${data.length}件)`);
    };

    write('products_new_cache.json',              newProds);
    write('products_popular_cache.json',          popularProds);
    write('ranking_2026_cache.json',              ranking2026);
    write('ranking_default_cache.json',           rankingDefault);
    write('actress_ranking_2026_cache.json',      actressRanking2026);
    write('actress_ranking_default_cache.json',   actressRankingDefault);
    write('home_preorder_cache.json',             preorderProds);
    write('home_preorder_curated_cache.json',     homePreorderCurated);
    write('sale_cache.json',                      saleProds);

    console.log('\n完了！次のコマンドでデプロイしてください:');
    console.log('  cd site && npx opennextjs-cloudflare build && npx opennextjs-cloudflare deploy');

    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
