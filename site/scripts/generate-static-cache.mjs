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
import { d1, fanzaShards } from '../../scripts/lib/d1.js';

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

if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_D1_TOKEN
    || !process.env.D1_MGS_ID || !process.env.D1_FANZA_0_ID) {
    console.error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_D1_TOKEN / D1_MGS_ID / D1_FANZA_ID が未設定です');
    process.exit(1);
}

const mgs   = d1('mgs');
const fanza = fanzaShards();

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

// 女優名ではなく役名/説明文（「ゆい 26歳 フリーター」等）かを判定。
// lib/actressFilter.ts の looksLikeDescription と同等ロジック。女優ランキングから役名を除外する。
function looksLikeDescription(name) {
    if (!name) return true;
    if (/\d+歳/.test(name)) return true;             // 年齢入り
    if (/\d{4}年\d+月/.test(name)) return true;       // 年月（誤スクレイプ）
    if (/[【】()]/.test(name)) return true;           // 括弧（ASCII）
    if (name.length > 30) return true;                // 極端に長い
    if (/\s/.test(name.trim())) return true;          // スペース含む（名前+職業/年齢形式）
    return false;
}

// known女優リスト（actress_display_cache.json・FANZA登録6万人）を読み込む
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

// 役名/属性語パターン（known外の名前に適用）
const ROLE_ATTR_RE = /カップ|アイドル|レイヤー|素人|ナンパ|人妻|熟女|美少女|お姉さん|奥様|奥さん|先生|店員|社員|職員|店長|彼女|新妻|若妻|ギャル|コスプレ|ナース|女医|教師|秘書|OL/;

// 女優ランキングに採用してよい名前か
// FANZA登録(actress_display_cache=ActressSearch API)にある女優のみ採用するホワイトリスト方式。
// FANZA APIに女優登録が無い名前は役名/通称(いつき・りおぴん・「寝起きでも〜美女3名」等)とみなし除外。
function isValidActressName(name) {
    if (!name) return false;
    const known = getKnownActresses();
    if (known.size > 0) return known.has(name);       // knownロード成功時: ホワイトリスト厳格
    // knownロード失敗時のみパターン判定にフォールバック（ランキングが空になるのを防ぐ）
    if (looksLikeDescription(name)) return false;
    if (/(さん|ちゃん|くん|君)$/.test(name)) return false;
    if (/[&＆・/／＋+]/.test(name)) return false;
    if (ROLE_ATTR_RE.test(name)) return false;
    return true;
}

// MGS優先マージ: 同一product_idのFANZA重複を除去してインターリーブ
function mergeDedup(mgsRows, fanzaRows, mgsSource, fanzaSource) {
    const mgsIds = new Set(mgsRows.map(r => String(r.product_id)));
    const deduped = fanzaRows.filter(r => !mgsIds.has(String(r.product_id)));
    const combined = [];
    const maxLen = Math.max(mgsRows.length, deduped.length);
    for (let i = 0; i < maxLen; i++) {
        if (mgsRows[i])  combined.push({ ...mgsRows[i],  main_image_url: poster(String(mgsRows[i].main_image_url   || '')), source: mgsSource   || 'mgs'   });
        if (deduped[i])  combined.push({ ...deduped[i],  main_image_url: poster(String(deduped[i].main_image_url   || '')), source: fanzaSource || 'fanza' });
    }
    return combined;
}

const BEST = ['%BEST%','%ベスト%','%総集編%','%コレクション%','%Best%','%リマスター%','%AIリマスター%'];
const bestConds = BEST.map(() => 'title NOT LIKE ?').join(' AND ');
const bestArgs  = BEST;

const today = new Date().toISOString().slice(0, 10);
const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// ── ホーム画面掲載メーカーリスト（予約・セール共通） ──────────────
// ['exact'|'like', value]
// exact = 完全一致（誤ヒット防止: プレミアム熟女・マドンナモンロー等を除外）
// like  = 部分一致（DB登録名が長いメーカー: エスワン→エスワン ナンバーワンスタイル 等）
const HOME_MAKERS = [
    ['like',  'エスワン'],       // DB: "エスワン ナンバーワンスタイル"
    ['exact', 'ムーディーズ'],
    ['exact', 'アイデアポケット'],
    ['exact', 'OPPAI'],
    ['exact', 'E-BODY'],
    ['exact', 'Fitch'],
    ['exact', 'マドンナ'],       // exact: マドンナモンロー を除外
    ['exact', '本中'],
    ['like',  'ダスッ'],         // DB: "ダスッ！"
    ['exact', 'kawaii'],
    ['exact', 'Hunter'],         // exact: LADY HUNTERS（桃太郎映像出版）を除外
    ['exact', 'ワンズファクトリー'],
    ['exact', 'SODクリエイト'],
    ['exact', 'FALENO'],         // exact: FALENO TUBE を除外
    ['exact', 'TAMEIKE'],
    ['like',  'million'],        // label: "million（ミリオン）"
    ['exact', 'プレミアム'],     // exact: プレミアム熟女/エマニエル を除外
    ['exact', 'DAHLIA'],
];

