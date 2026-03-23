/**
 * FANZA → Turso 再開スクリプト
 * better-sqlite3を使ってメモリを節約し、INSERT OR IGNOREで重複スキップして再開
 *
 * 実行: node scripts/resume_fanza_turso.js
 */
const path = require('path');
const Database = require('better-sqlite3');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DB_PATH = path.join(__dirname, '..', 'data', 'fanza.db');
const BATCH_SIZE = 50;

async function main() {
    const url = process.env.TURSO_FANZA_URL;
    const token = process.env.TURSO_FANZA_TOKEN;

    if (!url || !token) {
        console.error('❌ TURSO_FANZA_URL / TURSO_FANZA_TOKEN が未設定');
        process.exit(1);
    }

    console.log('========================================');
    console.log('  FANZA → Turso 再開移行');
    console.log('========================================\n');

    // Turso接続・現在のカウント確認
    const turso = createClient({ url, authToken: token });

    // スキーマが無ければ作成
    await turso.execute(`CREATE TABLE IF NOT EXISTS products (
        product_id TEXT PRIMARY KEY,
        title TEXT,
        actresses TEXT,
        maker TEXT,
        label TEXT,
        duration_min INTEGER,
        genres TEXT,
        sale_start_date TEXT,
        main_image_url TEXT,
        sample_images_json TEXT,
        sample_video_url TEXT,
        affiliate_url TEXT,
        detail_url TEXT,
        scraped_at TEXT,
        updated_at TEXT
    )`);
    await turso.execute('CREATE INDEX IF NOT EXISTS idx_sale_date ON products(sale_start_date)');
    await turso.execute('CREATE INDEX IF NOT EXISTS idx_maker ON products(maker)');
    await turso.execute('CREATE INDEX IF NOT EXISTS idx_label ON products(label)');

    const countResult = await turso.execute('SELECT COUNT(*) as cnt FROM products');
    const tursoCount = Number(countResult.rows[0].cnt);
    console.log(`Turso現在のレコード数: ${tursoCount.toLocaleString()} 件`);

    // ローカルDB（better-sqlite3 = メモリに全部載せない）
    console.log('\nローカルDB接続中...');
    const localDb = new Database(DB_PATH, { readonly: true });
    const totalRow = localDb.prepare('SELECT COUNT(*) as cnt FROM products').get();
    const total = totalRow.cnt;
    console.log(`ローカル総件数: ${total.toLocaleString()} 件`);
    console.log(`残り: ${(total - tursoCount).toLocaleString()} 件\n`);

    if (tursoCount >= total) {
        console.log('✅ すでに全件移行済みです');
        localDb.close();
        turso.close();
        return;
    }

    // OFFSETで続きから取得
    const columns = [
        'product_id','title','actresses','maker','label','duration_min',
        'genres','sale_start_date','main_image_url','sample_images_json',
        'sample_video_url','affiliate_url','detail_url','scraped_at','updated_at'
    ];
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT OR IGNORE INTO products (${columns.join(', ')}) VALUES (${placeholders})`;

    const stmt = localDb.prepare(`SELECT ${columns.join(', ')} FROM products LIMIT ? OFFSET ?`);

    let inserted = 0;
    let offset = tursoCount;
    const startTime = Date.now();

    console.log(`[移行開始] offset=${offset.toLocaleString()} から再開...\n`);

    while (offset < total) {
        const rows = stmt.all(BATCH_SIZE, offset);
        if (rows.length === 0) break;

        const statements = rows.map(row => ({
            sql: insertSql,
            args: columns.map(col => row[col] ?? null),
        }));

        try {
            await turso.batch(statements, 'write');
            inserted += rows.length;
        } catch (err) {
            // 個別挿入にフォールバック
            for (const row of rows) {
                try {
                    await turso.execute({ sql: insertSql, args: columns.map(col => row[col] ?? null) });
                    inserted++;
                } catch (e2) {
                    console.error(`\n  [スキップ] ${row.product_id}: ${e2.message}`);
                }
            }
        }

        offset += rows.length;

        const elapsed = Math.max(1, (Date.now() - startTime) / 1000);
        const rate = (inserted / elapsed).toFixed(0);
        const pct = ((tursoCount + inserted) / total * 100).toFixed(1);
        process.stdout.write(
            `  ${(tursoCount + inserted).toLocaleString()} / ${total.toLocaleString()} (${pct}%) ${rate}件/秒  \r`
        );
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n\n✅ ${inserted.toLocaleString()} 件追加完了 (${elapsed}秒)`);

    const finalCount = await turso.execute('SELECT COUNT(*) as cnt FROM products');
    console.log(`Turso最終確認: ${Number(finalCount.rows[0].cnt).toLocaleString()} 件`);

    localDb.close();
    turso.close();
    console.log('\n========================================\n');
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
