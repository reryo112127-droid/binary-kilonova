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
    const makerList = [...top300, ...mgsOnly].sort((a, b) => b.count - a.count);

    // ── レーベル(label)追加: メーカー一覧に無いブランドを補完 ──
    console.log('[メーカー一覧] レーベル取得中...');
    const existingNames = new Set(makerList.map(m => m.name));
    const [mgsLabels, fanzaLabels] = await Promise.all([
        mgs.execute({
            sql: `SELECT label, COUNT(*) as cnt FROM products
                  WHERE label IS NOT NULL AND LENGTH(TRIM(label)) > 1 AND label != '----'
                    AND (duration_min IS NULL OR duration_min < 600)
                  GROUP BY label HAVING cnt >= 3 ORDER BY cnt DESC LIMIT 1500`,
            args: [],
        }).then(r => r.rows).catch(() => []),
        fanza.execute({
            sql: `SELECT label, COUNT(*) as cnt,
                         SUM(CASE WHEN floor = 'videoc' THEN 1 ELSE 0 END) as videoc_cnt
                  FROM products
                  WHERE label IS NOT NULL AND LENGTH(TRIM(label)) > 1 AND label != '----'
                  GROUP BY label HAVING cnt >= 3 ORDER BY cnt DESC LIMIT 4000`,
            args: [],
        }).then(r => r.rows).catch((e) => { console.error('[FANZA label query error]', e.message); return []; }),
    ]);

    const labelMap = new Map();
    for (const row of mgsLabels) {
        const name = String(row.label ?? '').trim();
        if (!name || existingNames.has(name)) continue;
        const e = labelMap.get(name);
        if (e) { e.count += Number(row.cnt ?? 0); }
        else labelMap.set(name, { name, count: Number(row.cnt ?? 0), sample_image: '', sources: ['mgs'], floor: 'videoa', is_label: true });
    }
    for (const row of fanzaLabels) {
        const name = String(row.label ?? '').trim();
        if (!name || existingNames.has(name)) continue;
        const cnt = Number(row.cnt ?? 0);
        const floor = Number(row.videoc_cnt ?? 0) > cnt / 2 ? 'videoc' : 'videoa';
        const e = labelMap.get(name);
        if (e) { e.count += cnt; if (!e.sources.includes('fanza')) e.sources.push('fanza'); if (floor === 'videoc') e.floor = 'videoc'; }
        else labelMap.set(name, { name, count: cnt, sample_image: '', sources: ['fanza'], floor, is_label: true });
    }

    const labelList = Array.from(labelMap.values()).sort((a, b) => b.count - a.count);
    console.log(`[メーカー一覧] メーカー ${makerList.length}件 + レーベル ${labelList.length}件`);
    return [...makerList, ...labelList].sort((a, b) => b.count - a.count);
}

// ── 女優表示用フルプロフィールキャッシュ ─────────────────────────
// actress_display_cache.json: 女優APIのTursoクエリをゼロにするための静的JSON
async function genActressDisplayCache() {
    console.log('[女優表示キャッシュ] 取得中...');
    const rows = await fanza.execute(
        `SELECT name, fanza_id, ruby, height, bust, waist, hip, cup,
                birthday, blood_type, hobby, prefectures,
                image_url, twitter, instagram, tiktok,
                aliases, avwiki_url, agency_url, agency_source,
                augmented, retired
         FROM actress_profiles
         ORDER BY name`
    ).then(r => r.rows).catch(() => []);

    // Record<name, profile> 形式で返す（O(1)ルックアップ用）
    const map = {};
    for (const row of rows) {
        const name = String(row.name ?? '').trim();
        if (!name) continue;
        let aliases = [];
        try { aliases = row.aliases ? JSON.parse(String(row.aliases)) : []; } catch { /* ignore */ }
        map[name] = {
            name,
            fanza_id:     row.fanza_id   ?? null,
            ruby:         row.ruby       ?? null,
            height:       row.height     ?? null,
            bust:         row.bust       ?? null,
            waist:        row.waist      ?? null,
            hip:          row.hip        ?? null,
            cup:          row.cup        ?? null,
            birthday:     row.birthday   ?? null,
            blood_type:   row.blood_type ?? null,
            hobby:        row.hobby      ?? null,
            prefectures:  row.prefectures ?? null,
            image_url:    row.image_url  ?? null,
            twitter:      row.twitter    ?? null,
            instagram:    row.instagram  ?? null,
            tiktok:       row.tiktok     ?? null,
            aliases,
            avwiki_url:   row.avwiki_url  ?? null,
            agency_url:   row.agency_url  ?? null,
            agency_source:row.agency_source ?? null,
            augmented:    row.augmented === 1,
            retired:      row.retired === 1,
        };
    }
    return map;
}

