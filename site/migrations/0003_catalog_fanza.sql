-- D1: avrankings-fanza カタログスキーマ（FTS は 0004 でデータ投入後に作成）
-- ローカル data/fanza.db の products スキーマを複製（フォールバックSELECT互換のため全カラム保持）。
-- 投入: wrangler d1 execute avrankings-fanza --remote --file=migrations/0003_catalog_fanza.sql

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
    sample_images_json TEXT,
    affiliate_url     TEXT,
    detail_url        TEXT,
    scraped_at        TEXT,
    updated_at        TEXT,
    sample_video_url  TEXT,
    list_price        INTEGER,
    current_price     INTEGER,
    discount_pct      INTEGER,
    price_updated_at  TEXT,
    sale_end_date     TEXT,
    review_count      INTEGER,
    review_average    REAL,
    series_id         TEXT,
    series_name       TEXT,
    vr_flag           INTEGER DEFAULT 0,
    floor             TEXT
);

CREATE INDEX IF NOT EXISTS idx_sale_start   ON products(sale_start_date DESC);
CREATE INDEX IF NOT EXISTS idx_discount     ON products(discount_pct DESC);
CREATE INDEX IF NOT EXISTS idx_duration     ON products(duration_min);
CREATE INDEX IF NOT EXISTS idx_series       ON products(series_name);
CREATE INDEX IF NOT EXISTS idx_vr           ON products(vr_flag);

-- 女優プロフィール（日次更新で新出演女優を DMM API から取得して upsert）
-- ランタイムは data/actress_profiles.json（静的）を読むが、書き込み先として保持。
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

-- サジェスト用キャッシュ（build_suggest_cache.js が key='main' に JSON を保存）
CREATE TABLE IF NOT EXISTS suggest_cache (
    key        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT
);
