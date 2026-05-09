/**
 * MGS新作が止まった原因を診断するスクリプト
 * 使い方: node scripts/diagnose_mgs_gap.js
 */
const { createClient } = require('@libsql/client');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', 'site', '.env.local') });

async function main() {
    const url   = process.env.TURSO_MGS_URL;
    const token = process.env.TURSO_MGS_TOKEN;
    if (!url || !token) { console.error('TURSO_MGS_URL/TOKEN 未設定'); process.exit(1); }

    const db = createClient({ url, authToken: token });

    // 1) 最後にscrapeされた日時
    const lastScrape = await db.execute(
        "SELECT MAX(scraped_at) as last FROM products"
    );
    console.log('最終scraped_at:', lastScrape.rows[0].last);

    // 2) 5月4日以降にscrapeされた件数
    const recentScrape = await db.execute(
        "SELECT COUNT(*) as cnt FROM products WHERE scraped_at >= '2026-05-04'"
    );
    console.log('2026-05-04以降にscrapeされた件数:', recentScrape.rows[0].cnt);

    // 3) sale_start_date が 2026/05/05 以降の作品（5月4日以前にDBに入っている可能性）
    const futureSales = await db.execute(
        `SELECT product_id, title, sale_start_date, scraped_at
         FROM products
         WHERE REPLACE(sale_start_date,'/','-') >= '2026-05-05'
         ORDER BY REPLACE(sale_start_date,'/','-') DESC
         LIMIT 20`
    );
    console.log('\n--- sale_start_date が 2026-05-05 以降の作品 ---');
    if (futureSales.rows.length === 0) {
        console.log('  (なし) → 5月5日以降の作品がDBに存在しない');
    } else {
        for (const r of futureSales.rows) {
            console.log(`  ${r.product_id}  発売:${r.sale_start_date}  scrape:${String(r.scraped_at).slice(0,10)}  ${String(r.title).slice(0,30)}`);
        }
    }

    // 4) scraped_at が 2026-05-04 で sale_start_date が 5月5日以降のもの
    const preorders = await db.execute(
        `SELECT COUNT(*) as cnt FROM products
         WHERE scraped_at >= '2026-05-04' AND scraped_at < '2026-05-05'
         AND REPLACE(sale_start_date,'/','-') >= '2026-05-05'`
    );
    console.log('\n5月4日にscrapeされ、発売日が5月5日以降の件数（予約作品）:', preorders.rows[0].cnt);

    // 5) 直近の発売日ごとの件数（発売状況確認）
    const salesByDate = await db.execute(
        `SELECT REPLACE(sale_start_date,'/','-') as date, COUNT(*) as cnt
         FROM products
         WHERE REPLACE(sale_start_date,'/','-') >= '2026-04-28'
         GROUP BY date
         ORDER BY date DESC
         LIMIT 15`
    );
    console.log('\n--- 直近の発売日別件数 ---');
    for (const r of salesByDate.rows) {
        console.log(`  ${r.date}: ${r.cnt}件`);
    }

    // 6) 最新30件のproduct_id + scraped_at
    const latest = await db.execute(
        `SELECT product_id, sale_start_date, scraped_at FROM products
         ORDER BY scraped_at DESC LIMIT 10`
    );
    console.log('\n--- 最新10件（scraped_at順） ---');
    for (const r of latest.rows) {
        console.log(`  ${r.product_id}  発売:${r.sale_start_date}  scrape:${String(r.scraped_at).slice(0,19)}`);
    }

    db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
