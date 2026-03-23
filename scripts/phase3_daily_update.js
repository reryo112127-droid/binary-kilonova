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
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createClient } = require('@libsql/client');
const db = require('../db/database');
const { fetchPage, politeWait, buildSearchUrl, buildDetailUrl } = require('../lib/fetcher');
const { parseSearchPage, parseDetailPage } = require('../lib/parser');

const IS_CI = !!process.env.CI;

const MGS_COLUMNS = [
    'product_id','title','actresses','maker','label','duration_min',
    'genres','sale_start_date','main_image_url','sample_images_json',
    'sample_video_url','detail_scraped','scraped_at','updated_at',
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

async function main() {
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
                        console.log(`    [新規+詳細] ${product.product_id}: ${detail.maker || '?'} / ${detail.duration_min || '?'}分`);
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
        console.log('  フェーズ3 サマリー');
        console.log('========================================');
        console.log(`  新規追加: ${totalNew}件`);
        console.log(`  既知スキップ: ${totalKnown}件`);
        console.log(`  経過時間: ${elapsed}分`);
        console.log(`  DB件数: ${statsBefore.total.toLocaleString()} → ${statsAfter.total.toLocaleString()}`);
        console.log('========================================\n');

        // ---- Turso 同期 ----
        const tursoUrl   = process.env.TURSO_MGS_URL;
        const tursoToken = process.env.TURSO_MGS_TOKEN;

        if (newProducts.length === 0) {
            console.log('[Turso] 新規なし — スキップ');
        } else if (!tursoUrl || !tursoToken) {
            console.warn('[Turso] TURSO_MGS_URL/TOKEN 未設定 — スキップ');
        } else {
            console.log(`[Turso] ${newProducts.length}件 同期中...`);
            try {
                const turso = tursoShared || createClient({ url: tursoUrl, authToken: tursoToken });
                await tursoUpsertBatch(turso, newProducts);
                if (!tursoShared) turso.close();
                console.log(`[Turso] ✅ ${newProducts.length}件 同期完了`);
            } catch (e) {
                console.error('[Turso] 同期エラー:', e.message);
            }
        }

        if (tursoShared) { tursoShared.close(); tursoShared = null; }
        if (!IS_CI) db.close();
    }
}

main().catch((err) => {
    console.error('致命的エラー:', err);
    if (!IS_CI) db.close();
    process.exit(1);
});
