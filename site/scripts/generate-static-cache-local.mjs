/**
 * 静的JSONキャッシュ生成スクリプト（ローカルSQLite版）
 * Tursoが使えない場合にローカルのfanza.db / mgs.dbから生成する
 * 使い方: node scripts/generate-static-cache-local.mjs
 *
 * 生成ファイル (site/data/ + site/public/data/):
 *   products_new_cache.json          - 新着作品 (top60)
 *   products_popular_cache.json      - 人気作品 (top60)
 *   ranking_2026_cache.json          - 作品ランキング2026 (top100)
 *   ranking_default_cache.json       - 作品ランキング（直近1年、top100）
 *   actress_ranking_2026_cache.json  - 女優ランキング2026 (top50)
 *   actress_ranking_default_cache.json - 女優ランキング（直近1年、top50）
 *   home_preorder_cache.json         - 予約作品・全メーカー
 *   home_preorder_curated_cache.json - 予約作品・厳選メーカー（ホーム用）
 *   sale_cache.json                  - セール中作品
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openLocal } from '../../scripts/lib/localsqlite.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '..', 'data'); // binary-kilonova/data/

const MGS_DB   = path.join(DATA, 'mgs.db');
const FANZA_DB = path.join(DATA, 'fanza.db');

if (!fs.existsSync(MGS_DB))   { console.error('mgs.db が見つかりません: ' + MGS_DB);   process.exit(1); }
if (!fs.existsSync(FANZA_DB)) { console.error('fanza.db が見つかりません: ' + FANZA_DB); process.exit(1); }

const mgs   = openLocal(MGS_DB);
const fanza = openLocal(FANZA_DB);

function poster(url) {
    if (!url) return '';
    if (url.includes('pb_e_')) return url.replace('pb_e_', 'pf_e_');
    if (url.includes('/digital/amateur/') && url.endsWith('jm.jpg')) return url.replace('jm.jpg', 'jp-001.jpg');
    return url;
}

// 役名/説明文判定（「ゆい 26歳 フリーター」等）
function looksLikeDescription(name) {
    if (!name) return true;
    if (/\d+歳/.test(name)) return true;
    if (/\d{4}年\d+月/.test(name)) return true;
    if (/[【】()]/.test(name)) return true;
    if (name.length > 30) return true;
    if (/\s/.test(name.trim())) return true;
    return false;
}

// known女優リスト（actress_display_cache.json）読み込み
let _knownActresses = null;
function getKnownActresses() {
    if (_knownActresses) return _knownActresses;
    _knownActresses = new Set();
    try {
        const p = path.join(ROOT, 'public', 'data', 'actress_display_cache.json');
        if (fs.existsSync(p)) {
            const m = JSON.parse(fs.readFileSync(p, 'utf-8'));
            for (const n of Object.keys(m)) _knownActresses.add(n);
        }
    } catch { /* ignore */ }
    return _knownActresses;
}

const ROLE_ATTR_RE = /カップ|アイドル|レイヤー|素人|ナンパ|人妻|熟女|美少女|お姉さん|奥様|奥さん|先生|店員|社員|職員|店長|彼女|新妻|若妻|ギャル|コスプレ|ナース|女医|教師|秘書|OL/;

// 女優ランキングに採用してよい名前か（FANZA登録ホワイトリスト方式）
function isValidActressName(name) {
    if (!name) return false;
    const known = getKnownActresses();
    if (known.size > 0) return known.has(name);
    if (looksLikeDescription(name)) return false;
    if (/(さん|ちゃん|くん|君)$/.test(name)) return false;
    if (/[&＆・/／＋+]/.test(name)) return false;
    if (ROLE_ATTR_RE.test(name)) return false;
    return true;
}

const BEST = ['%BEST%','%ベスト%','%総集編%','%コレクション%','%Best%','%リマスター%','%AIリマスター%'];
const bestConds = BEST.map(() => 'title NOT LIKE ?').join(' AND ');
const bestArgs  = BEST;

const today = new Date().toISOString().slice(0, 10);
const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// ── ホーム画面掲載メーカーリスト ────────────────────────────────────
// ['exact'|'like', value]  ※ generate-static-cache.mjs / route.ts と同一定義を維持
const HOME_MAKERS = [
    ['like',  'エスワン'],
    ['exact', 'ムーディーズ'],
    ['exact', 'アイデアポケット'],
    ['exact', 'OPPAI'],
    ['exact', 'E-BODY'],
    ['exact', 'Fitch'],
    ['exact', 'マドンナ'],
    ['exact', '本中'],
    ['like',  'ダスッ'],
    ['exact', 'kawaii'],
    ['exact', 'Hunter'],
    ['exact', 'ワンズファクトリー'],
    ['exact', 'SODクリエイト'],
    ['exact', 'FALENO'],
    ['exact', 'TAMEIKE'],
    ['like',  'million'],
    ['exact', 'プレミアム'],
    ['exact', 'DAHLIA'],
];

