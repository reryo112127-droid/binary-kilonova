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
import { createClient } from '@libsql/client';

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

const mgs   = createClient({ url: 'file:' + path.join(DATA, 'mgs.db') });
const fanza = createClient({ url: 'file:' + path.join(DATA, 'fanza.db') });

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

    // --all で全商品(ローカルDB全件)、引数なしで静的キャッシュ掲載の主要商品のみ
    const allMode = process.argv.includes('--all');
    let ids;
    if (allMode) {
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

    // /api/admin/r2-populate へ500件ずつPOST
    const url = `${SITE_URL}/api/admin/r2-populate`;
    let saved = 0;
    for (let i = 0; i < items.length; i += 200) {
        const chunk = items.slice(i, i + 200);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
                body: JSON.stringify({ items: chunk }),
            });
            const j = await res.json();
            saved += (j.saved || 0);
            console.log(`  投入 ${i + chunk.length}/${items.length} (saved累計: ${saved})`);
        } catch (e) {
            console.error('  POST失敗:', e.message);
        }
    }
    console.log(`完了: R2投入 ${saved}件`);
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
