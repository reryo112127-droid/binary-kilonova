/**
 * データベース操作モジュール（sql.js版）
 * SQLiteデータベースの初期化・CRUD操作を提供
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'mgs.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db = null;

/**
 * データベースを初期化（なければ作成）
 */
async function init() {
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
        const buffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }

    // スキーマ適用
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    db.run(schema);

    // カラム追加マイグレーション（既存DBへの対応）
    for (const sql of [
        'ALTER TABLE products ADD COLUMN list_price INTEGER',
        'ALTER TABLE products ADD COLUMN current_price INTEGER',
        'ALTER TABLE products ADD COLUMN discount_pct INTEGER DEFAULT 0',
        'ALTER TABLE products ADD COLUMN sale_end_date TEXT',
        'ALTER TABLE products ADD COLUMN price_updated_at TEXT',
    ]) {
        try { db.run(sql); } catch {} // 既存カラムはエラーを無視
    }

    console.log(`[DB] 初期化完了: ${DB_PATH}`);
    return db;
}

/**
 * データベースをファイルに永続化
 */
function save() {
    if (!db) return;
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
}

/**
 * 作品データをUPSERT（フェーズ1: 一覧ページから取得したデータ）
 */
function upsertProductFromList(product) {
    db.run(`
    INSERT INTO products (product_id, title, actresses, main_image_url, sample_images_json, sample_video_url)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id) DO UPDATE SET
      title = COALESCE(excluded.title, title),
      actresses = COALESCE(excluded.actresses, actresses),
      main_image_url = COALESCE(excluded.main_image_url, main_image_url),
      sample_images_json = COALESCE(excluded.sample_images_json, sample_images_json),
      sample_video_url = COALESCE(excluded.sample_video_url, sample_video_url),
      updated_at = datetime('now','localtime')
  `, [
        product.product_id,
        product.title || null,
        product.actresses || null,
        product.main_image_url || null,
        product.sample_images ? JSON.stringify(product.sample_images) : null,
        product.sample_video_url || null,
    ]);
}

/**
 * バッチ挿入（トランザクション内で複数件をまとめて挿入）
 */
function upsertProductsFromList(products) {
    db.run('BEGIN TRANSACTION');
    try {
        for (const item of products) {
            upsertProductFromList(item);
        }
        db.run('COMMIT');
    } catch (e) {
        db.run('ROLLBACK');
        throw e;
    }
}

/**
 * 作品データを更新（フェーズ2: 詳細ページから取得した補完データ）
 */
function updateProductDetail(product_id, detail) {
    db.run(`
    UPDATE products SET
      maker = ?,
      label = ?,
      duration_min = ?,
      detail_scraped = 1,
      updated_at = datetime('now','localtime')
    WHERE product_id = ?
  `, [
        detail.maker || null,
        detail.label || null,
        detail.duration_min || null,
        product_id,
    ]);
}

/**
 * 作品の価格情報を更新
 */
function updateProductPrice(product_id, price) {
    db.run(`
        UPDATE products SET
            list_price       = ?,
            current_price    = ?,
            discount_pct     = ?,
            sale_end_date    = ?,
            price_updated_at = datetime('now','localtime'),
            updated_at       = datetime('now','localtime')
        WHERE product_id = ?
    `, [
        price.list_price ?? null,
        price.current_price ?? null,
        price.discount_pct ?? 0,
        price.sale_end_date ?? null,
        product_id,
    ]);
}

/**
 * 詳細未取得の作品IDリストを取得
 */
function getUnscrapedDetailIds(limit = 1000) {
    const rows = db.exec(`
    SELECT product_id FROM products
    WHERE detail_scraped = 0
    ORDER BY scraped_at ASC
    LIMIT ${limit}
  `);
    if (!rows.length || !rows[0].values.length) return [];
    return rows[0].values.map(row => row[0]);
}

/**
 * 作品IDが既に存在するか確認
 */
function productExists(product_id) {
    const result = db.exec('SELECT 1 FROM products WHERE product_id = ?', [product_id]);
    return result.length > 0 && result[0].values.length > 0;
}

/**
 * スクレイピング進捗を取得
 */
function getProgress(phase) {
    const result = db.exec('SELECT * FROM scrape_progress WHERE phase = ?', [phase]);
    if (!result.length || !result[0].values.length) return null;
    const cols = result[0].columns;
    const vals = result[0].values[0];
    const obj = {};
    cols.forEach((col, i) => { obj[col] = vals[i]; });
    return obj;
}

/**
 * スクレイピング進捗を更新
 */
function updateProgress(phase, data) {
    db.run(`
    INSERT INTO scrape_progress (phase, last_page, last_product_id, total_pages)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(phase) DO UPDATE SET
      last_page = COALESCE(?, last_page),
      last_product_id = COALESCE(?, last_product_id),
      total_pages = COALESCE(?, total_pages),
      updated_at = datetime('now','localtime')
  `, [
        phase,
        data.last_page ?? null,
        data.last_product_id ?? null,
        data.total_pages ?? null,
        data.last_page ?? null,
        data.last_product_id ?? null,
        data.total_pages ?? null,
    ]);
}

/**
 * 統計情報を取得
 */
function getStats() {
    const q = (sql) => {
        const r = db.exec(sql);
        return (r.length && r[0].values.length) ? r[0].values[0][0] : 0;
    };
    return {
        total: q('SELECT COUNT(*) FROM products'),
        detail_scraped: q('SELECT COUNT(*) FROM products WHERE detail_scraped = 1'),
        detail_pending: q('SELECT COUNT(*) FROM products WHERE detail_scraped = 0'),
        with_video: q('SELECT COUNT(*) FROM products WHERE sample_video_url IS NOT NULL AND sample_video_url != ""'),
        long_duration: q('SELECT COUNT(*) FROM products WHERE duration_min >= 600'),
    };
}

/**
 * 全作品を取得（CSVエクスポート用）
 */
function getAllProducts(excludeLongDuration = false) {
    let sql = 'SELECT * FROM products';
    if (excludeLongDuration) {
        sql += ' WHERE duration_min IS NULL OR duration_min < 600';
    }
    sql += ' ORDER BY product_id';
    const result = db.exec(sql);
    if (!result.length) return [];
    const cols = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

function getDb() {
    return db;
}

function close() {
    if (db) {
        save();
        db.close();
        db = null;
    }
}

module.exports = {
    init,
    save,
    upsertProductFromList,
    upsertProductsFromList,
    updateProductDetail,
    updateProductPrice,
    getUnscrapedDetailIds,
    productExists,
    getProgress,
    updateProgress,
    getStats,
    getAllProducts,
    getDb,
    close,
};