// MGS用メーカー条件（maker列）
const mgsMakerCond = HOME_MAKERS.map(([t]) => t === 'exact' ? 'maker = ?' : 'maker LIKE ?').join(' OR ');
const mgsMakerArgs = HOME_MAKERS.map(([t, v]) => t === 'exact' ? v : `%${v}%`);
// FANZA用メーカー条件（label列 OR maker列）
const fanzaMakerCond = HOME_MAKERS.map(([t]) =>
    t === 'exact' ? '(maker = ? OR label = ?)' : '(maker LIKE ? OR label LIKE ?)'
).join(' OR ');
const fanzaMakerArgs = HOME_MAKERS.flatMap(([t, v]) =>
    t === 'exact' ? [v, v] : [`%${v}%`, `%${v}%`]
);

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
                  ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT 300`,
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
                  ORDER BY sale_start_date DESC LIMIT 300`,
            args: [twoWeeksAgo, today, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);

    const combined = mergeDedup(mgsRows, fanzaRows);

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
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, sale_end_date
                  FROM products
                  WHERE ${bestConds}
                  ORDER BY review_count DESC, sale_start_date DESC LIMIT 200`,
            args: bestArgs,
        }).then(r => r.rows).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);

    const combined = mergeDedup(mgsRows, fanzaRows);

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
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, sale_end_date
                  FROM products
                  WHERE sale_start_date >= ? AND sale_start_date <= ?
                    AND ${bestConds}
                  ORDER BY COALESCE(review_count,0)*COALESCE(review_average,0) DESC, sale_start_date DESC LIMIT 200`,
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
                  ORDER BY wish_count DESC LIMIT 200`,
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
            const names = String(row.actresses).split(/,|、/).map(s => s.trim()).filter(Boolean).filter(isValidActressName);
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

    const combined = mergeDedup(mgsRows, fanzaRows);

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

    const combined = mergeDedup(mgsRows, fanzaRows);

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

    const combined = mergeDedup(mgsRows, fanzaRows);
    combined.sort((a, b) => Number(b.discount_pct) - Number(a.discount_pct));
    return combined;
}

// ── メーカー一覧（floor付き） ──────────────────────────────────────
async function genMakersList() {
    console.log('[メーカー一覧] 取得中...');
    const [mgsRows, fanzaRows, fanzaVideocRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT maker, COUNT(*) as cnt, MAX(main_image_url) as sample_image
                  FROM products WHERE maker IS NOT NULL AND LENGTH(TRIM(maker)) > 1
                    AND (duration_min IS NULL OR duration_min < 600)
                  GROUP BY maker HAVING cnt >= 3 ORDER BY cnt DESC LIMIT 2000`,
            args: [],
        }).then(r => r.rows).catch(() => []),
        // floor情報付きで取得（videoc/videoa の多数決）
        fanza.execute({
            sql: `SELECT maker, COUNT(*) as cnt, MAX(main_image_url) as sample_image,
                         SUM(CASE WHEN floor = 'videoc' THEN 1 ELSE 0 END) as videoc_cnt
                  FROM products WHERE maker IS NOT NULL AND LENGTH(TRIM(maker)) > 1
                  GROUP BY maker HAVING cnt >= 3 ORDER BY cnt DESC LIMIT 3000`,
            args: [],
        }).then(r => r.rows).catch(() => []),
        // 素人(videoc)主体メーカーは小規模で上位400から漏れるため専用取得（videocが過半数のみ・大手誤分類回避）
        fanza.execute({
            sql: `SELECT maker, COUNT(*) as cnt, MAX(main_image_url) as sample_image,
                         SUM(CASE WHEN floor = 'videoc' THEN 1 ELSE 0 END) as videoc_cnt
                  FROM products WHERE maker IS NOT NULL AND LENGTH(TRIM(maker)) > 1
                  GROUP BY maker HAVING videoc_cnt >= 3 AND videoc_cnt > cnt / 2
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
        // 過半数がvideocならvideoc判定
        const floor = videocCnt > cnt / 2 ? 'videoc' : 'videoa';
        const e = map.get(name);
        if (e) { e.count += cnt; e.sources.push('fanza'); if (floor === 'videoc') e.floor = 'videoc'; }
        else map.set(name, { name, count: cnt, sample_image: poster(String(row.sample_image ?? '')), sources: ['fanza'], floor });
    }
    // 素人(videoc)主体メーカーを必ず取り込む（上位400に入らない小規模シリーズも含める）
    for (const row of fanzaVideocRows) {
        const name = String(row.maker ?? '').trim();
        if (!name) continue;
        const e = map.get(name);
        if (e) { e.floor = 'videoc'; if (!e.sources.includes('fanza')) e.sources.push('fanza'); }
        else map.set(name, { name, count: Number(row.cnt ?? 0), sample_image: poster(String(row.sample_image ?? '')), sources: ['fanza'], floor: 'videoc' });
    }
    // 作品が3件以上ある全メーカーを掲載（上限なし）。/makersは五十音×platform×検索でフィルタ描画。
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
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
    for (const r of mgsRows)  { const p = String(r.product_id); if (!seen.has(p)) { seen.add(p); products.push(p); } }
    for (const r of fanzaRows) { const p = String(r.product_id); if (!seen.has(p)) { seen.add(p); products.push(p); } }

    return { actresses, products };
}

// ── メイン ────────────────────────────────────────────────────────
async function main() {
    const dataDir = path.join(ROOT, 'data');

    // 順次実行 + クエリ間300ms待機（Tursoレート制限 "fetch failed" を防ぐ）
    // sitemap_cache.json / makers_cache.json は weekly-sitemap-cache ワークフローが生成
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const newProds            = await genNewProducts();            await wait(300);
    const popularProds        = await genPopularProducts();        await wait(300);
    const ranking2026         = await genRanking2026();            await wait(300);
    const rankingDefault      = await genRankingDefault();         await wait(300);
    const actressRanking2026  = await genActressRanking2026();     await wait(300);
    const actressRankingDefault = await genActressRankingDefault(); await wait(300);
    const preorderProds       = await genPreorderProducts();       await wait(300);
    const homePreorderCurated = await genHomePreorderCurated();    await wait(300);
    const saleProds           = await genSaleProducts();

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
