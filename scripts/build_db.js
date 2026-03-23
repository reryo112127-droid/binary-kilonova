/**
 * JSONL統合 → SQLite DB構築 (v2)
 * 
 * sql.jsのexport問題を回避するため、中間保存を行わず最後に1回だけ保存する。
 * メモリ内で全データを処理し、最終的にexportしてファイルに書き出す。
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'mgs.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

const JSONL_FILES = [
    { path: path.join(DATA_DIR, 'mgs_products_by_maker.jsonl'), label: 'メーカー別' },
    { path: path.join(DATA_DIR, 'mgs_products_by_actress.jsonl'), label: '女優別' },
    { path: path.join(DATA_DIR, 'mgs_products_by_month.jsonl'), label: '月別' },
];

const BATCH_SIZE = 10000;

async function main() {
    console.log('========================================');
    console.log('  MGS動画 JSONL → SQLite DB 構築 (v2)');
    console.log('========================================\n');

    // ステップ1: 全JSONLをメモリ上で重複排除
    console.log('[ステップ1] 全JSONLを読み込み、品番ベースで重複排除...\n');

    const productsMap = new Map(); // product_id → product data

    for (const file of JSONL_FILES) {
        if (!fs.existsSync(file.path)) {
            console.log(`  [スキップ] ${file.label}: ファイルなし`);
            continue;
        }

        const rl = readline.createInterface({
            input: fs.createReadStream(file.path),
            crlfDelay: Infinity,
        });

        let lineCount = 0;
        let newCount = 0;

        for await (const line of rl) {
            if (!line.trim()) continue;
            lineCount++;
            try {
                const p = JSON.parse(line);
                if (!productsMap.has(p.product_id)) {
                    productsMap.set(p.product_id, p);
                    newCount++;
                }
            } catch (e) { }
        }

        console.log(`  [${file.label}] ${lineCount.toLocaleString()}行 → 新規: ${newCount.toLocaleString()}`);
    }

    console.log(`\n  ✅ ユニーク品番合計: ${productsMap.size.toLocaleString()}\n`);

    // ステップ2: SQLiteに一括挿入
    console.log('[ステップ2] SQLiteデータベースを構築...\n');

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
    productsMap.clear(); // メモリ解放

    const startTime = Date.now();
    let inserted = 0;

    db.run('BEGIN TRANSACTION');

    for (const p of products) {
        db.run(`
      INSERT INTO products (product_id, title, actresses, main_image_url, sample_images_json, sample_video_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
            p.product_id,
            p.title || null,
            p.actresses || null,
            p.main_image_url || null,
            p.sample_images ? JSON.stringify(p.sample_images) : null,
            p.sample_video_url || null,
        ]);

        inserted++;

        if (inserted % BATCH_SIZE === 0) {
            db.run('COMMIT');
            process.stdout.write(`  💾 ${inserted.toLocaleString()} / ${products.length.toLocaleString()} 挿入済み\n`);
            db.run('BEGIN TRANSACTION');
        }
    }

    db.run('COMMIT');
    console.log(`  💾 ${inserted.toLocaleString()} / ${products.length.toLocaleString()} 挿入完了`);

    // ステップ3: 1回だけ保存
    console.log('\n[ステップ3] DBファイルに保存...');
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
    const withTitle = q("SELECT COUNT(*) FROM products WHERE title IS NOT NULL AND title != ''");
    const withActress = q("SELECT COUNT(*) FROM products WHERE actresses IS NOT NULL AND actresses != ''");
    const withVideo = q("SELECT COUNT(*) FROM products WHERE sample_video_url IS NOT NULL AND sample_video_url != ''");
    const withImage = q("SELECT COUNT(*) FROM products WHERE main_image_url IS NOT NULL AND main_image_url != ''");

    console.log(`  📦 総品番数:        ${total.toLocaleString()}`);
    console.log(`  📝 タイトルあり:    ${withTitle.toLocaleString()} (${(withTitle / total * 100).toFixed(1)}%)`);
    console.log(`  👩 出演者あり:      ${withActress.toLocaleString()} (${(withActress / total * 100).toFixed(1)}%)`);
    console.log(`  🖼️  画像URLあり:     ${withImage.toLocaleString()} (${(withImage / total * 100).toFixed(1)}%)`);
    console.log(`  🎬 動画URLあり:     ${withVideo.toLocaleString()} (${(withVideo / total * 100).toFixed(1)}%)`);
    console.log(`  📋 詳細取得済み:    0 (フェーズ2で補完)`);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n  ⏱️ DB構築時間:      ${elapsed}秒`);

    // 保存後に再読み込みして件数検証
    console.log('\n[再読み込み検証]');
    const db2 = new SQL.Database(fs.readFileSync(DB_PATH));
    const r2 = db2.exec('SELECT COUNT(*) FROM products');
    const count2 = (r2.length && r2[0].values.length) ? r2[0].values[0][0] : 0;
    console.log(`  再読み込み後のCOUNT: ${count2.toLocaleString()}`);

    if (count2 === total) {
        console.log('  ✅ 完全一致！DBの永続化に成功');
    } else {
        console.log(`  ⚠️ 不一致！ メモリ: ${total} / ファイル: ${count2}`);
    }

    db2.close();
    db.close();
    console.log('\n========================================\n');
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
