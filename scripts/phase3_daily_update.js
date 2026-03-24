/**
 * フェーズ3: 日次アップデート（差分取得）
 *
 * 新着順で検索一覧ページを巡回し、
 * DBに未登録の新規作品だけを追加する。
 * 既知の作品IDが一定数見つかったら終了する。
 * 更新後は Turso にも同期する。
 *
 * 使い方:
 *   node scripts/phase3_daily_update.js
 */
const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createClient } = require('@libsql/client');
const db = require('../db/database');
const { fetchPage, politeWait, buildSearchUrl, buildDetailUrl } = require('../lib/fetcher');
const { parseSearchPage, parseDetailPage } = require('../lib/parser');

const ACTRESS_INDEX_FILE = path.join(__dirname, '..', 'data', 'mgs_actress_index.json');

const IS_CI = !!process.env.CI;

// STEP2: 直近何ページ分の価格を毎日更新するか（1ページ=120件、30ページ=3600件）
const PRICE_REFRESH_PAGES = 30;

const MGS_COLUMNS = [
    'product_id','title','actresses','maker','label','duration_min',
    'genres','sale_start_date','main_image_url','sample_images_json',
    'sample_video_url','detail_scraped','scraped_at','updated_at',
    'list_price','current_price','discount_pct','sale_end_date','price_updated_at',
];