const mgsMakerCond = HOME_MAKERS.map(([t]) => t === 'exact' ? 'maker = ?' : 'maker LIKE ?').join(' OR ');
const mgsMakerArgs = HOME_MAKERS.map(([t, v]) => t === 'exact' ? v : `%${v}%`);
const fanzaMakerCond = HOME_MAKERS.map(([t]) =>
    t === 'exact' ? '(maker = ? OR label = ?)' : '(maker LIKE ? OR label LIKE ?)'
).join(' OR ');
const fanzaMakerArgs = HOME_MAKERS.flatMap(([t, v]) =>
    t === 'exact' ? [v, v] : [`%${v}%`, `%${v}%`]
);

// FANZA拡張列（存在しない場合はNULLフォールバック）
const FANZA_EXT = `COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, sale_end_date`;
const FANZA_EXT_VR = `COALESCE(discount_pct,0) AS discount_pct, list_price, current_price,
    CASE WHEN typeof(series_name)='text' THEN series_name ELSE NULL END AS series_name,
    CASE WHEN typeof(series_id)='text' THEN series_id ELSE NULL END AS series_id,
    CASE WHEN typeof(vr_flag)='integer' THEN vr_flag ELSE 0 END AS vr_flag,
    sale_end_date`;

// ── 新着作品 ──────────────────────────────────────────────────────
async function genNewProducts() {
    console.log('[新着作品] 取得中...');
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
                  ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT 300`,
            args: [twoWeeksAgo, today, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         ${FANZA_EXT}
                  FROM products
                  WHERE sale_start_date IS NOT NULL
                    AND SUBSTR(sale_start_date,1,10) >= ?
                    AND SUBSTR(sale_start_date,1,10) <= ?
                    AND ${bestConds}
                  ORDER BY sale_start_date DESC LIMIT 300`,
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
                  ORDER BY wish_count DESC LIMIT 200`,
            args: bestArgs,
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(review_count,0) AS review_count, COALESCE(review_average,0) AS review_average,
                         ${FANZA_EXT}
                  FROM products
                  WHERE ${bestConds}
                  ORDER BY COALESCE(review_count,0)*COALESCE(review_average,0) DESC, sale_start_date DESC LIMIT 200`,
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
                  ORDER BY wish_count DESC LIMIT 200`,
            args: [FROM, TO, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(review_count,0) AS review_count, COALESCE(review_average,0) AS review_average,
                         ${FANZA_EXT}
                  FROM products
                  WHERE sale_start_date >= ? AND sale_start_date <= ?
                    AND ${bestConds}
                  ORDER BY COALESCE(review_count,0)*COALESCE(review_average,0) DESC, sale_start_date DESC LIMIT 200`,
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

// ── 作品ランキング（日付範囲なし・デフォルト） ──────────────────
async function genRankingDefault() {
    console.log('[作品ランキング デフォルト] 取得中...');
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, NULL AS sale_end_date
                  FROM products
                  WHERE (duration_min IS NULL OR duration_min < 600)
                    AND REPLACE(sale_start_date,'/','-') >= ?
                    AND ${bestConds}
                  ORDER BY wish_count DESC LIMIT 200`,
            args: [oneYearAgo, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(review_count,0) AS review_count, COALESCE(review_average,0) AS review_average,
                         ${FANZA_EXT}
                  FROM products
                  WHERE sale_start_date >= ?
                    AND ${bestConds}
                  ORDER BY COALESCE(review_count,0) DESC, sale_start_date DESC LIMIT 300`,
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
            `SELECT name, image_url FROM actress_profiles WHERE image_url IS NOT NULL LIMIT 3000`
        ).then(r => r.rows).catch(() => []),
    ]);

    return buildActressRanking(mgsRows, fanzaRows, profileRows, 50);
}

// ── 女優ランキング（デフォルト・直近1年） ──────────────────────
async function genActressRankingDefault() {
    console.log('[女優ランキング デフォルト] 取得中...');

    const [mgsRows, fanzaRows, profileRows] = await Promise.all([
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
        fanza.execute(
            `SELECT name, image_url FROM actress_profiles WHERE image_url IS NOT NULL LIMIT 3000`
        ).then(r => r.rows).catch(() => []),
    ]);

    return buildActressRanking(mgsRows, fanzaRows, profileRows, 50);
}

