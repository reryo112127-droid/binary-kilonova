/**
 * 女優ページ（/actress/[name]）の作品カード静的キャッシュ（2026-09-11）。
 *
 * 女優ページは lib/landingPage.ts の fetchProducts で `/api/products?actress=…&sort=wish_count`
 * を呼んでおり、/api/products 側の女優キャッシュ（actress_top/extended）は
 * 「sort=new のとき」かつ「30件そろうとき」しか使わないので、**女優ページのクロールは
 * 全件 D1 に落ちていた**（サイトマップ掲載 20,549人のうち静的キャッシュに載っていたのも
 * 2,234人だけ）。女優ページはサイトマップ最大の塊なので、SEO で URL を増やすほど
 * D1 の日次読取枠を線形に削る。
 *
 * ここでサイトマップ掲載の全女優ぶんのカードを LP キャッシュと同じ 128 分割シャード
 * （data/lp/actress/<nn>.json、キーは女優名）に焼き、女優ページは静的優先で描画する。
 * 読み出しは lib/lpCache.ts の readLpCards('actress', name) をそのまま使う
 * （ハッシュ実装は lpShardKey と同じにすること。ずれると全女優ページが D1 に落ちる）。
 *
 * /api/products と同じ意味で集める:
 *   - 女優の照合 … 別名グループ（actress_aliases.json）のいずれかが、出演者欄を「,」「、」で
 *                  区切った要素と**完全一致**する作品（route.ts の最終フィルタと同じ）
 *   - 除外       … excludeBest=1 と同じ（BEST/総集編系タイトル・480分超）
 *   - 並び       … sort=wish_count: MGS は wish_count 降順、FANZA は配信日降順を交互に
 *                  （品番コアで MGS/FANZA の重複を1枚に）
 * データ源はローカル SQLite（D1 は読まない）。ローカル DB は D1 より件数が少ないので、
 * 収録数は D1 より少なくなりうる（その場合も上限未満＝全件扱いにはせず、下の PER 判定に従う）。
 *
 * 使い方: node scripts/build_actress_cache.mjs [--per=60]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // site/
const REPO = path.resolve(ROOT, '..');

/** 1女優あたりの収録上限。app/actress/[name]/route.ts の ACTRESS_CACHE_PER と同じ値にすること */
export const ACTRESS_CACHE_PER = 60;
const SHARD_COUNT = 128;

// lib/bestFilter.ts / scripts/build_lp_cache.mjs と同じ除外条件
const BEST_PATTERNS = ['%BEST%', '%ベスト%', '%総集編%', '%コレクション%', '%福袋%', '%詰め合わせ%', '%コンプリート%', '%枚組%'];
const BEST_SQL = BEST_PATTERNS.map(() => 'title NOT LIKE ?').join(' AND ') + ' AND COALESCE(duration_min, 0) <= 480';

/** FNV-1a 32bit → "00".."7f"。lib/lpCache.ts の lpShardKey と同じ実装 */
export function shardKey(slug) {
    let h = 2166136261;
    for (let i = 0; i < slug.length; i++) {
        h ^= slug.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % SHARD_COUNT).toString(16).padStart(2, '0');
}

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

// ── lib/actressFilter.ts の filterActresses と同じ整形 ─────────────────────────
// /api/products は出演者欄をこれで整形してから女優名を完全一致で照合する。
// 素人作品は括弧（別名・年号）を外し、実在女優ホワイトリストに載る名前だけ残すので、
// 生の出演者欄で照合すると「D1 では出る作品が出ない / 出ない作品が出る」ずれが起きる。
const normName = s => String(s || '').trim().replace(/\s+/g, '');
let knownActresses = null;
function isAmateurWork(genres, maker) {
    const g = genres || '', m = maker || '';
    if (g.includes('素人') || g.includes('アマチュア') || g.includes('ナンパ') || g.includes('ハメ撮り')) return true;
    if (m.includes('素人') || m.includes('LUXURY TV') || m.includes('プレステージプレミアム')) return true;
    return false;
}
function looksLikeDescription(name) {
    if (/\d+歳/.test(name)) return true;
    if (/\d{4}年\d+月/.test(name)) return true;
    if (/[【】\(\)]/.test(name)) return true;
    if (name.length > 30) return true;
    if (/\s/.test(name.trim())) return true;
    return false;
}
export function filterActresses(actressesStr, genres, maker) {
    if (!actressesStr) return null;
    const protectedStr = actressesStr.replace(/（[^）]*）/g, m => m.replace(/[,、]/g, ' '));
    const entries = protectedStr.split(/[,、]/).map(s => s.trim()).filter(Boolean)
        .filter(e => !/^[＊*]+$/.test(e));
    if (entries.length === 0) return null;
    const isAmateur = isAmateurWork(genres || '', maker || '') || entries.some(e => looksLikeDescription(e));
    if (isAmateur) {
        knownActresses ??= new Set(readJson(path.join(ROOT, 'data', 'actress_whitelist.json')) || []);
        const processed = entries
            .map(entry => entry.replace(/（[^）]*）|\([^)]*\)/g, ''))
            .filter(entry => knownActresses.has(normName(entry)));
        if (processed.length === 0) return null;
        return [...new Set(processed)].join(', ');
    }
    if (!/[＊*]/.test(actressesStr)) return actressesStr;
    return entries.join(', ');
}