async function tursoUpsertBatch(turso, rows) {
    const placeholders = MGS_COLUMNS.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO products (${MGS_COLUMNS.join(', ')}) VALUES (${placeholders})`;
    const BATCH = 50;
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        try {
            await turso.batch(
                batch.map(row => ({ sql, args: MGS_COLUMNS.map(c => row[c] ?? null) })),
                'write'
            );
        } catch {
            for (const row of batch) {
                try {
                    await turso.execute({ sql, args: MGS_COLUMNS.map(c => row[c] ?? null) });
                } catch (e2) {
                    console.error(`  [スキップ] ${row.product_id}: ${e2.message}`);
                }
            }
        }
    }
}

const ITEMS_PER_PAGE = 120;
const KNOWN_THRESHOLD = 60; // 既知IDがこの数見つかったら終了（半ページ分）

// ============================================================
//  STEP 2: 価格更新（直近 PRICE_REFRESH_PAGES ページ分）
// ============================================================
async function buildPriceMap(pages) {
    const priceMap = new Map();
    for (let p = 1; p <= pages; p++) {
        const url = buildSearchUrl(p, ITEMS_PER_PAGE);
        try {
            const html = await fetchPage(url);
            const { products } = parseSearchPage(html);
            if (products.length === 0) break;
            const now = new Date().toISOString();
            for (const product of products) {
                priceMap.set(product.product_id, {
                    list_price:      product.list_price,
                    current_price:   product.current_price,
                    discount_pct:    product.discount_pct,
                    sale_end_date:   product.sale_end_date,
                    price_updated_at: now,
                });
            }
            process.stdout.write(`  価格取得: ${p}/${pages}ページ (${priceMap.size}件)\r`);
            if (p < pages) await politeWait();
        } catch (e) {
            console.warn(`\n  [価格更新] ページ${p}エラー: ${e.message}`);
            break;
        }
    }
    console.log(`\n  価格取得完了: ${priceMap.size.toLocaleString()}件`);
    return priceMap;
}

async function main() {
    // ---- Turso スキーママイグレーション（価格カラム、冪等） ----
    {
        const _url   = process.env.TURSO_MGS_URL;
        const _token = process.env.TURSO_MGS_TOKEN;
        if (_url && _token) {
            const _turso = createClient({ url: _url, authToken: _token });
            for (const sql of [
                'ALTER TABLE products ADD COLUMN list_price INTEGER',
                'ALTER TABLE products ADD COLUMN current_price INTEGER',
                'ALTER TABLE products ADD COLUMN discount_pct INTEGER DEFAULT 0',
                'ALTER TABLE products ADD COLUMN sale_end_date TEXT',
                'ALTER TABLE products ADD COLUMN price_updated_at TEXT',
            ]) {
                try { await _turso.execute(sql); } catch {} // 既存カラムは無視
            }
            _turso.close();
        }
    }

    // ---- CI環境: Tursoから既知IDを取得（ローカルDB代替） ----
    let knownIds   = new Set();
    let tursoShared = null; // CI用に事前作成したTursoクライアント

    if (IS_CI) {
        const tursoUrl   = process.env.TURSO_MGS_URL;
        const tursoToken = process.env.TURSO_MGS_TOKEN;
        if (!tursoUrl || !tursoToken) {
            console.error('CI環境では TURSO_MGS_URL / TURSO_MGS_TOKEN が必要です');
            process.exit(1);
        }
        tursoShared = createClient({ url: tursoUrl, authToken: tursoToken });
        const r = await tursoShared.execute(
            'SELECT product_id FROM products ORDER BY scraped_at DESC LIMIT 3000'
        );
        r.rows.forEach(row => knownIds.add(String(row[0])));
        console.log(`[CI] Tursoから既知ID ${knownIds.size}件取得`);
    } else {
        await db.init();
    }

    // ---- 女優インデックス読み込み ----
    const actressIndex = fs.existsSync(ACTRESS_INDEX_FILE)
        ? JSON.parse(fs.readFileSync(ACTRESS_INDEX_FILE, 'utf-8'))
        : {};
    // 今日の出演記録: 女優名 → 品番リスト
    const todayAppearances = new Map(); // name → [product_id, ...]

    console.log('========================================');
    console.log('  MGS動画 フェーズ3: 日次アップデート');
    console.log('========================================\n');

    const statsBefore = IS_CI ? { total: knownIds.size } : db.getStats();
    console.log(`  現在のDB件数: ${statsBefore.total.toLocaleString()}\n`);

    let currentPage = 1;
    let totalNew = 0;
    let totalKnown = 0;
    let consecutiveKnown = 0;
    const startTime = Date.now();
    const newProducts = []; // Turso同期用

    try {
        while (true) {
            const url = buildSearchUrl(currentPage, ITEMS_PER_PAGE);
            console.log(`[ページ ${currentPage}] 新着チェック...`);

            const html = await fetchPage(url);
            const { products } = parseSearchPage(html);

            if (products.length === 0) {
                console.log('  [終了] 商品なし');
                break;
            }

            let pageNew = 0;
            let pageKnown = 0;

            for (const product of products) {
                const exists = IS_CI
                    ? knownIds.has(String(product.product_id))
                    : db.productExists(product.product_id);

                if (exists) {
                    pageKnown++;
                    consecutiveKnown++;
                } else {
                    // 新規作品！
                    if (!IS_CI) db.upsertProductFromList(product);
                    knownIds.add(String(product.product_id)); // 重複防止
                    pageNew++;
                    consecutiveKnown = 0;

                    // 新規作品は即座に詳細ページもスクレイピング
                    const now = new Date().toISOString();
                    const productRow = {
                        product_id:         product.product_id,
                        title:              product.title || null,
                        actresses:          product.actresses || null,
                        maker:              null,
                        label:              null,
                        duration_min:       null,
                        genres:             null,
                        sale_start_date:    null,
                        main_image_url:     product.main_image_url || null,
                        sample_images_json: product.sample_images ? JSON.stringify(product.sample_images) : null,
                        sample_video_url:   product.sample_video_url || null,
                        detail_scraped:     0,
                        scraped_at:         now,
                        updated_at:         now,
                        // 一覧ページから取得した価格
                        list_price:         product.list_price ?? null,
                        current_price:      product.current_price ?? null,
                        discount_pct:       product.discount_pct ?? 0,
                        sale_end_date:      product.sale_end_date ?? null,
                        price_updated_at:   now,
                    };
                    try {
                        await politeWait();
                        const detailHtml = await fetchPage(buildDetailUrl(product.product_id));
                        const detail = parseDetailPage(detailHtml);
                        if (!IS_CI) db.updateProductDetail(product.product_id, detail);
                        productRow.maker         = detail.maker || null;
                        productRow.label         = detail.label || null;
                        productRow.duration_min  = detail.duration_min || null;
                        productRow.detail_scraped = 1;
                        // 詳細ページの価格で上書き（より正確）
                        if (detail.list_price != null)    productRow.list_price    = detail.list_price;
                        if (detail.current_price != null) productRow.current_price = detail.current_price;
                        if (detail.discount_pct  != null) productRow.discount_pct  = detail.discount_pct;
                        if (detail.sale_end_date)          productRow.sale_end_date  = detail.sale_end_date;
                        // 女優インデックス更新（詳細ページの actress_links を優先）
                        const links = detail.actress_links?.length ? detail.actress_links : (product.actress_links || []);
                        const today = new Date().toISOString().slice(0, 10);
                        for (const { name, mgs_id } of links) {
                            if (!actressIndex[name]) {
                                actressIndex[name] = { mgs_id, mgs_url: `https://www.mgstage.com/search/cSearch.php?type=top&actor[]=${encodeURIComponent(mgs_id)}`, first_seen: today, last_seen: today };
                            } else {
                                actressIndex[name].last_seen = today;
                                if (mgs_id) actressIndex[name].mgs_id = mgs_id;
                            }
                            if (!todayAppearances.has(name)) todayAppearances.set(name, []);
                            todayAppearances.get(name).push(product.product_id);
                        }
                        console.log(`    [新規+詳細] ${product.product_id}: ${detail.maker || '?'} / ${detail.duration_min || '?'}分${detail.discount_pct > 0 ? ` / ${detail.discount_pct}%OFF` : ''}`);
                    } catch (e) {
                        console.log(`    [新規] ${product.product_id} (詳細取得失敗: ${e.message})`);
                    }
                    newProducts.push(productRow);
                }
            }

            totalNew += pageNew;
            totalKnown += pageKnown;

            console.log(`  新規: ${pageNew}件 / 既知: ${pageKnown}件`);

            // 終了条件: 既知IDが十分見つかった（古いデータ領域に入った）
            if (consecutiveKnown >= KNOWN_THRESHOLD) {
                console.log(`\n[完了] ${consecutiveKnown}件連続で既知ID → 差分取得完了`);
                break;
            }

            if (!IS_CI) db.save();
            currentPage++;
            await politeWait();
        }
    } catch (error) {
        console.error(`\n[エラー] ${error.message}`);
    } finally {
        if (!IS_CI) db.save();

        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        const statsAfter = IS_CI
            ? { total: statsBefore.total + totalNew }
            : db.getStats();

        console.log('\n========================================');
        console.log('  フェーズ3 STEP1 サマリー');
        console.log('========================================');
        console.log(`  新規追加: ${totalNew}件`);
        console.log(`  既知スキップ: ${totalKnown}件`);
        console.log(`  経過時間: ${elapsed}分`);
        console.log(`  DB件数: ${statsBefore.total.toLocaleString()} → ${statsAfter.total.toLocaleString()}`);
        console.log('========================================\n');

        // ---- 女優インデックス保存・レポート ----
        if (todayAppearances.size > 0) {
            if (!IS_CI) {
                fs.writeFileSync(ACTRESS_INDEX_FILE, JSON.stringify(actressIndex, null, 2));
            }
            console.log(`[女優] 今日の新作出演: ${todayAppearances.size}名`);
            for (const [name, products] of [...todayAppearances.entries()].sort((a, b) => b[1].length - a[1].length)) {
                console.log(`  ${name}: ${products.join(', ')}`);
            }
            console.log(`  インデックス累計: ${Object.keys(actressIndex).length.toLocaleString()}名\n`);
        } else {
            console.log('[女優] 今日の新作なし\n');
        }

        // ---- STEP 2: 価格更新 ----
        let priceMap = new Map();
        let saleCount = 0;
        try {
            console.log(`[STEP 2] 価格更新: 直近${PRICE_REFRESH_PAGES}ページ (${PRICE_REFRESH_PAGES * ITEMS_PER_PAGE}件)`);
            priceMap = await buildPriceMap(PRICE_REFRESH_PAGES);
            for (const v of priceMap.values()) {
                if (v.discount_pct > 0) saleCount++;
            }
            console.log(`  セール中: ${saleCount.toLocaleString()}件`);

            if (!IS_CI && priceMap.size > 0) {
                for (const [product_id, price] of priceMap) {
                    db.updateProductPrice(product_id, price);
                }
                db.save();
                console.log(`  ローカルDB 価格更新完了`);
            }
        } catch (e) {
            console.warn('[STEP 2] 価格更新エラー:', e.message);
        }

        // ---- Turso 同期 ----
        const tursoUrl   = process.env.TURSO_MGS_URL;
        const tursoToken = process.env.TURSO_MGS_TOKEN;

        if (newProducts.length === 0 && priceMap.size === 0) {
            console.log('[Turso] 更新なし — スキップ');
        } else if (!tursoUrl || !tursoToken) {
            console.warn('[Turso] TURSO_MGS_URL/TOKEN 未設定 — スキップ');
        } else {
            const turso = tursoShared || createClient({ url: tursoUrl, authToken: tursoToken });
            // 新規作品 upsert
            if (newProducts.length > 0) {
                console.log(`[Turso] 新規${newProducts.length}件 同期中...`);
                try {
                    await tursoUpsertBatch(turso, newProducts);
                    console.log(`[Turso] ✅ 新規${newProducts.length}件 同期完了`);
                } catch (e) {
                    console.error('[Turso] 新規同期エラー:', e.message);
                }
            }
            // 価格 update（既存作品はUPDATE）
            if (priceMap.size > 0) {
                const updateSql = `UPDATE products SET
                    list_price=?, current_price=?, discount_pct=?, sale_end_date=?, price_updated_at=?, updated_at=?
                    WHERE product_id=?`;
                const entries = Array.from(priceMap.entries());
                const BATCH = 50;
                let tUpdated = 0;
                for (let i = 0; i < entries.length; i += BATCH) {
                    const batch = entries.slice(i, i + BATCH);
                    try {
                        await turso.batch(
                            batch.map(([pid, v]) => ({
                                sql: updateSql,
                                args: [v.list_price, v.current_price, v.discount_pct, v.sale_end_date, v.price_updated_at, v.price_updated_at, pid],
                            })),
                            'write'
                        );
                        tUpdated += batch.length;
                    } catch {
                        for (const [pid, v] of batch) {
                            try {
                                await turso.execute({ sql: updateSql, args: [v.list_price, v.current_price, v.discount_pct, v.sale_end_date, v.price_updated_at, v.price_updated_at, pid] });
                                tUpdated++;
                            } catch {}
                        }
                    }
                    process.stdout.write(`  価格Turso更新: ${tUpdated}/${entries.length}\r`);
                }
                console.log(`\n[Turso] ✅ 価格${tUpdated.toLocaleString()}件 更新完了`);
            }
            if (!tursoShared) turso.close();
        }

        if (tursoShared) { tursoShared.close(); tursoShared = null; }
        if (!IS_CI) db.close();

        console.log('\n========================================');
        console.log(`  ✅ 完了 (${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })})`);
        if (saleCount > 0) console.log(`  🏷️ セール中: ${saleCount}件`);
        console.log('========================================\n');
    }
}

main().catch((err) => {
    console.error('致命的エラー:', err);
    if (!IS_CI) db.close();
    process.exit(1);
});