// 女優別商品リスト共通処理: 重複除去・BEST除外・新着順ソート・最小フィールド化
// 検索カード(search.html/search-other.html)が使うフィールドのみ残してサイズ削減
const BEST_RE = /BEST|ベスト|総集編|コレクション|best/i;
function mergeBestExcludeSort(mgsRows, fanzaRows, limit) {
    const seen = new Set();
    return [...mgsRows, ...fanzaRows].filter(r => {
        const pid = String(r.product_id);
        if (seen.has(pid)) return false;
        seen.add(pid);
        if (BEST_RE.test(String(r.title ?? ''))) return false; // BEST/総集編除外
        return true;
    }).sort((a, b) => {
        const da = String(a.sale_start_date ?? '').replace(/\//g, '-').slice(0, 10);
        const db = String(b.sale_start_date ?? '').replace(/\//g, '-').slice(0, 10);
        return db.localeCompare(da);
    }).slice(0, limit).map(r => ({
        product_id:     r.product_id,
        title:          r.title,
        actresses:      r.actresses,
        main_image_url: r.main_image_url,
        genres:         r.genres,
        maker:          r.maker,
        source:         r.source,
    }));
}

// ── 人気女優 上位200人の商品リスト静的JSON ─────────────────────────
// actress_top_products.json: 女優検索ページのTursoクエリを完全ゼロに
async function genTopActressProducts() {
    console.log('[人気女優商品リスト] 取得中...');

    // MGSのwish_count上位から女優名を抽出（上位200人）
    const mgsActressRows = await mgs.execute({
        sql: `SELECT actresses, SUM(wish_count) as total_wish
              FROM products
              WHERE actresses IS NOT NULL AND actresses != '' AND actresses != '----'
                AND (duration_min IS NULL OR duration_min < 600)
              GROUP BY actresses
              ORDER BY total_wish DESC
              LIMIT 1000`,
        args: [],
    }).then(r => r.rows).catch(() => []);

    // 女優名ごとに集計（カンマ区切りを展開）
    const actressWish = new Map();
    for (const row of mgsActressRows) {
        const names = String(row.actresses ?? '').split(/,|、/).map(s => s.trim()).filter(s => s && s !== '----');
        const w = Number(row.total_wish ?? 0);
        for (const n of names) {
            actressWish.set(n, (actressWish.get(n) || 0) + w);
        }
    }
    const top200 = [...actressWish.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 200)
        .map(([name]) => name);

    console.log(`  上位200女優を特定 (サンプル: ${top200.slice(0,5).join(', ')})`);

    // 各女優の商品を取得（検索カードに必要な最小フィールドのみ）
    const SQL = `SELECT product_id, title, actresses, main_image_url, genres, maker, sale_start_date`;

    const result = {};
    const BATCH = 20; // 同時リクエスト数を制限

    for (let i = 0; i < top200.length; i += BATCH) {
        const batch = top200.slice(i, i + BATCH);
        await Promise.all(batch.map(async (actressName) => {
            const escaped = actressName.replace(/"/g, '""');
            const ftsMatch = `actresses : "${escaped}"`;
            const [mgsRows, fanzaRows] = await Promise.all([
                mgs.execute({
                    sql: `${SQL}
                          FROM products
                          WHERE product_id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?)
                            AND (duration_min IS NULL OR duration_min < 600)
                          ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT 30`,
                    args: [ftsMatch],
                }).then(r => r.rows.map(row => ({ ...row, source: 'mgs' }))).catch(() => []),
                fanza.execute({
                    sql: `${SQL}
                          FROM products
                          WHERE product_id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?)
                          ORDER BY sale_start_date DESC LIMIT 30`,
                    args: [ftsMatch],
                }).then(r => r.rows.map(row => ({ ...row, source: 'fanza' }))).catch(() => []),
            ]);

            const combined = mergeBestExcludeSort(mgsRows, fanzaRows, 21); // 21件: 20表示+1
            if (combined.length > 0) result[actressName] = combined;
        }));
        if (i + BATCH < top200.length) await new Promise(r => setTimeout(r, 100));
    }

    return result;
}

// ── 拡張女優商品リスト（20作品以上 ＋ ホームメーカー出演者）────────
// actress_extended_products.json
async function genExtendedActressProducts(existingNames) {
    console.log('[拡張女優商品リスト] 対象女優を特定中...');

    // ホームメーカー条件（SALE_MAKERS_FANZAと同一）
    const HOME_MAKER_SQL = `(
        maker LIKE '%エスワン%' OR label LIKE '%エスワン%' OR
        maker = 'ムーディーズ' OR label = 'ムーディーズ' OR
        maker = 'アイデアポケット' OR label = 'アイデアポケット' OR
        maker = 'OPPAI' OR label = 'OPPAI' OR
        maker = 'E-BODY' OR label = 'E-BODY' OR
        maker = 'Fitch' OR label = 'Fitch' OR
        maker = 'マドンナ' OR label = 'マドンナ' OR
        maker = '本中' OR label = '本中' OR
        maker LIKE '%ダスッ%' OR label LIKE '%ダスッ%' OR
        maker = 'kawaii' OR label = 'kawaii' OR
        maker = 'Hunter' OR label = 'Hunter' OR
        maker = 'ワンズファクトリー' OR label = 'ワンズファクトリー' OR
        maker = 'SODクリエイト' OR label = 'SODクリエイト' OR
        maker = 'FALENO' OR label = 'FALENO' OR
        maker = 'TAMEIKE' OR label = 'TAMEIKE' OR
        maker LIKE '%million%' OR label LIKE '%million%' OR
        maker = 'プレミアム' OR label = 'プレミアム' OR
        maker = 'DAHLIA' OR label = 'DAHLIA'
    )`;

    // 3クエリを並列取得
    const [fanza20Rows, mgs20Rows, fanzaMakerRows] = await Promise.all([
        // FANZA: 20作品以上のパターン
        fanza.execute({
            sql: `SELECT actresses, COUNT(*) as cnt FROM products
                  WHERE actresses IS NOT NULL AND actresses != '' AND actresses != '----'
                  GROUP BY actresses HAVING cnt >= 20 ORDER BY cnt DESC`,
            args: [],
        }).then(r => r.rows).catch(() => []),
        // MGS: 20作品以上のパターン
        mgs.execute({
            sql: `SELECT actresses, COUNT(*) as cnt FROM products
                  WHERE actresses IS NOT NULL AND actresses != '' AND actresses != '----'
                    AND (duration_min IS NULL OR duration_min < 600)
                  GROUP BY actresses HAVING cnt >= 20 ORDER BY cnt DESC`,
            args: [],
        }).then(r => r.rows).catch(() => []),
        // FANZA: ホームメーカー出演パターン（全件）
        fanza.execute({
            sql: `SELECT actresses, COUNT(*) as cnt FROM products
                  WHERE actresses IS NOT NULL AND actresses != '' AND actresses != '----'
                    AND ${HOME_MAKER_SQL}
                  GROUP BY actresses HAVING cnt >= 3 ORDER BY cnt DESC`,
            args: [],
        }).then(r => r.rows).catch(() => []),
    ]);

    // 個人名ごとに出演作品数を集計
    const individualCounts = new Map();
    const splitNames = (rows) => {
        for (const row of rows) {
            const cnt = Number(row.cnt ?? 1);
            const names = String(row.actresses ?? '').split(/,|、/).map(s => s.trim()).filter(s => s && s !== '----');
            for (const n of names) {
                individualCounts.set(n, (individualCounts.get(n) || 0) + cnt);
            }
        }
    };
    splitNames(fanza20Rows);
    splitNames(mgs20Rows);
    splitNames(fanzaMakerRows);

    // 対象: 個人作品数20以上 OR ホームメーカーに3作以上出演
    // → ここでは全ての集計済み名前が対象（20作以上パターン OR メーカーパターンに含まれる名前）
    const excluded = new Set(existingNames);
    const candidates = [...individualCounts.entries()]
        .filter(([name]) => !excluded.has(name) && name.length >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2500)  // 最大2500人（25MBアセット上限に合わせ10作品×2500人≈23MB）
        .map(([name]) => name);

    console.log(`  対象 ${candidates.length}人 (サンプル: ${candidates.slice(0,5).join(', ')})`);

    // 各女優の商品を取得（検索カードに必要な最小フィールドのみ）
    const SQL = `SELECT product_id, title, actresses, main_image_url, genres, maker, sale_start_date`;

    const result = {};
    const BATCH = 15;

    for (let i = 0; i < candidates.length; i += BATCH) {
        const batch = candidates.slice(i, i + BATCH);
        await Promise.all(batch.map(async (actressName) => {
            const escaped = actressName.replace(/"/g, '""');
            const ftsMatch = `actresses : "${escaped}"`;
            const [mgsRows, fanzaRows] = await Promise.all([
                mgs.execute({
                    sql: `${SQL} FROM products
                          WHERE product_id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?)
                            AND (duration_min IS NULL OR duration_min < 600)
                          ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT 20`,
                    args: [ftsMatch],
                }).then(r => r.rows.map(row => ({ ...row, source: 'mgs' }))).catch(() => []),
                fanza.execute({
                    sql: `${SQL} FROM products
                          WHERE product_id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?)
                          ORDER BY sale_start_date DESC LIMIT 20`,
                    args: [ftsMatch],
                }).then(r => r.rows.map(row => ({ ...row, source: 'fanza' }))).catch(() => []),
            ]);

            const combined = mergeBestExcludeSort(mgsRows, fanzaRows, 11); // 11件: 10表示+1
            if (combined.length > 0) result[actressName] = combined;
        }));
        if (i + BATCH < candidates.length) await new Promise(r => setTimeout(r, 150));
        if (i % 300 === 0 && i > 0) console.log(`  進捗: ${i}/${candidates.length}人`);
    }

    return result;
}

// ── メイン ────────────────────────────────────────────────────────
async function main() {
    const dataDir = path.join(ROOT, 'data');

    const wait = ms => new Promise(r => setTimeout(r, ms));
    const sitemapData        = await genSitemapCache();        await wait(200);
    const makersList         = await genMakersList();          await wait(200);
    const actressMap         = await genActressDisplayCache(); await wait(200);
    const topActressProducts = await genTopActressProducts();  await wait(200);
    const extActressProducts = await genExtendedActressProducts(Object.keys(topActressProducts));

    const write = (filename, data) => {
        const p = path.join(dataDir, filename);
        const pubP = path.join(ROOT, 'public', 'data', filename);
        const json = JSON.stringify(data, null, 0);
        fs.writeFileSync(p, json);
        fs.mkdirSync(path.dirname(pubP), { recursive: true });
        fs.writeFileSync(pubP, json);
        const count = Array.isArray(data) ? data.length : Object.keys(data).length;
        console.log(`✓ ${filename} (${count}件)`);
    };

    const sitemapPath    = path.join(dataDir, 'sitemap_cache.json');
    const sitemapPubPath = path.join(ROOT, 'public', 'data', 'sitemap_cache.json');
    const sitemapJson = JSON.stringify(sitemapData, null, 0);
    fs.writeFileSync(sitemapPath, sitemapJson);
    fs.writeFileSync(sitemapPubPath, sitemapJson);
    console.log(`✓ sitemap_cache.json (女優:${sitemapData.actresses.length}件, 作品:${sitemapData.products.length}件)`);

    write('makers_cache.json', makersList);
    write('actress_display_cache.json', actressMap);
    write('actress_top_products.json', topActressProducts);
    write('actress_extended_products.json', extActressProducts);

    console.log('\n完了！');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
