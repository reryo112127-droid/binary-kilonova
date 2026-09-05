/**
 * 長尾LP（/genre/… ・/maker/… ・/series/…）の先頭ページぶんの作品カードを静的JSONに焼き込む。
 * **LPのクロールで D1 を1行も読まないようにする**のが目的。
 *
 * 背景: LPの枠は静的だが、本文カードは lib/landingPage.ts が内部で /api/products を呼んでおり、
 * genre/maker/series は静的キャッシュ経路が無いので必ず D1 に落ちていた。LPは
 * 287(ジャンル)+3,461(メーカー)+147(シリーズ) ≒ 3,900 URL あり、SEOでLPを増やすほど
 * D1 の日次枠（500万行/日）を線形に食う構造だった。
 *
 * **1パス方式**: LPごとに `LIKE '%name%'` を投げると全文スキャン×3,900回で終わらない
 * （実測10分以上）。そこで DB を人気順に1回だけ走査し、各行を該当スラッグのバケツへ
 * 詰める。スラッグ判定は「distinct な genres 要素 / maker 名」単位でメモ化するので、
 * 部分一致（"エスワン" が "エスワン ナンバーワンスタイル" に当たる）も D1 と同じ意味になる。
 *
 * データ源はローカル SQLite。D1 は読まない（生成のために枠を使っては本末転倒）。
 * ただしローカル fanza.db は D1 より古い（FANZAの日次更新は GitHub Actions が D1 だけを更新）ため、
 * **人気順LP(genre/maker)の FANZA 側は日付順ではなくレビュー人気順**にしてある。
 * 「人気ランキング」ページとしては日付順より妥当で、ローカルDBの鮮度にも左右されない。
 * series LP だけは sort=new なので日付順（＝ローカルの鮮度に依存する）。
 *
 * 出力: site/data/lp/<type>/<nn>.json と site/public/data/lp/<type>/<nn>.json
 *       中身は { "<slug>": [ {product_id,title,actresses,main_image_url,source}, ... ] }
 *
 * 使い方: node scripts/build_lp_cache.mjs [--per=60]
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // site/
const REPO = path.resolve(ROOT, '..');

export const LP_SHARD_COUNT = 128;   // メーカーが3,400件あり、16分割だと1シャード1.3MBでisolateに重い

/** FNV-1a 32bit。site/lib/lpCache.ts の lpShardKey と **必ず同じ実装**にすること。 */
export function lpShardKey(slug) {
    const s = String(slug);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % LP_SHARD_COUNT).toString(16).padStart(2, '0');
}

// lib/bestFilter.ts と同じ除外条件
const BEST_PATTERNS = ['%BEST%', '%ベスト%', '%総集編%', '%コレクション%', '%福袋%', '%詰め合わせ%', '%コンプリート%', '%枚組%'];
const COMPILATION_MAX_MIN = 480;
const BEST_SQL = BEST_PATTERNS.map(() => 'title NOT LIKE ?').join(' AND ')
    + ` AND (duration_min IS NULL OR duration_min <= ${COMPILATION_MAX_MIN})`;

// MGS裏表紙→表紙（lib/landingPage.ts の poster と同じ）
function poster(url) {
    if (!url) return '';
    if (url.includes('pb_e_')) return url.replace('pb_e_', 'pf_e_');
    if (url.includes('/digital/amateur/') && url.endsWith('jm.jpg')) return url.replace('jm.jpg', 'jp-001.jpg');
    return url;
}

/** /api/products と同じ品番コア（MGSとFANZAに同じ作品がある場合1枚に） */
function coreId(id) {
    const s = String(id || '').toLowerCase().replace(/^h_\d+/, '').replace(/^\d+/, '').replace(/[^a-z0-9]/g, '');
    const m = s.match(/^([a-z]+)0*(\d+)$/);
    return m ? m[1] + m[2] : s;
}

// カード描画に使う項目（public/design/**.html の renderer が参照する p.xxx に合わせる）。
// /api/products の応答としてもそのまま返せるようにするため、価格・尺・サンプル動画まで持つ。
function card(row, source) {
    const c = {
        product_id: row.product_id,
        title: row.title ?? '',
        actresses: row.actresses ?? '',
        main_image_url: poster(row.main_image_url ?? ''),
        source,
    };
    // 空はキーごと落としてサイズを削る（描画側は undefined を想定済み）
    const opt = {
        genres: row.genres, maker: row.maker, sale_start_date: row.sale_start_date,
        duration_min: row.duration_min, sample_video_url: row.sample_video_url,
        discount_pct: row.discount_pct, list_price: row.list_price, current_price: row.current_price,
        wish_count: row.wish_count, review_count: row.review_count,
        series_name: row.series_name, vr_flag: row.vr_flag,
    };
    for (const [k, v] of Object.entries(opt)) {
        if (v !== null && v !== undefined && v !== '' && v !== 0) c[k] = v;
    }
    return c;
}

