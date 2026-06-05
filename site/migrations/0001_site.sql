-- D1: avrankings-site スキーマ（旧 Turso SITE DB の移行先）
-- 可変ユーザーデータ: いいね/レビュー/購入/出演者投稿/SNS投稿/X投稿判定
-- 内容は site/lib/siteDb.ts の initSiteSchema() と一致させること。
-- 投入: wrangler d1 execute avrankings-site --remote --file=migrations/0001_site.sql

CREATE TABLE IF NOT EXISTS product_likes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(product_id, session_id)
);

CREATE TABLE IF NOT EXISTS actress_likes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    actress_name TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(actress_name, session_id)
);

CREATE TABLE IF NOT EXISTS product_reviews (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    stars      INTEGER NOT NULL CHECK(stars >= 1 AND stars <= 5),
    title      TEXT,
    comment    TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(product_id, session_id)
);

CREATE TABLE IF NOT EXISTS purchase_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL,
    platform   TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cast_contributions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(session_id, product_id)
);

CREATE TABLE IF NOT EXISTS sns_submissions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    actress_name       TEXT NOT NULL,
    twitter_username   TEXT,
    instagram_username TEXT,
    session_id         TEXT,
    submitted_at       TEXT DEFAULT (datetime('now')),
    status             TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS rename_submissions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    old_name      TEXT NOT NULL,
    new_name      TEXT NOT NULL,
    reference_url TEXT,
    session_id    TEXT,
    submitted_at  TEXT DEFAULT (datetime('now')),
    status        TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS product_safety (
    product_id TEXT PRIMARY KEY,
    x_safe     INTEGER NOT NULL DEFAULT 1,
    checked_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS x_post_decisions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL UNIQUE,
    decision   TEXT NOT NULL,
    new_genre  TEXT,
    post_type  TEXT DEFAULT 'package',
    posted_at  TEXT,
    tweet_id   TEXT,
    tweet_text TEXT,
    decided_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_product_likes_pid   ON product_likes(product_id);
CREATE INDEX IF NOT EXISTS idx_actress_likes_name  ON actress_likes(actress_name);
CREATE INDEX IF NOT EXISTS idx_product_reviews_pid ON product_reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_purchase_events_pid ON purchase_events(product_id);
CREATE INDEX IF NOT EXISTS idx_cast_contrib_session ON cast_contributions(session_id);
