/**
 * ローカルDB(fanza.db/mgs.db)から商品詳細を生成し、R2に投入する。
 * Tursoブロック中でも新作等の商品詳細ページを表示できるようにする。
 * 使い方: node scripts/populate_r2_local.mjs
 *
 * 対象: 静的キャッシュ(新着/人気/ランキング/予約/セール/女優別商品)に載る product_id。
 *       = サイトでアクセスされる主要商品。/api/admin/r2-populate 経由でR2(product/{id}.json)へ。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openLocal } from '../../scripts/lib/localsqlite.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');         // site/
const DATA = path.join(ROOT, '..', 'data');      // binary-kilonova/data
const PUBDATA = path.join(ROOT, 'public', 'data');

const MGS_AFF_ID = 'C45KQ3NS85OYDAQRUA5YQUD8RH';
const AMATEUR_MAKER_PATTERNS = ['シロウト', 'ナンパ', '素人', 'ドキュメン', 'アマTV', 'ガチなま', 'ハメ撮り'];

const SITE_URL = 'https://avrankings.com';

// ADMIN_KEY を .env.local から読み込み
function loadAdminKey() {
    const p = path.join(ROOT, '.env.local');
    if (!fs.existsSync(p)) return null;
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
        const m = line.match(/^ADMIN_KEY=(.+)$/);
        if (m) return m[1].trim();
    }
    return null;
}

const mgs   = openLocal(path.join(DATA, 'mgs.db'));
const fanza = openLocal(path.join(DATA, 'fanza.db'));

function detectAmateur(maker, genres) {
    if (genres && genres.includes('素人')) return true;
    if (maker && AMATEUR_MAKER_PATTERNS.some(p => maker.includes(p))) return true;
    return false;
}

// 対象 product_id を静的キャッシュから収集
function collectProductIds() {
    const ids = new Set();
    const listFiles = ['products_new_cache.json', 'products_popular_cache.json',
        'ranking_default_cache.json', 'ranking_2026_cache.json',
        'home_preorder_cache.json', 'home_preorder_curated_cache.json', 'sale_cache.json'];
    for (const f of listFiles) {
        const p = path.join(PUBDATA, f);
        if (!fs.existsSync(p)) continue;
        try { JSON.parse(fs.readFileSync(p, 'utf-8')).forEach(x => x.product_id && ids.add(String(x.product_id))); } catch {}
    }
    // 女優別商品リスト（{name: [products]}）
    for (const f of ['actress_top_products.json', 'actress_extended_products.json']) {
        const p = path.join(PUBDATA, f);
        if (!fs.existsSync(p)) continue;
        try {
            const m = JSON.parse(fs.readFileSync(p, 'utf-8'));
            Object.values(m).forEach(arr => Array.isArray(arr) && arr.forEach(x => x.product_id && ids.add(String(x.product_id))));
        } catch {}
    }
    return [...ids];
}

// /api/product/[id] の responseData 相当を生成
function buildDetail(id, mgsRow, fanzaRow) {
    if (!mgsRow && !fanzaRow) return null;
    const primary = mgsRow ?? fanzaRow;
    const source = mgsRow ? 'mgs' : 'fanza';

    const mgsAff = mgsRow ? `${'https://www.mgstage.com/product/product_detail/'}${id}/?aff=${MGS_AFF_ID}` : null;
    const fanzaAff = fanzaRow ? (fanzaRow.affiliate_url ?? null) : null;

    const discountPct = Number(fanzaRow?.discount_pct ?? mgsRow?.discount_pct ?? 0);
    const listPrice   = fanzaRow?.list_price    ?? mgsRow?.list_price    ?? null;
    const currentPrice= fanzaRow?.current_price ?? mgsRow?.current_price ?? null;
    const saleEndDate = fanzaRow?.sale_end_date ?? mgsRow?.sale_end_date ?? null;

    const d = Number(primary.duration_min);
    const durationMin = (d && d > 1) ? d : null;

    const reviewAverage = Number(fanzaRow?.review_average ?? 0);
    const reviewCount   = Number(fanzaRow?.review_count   ?? 0);

    let sampleImages = [];
    try { if (primary.sample_images_json) sampleImages = JSON.parse(String(primary.sample_images_json)); } catch {}

    return {
        ...primary,
        duration_min: durationMin,
        source,
        affiliate_url: mgsAff ?? fanzaAff,
        mgs_affiliate_url: mgsAff,
        fanza_affiliate_url: fanzaAff,
        discount_pct: discountPct,
        list_price: listPrice,
        current_price: currentPrice,
        sale_end_date: saleEndDate,
        review_average: reviewAverage || null,
        review_count: reviewCount || null,
        actresses: (mgsRow?.actresses || fanzaRow?.actresses || null),
        is_amateur: detectAmateur(primary.maker ?? null, primary.genres ?? null),
        sample_images: sampleImages,
    };
}

async function main() {
    const adminKey = loadAdminKey();
    if (!adminKey) { console.error('ADMIN_KEY が .env.local に見つかりません'); process.exit(1); }

    const url = `${SITE_URL}/api/admin/r2-populate`;
    const POST_BATCH = 40, CONCURRENCY = 5;
    let loggedStatus = false;
    async function postOnce(chunk) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey }, body: JSON.stringify({ items: chunk }) });
                if (!res.ok) {
                    if (!loggedStatus) { loggedStatus = true; console.error(`  POST非OK status=${res.status}`); }
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                    continue;
                }
                const j = await res.json();
                return j.saved || 0;
            } catch (e) {
                if (!loggedStatus) { loggedStatus = true; console.error('  POST例外:', e.message); }
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            }
        }
        return 0;
    }
    async function postBatches(items) {
        let saved = 0;
        const batches = [];
        for (let i = 0; i < items.length; i += POST_BATCH) batches.push(items.slice(i, i + POST_BATCH));
        const queue = [...batches];
        async function worker() { while (queue.length) saved += await postOnce(queue.shift()); }
        await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
        return saved;
    }

    // FANZAモード: rowidページングでストリーミング投入（メモリ圧迫なし）
    if (process.argv.includes('--fanza')) {
        const READ_CHUNK = 3000;
        let lastRowid = 0, total = 0, saved = 0;
        while (true) {
            const rows = (await fanza.execute({ sql: 'SELECT rowid AS _rid, * FROM products WHERE rowid > ? ORDER BY rowid LIMIT ?', args: [lastRowid, READ_CHUNK] })).rows;
            if (rows.length === 0) break;
            lastRowid = Number(rows[rows.length - 1]._rid);
            const items = [];
            for (const r of rows) {
                delete r._rid;
                const data = buildDetail(String(r.product_id), null, r);
                if (data) items.push({ id: String(r.product_id), data });
            }
            saved += await postBatches(items);
            total += rows.length;
            console.log(`  FANZA投入 ${total}件 (saved累計 ${saved})`);
        }
        console.log(`完了: FANZA R2投入 ${saved}件`);
        process.exit(0);
    }

    // モード: --all (MGS+FANZA全件) / 既定(静的キャッシュ掲載分)
    // --all (MGS+FANZA全件) / 既定(静的キャッシュ掲載分)
    let ids;
    if (process.argv.includes('--all')) {
        const [mgsIds, fanzaIds] = await Promise.all([
            mgs.execute('SELECT product_id FROM products').then(r => r.rows.map(x => String(x.product_id))).catch(() => []),
            fanza.execute('SELECT product_id FROM products').then(r => r.rows.map(x => String(x.product_id))).catch(() => []),
        ]);
        ids = [...new Set([...mgsIds, ...fanzaIds])];
        console.log(`全件モード — 対象商品: ${ids.length}件`);
    } else {
        ids = collectProductIds();
        console.log(`主要商品モード — 対象商品: ${ids.length}件`);
    }

    const items = [];
    let notFound = 0;
    for (const id of ids) {
        const [mgsRow, fanzaRow] = await Promise.all([
            mgs.execute({ sql: 'SELECT * FROM products WHERE product_id = ? LIMIT 1', args: [id] }).then(r => r.rows[0] ?? null).catch(() => null),
            fanza.execute({ sql: 'SELECT * FROM products WHERE product_id = ? LIMIT 1', args: [id] }).then(r => r.rows[0] ?? null).catch(() => null),
        ]);
        const data = buildDetail(id, mgsRow, fanzaRow);
        if (data) items.push({ id, data });
        else notFound++;
    }
    console.log(`詳細生成: ${items.length}件 (DB未発見 ${notFound}件)`);
    const saved = await postBatches(items);
    console.log(`完了: R2投入 ${saved}件`);
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
