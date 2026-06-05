-- D1: avrankings-mgs カタログスキーマ（FTS は 0004 でデータ投入後に作成）
-- ローカル data/mgs.db の products スキーマを複製（フォールバックSELECT互換のため全カラム保持）。
-- 投入: wrangler d1 execute avrankings-mgs --remote --file=migrations/0002_catalog_mgs.sql

CREATE TABLE IF NOT EXISTS products (
    product_id        TEXT PRIMARY KEY,
    title             TEXT,
    actresses         TEXT,
    maker             TEXT,
    label             TEXT,
    duration_min      INTEGER,
    wish_count        INTEGER,
    genres            TEXT,
    sale_start_date   TEXT,
    main_image_url    TEXT,
    sample_images_json TEXT,
    sample_video_url  TEXT,
    detail_scraped    INTEGER DEFAULT 0,
    scraped_at        TEXT,
    updated_at        TEXT,
    x_posted_at       TEXT,
    x_posted_account  TEXT,
    list_price        INTEGER,
    current_price     INTEGER,
    discount_pct      INTEGER DEFAULT 0,
    sale_end_date     TEXT,
    price_updated_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_sale_start    ON products(sale_start_date DESC);
CREATE INDEX IF NOT EXISTS idx_discount      ON products(discount_pct DESC);
CREATE INDEX IF NOT EXISTS idx_wish          ON products(wish_count DESC);
CREATE INDEX IF NOT EXISTS idx_duration      ON products(duration_min);
-- buildOrderBy が使う正規化日付（MGS は YYYY/MM/DD）への関数インデックス
CREATE INDEX IF NOT EXISTS idx_sale_date_norm ON products(REPLACE(sale_start_date, '/', '-') DESC);
