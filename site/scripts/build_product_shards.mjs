/**
 * 商品詳細の静的シャードを生成する（D1 無料枠切れ時のフォールバック用）。
 *
 * 背景: R2 read-through を止めて以降、商品詳細の供給源は D1 だけになった。D1 の日次枠
 * （アカウント全体で500万行読取/日）が切れると `/api/product/[id]` が 404 を返し、
 * 商品ページが骨組みだけになる。実際に 2026-09-04 の本番で起きている。
 *
 * 収録対象（優先順）:
 *   1. **静的キャッシュに載っている作品の和集合**（新作/人気/セール/ランキング/女優ページ）
 *      = 枠切れ中でも一覧に出る＝クリックできる作品。ここは 100% 埋める。
 *   2. **サイトマップに載っている作品**（sitemap_cache.json = 索引対象）。枠切れ中に
 *      Googlebot が索引済みURLを踏んで 404 を返すと、大量の soft-404 で剥がされる。
 *   3. 余った枠を人気作品で埋める（MGS=wish_count / FANZA=review_count×review_average）。
 *      Google 検索から直に商品ページへ来る導線ぶんの保険。
 *
 * データ源はローカル SQLite（data/mgs.db・data/fanza.db）。**D1 は読まない**（枠切れの
 * ときにこそ再生成したいので、D1 に依存させない）。ローカル DB に無い作品は静的キャッシュ側の
 * フィールドだけで最低限のレコードを作る（title/actresses/画像/価格は静的キャッシュにある）。
 * ローカル DB は D1 より古い（出演者名の修正が反映されない等 [[avrankings-local-db-staleness]]）が、
 * これは D1 が死んでいる間だけ使う劣化版なので許容する。
 *
 * 出力: site/data/product/<nn>.json と site/public/data/product/<nn>.json（nn = 00..7f）
 *       中身は { "<小文字product_id>": { products行と同じ列 } }
 *
 * 使い方: node scripts/build_product_shards.mjs [--max=30000]
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // site/
const REPO = path.resolve(ROOT, '..');                                          // binary-kilonova/

export const SHARD_COUNT = 128;

/** FNV-1a 32bit。site/lib/productShard.ts の productShardKey と **必ず同じ実装**にすること。 */
export function productShardKey(id) {
    const s = String(id).toLowerCase();
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % SHARD_COUNT).toString(16).padStart(2, '0');
}

// 収録する列（products テーブルと同じ名前にする。呼び出し側が D1 の行と同じに扱えるように）
const COMMON_COLS = [
    'product_id', 'title', 'actresses', 'maker', 'label', 'genres', 'sale_start_date',
    'main_image_url', 'duration_min', 'sample_video_url', 'sample_images_json',
    'list_price', 'current_price', 'discount_pct', 'sale_end_date',
];
const MGS_COLS = [...COMMON_COLS, 'wish_count'];
const FANZA_COLS = [...COMMON_COLS, 'affiliate_url', 'review_count', 'review_average', 'series_id', 'series_name', 'vr_flag'];

/** ギャラリーは先頭 N 枚まで（全部入れるとシャードが肥大する） */
const MAX_SAMPLE_IMAGES = 6;

// 一覧に出る＝クリックできる作品を集めるキャッシュ
const LIST_CACHES = [
    'products_new_cache.json', 'products_popular_cache.json', 'sale_cache.json',
    'ranking_2026_cache.json', 'ranking_default_cache.json',
    'home_preorder_cache.json', 'home_preorder_curated_cache.json',
];
const ACTRESS_CACHES = ['actress_top_products.json', 'actress_extended_products.json'];

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

