-- D1: avrankings-fanza スリム検索スキーマ（無料500MB枠に収めるための再構築用）
-- sample_images_json(342MB) ほか検索に不要な大列を除外。画像ギャラリーはR2配信。
-- 残す列 = ロングテール検索の SELECT/フィルタ + 表示 + affiliate_url(購入リンク) + main_image_url。
-- 除外列 = sample_images_json / detail_url / scraped_at / updated_at / price_updated_at /
--          review_count / review_average / floor
-- FTS は 0004_catalog_fts.sql を再利用（title/actresses/genres/label/maker は保持）。
-- 投入: wrangler d1 execute avrankings-fanza --remote --file=migrations/0005_catalog_fanza_slim.sql

CREATE TABLE IF NOT EXISTS products (
    product_id        TEXT PRIMARY KEY,
    title             TEXT,
    actresses         TEXT,
    maker             TEXT,
    label             TEXT,
    duration_min      INTEGER,
    genres            TEXT,
    sale_start_date   TEXT,
    main_image_url    TEXT,
    sample_video_url  TEXT,
    affiliate_url     TEXT,
    list_price        INTEGER,
    current_price     INTEGER,
    discount_pct      INTEGER,
    sale_end_date     TEXT,
    series_id         TEXT,
    series_name       TEXT,
    vr_flag           INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sale_start   ON products(sale_start_date DESC);
CREATE INDEX IF NOT EXISTS idx_discount     ON products(discount_pct DESC);
CREATE INDEX IF NOT EXISTS idx_duration     ON products(duration_min);
-- 無料500MB枠に収めるため idx_series(LIKE検索でインデックス不使用=無駄) と idx_vr(ニッチ) は作らない

-- 女優プロフィール（日次更新が upsert）
CREATE TABLE IF NOT EXISTS actress_profiles (
    name        TEXT PRIMARY KEY,
    fanza_id    TEXT,
    ruby        TEXT,
    height      INTEGER,
    bust        INTEGER,
    waist       INTEGER,
    hip         INTEGER,
    cup         TEXT,
    birthday    TEXT,
    blood_type  TEXT,
    hobby       TEXT,
    prefectures TEXT,
    image_url   TEXT,
    updated_at  TEXT
);

-- サジェスト用キャッシュ
CREATE TABLE IF NOT EXISTS suggest_cache (
    key        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT
);
