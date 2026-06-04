/**
 * Tursoに不足インデックスを適用するスクリプト
 *
 * 実行:
 *   node scripts/apply_indexes.js mgs
 *   node scripts/apply_indexes.js fanza
 *   node scripts/apply_indexes.js all
 */
const { createClient } = require('@libsql/client');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', 'site', '.env.local') });

const target = process.argv[2] || 'all';

const MGS_INDEXES = [
    // ランキング・人気順ソート用
    `CREATE INDEX IF NOT EXISTS idx_wish_count ON products(wish_count DESC)`,
    // 新着ソート・日付フィルター用（REPLACE関数インデックスでフルスキャン回避）
    `CREATE INDEX IF NOT EXISTS idx_sale_date_norm ON products(REPLACE(sale_start_date, '/', '-') DESC)`,
    // サンプル動画フィルター用（WHERE部分インデックス）
    `CREATE INDEX IF NOT EXISTS idx_sample_video ON products(sample_video_url) WHERE sample_video_url IS NOT NULL`,
    // similar API: maker完全一致 + wish_count降順（商品詳細ページで毎回発生）
    `CREATE INDEX IF NOT EXISTS idx_maker_wish ON products(maker, wish_count DESC)`,
];

const FANZA_INDEXES = [
    // 配信日ソート（既存インデックスをDESC順に再作成）
    `CREATE INDEX IF NOT EXISTS idx_sale_date_desc ON products(sale_start_date DESC)`,
    // ランキングクエリ用
    `CREATE INDEX IF NOT EXISTS idx_review_count ON products(review_count DESC)`,
    // サンプル動画フィルター用
    `CREATE INDEX IF NOT EXISTS idx_sample_video ON products(sample_video_url) WHERE sample_video_url IS NOT NULL`,
    // similar API: maker完全一致 + 新着順（FANZAはwish_countカラムなし）
    `CREATE INDEX IF NOT EXISTS idx_maker_date ON products(maker, sale_start_date DESC)`,
    // セールソート・セールフィルター用（discount_pct > 0 の部分インデックス）
    `CREATE INDEX IF NOT EXISTS idx_discount_pct ON products(discount_pct DESC) WHERE discount_pct > 0`,
    // VRフィルター用（部分インデックス）
    `CREATE INDEX IF NOT EXISTS idx_vr_flag ON products(vr_flag) WHERE vr_flag = 1`,
    // メーカー一覧キャッシュ生成 GROUP BY maker + floor カバリングインデックス
    `CREATE INDEX IF NOT EXISTS idx_maker_floor ON products(maker, floor)`,
    // excludeBest: duration_min <= 200 フィルター高速化
    `CREATE INDEX IF NOT EXISTS idx_duration_min ON products(duration_min)`,
];

async function applyIndexes(label, url, token, indexes) {
    if (!url || !token) {
        console.error(`[${label}] 環境変数が未設定 (URL=${url ? '✓' : '✗'}, TOKEN=${token ? '✓' : '✗'})`);
        return;
    }

    const client = createClient({ url, authToken: token });
    console.log(`\n[${label}] インデックス適用開始...`);

    for (const sql of indexes) {
        try {
            await client.execute(sql);
            const name = sql.match(/idx_\w+/)?.[0] ?? sql.slice(0, 60);
            console.log(`  ✓ ${name}`);
        } catch (err) {
            console.error(`  ✗ エラー: ${err.message}`);
            console.error(`    SQL: ${sql.slice(0, 80)}...`);
        }
    }

    // EXPLAIN QUERY PLAN で重要クエリを確認
    console.log(`\n[${label}] クエリプラン確認:`);
    const checkQueries = label === 'MGS'
        ? [
            { label: 'wish_count ORDER BY', sql: `EXPLAIN QUERY PLAN SELECT product_id FROM products ORDER BY wish_count DESC LIMIT 100` },
            { label: 'sale_start_date ORDER BY', sql: `EXPLAIN QUERY PLAN SELECT product_id FROM products WHERE REPLACE(sale_start_date,'/','-') <= '2026-05-07' ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT 20` },
            { label: 'maker + wish_count (similar)', sql: `EXPLAIN QUERY PLAN SELECT product_id FROM products WHERE maker = 'SODクリエイト' ORDER BY wish_count DESC LIMIT 40` },
          ]
        : [
            { label: 'review_count ORDER BY', sql: `EXPLAIN QUERY PLAN SELECT product_id FROM products ORDER BY review_count DESC LIMIT 100` },
            { label: 'sale_start_date ORDER BY', sql: `EXPLAIN QUERY PLAN SELECT product_id FROM products ORDER BY sale_start_date DESC LIMIT 20` },
            { label: 'maker + sale_start_date (similar)', sql: `EXPLAIN QUERY PLAN SELECT product_id FROM products WHERE maker = 'SODクリエイト' ORDER BY sale_start_date DESC LIMIT 40` },
            { label: 'discount_pct ORDER BY', sql: `EXPLAIN QUERY PLAN SELECT product_id FROM products WHERE discount_pct > 0 ORDER BY discount_pct DESC LIMIT 20` },
            { label: 'vr_flag filter', sql: `EXPLAIN QUERY PLAN SELECT product_id FROM products WHERE vr_flag = 1 ORDER BY sale_start_date DESC LIMIT 20` },
          ];

    for (const q of checkQueries) {
        try {
            const res = await client.execute(q.sql);
            const plan = res.rows.map(r => Object.values(r).join(' | ')).join('\n    ');
            const hasFullScan = plan.includes('SCAN');
            const icon = hasFullScan ? '⚠ FULL SCAN' : '✓ INDEX使用';
            console.log(`  ${icon} [${q.label}]\n    ${plan}`);
        } catch (err) {
            console.error(`  プラン確認失敗: ${err.message}`);
        }
    }
}

(async () => {
    if (target === 'mgs' || target === 'all') {
        await applyIndexes('MGS',
            process.env.TURSO_MGS_URL,
            process.env.TURSO_MGS_TOKEN,
            MGS_INDEXES
        );
    }
    if (target === 'fanza' || target === 'all') {
        await applyIndexes('FANZA',
            process.env.TURSO_FANZA_URL,
            process.env.TURSO_FANZA_TOKEN,
            FANZA_INDEXES
        );
    }
    console.log('\n完了');
})();