/** 静的キャッシュから「クリックできる作品」を id → 素の商品オブジェクトで集める */
function collectSeeds() {
    const seeds = new Map();
    const add = (p) => {
        const id = String(p?.product_id ?? '');
        if (!id || seeds.has(id.toLowerCase())) return;
        seeds.set(id.toLowerCase(), p);
    };
    for (const f of LIST_CACHES) {
        const d = readJson(path.join(ROOT, 'data', f));
        if (Array.isArray(d)) d.forEach(add);
    }
    for (const f of ACTRESS_CACHES) {
        const d = readJson(path.join(ROOT, 'data', f));
        if (d && typeof d === 'object') for (const list of Object.values(d)) if (Array.isArray(list)) list.forEach(add);
    }
    return seeds;
}

/** sample_images_json を先頭 MAX_SAMPLE_IMAGES 枚に切り詰める（壊れた JSON は捨てる） */
function capSampleImages(json) {
    if (!json) return null;
    try {
        const arr = JSON.parse(String(json));
        if (!Array.isArray(arr) || arr.length === 0) return null;
        return JSON.stringify(arr.slice(0, MAX_SAMPLE_IMAGES));
    } catch { return null; }
}

/**
 * @param noGallery サンプル画像を入れない。ギャラリーは1件あたり約540バイトで
 *   レコードの半分以上を占めるため、サイトマップ長尾ぶん（閲覧される確率が低く、
 *   主目的が「枠切れ中に404を返さないこと」）では落としてアセット量を抑える。
 */
function pick(row, cols, source, noGallery = false) {
    const out = { source };
    for (const c of cols) {
        if (noGallery && c === 'sample_images_json') continue;
        const v = row[c];
        if (v === null || v === undefined || v === '') continue;   // 空はキーごと省いてサイズを削る
        out[c] = c === 'sample_images_json' ? capSampleImages(v) : v;
        if (out[c] === null) delete out[c];
    }
    return out;
}

function openDb(file) {
    const p = path.join(REPO, 'data', file);
    if (!fs.existsSync(p)) {
        console.warn(`[warn] ${p} が無いので静的キャッシュのフィールドだけで作ります`);
        return null;
    }
    const Database = require('better-sqlite3');
    return new Database(p, { readonly: true });
}