/**
 * 「値 → 当てはまるスラッグ配列」をメモ化して返す関数を作る。
 * 部分一致（slug が値に含まれる）で判定するので D1 の `LIKE '%slug%'` と同じ意味になる。
 */
function makeMatcher(slugs) {
    const memo = new Map();
    return (value) => {
        const v = String(value ?? '');
        if (!v) return [];
        let hit = memo.get(v);
        if (hit === undefined) {
            hit = slugs.filter(s => v.includes(s));
            memo.set(v, hit);
        }
        return hit;
    };
}

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function main() {
    const perArg = process.argv.find(a => a.startsWith('--per='));
    const PER = perArg ? parseInt(perArg.split('=')[1], 10) : 60;   // 30件×2ページぶん

    const Database = require('better-sqlite3');
    const mgsPath = path.join(REPO, 'data', 'mgs.db');
    const fanzaPath = path.join(REPO, 'data', 'fanza.db');
    if (!fs.existsSync(mgsPath) || !fs.existsSync(fanzaPath)) {
        console.warn('! ローカルDBが無いのでLPキャッシュ生成をスキップ（既存を維持）');
        return;
    }
    const mgs = new Database(mgsPath, { readonly: true });
    const fanza = new Database(fanzaPath, { readonly: true });

    // ジャンルは genres_cache.json（LPを持つ287件）だけだと足りない。
    // 商品詳細の「関連作品」は作品が持つジャンル名でそのまま /api/products?genre= を叩くので、
    // キャッシュに無いジャンルは D1 の FTS 全マッチ（実測 1回約6万行）へ落ちる。
    // カタログ全体でも 423 種しかない（+136件≒+2MB）ので、**カタログに出る全ジャンル**を収録する。
    const genreSlugSet = new Set((readJson(path.join(ROOT, 'data', 'genres_cache.json')) || []).map(g => g.name).filter(Boolean));
    const lpOnlyCount = genreSlugSet.size;
    for (const db of [mgs, fanza]) {
        for (const row of db.prepare('SELECT DISTINCT genres FROM products WHERE genres IS NOT NULL').iterate()) {
            for (const el of String(row.genres).split(/,\s*/)) {
                const g = el.trim();
                if (g) genreSlugSet.add(g);
            }
        }
    }
    const genreSlugs = [...genreSlugSet];
    const makerSlugs = (readJson(path.join(ROOT, 'data', 'makers_cache.json')) || []).map(m => m.name).filter(Boolean);
    const seriesSlugs = new Set((readJson(path.join(ROOT, 'data', 'series_cache.json')) || []).map(s => s.name).filter(Boolean));
    console.log(`[LP] スラッグ: ジャンル${genreSlugs.length}(うちLP ${lpOnlyCount}) / メーカー${makerSlugs.length} / シリーズ${seriesSlugs.size}`);

    const matchGenre = makeMatcher(genreSlugs);
    const matchMaker = makeMatcher(makerSlugs);

    // buckets[type][slug] = { mgs: [], fanza: [] }
    const buckets = { genre: new Map(), maker: new Map(), series: new Map() };
    const bucketOf = (type, slug) => {
        let b = buckets[type].get(slug);
        if (!b) { b = { mgs: [], fanza: [] }; buckets[type].set(slug, b); }
        return b;
    };

    /** 1行を該当スラッグのバケツへ詰める（各バケツは PER 件で打ち止め） */
    function assign(row, source) {
        const c = card(row, source);
        // ジャンル: "独占配信, 素人, 巨乳" のような連結文字列。要素ごとに判定する
        const seenSlug = new Set();
        for (const el of String(row.genres ?? '').split(/,\s*/)) {
            for (const slug of matchGenre(el)) {
                if (seenSlug.has('g:' + slug)) continue;
                seenSlug.add('g:' + slug);
                const b = bucketOf('genre', slug)[source];
                if (b.length < PER) b.push(c);
            }
        }
        // メーカー: maker 列と label 列の両方が対象（D1 と同じ）
        for (const val of [row.maker, row.label]) {
            for (const slug of matchMaker(val)) {
                if (seenSlug.has('m:' + slug)) continue;
                seenSlug.add('m:' + slug);
                const b = bucketOf('maker', slug)[source];
                if (b.length < PER) b.push(c);
            }
        }
    }

    // ── MGS: 人気順（wish_count DESC）に1パス ────────────────────────────
    let n = 0;
    const mgsStmt = mgs.prepare(
        `SELECT product_id, title, actresses, main_image_url, genres, maker, label,
                sale_start_date, duration_min, sample_video_url, wish_count,
                COALESCE(discount_pct,0) AS discount_pct, list_price, current_price
         FROM products
         WHERE (duration_min IS NULL OR duration_min < 600) AND ${BEST_SQL}
         ORDER BY wish_count DESC`);
    for (const row of mgsStmt.iterate(...BEST_PATTERNS)) { assign(row, 'mgs'); n++; }
    console.log(`[LP] MGS ${n.toLocaleString()}行を走査`);

    // ── FANZA: レビュー人気順に1パス ──────────────────────────────────
    n = 0;
    const fanzaStmt = fanza.prepare(
        `SELECT product_id, title, actresses, main_image_url, genres, maker, label,
                sale_start_date, duration_min, sample_video_url, review_count, series_name, vr_flag,
                COALESCE(discount_pct,0) AS discount_pct, list_price, current_price
         FROM products
         WHERE ${BEST_SQL}
         ORDER BY COALESCE(review_count,0) * COALESCE(review_average,0) DESC`);
    for (const row of fanzaStmt.iterate(...BEST_PATTERNS)) { assign(row, 'fanza'); n++; }
    console.log(`[LP] FANZA ${n.toLocaleString()}行を走査`);

    // ── シリーズ: series_name 完全一致・配信日DESC（/api/products は series 指定時 FANZA のみ）──
    n = 0;
    const seriesStmt = fanza.prepare(
        `SELECT product_id, title, actresses, main_image_url, series_name, genres, maker,
                sale_start_date, duration_min, sample_video_url, review_count, vr_flag,
                COALESCE(discount_pct,0) AS discount_pct, list_price, current_price
         FROM products WHERE series_name IS NOT NULL ORDER BY sale_start_date DESC`);
    for (const row of seriesStmt.iterate()) {
        const name = row.series_name;
        if (!seriesSlugs.has(name)) continue;
        const b = bucketOf('series', name).fanza;
        if (b.length < PER) { b.push(card(row, 'fanza')); n++; }
    }
    console.log(`[LP] シリーズ ${n.toLocaleString()}件を収集`);

    mgs.close();
    fanza.close();

    // ── MGS/FANZA を交互マージして書き出し（/api/products の人気順と同じ並べ方）──
    let grandTotal = 0, grandBytes = 0;
    for (const [type, map] of Object.entries(buckets)) {
        const shards = {};
        for (let i = 0; i < LP_SHARD_COUNT; i++) shards[i.toString(16).padStart(2, '0')] = {};
        let filled = 0;
        for (const [slug, b] of map) {
            const out = [];
            const seen = new Set();
            const push = (c) => {
                const k = coreId(c.product_id);
                if (k && seen.has(k)) return;
                if (k) seen.add(k);
                out.push(c);
            };
            const max = Math.max(b.mgs.length, b.fanza.length);
            for (let i = 0; i < max && out.length < PER; i++) {
                if (b.mgs[i]) push(b.mgs[i]);
                if (b.fanza[i] && out.length < PER) push(b.fanza[i]);
            }
            if (out.length === 0) continue;   // 0件はキャッシュせずD1へ落とす
            shards[lpShardKey(slug)][slug] = out.slice(0, PER);
            filled++;
        }
        let bytes = 0;
        for (const base of [path.join(ROOT, 'data', 'lp', type), path.join(ROOT, 'public', 'data', 'lp', type)]) {
            fs.mkdirSync(base, { recursive: true });
            for (const [nn, obj] of Object.entries(shards)) {
                const json = JSON.stringify(obj);
                fs.writeFileSync(path.join(base, `${nn}.json`), json);
                if (base.includes(path.join('public', 'data'))) continue;
                bytes += json.length;
            }
        }
        grandTotal += filled; grandBytes += bytes;
        console.log(`[LP] ${type}: ${filled}スラッグ収録 / ${(bytes / 1024 / 1024).toFixed(2)}MB`);
    }
    console.log(`[LP] 合計 ${grandTotal} スラッグ / ${(grandBytes / 1024 / 1024).toFixed(2)}MB（1LPあたり最大${PER}件）`);
}

// テストからは関数だけ import したいので、直接実行のときだけ走らせる
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("build_lp_cache.mjs")) {
    main();
}
