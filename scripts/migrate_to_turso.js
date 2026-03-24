/**
 * Turso移行スクリプト
 * ローカルSQLite (mgs.db / fanza.db) → Turso Cloud
 *
 * 実行:
 *   node scripts/migrate_to_turso.js mgs
 *   node scripts/migrate_to_turso.js fanza
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DB_TARGET = process.argv[2]; // 'mgs' or 'fanza'
if (!DB_TARGET || !['mgs', 'fanza'].includes(DB_TARGET)) {
    console.error('Usage: node migrate_to_turso.js [mgs|fanza]');
    process.exit(1);
}

const CONFIGS = {
    mgs: {
        dbPath: path.join(__dirname, '..', 'data', 'mgs.db'),
        url: process.env.TURSO_MGS_URL,
        token: process.env.TURSO_MGS_TOKEN,
        schema: `CREATE TABLE IF NOT EXISTS products (
            product_id TEXT PRIMARY KEY,
            title TEXT,
            actresses TEXT,
            maker TEXT,
            label TEXT,
            duration_min INTEGER,
            wish_count INTEGER,
            genres TEXT,
            sale_start_date TEXT,
            main_image_url TEXT,
            sample_images_json TEXT,
            sample_video_url TEXT,
            detail_scraped INTEGER DEFAULT 0,
            list_price INTEGER,
            current_price INTEGER,
            discount_pct INTEGER DEFAULT 0,
            sale_end_date TEXT,
            price_updated_at TEXT,
            scraped_at TEXT,
            updated_at TEXT,
            x_posted_at TEXT,
            x_posted_account TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sale_date ON products(sale_start_date);
        CREATE INDEX IF NOT EXISTS idx_wish ON products(wish_count);
        CREATE INDEX IF NOT EXISTS idx_maker ON products(maker);
        CREATE INDEX IF NOT EXISTS idx_discount ON products(discount_pct);`,
        // detail_scraped=1 のみ移行（サイト表示対象）
        query: 'SELECT * FROM products WHERE detail_scraped = 1',
    },
    fanza: {
        dbPath: path.join(__dirname, '..', 'data', 'fanza.db'),
        url: process.env.TURSO_FANZA_URL,
        token: process.env.TURSO_FANZA_TOKEN,
        schema: `CREATE TABLE IF NOT EXISTS products (
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
        );
        CREATE INDEX IF NOT EXISTS idx_sale_date ON products(sale_start_date);
        CREATE INDEX IF NOT EXISTS idx_maker ON products(maker);
        CREATE INDEX IF NOT EXISTS idx_label ON products(label);`,
        query: 'SELECT * FROM products',
    },
};

const BATCH_SIZE = 50; // Turso推奨バッチサイズ

async function main() {
    const config = CONFIGS[DB_TARGET];

    if (!config.url || !config.token) {
        console.error(`❌ 環境変数 TURSO_${DB_TARGET.toUpperCase()}_URL / TOKEN が未設定`);
        process.exit(1);
    }

    console.log('========================================');
    console.log(`  Turso移行: ${DB_TARGET.toUpperCase()}`);
    console.log('========================================\n');
    console.log(`  URL: ${config.url}`);

    // ローカルSQLite読み込み
    console.log('\n[1] ローカルDB読み込み...');
    const SQL = await initSqlJs();
    const localDb = new SQL.Database(fs.readFileSync(config.dbPath));
    const stmt = localDb.prepare(config.query);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    localDb.close();
    console.log(`  ${rows.length.toLocaleString()} 件読み込み完了`);

    // Turso接続
    const turso = createClient({ url: config.url, authToken: config.token });

    // スキーマ作成
    console.log('\n[2] スキーマ作成...');
    // 既存テーブルを削除して再作成
    await turso.execute('DROP TABLE IF EXISTS products');
    // 複数ステートメントをセミコロン分割して実行
    const schemaStmts = config.schema.split(';').map(s => s.trim()).filter(Boolean);
    for (const s of schemaStmts) {
        await turso.execute(s);
    }
    console.log('  スキーマ適用完了');

    // データ移行
    console.log(`\n[3] データ移行 (バッチサイズ: ${BATCH_SIZE})...\n`);
    const columns = Object.keys(rows[0]);
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT OR IGNORE INTO products (${columns.join(', ')}) VALUES (${placeholders})`;

    let inserted = 0;
    const startTime = Date.now();

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const statements = batch.map(row => ({
            sql: insertSql,
            args: columns.map(col => {
                const v = row[col];
                return v === undefined ? null : v;
            }),
        }));

        try {
            await turso.batch(statements, 'write');
            inserted += batch.length;
        } catch (err) {
            console.error(`  [エラー] batch ${i}-${i + BATCH_SIZE}: ${err.message}`);
            // 個別挿入にフォールバック
            for (const row of batch) {
                try {
                    await turso.execute({
                        sql: insertSql,
                        args: columns.map(col => row[col] ?? null),
                    });
                    inserted++;
                } catch (e2) {
                    console.error(`  [スキップ] ${row.product_id}: ${e2.message}`);
                }
            }
        }

        if (inserted % 5000 === 0 || inserted === rows.length) {
            const pct = (inserted / rows.length * 100).toFixed(1);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            const rate = (inserted / elapsed).toFixed(0);
            process.stdout.write(`  ${inserted.toLocaleString()} / ${rows.length.toLocaleString()} (${pct}%) ${rate}件/秒\r`);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n\n  ✅ ${inserted.toLocaleString()} 件移行完了 (${elapsed}秒)`);

    // 検証
    const result = await turso.execute('SELECT COUNT(*) as cnt FROM products');
    console.log(`  Turso確認: ${result.rows[0].cnt} 件`);

    turso.close();
    console.log('\n========================================\n');
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