function main() {
    const maxArg = process.argv.find(a => a.startsWith('--max='));
    const MAX = maxArg ? parseInt(maxArg.split('=')[1], 10) : 70000;

    const seeds = collectSeeds();
    console.log(`[seed] 静的キャッシュに載る作品: ${seeds.size} 件`);

    // サイトマップ掲載＝索引対象のURL。ここに載っていて詳細が出せないと、
    // 枠切れ中のクロールが soft-404 になり索引から外れる。product_id しか無いので
    // ローカルDBから引く（引けなければ収録しない）。
    const sitemap = readJson(path.join(ROOT, 'data', 'sitemap_cache.json'));
    const sitemapIds = (sitemap?.products ?? []).map(String);
    console.log(`[seed] サイトマップ掲載: ${sitemapIds.length} 件`);

    const mgs = openDb('mgs.db');
    const fanza = openDb('fanza.db');
    const getMgs = mgs ? mgs.prepare(`SELECT ${MGS_COLS.join(', ')} FROM products WHERE product_id = ?`) : null;
    const getFanza = fanza ? fanza.prepare(`SELECT ${FANZA_COLS.join(', ')} FROM products WHERE product_id = ?`) : null;

    /** id → レコード（products 行と同じ形） */
    const records = new Map();
    let fromDb = 0, fromSeed = 0;

    for (const [key, seed] of seeds) {
        const id = String(seed.product_id);
        const src = String(seed.source ?? '');
        // 静的キャッシュの source を信じつつ、外れたらもう片方も引く
        const order = src === 'fanza' ? ['fanza', 'mgs'] : ['mgs', 'fanza'];
        // 静的キャッシュ側の値をベースにする。ローカルDBの行があれば上書きし、
        // DB側が欠けている項目（出演者が空の行が実際にある）はキャッシュの値で埋まる。
        const seedRec = pick(seed, [...COMMON_COLS, 'wish_count', 'review_count', 'review_average', 'series_name'],
            src || (id.includes('-') ? 'mgs' : 'fanza'));
        seedRec.product_id = id;

        let dbRec = null;
        for (const s of order) {
            const row = s === 'mgs' ? getMgs?.get(id) : getFanza?.get(id);
            if (row) { dbRec = pick(row, s === 'mgs' ? MGS_COLS : FANZA_COLS, s); break; }
        }
        if (dbRec) fromDb++; else fromSeed++;
        records.set(key, dbRec ? { ...seedRec, ...dbRec } : seedRec);
    }
    console.log(`[seed] ローカルDBから ${fromDb} 件 / 静的キャッシュのみ ${fromSeed} 件`);

    // サイトマップ掲載ぶんを追加（静的キャッシュに無いものはローカルDBから）
    let fromSitemap = 0;
    for (const id of sitemapIds) {
        const key = id.toLowerCase();
        if (records.has(key) || records.size >= MAX) continue;
        const row = getMgs?.get(id) ?? getFanza?.get(id);
        if (!row) continue;   // ローカルDBに無い＝収録できない
        const isMgsRow = Object.prototype.hasOwnProperty.call(row, 'wish_count');
        records.set(key, pick(row, isMgsRow ? MGS_COLS : FANZA_COLS, isMgsRow ? 'mgs' : 'fanza', true));
        fromSitemap++;
    }
    console.log(`[seed] サイトマップぶんを ${fromSitemap} 件追加（計 ${records.size} 件）`);

    // 余った枠を人気作品で埋める（MGS と FANZA で半分ずつ）
    const remaining = Math.max(0, MAX - records.size);
    if (remaining > 0) {
        const half = Math.ceil(remaining / 2);
        const fills = [];
        if (getMgs) fills.push(['mgs', MGS_COLS, mgs.prepare(
            `SELECT ${MGS_COLS.join(', ')} FROM products WHERE wish_count IS NOT NULL ORDER BY wish_count DESC LIMIT ?`).all(half)]);
        if (getFanza) fills.push(['fanza', FANZA_COLS, fanza.prepare(
            `SELECT ${FANZA_COLS.join(', ')} FROM products WHERE review_count IS NOT NULL
             ORDER BY COALESCE(review_count,0) * COALESCE(review_average,0) DESC LIMIT ?`).all(half)]);
        let added = 0;
        for (const [src, cols, rows] of fills) {
            for (const row of rows) {
                const key = String(row.product_id).toLowerCase();
                if (records.has(key) || records.size >= MAX) continue;
                records.set(key, pick(row, cols, src));
                added++;
            }
        }
        console.log(`[fill] 人気作品を ${added} 件追加`);
    }

    mgs?.close();
    fanza?.close();

    // シャードへ振り分けて書き出し
    const shards = {};
    for (let i = 0; i < SHARD_COUNT; i++) shards[i.toString(16).padStart(2, '0')] = {};
    for (const [key, rec] of records) shards[productShardKey(key)][key] = rec;

    let total = 0, maxBytes = 0;
    for (const base of [path.join(ROOT, 'data', 'product'), path.join(ROOT, 'public', 'data', 'product')]) {
        fs.mkdirSync(base, { recursive: true });
        for (const [nn, obj] of Object.entries(shards)) {
            const json = JSON.stringify(obj);
            fs.writeFileSync(path.join(base, `${nn}.json`), json);
            if (base.endsWith(path.join('public', 'data', 'product'))) continue;
            total += json.length;
            maxBytes = Math.max(maxBytes, json.length);
        }
    }
    const mb = (n) => (n / 1024 / 1024).toFixed(2) + 'MB';
    console.log(`[done] ${records.size} 件を ${SHARD_COUNT} シャードへ  合計 ${mb(total)} / 最大 ${mb(maxBytes)}`);
    // Workers のアセット上限は 1ファイル25MB。1シャードがそれに近づいたら分割数を増やすこと。
    if (maxBytes > 20 * 1024 * 1024) console.warn('[warn] シャードが25MBのアセット上限に接近しています');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build_product_shards.mjs')) {
    main();
}
