/**
 * FANZA フェーズ2: fanza.db 構築スクリプト
 *
 * fanza_products.jsonl → SQLite (fanza.db)
 *
 * 実行: node scripts/fanza_build_db.js
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const JSONL_FILE = path.join(DATA_DIR, 'fanza_products.jsonl');
const DB_PATH = path.join(DATA_DIR, 'fanza.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'fanza_schema.sql');

const BATCH_SIZE = 5000;

async function main() {
    console.log('========================================');
    console.log('  FANZA JSONL → SQLite DB 構築');
    console.log('========================================\n');

    if (!fs.existsSync(JSONL_FILE)) {
        console.error(`❌ ${JSONL_FILE} が見つかりません。先に fanza_phase1_fetch.js を実行してください。`);
        process.exit(1);
    }

    // JSONLを読み込み重複排除
    console.log('[ステップ1] JSONL読み込み・重複排除...\n');
    const productsMap = new Map();

    const rl = readline.createInterface({
        input: fs.createReadStream(JSONL_FILE),
        crlfDelay: Infinity,
    });

    let lineCount = 0;
    for await (const line of rl) {
        if (!line.trim()) continue;
        lineCount++;
        try {
            const p = JSON.parse(line);
            if (p.product_id && !productsMap.has(p.product_id)) {
                productsMap.set(p.product_id, p);
            }
        } catch (e) { /* skip malformed lines */ }
    }

    console.log(`  📄 総行数: ${lineCount.toLocaleString()}`);
    console.log(`  ✅ ユニーク品番: ${productsMap.size.toLocaleString()}\n`);

    // DB構築
    console.log('[ステップ2] SQLiteデータベース構築...\n');

    if (fs.existsSync(DB_PATH)) {
        fs.unlinkSync(DB_PATH);
        console.log('  [クリーン] 既存DB削除');
    }

    const SQL = await initSqlJs();
    const db = new SQL.Database();

    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    db.run(schema);
    console.log('  [スキーマ] 適用完了');

    const products = Array.from(productsMap.values());
    productsMap.clear();

    const startTime = Date.now();
    let inserted = 0;

    db.run('BEGIN TRANSACTION');

    for (const p of products) {
        db.run(`
            INSERT OR IGNORE INTO products (
                product_id, title, actresses, maker, label,
                duration_min, genres, sale_start_date,
                main_image_url, sample_images_json, affiliate_url, detail_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            p.product_id,
            p.title || null,
            p.actresses || null,
            p.maker || null,
            p.label || null,
            p.duration_min || null,
            p.genres || null,
            p.sale_start_date || null,
            p.main_image_url || null,
            p.sample_images ? JSON.stringify(p.sample_images) : null,
            p.affiliate_url || null,
            p.detail_url || null,
        ]);

        inserted++;

        if (inserted % BATCH_SIZE === 0) {
            db.run('COMMIT');
            process.stdout.write(`  💾 ${inserted.toLocaleString()} / ${products.length.toLocaleString()} 挿入済み\r`);
            db.run('BEGIN TRANSACTION');
        }
    }

    db.run('COMMIT');
    console.log(`\n  💾 ${inserted.toLocaleString()} 件挿入完了`);

    // 保存
    console.log('\n[ステップ3] DBファイル保存...');
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
    console.log(`  ✅ 保存完了: ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);

    // 検証
    console.log('\n========================================');
    console.log('  DB検証');
    console.log('========================================\n');

    const q = (sql) => {
        const r = db.exec(sql);
        return (r.length && r[0].values.length) ? r[0].values[0][0] : 0;
    };

    const total = q('SELECT COUNT(*) FROM products');
    const withActress = q("SELECT COUNT(*) FROM products WHERE actresses IS NOT NULL AND actresses != ''");
    const withImage = q("SELECT COUNT(*) FROM products WHERE main_image_url IS NOT NULL AND main_image_url != ''");
    const withDate = q("SELECT COUNT(*) FROM products WHERE sale_start_date IS NOT NULL AND sale_start_date != ''");

    console.log(`  📦 総品番数:     ${total.toLocaleString()}`);
    console.log(`  👩 出演者あり:   ${withActress.toLocaleString()} (${(withActress / total * 100).toFixed(1)}%)`);
    console.log(`  🖼️  画像URLあり:  ${withImage.toLocaleString()} (${(withImage / total * 100).toFixed(1)}%)`);
    console.log(`  📅 発売日あり:   ${withDate.toLocaleString()} (${(withDate / total * 100).toFixed(1)}%)`);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n  ⏱️ 構築時間: ${elapsed}秒`);

    db.close();
    console.log('\n========================================\n');
    console.log('次のステップ: サイトを起動して動作確認 (npm run dev)\n');
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
