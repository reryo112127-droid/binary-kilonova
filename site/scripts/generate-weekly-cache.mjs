/**
 * 週次静的キャッシュ生成スクリプト（低頻度更新データ）
 * 使い方: node scripts/generate-weekly-cache.mjs
 *
 * 生成ファイル:
 *   data/sitemap_cache.json   - サイトマップ用URL一覧（女優5000件+作品10000件）
 *   data/makers_cache.json    - メーカー一覧（300件）
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function loadEnv() {
    const envPath = path.join(ROOT, '.env.local');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
}

loadEnv();

if (!process.env.TURSO_MGS_URL || !process.env.TURSO_FANZA_URL) {
    console.error('TURSO_MGS_URL / TURSO_FANZA_URL が未設定です');
    process.exit(1);
}

const mgs   = createClient({ url: process.env.TURSO_MGS_URL,   authToken: process.env.TURSO_MGS_TOKEN });
const fanza = createClient({ url: process.env.TURSO_FANZA_URL,  authToken: process.env.TURSO_FANZA_TOKEN });

function poster(url) {
    if (!url) return '';
    if (url.includes('pb_e_')) return url.replace('pb_e_', 'pf_e_');
    if (url.includes('/digital/amateur/') && url.endsWith('jm.jpg')) return url.replace('jm.jpg', 'jp-001.jpg');
    return url;
}

// ── サイトマップ用URLキャッシュ ────────────────────────────────────
async function genSitemapCache() {
    console.log('[サイトマップキャッシュ] 取得中...');
    const [actressRows, mgsRows, fanzaRows] = await Promise.all([
        fanza.execute(
            'SELECT name FROM actress_profiles WHERE image_url IS NOT NULL ORDER BY name LIMIT 5000'
        ).then(r => r.rows).catch(() => []),
        mgs.execute(
            'SELECT product_id FROM products WHERE (duration_min IS NULL OR duration_min != 1) ORDER BY wish_count DESC LIMIT 5000'
        ).then(r => r.rows).catch(() => []),
        fanza.execute(
            'SELECT product_id FROM products ORDER BY sale_start_date DESC LIMIT 5000'
        ).then(r => r.rows).catch(() => []),
    ]);

    const actresses = actressRows.map(r => String(r.name));
    const seen = new Set();
    const products = [];
    for (const r of mgsRows)   { const p = String(r.product_id); if (!seen.has(p)) { seen.add(p); products.push(p); } }
    for (const r of fanzaRows) { const p = String(r.product_id); if (!seen.has(p)) { seen.add(p); products.push(p); } }

    return { actresses, products };
}

// ── メーカー一覧（floor付き） ──────────────────────────────────────
async function genMakersList() {
    console.log('[メーカー一覧] 取得中...');
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT maker, COUNT(*) as cnt, MAX(main_image_url) as sample_image
                  FROM products WHERE maker IS NOT NULL AND LENGTH(TRIM(maker)) > 1
                    AND (duration_min IS NULL OR duration_min < 600)
                  GROUP BY maker HAVING cnt >= 3 ORDER BY cnt DESC LIMIT 600`,
            args: [],
        }).then(r => r.rows).catch(() => []),
        // MAX(main_image_url) を除去: カバリングインデックス(maker,floor)で高速化
        // sample_imageはmaker一覧カードで未使用のため省略
        fanza.execute({
            sql: `SELECT maker, COUNT(*) as cnt,
                         SUM(CASE WHEN floor = 'videoc' THEN 1 ELSE 0 END) as videoc_cnt
                  FROM products WHERE maker IS NOT NULL AND LENGTH(TRIM(maker)) > 1
                  GROUP BY maker HAVING cnt >= 3 ORDER BY cnt DESC LIMIT 600`,
            args: [],
        }).then(r => r.rows).catch((e) => { console.error('[FANZA maker query error]', e.message); return []; }),
    ]);

    const map = new Map();
    for (const row of mgsRows) {
        const name = String(row.maker ?? '').trim();
        if (!name) continue;
        map.set(name, { name, count: Number(row.cnt ?? 0), sample_image: poster(String(row.sample_image ?? '')), sources: ['mgs'], floor: 'videoa' });
    }
    for (const row of fanzaRows) {
        const name = String(row.maker ?? '').trim();
        if (!name) continue;
        const cnt = Number(row.cnt ?? 0);
        const videocCnt = Number(row.videoc_cnt ?? 0);
        const floor = videocCnt > cnt / 2 ? 'videoc' : 'videoa';
        const e = map.get(name);
        if (e) { e.count += cnt; e.sources.push('fanza'); if (floor === 'videoc') e.floor = 'videoc'; }
        else map.set(name, { name, count: cnt, sample_image: poster(String(row.sample_image ?? '')), sources: ['fanza'], floor });
    }

    // MGSソース限定メーカーを件数上位300件 + MGS専用全件で構成
    const all = Array.from(map.values()).sort((a, b) => b.count - a.count);
    const top300 = all.slice(0, 300);
    const top300Names = new Set(top300.map(m => m.name));
    // MGS専用で上位300に入らなかったものを追加（cnt>=3保証済み）
    const mgsOnly = all.filter(m => m.sources.length === 1 && m.sources[0] === 'mgs' && !top300Names.has(m.name));
    return [...top300, ...mgsOnly].sort((a, b) => b.count - a.count);
}

// ── メイン ────────────────────────────────────────────────────────
async function main() {
    const dataDir = path.join(ROOT, 'data');

    const wait = ms => new Promise(r => setTimeout(r, ms));
    const sitemapData = await genSitemapCache(); await wait(300);
    const makersList  = await genMakersList();

    const write = (filename, data) => {
        const p = path.join(dataDir, filename);
        const pubP = path.join(ROOT, 'public', 'data', filename);
        fs.writeFileSync(p, JSON.stringify(data, null, 0));
        fs.mkdirSync(path.dirname(pubP), { recursive: true });
        fs.writeFileSync(pubP, JSON.stringify(data, null, 0));
        console.log(`✓ ${filename} (${data.length}件)`);
    };

    const sitemapPath    = path.join(dataDir, 'sitemap_cache.json');
    const sitemapPubPath = path.join(ROOT, 'public', 'data', 'sitemap_cache.json');
    const sitemapJson = JSON.stringify(sitemapData, null, 0);
    fs.writeFileSync(sitemapPath, sitemapJson);
    fs.writeFileSync(sitemapPubPath, sitemapJson);
    console.log(`✓ sitemap_cache.json (女優:${sitemapData.actresses.length}件, 作品:${sitemapData.products.length}件)`);

    write('makers_cache.json', makersList);

    console.log('\n完了！');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
