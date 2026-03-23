-- FANZA動画 データベーススキーマ

CREATE TABLE IF NOT EXISTS products (
    product_id    TEXT PRIMARY KEY,                   -- 品番 (FANZAのcontent_id)
    title         TEXT,                                -- 作品タイトル
    actresses     TEXT,                                -- 出演女優 (カンマ区切り)
    maker         TEXT,                                -- メーカー
    label         TEXT,                                -- レーベル
    duration_min  INTEGER,                             -- 収録時間(分)
    genres        TEXT,                                -- ジャンル (カンマ区切り)
    sale_start_date TEXT,                              -- 配信開始日 (YYYY-MM-DD)
    main_image_url TEXT,                               -- メイン画像URL (large)
    sample_images_json TEXT,                            -- サンプル画像URL (JSON配列)
    sample_video_url TEXT,                             -- サンプル動画プレイヤーURL (DMM litevideo)
    affiliate_url TEXT,                                -- アフィリエイトURL
    detail_url    TEXT,                                -- 詳細ページURL
    list_price    INTEGER,                             -- 定価 (円)
    current_price INTEGER,                             -- 現在価格 (円、セール時は定価より低い)
    discount_pct  INTEGER DEFAULT 0,                   -- 割引率 (0-100%)
    price_updated_at TEXT,                             -- 価格最終更新日時
    scraped_at    TEXT DEFAULT (datetime('now','localtime')),
    updated_at    TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_sale_date ON products(sale_start_date);
CREATE INDEX IF NOT EXISTS idx_maker ON products(maker);
CREATE INDEX IF NOT EXISTS idx_label ON products(label);
CREATE INDEX IF NOT EXISTS idx_discount ON products(discount_pct);

-- 取得進捗管理
CREATE TABLE IF NOT EXISTS fetch_progress (
    month_key     TEXT PRIMARY KEY,   -- 'YYYY-MM' 形式
    total_items   INTEGER DEFAULT 0,
    fetched_at    TEXT DEFAULT (datetime('now','localtime'))
);
