/**
 * バックフィル: sale_start_date が NULL の MGS 作品を詳細ページから補完する
 *
 * 使い方:
 *   node scripts/backfill_mgs_sale_date.js
 *   node scripts/backfill_mgs_sale_date.js --limit 200   # 一度に処理する件数
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createClient } = require('@libsql/client');
const { fetchPage, politeWait, buildDetailUrl } = require('../lib/fetcher');
const { parseDetailPage } = require('../lib/parser');

const _args = process.argv.slice(2);
const _limitIdx = _args.indexOf('--limit');
const LIMIT = _limitIdx !== -1 ? parseInt(_args[_limitIdx + 1], 10) : 2200;

async function main() {
    const tursoUrl   = process.env.TURSO_MGS_URL;
    const tursoToken = process.env.TURSO_MGS_TOKEN;
    if (!tursoUrl || !tursoToken) {
        console.error('TURSO_MGS_URL/TOKEN が未設定');
        process.exit(1);
    }

    const turso = createClient({ url: tursoUrl, authToken: tursoToken });

    // NULL日付の作品を取得
    const res = await turso.execute({
        sql: 'SELECT product_id, title, scraped_at FROM products WHERE sale_start_date IS NULL ORDER BY scraped_at DESC LIMIT ?',
        args: [LIMIT],
    });
    const rows = res.rows;
    console.log(`NULL日付の作品: ${rows.length}件 (最大 ${LIMIT}件)`);

    let updated = 0;
    let failed  = 0;
    let skipped = 0;

    for (let i = 0; i < rows.length; i++) {
        const { product_id, title } = rows[i];
        process.stdout.write(`[${i + 1}/${rows.length}] ${product_id} ... `);
        try {
            await politeWait();
            const html   = await fetchPage(buildDetailUrl(product_id));
            const detail = parseDetailPage(html);

            if (!detail.sale_start_date) {
                console.log(`スキップ (詳細ページにも日付なし)`);
                skipped++;
                continue;
            }

            await turso.execute({
                sql: `UPDATE products SET
                    sale_start_date = ?,
                    genres          = COALESCE(genres, ?),
                    actresses       = COALESCE(actresses, ?),
                    maker           = COALESCE(maker, ?),
                    label           = COALESCE(label, ?),
                    duration_min    = COALESCE(duration_min, ?)
                  WHERE product_id = ?`,
                args: [
                    detail.sale_start_date,
                    detail.genres          || null,
                    detail.actresses       || null,
                    detail.maker           || null,
                    detail.label           || null,
                    detail.duration_min    || null,
                    product_id,
                ],
            });
            console.log(`✅ ${detail.sale_start_date}`);
            updated++;
        } catch (e) {
            console.log(`❌ ${e.message}`);
            failed++;
        }

        // 100件ごとに進捗表示
        if ((i + 1) % 100 === 0) {
            console.log(`\n--- 進捗: ${updated}件更新 / ${skipped}件スキップ / ${failed}件失敗 ---\n`);
        }
    }

    turso.close();
    console.log('\n========================================');
    console.log(`  完了: ${updated}件更新 / ${skipped}件スキップ / ${failed}件失敗`);
    console.log('========================================');
}

main().catch(e => { console.error(e); process.exit(1); });
