-- MGS動画スクレイピング データベーススキーマ

CREATE TABLE IF NOT EXISTS products (
    product_id    TEXT PRIMARY KEY,                   -- 品番 (例: 259LUXU-1875)
    title         TEXT,                                -- 作品タイトル
    actresses     TEXT,                                -- 出演女優 (カンマ区切り)
    maker         TEXT,                                -- メーカー
    label         TEXT,                                -- レーベル
    duration_min  INTEGER,                             -- 収録時間(分)
    wish_count    INTEGER,                             -- 欲しいものリスト追加数
    genres        TEXT,                                -- ジャンル (カンマ区切り)
    sale_start_date TEXT,                              -- 配信開始日
    main_image_url TEXT,                               -- メイン画像URL
    sample_images_json TEXT,                            -- サンプル画像URL (JSON配列)
    sample_video_url   TEXT,                            -- サンプル動画URL
    detail_scraped INTEGER DEFAULT 0,                  -- 詳細ページ取得済みフラグ (0/1)
    list_price     INTEGER,                             -- 定価（円）
    current_price  INTEGER,                             -- 現在価格（セール時は割引後）
    discount_pct   INTEGER DEFAULT 0,                  -- 割引率（%）
    sale_end_date  TEXT,                               -- セール終了日時
    price_updated_at TEXT,                             -- 価格最終更新日時
    x_posted_at    TEXT DEFAULT NULL,                  -- Xに投稿した日時
    x_posted_account TEXT DEFAULT NULL,                -- 投稿したXアカウント (例: desireav-002)
    scraped_at     TEXT DEFAULT (datetime('now','localtime')), -- 初回取得日時
    updated_at     TEXT DEFAULT (datetime('now','localtime'))  -- 最終更新日時
);

CREATE INDEX IF NOT EXISTS idx_detail_scraped ON products(detail_scraped);
CREATE INDEX IF NOT EXISTS idx_scraped_at ON products(scraped_at);
CREATE INDEX IF NOT EXISTS idx_maker ON products(maker);
CREATE INDEX IF NOT EXISTS idx_duration ON products(duration_min);
CREATE INDEX IF NOT EXISTS idx_discount ON products(discount_pct);

-- スクレイピング進捗管理テーブル
CREATE TABLE IF NOT EXISTS scrape_progress (
    phase         TEXT PRIMARY KEY,     -- 'phase1', 'phase2', 'phase3'
    last_page     INTEGER DEFAULT 0,    -- フェーズ1: 最後に完了したページ番号
    last_product_id TEXT,               -- フェーズ2: 最後に処理した品番
    total_pages   INTEGER,              -- フェーズ1: 総ページ数
    updated_at    TEXT DEFAULT (datetime('now','localtime'))
);
