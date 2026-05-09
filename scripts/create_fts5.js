/**
 * create_fts5.js
 *
 * FANZA/MGS Turso DB に FTS5 trigram インデックスを構築する。
 * products_fts (title, actresses, genres, maker, label) を作成し
 * LIKE '%X%' の代わりに高速な MATCH を使えるようにする。
 */

const { createClient } = require('@libsql/client');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function buildFts5(db, dbName) {
    console.log(`\n[${dbName}] FTS5 trigram 構築開始...`);

    // FTS5 テーブル作成
    await db.execute(`CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
        product_id UNINDEXED,
        title,
        actresses,
        genres,
        maker,
        label,
        tokenize='trigram'
    )`);
    console.log('  テーブル作成OK');

    // 既存データ確認
    const [ftsRow, prodRow] = await Promise.all([
        db.execute('SELECT COUNT(*) c FROM products_fts'),
        db.execute('SELECT COUNT(*) c FROM products'),
    ]);
    const ftsCount  = Number(ftsRow.rows[0].c);
    const prodCount = Number(prodRow.rows[0].c);
    console.log(`  products: ${prodCount.toLocaleString()}, products_fts: ${ftsCount.toLocaleString()}`);

    if (ftsCount >= prodCount * 0.95) {
        console.log('  既に構築済み → スキップ');
        await benchmark(db);
        return;
    }

    // 不完全なら全削除して再構築
    if (ftsCount > 0) {
        await db.execute('DELETE FROM products_fts');
        console.log('  既存FTSデータをクリア');
    }

    // INSERT INTO ... SELECT で一括投入（サーバー側で完結するため高速）
    console.log(`  INSERT INTO products_fts SELECT FROM products...`);
    console.time('  INSERT');
    try {
        await db.execute(`
            INSERT INTO products_fts(product_id, title, actresses, genres, maker, label)
            SELECT product_id,
                   COALESCE(title,''),
                   COALESCE(actresses,''),
                   COALESCE(genres,''),
                   COALESCE(maker,''),
                   COALESCE(label,'')
            FROM products
        `);
        console.timeEnd('  INSERT');
    } catch (e) {
        // タイムアウト時はバッチ挿入にフォールバック
        console.log('  一括INSERT失敗、バッチ挿入に切り替え:', e.message.slice(0, 80));
        await batchInsert(db, prodCount);
    }

    const afterRow = await db.execute('SELECT COUNT(*) c FROM products_fts');
    console.log(`  完了: ${Number(afterRow.rows[0].c).toLocaleString()} 件`);

    await benchmark(db);
}

async function batchInsert(db, totalRows) {
    const BATCH = 500;
    let offset = 0;
    console.time('  batchInsert');
    while (offset < totalRows) {
        const rows = await db.execute({
            sql: `SELECT product_id,
                         COALESCE(title,''),
                         COALESCE(actresses,''),
                         COALESCE(genres,''),
                         COALESCE(maker,''),
                         COALESCE(label,'')
                  FROM products LIMIT ? OFFSET ?`,
            args: [BATCH, offset],
        });
        if (rows.rows.length === 0) break;
        await db.batch(rows.rows.map(r => ({
            sql: 'INSERT INTO products_fts(product_id, title, actresses, genres, maker, label) VALUES (?,?,?,?,?,?)',
            args: Array.from(r),
        })));
        offset += rows.rows.length;
        process.stdout.write(`\r  ${offset.toLocaleString()}/${totalRows.toLocaleString()}`);
        await sleep(50);
    }
    console.timeEnd('  batchInsert');
}

async function benchmark(db) {
    console.log('  ベンチマーク:');
    console.time('    FTS actress');
    await db.execute({ sql: "SELECT COUNT(*) FROM products_fts WHERE products_fts MATCH ?", args: ['actresses : "波多野結衣"'] });
    console.timeEnd('    FTS actress');
    console.time('    FTS genre');
    await db.execute({ sql: "SELECT COUNT(*) FROM products_fts WHERE products_fts MATCH ?", args: ['genres : "巨乳"'] });
    console.timeEnd('    FTS genre');
}

async function main() {
    const fanza = createClient({ url: process.env.TURSO_FANZA_URL, authToken: process.env.TURSO_FANZA_TOKEN });
    const mgs   = createClient({ url: process.env.TURSO_MGS_URL,   authToken: process.env.TURSO_MGS_TOKEN });

    await buildFts5(fanza, 'FANZA');
    await buildFts5(mgs,   'MGS');

    fanza.close();
    mgs.close();
    console.log('\n✅ 完了');
}

main().catch(e => { console.error(e); process.exit(1); });