// SSR カードの描画（cardHtml）と共演女優リンク（collectCoStars）が使う項目だけ持つ。
// 女優ページ2万件ぶんなので、LP のように価格・尺までは持たない（サイズを抑える）。
// actresses は /api/products の応答と同じく整形済みの値を入れる。
function card(row, source, actresses) {
    return {
        product_id: row.product_id,
        title: row.title ?? '',
        actresses: actresses ?? '',
        main_image_url: poster(row.main_image_url ?? ''),
        source,
    };
}

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function main() {
    const perArg = process.argv.find(a => a.startsWith('--per='));
    const PER = perArg ? parseInt(perArg.split('=')[1], 10) : ACTRESS_CACHE_PER;

    const mgsPath = path.join(REPO, 'data', 'mgs.db');
    const fanzaPath = path.join(REPO, 'data', 'fanza.db');
    if (!fs.existsSync(mgsPath) || !fs.existsSync(fanzaPath)) {
        console.warn('! ローカルDBが無いので女優キャッシュ生成をスキップ（既存を維持）');
        return;
    }
    const sitemap = readJson(path.join(ROOT, 'data', 'sitemap_actresses.json'));
    const names = (sitemap?.actresses || []).filter(n => typeof n === 'string' && n);
    if (names.length === 0) {
        console.warn('! sitemap_actresses.json が空なので女優キャッシュ生成をスキップ（既存を維持）');
        return;
    }
    const aliases = readJson(path.join(ROOT, 'data', 'actress_aliases.json')) || [];

    // 出演者欄の1要素 → それを出演とみなす女優ページ名の一覧（別名グループを展開）
    const entryToNames = new Map();
    const link = (entry, name) => {
        let a = entryToNames.get(entry);
        if (!a) { a = []; entryToNames.set(entry, a); }
        if (!a.includes(name)) a.push(name);
    };
    for (const name of names) {
        const group = aliases.find(g => Array.isArray(g) && g.includes(name)) || [name];
        for (const e of group) link(e, name);
    }

    const buckets = new Map(); // name → { mgs: [], fanza: [] }
    const bucketOf = (name) => {
        let b = buckets.get(name);
        if (!b) { b = { mgs: [], fanza: [] }; buckets.set(name, b); }
        return b;
    };
    function assign(row, source) {
        // route.ts の最終フィルタと同じ: 整形後の出演者欄を「,」「、」で区切って完全一致
        const acts = filterActresses(row.actresses ?? null, row.genres ?? null, row.maker ?? null);
        if (!acts) return;
        const seen = new Set();
        let c = null;
        for (const raw of acts.split(/[,、]/)) {
            const targets = entryToNames.get(raw.trim());
            if (!targets) continue;
            for (const name of targets) {
                if (seen.has(name)) continue;
                seen.add(name);
                const b = bucketOf(name)[source];
                if (b.length < PER) b.push(c ??= card(row, source, acts));
            }
        }
    }

    const Database = require('better-sqlite3');
    const t0 = Date.now();
    const mgs = new Database(mgsPath, { readonly: true });
    let n = 0;
    for (const row of mgs.prepare(
        `SELECT product_id, title, actresses, main_image_url, genres, maker FROM products
         WHERE actresses IS NOT NULL AND actresses != '' AND COALESCE(duration_min, 0) < 600 AND ${BEST_SQL}
         ORDER BY wish_count DESC`).iterate(...BEST_PATTERNS)) { assign(row, 'mgs'); n++; }
    mgs.close();
    console.log(`[actress] MGS ${n.toLocaleString()}行を走査`);

    const fanza = new Database(fanzaPath, { readonly: true });
    n = 0;
    for (const row of fanza.prepare(
        `SELECT product_id, title, actresses, main_image_url, genres, maker FROM products
         WHERE actresses IS NOT NULL AND actresses != '' AND ${BEST_SQL}
         ORDER BY sale_start_date DESC`).iterate(...BEST_PATTERNS)) { assign(row, 'fanza'); n++; }
    fanza.close();
    console.log(`[actress] FANZA ${n.toLocaleString()}行を走査 (${((Date.now() - t0) / 1000).toFixed(1)}秒)`);

    // MGS/FANZA を交互マージ（/api/products の人気順と同じ並べ方）
    const shards = {};
    for (let i = 0; i < SHARD_COUNT; i++) shards[i.toString(16).padStart(2, '0')] = {};
    let filled = 0, cards = 0, full = 0;
    for (const name of names) {
        const b = buckets.get(name);
        if (!b) continue;
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
        if (out.length === 0) continue;   // 0件はキャッシュせず D1 へ落とす
        shards[shardKey(name)][name] = out.slice(0, PER);
        filled++; cards += out.length;
        if (out.length >= PER) full++;
    }

    let bytes = 0, maxShard = 0;
    for (const base of [path.join(ROOT, 'data', 'lp', 'actress'), path.join(ROOT, 'public', 'data', 'lp', 'actress')]) {
        fs.mkdirSync(base, { recursive: true });
        for (const [nn, obj] of Object.entries(shards)) {
            const json = JSON.stringify(obj);
            fs.writeFileSync(path.join(base, `${nn}.json`), json);
            if (base.includes(path.join('public', 'data'))) continue;
            bytes += json.length;
            maxShard = Math.max(maxShard, json.length);
        }
    }
    console.log(`[actress] ${filled.toLocaleString()} / ${names.length.toLocaleString()}人を収録`
        + `（上限${PER}件に達した人 ${full.toLocaleString()} / カード計 ${cards.toLocaleString()}）`);
    console.log(`[actress] ${(bytes / 1024 / 1024).toFixed(2)}MB / 最大シャード ${(maxShard / 1024 / 1024).toFixed(2)}MB`);
}

// テストからは関数だけ import したいので、直接実行のときだけ走らせる
if (process.argv[1]?.endsWith('build_actress_cache.mjs')) {
    main();
}