function buildActressRanking(mgsRows, fanzaRows, profileRows, topN) {
    const actressMap = new Map();
    const processRows = (rows) => {
        for (const row of rows) {
            if (!row.actresses) continue;
            const names = String(row.actresses).split(/,|、/).map(s => s.trim()).filter(Boolean).filter(isValidActressName);
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
        .slice(0, topN)
        .map(e => ({
            name: e.name,
            score: e.wishScore,
            work_count: e.workCount,
            image_url: profileMap.get(e.name) || null,
            sample_image: e.sampleImage,
        }));
}

// ── 予約作品・全メーカー ──────────────────────────────────────────
async function genPreorderProducts() {
    console.log('[予約作品 全メーカー] 取得中...');
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         0 AS discount_pct, NULL AS list_price, NULL AS current_price,
                         NULL AS series_name, NULL AS series_id, 0 AS vr_flag, NULL AS sale_end_date
                  FROM products
                  WHERE REPLACE(sale_start_date,'/','-') > ?
                    AND (duration_min IS NULL OR duration_min < 600)
                    AND ${bestConds}
                  ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT 300`,
            args: [today, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         ${FANZA_EXT_VR}
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
    console.log('[予約作品 厳選メーカー] 取得中...');
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         0 AS discount_pct, NULL AS list_price, NULL AS current_price,
                         NULL AS series_name, NULL AS series_id, 0 AS vr_flag, NULL AS sale_end_date
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
                         ${FANZA_EXT_VR}
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

// ── セール作品（割引率降順） ──────────────────────────────────────
async function genSaleProducts() {
    console.log('[セール作品] 取得中...');
    const [fanzaRows, mgsRows] = await Promise.all([
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         ${FANZA_EXT_VR}
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

// ── メーカー一覧 ──────────────────────────────────────────────────
async function genMakersList() {
    console.log('[メーカー一覧] 取得中...');
    const [mgsRows, fanzaRows, fanzaVideocRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT maker, COUNT(*) as cnt, MAX(main_image_url) as sample_image
                  FROM products
                  WHERE maker IS NOT NULL AND LENGTH(TRIM(maker)) > 1
                    AND (duration_min IS NULL OR duration_min < 600)
                  GROUP BY maker HAVING cnt >= 3
                  ORDER BY cnt DESC LIMIT 2000`,
            args: [],
        }).then(r => r.rows).catch(() => []),
        fanza.execute({
            sql: `SELECT maker, COUNT(*) as cnt, MAX(main_image_url) as sample_image,
                         SUM(CASE WHEN floor = 'videoc' THEN 1 ELSE 0 END) as videoc_cnt
                  FROM products
                  WHERE maker IS NOT NULL AND LENGTH(TRIM(maker)) > 1
                  GROUP BY maker HAVING cnt >= 3
                  ORDER BY cnt DESC LIMIT 3000`,
            args: [],
        }).then(r => r.rows).catch(() => []),
        // 素人(videoc)主体のメーカーは作品数が小さく上位400に入らず一覧から漏れるため、専用に取得して必ず含める。
        // videoaも持つ大手(SOD等)を誤分類しないよう「videocが過半数」のメーカーに限定。
        fanza.execute({
            sql: `SELECT maker, COUNT(*) as cnt, MAX(main_image_url) as sample_image,
                         SUM(CASE WHEN floor = 'videoc' THEN 1 ELSE 0 END) as videoc_cnt
                  FROM products
                  WHERE maker IS NOT NULL AND LENGTH(TRIM(maker)) > 1
                  GROUP BY maker
                  HAVING videoc_cnt >= 3 AND videoc_cnt > cnt / 2
                  ORDER BY cnt DESC LIMIT 1000`,
            args: [],
        }).then(r => r.rows).catch(() => []),
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
    // 素人(videoc)メーカーを必ず取り込む（上位400に入らない小規模シリーズも含める）
    for (const row of fanzaVideocRows) {
        const name = String(row.maker ?? '').trim();
        if (!name) continue;
        const e = map.get(name);
        if (e) { e.floor = 'videoc'; if (!e.sources.includes('fanza')) e.sources.push('fanza'); }
        else map.set(name, { name, count: Number(row.cnt ?? 0), sample_image: poster(String(row.sample_image ?? '')), sources: ['fanza'], floor: 'videoc' });
    }
    // 作品が3件以上ある全メーカーを掲載（上限なし）。
    // /makersページは platform×五十音×検索でフィルタ描画するため件数増でも軽量。
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

// ── メイン ────────────────────────────────────────────────────────
async function main() {
    const dataDir = path.join(ROOT, 'data');
    const pubDir  = path.join(ROOT, 'public', 'data');
    fs.mkdirSync(pubDir, { recursive: true });

    const write = (filename, data) => {
        fs.writeFileSync(path.join(dataDir, filename), JSON.stringify(data, null, 0));
        fs.writeFileSync(path.join(pubDir, filename),  JSON.stringify(data, null, 0));
        console.log(`✓ ${filename} (${Array.isArray(data) ? data.length : Object.keys(data).length}件)`);
    };

    // 順次実行（@libsql/client file:// はシリアルが安全）
    write('products_new_cache.json',              await genNewProducts());
    write('products_popular_cache.json',          await genPopularProducts());
    write('ranking_2026_cache.json',              await genRanking2026());
    write('ranking_default_cache.json',           await genRankingDefault());
    write('actress_ranking_2026_cache.json',      await genActressRanking2026());
    write('actress_ranking_default_cache.json',   await genActressRankingDefault());
    write('home_preorder_cache.json',             await genPreorderProducts());
    write('home_preorder_curated_cache.json',     await genHomePreorderCurated());
    write('sale_cache.json',                      await genSaleProducts());
    write('makers_cache.json',                    await genMakersList());

    console.log('\n完了！次のコマンドでデプロイしてください:');
    console.log('  npm run deploy:cf');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
