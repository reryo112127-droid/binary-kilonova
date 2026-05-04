/**
 * 静的JSONキャッシュ生成スクリプト（ローカルSQLite版）
 * Tursoが使えない場合にローカルのfanza.db / mgs.dbから生成する
 * 使い方: node scripts/generate-static-cache-local.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '..', 'data'); // binary-kilonova/data/

const MGS_DB   = path.join(DATA, 'mgs.db');
const FANZA_DB = path.join(DATA, 'fanza.db');

if (!fs.existsSync(MGS_DB))   { console.error('mgs.db が見つかりません: ' + MGS_DB);   process.exit(1); }
if (!fs.existsSync(FANZA_DB)) { console.error('fanza.db が見つかりません: ' + FANZA_DB); process.exit(1); }

const mgs   = createClient({ url: 'file:' + MGS_DB });
const fanza = createClient({ url: 'file:' + FANZA_DB });

function poster(url) {
    if (!url) return '';
    if (url.includes('pb_e_')) return url.replace('pb_e_', 'pf_e_');
    if (url.includes('/digital/amateur/') && url.endsWith('jm.jpg')) return url.replace('jm.jpg', 'jp-001.jpg');
    return url;
}

const BEST = ['%BEST%','%ベスト%','%総集編%','%コレクション%','%Best%'];
const bestConds = BEST.map(() => 'title NOT LIKE ?').join(' AND ');
const bestArgs  = BEST;

const today = new Date().toISOString().slice(0, 10);

async function genNewProducts() {
    console.log('[新着作品] 取得中...');
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date
                  FROM products
                  WHERE sale_start_date IS NOT NULL
                    AND REPLACE(sale_start_date,'/','-') <= ?
                    AND (duration_min IS NULL OR duration_min < 600)
                    AND ${bestConds}
                  ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT 60`,
            args: [today, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date
                  FROM products
                  WHERE sale_start_date IS NOT NULL AND sale_start_date <= ?
                    AND ${bestConds}
                  ORDER BY sale_start_date DESC LIMIT 60`,
            args: [today, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);

    const combined = [];
    const maxLen = Math.max(mgsRows.length, fanzaRows.length);
    for (let i = 0; i < maxLen; i++) {
        if (mgsRows[i])   combined.push({ ...mgsRows[i],   main_image_url: poster(mgsRows[i].main_image_url),   source: 'mgs' });
        if (fanzaRows[i]) combined.push({ ...fanzaRows[i], main_image_url: poster(fanzaRows[i].main_image_url), source: 'fanza' });
    }
    return combined.slice(0, 60);
}

async function genPopularProducts() {
    console.log('[人気作品] 取得中...');
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date
                  FROM products
                  WHERE (duration_min IS NULL OR duration_min < 600)
                    AND ${bestConds}
                  ORDER BY wish_count DESC LIMIT 60`,
            args: bestArgs,
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(review_count,0) AS review_count, COALESCE(review_average,0) AS review_average
                  FROM products
                  WHERE ${bestConds}
                  ORDER BY COALESCE(review_count,0)*COALESCE(review_average,0) DESC, sale_start_date DESC LIMIT 60`,
            args: bestArgs,
        }).then(r => r.rows).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);

    const combined = [];
    const maxLen = Math.max(mgsRows.length, fanzaRows.length);
    for (let i = 0; i < maxLen; i++) {
        if (mgsRows[i])   combined.push({ ...mgsRows[i],   main_image_url: poster(mgsRows[i].main_image_url),   source: 'mgs' });
        if (fanzaRows[i]) combined.push({ ...fanzaRows[i], main_image_url: poster(fanzaRows[i].main_image_url), source: 'fanza' });
    }
    return combined.slice(0, 60);
}

async function genRanking2026() {
    console.log('[作品ランキング2026] 取得中...');
    const FROM = '2026-01-01', TO = '2026-12-31';
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date
                  FROM products
                  WHERE (duration_min IS NULL OR duration_min < 600)
                    AND REPLACE(sale_start_date,'/','-') >= ? AND REPLACE(sale_start_date,'/','-') <= ?
                    AND ${bestConds}
                  ORDER BY wish_count DESC LIMIT 300`,
            args: [FROM, TO, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(review_count,0) AS review_count, COALESCE(review_average,0) AS review_average
                  FROM products
                  WHERE sale_start_date >= ? AND sale_start_date <= ?
                    AND ${bestConds}
                  ORDER BY COALESCE(review_count,0)*COALESCE(review_average,0) DESC, sale_start_date DESC LIMIT 300`,
            args: [FROM, TO, ...bestArgs],
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

async function genActressRanking2026() {
    console.log('[女優ランキング2026] 取得中...');
    const FROM = '2026-01-01', TO = '2026-12-31';

    const [mgsRows, fanzaRows, profileRows] = await Promise.all([
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
        fanza.execute(
            `SELECT name, image_url FROM actress_profiles WHERE image_url IS NOT NULL LIMIT 2000`
        ).then(r => r.rows).catch(() => []),
    ]);

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

    const profileMap = new Map(profileRows.map(r => [String(r.name), String(r.image_url)]));

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

async function main() {
    const dataDir = path.join(ROOT, 'data');

    const [newProds, popularProds, ranking2026, actressRanking2026] = await Promise.all([
        genNewProducts(),
        genPopularProducts(),
        genRanking2026(),
        genActressRanking2026(),
    ]);

    const write = (filename, data) => {
        const p = path.join(dataDir, filename);
        fs.writeFileSync(p, JSON.stringify(data, null, 0));
        console.log(`✓ ${filename} (${data.length}件)`);
    };

    write('products_new_cache.json',           newProds);
    write('products_popular_cache.json',       popularProds);
    write('ranking_2026_cache.json',           ranking2026);
    write('actress_ranking_2026_cache.json',   actressRanking2026);

    console.log('\n完了！次のコマンドでデプロイしてください:');
    console.log('  npx vercel deploy --prod --yes');

    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
