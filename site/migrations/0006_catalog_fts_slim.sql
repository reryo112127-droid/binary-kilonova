-- D1: スリムFANZA用 FTS5（maker を除外して無料500MB枠に収める）
-- ランタイム(products/route.ts)の MATCH は title/actresses/genres/label のみ使用し、
-- maker は base table の LIKE 検索なので FTS から maker を外しても機能損失なし。
-- 投入: 0005 適用後、products 投入前に実行（トリガで自動FTS生成）。
-- avrankings-fanza-slim 専用（MGSは従来の 0004 を使用）。

CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
    product_id UNINDEXED,
    title,
    actresses,
    genres,
    label,
    tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS products_ai AFTER INSERT ON products BEGIN
    INSERT INTO products_fts(product_id, title, actresses, genres, label)
    VALUES (new.product_id, new.title, new.actresses, new.genres, new.label);
END;

CREATE TRIGGER IF NOT EXISTS products_ad AFTER DELETE ON products BEGIN
    DELETE FROM products_fts WHERE product_id = old.product_id;
END;

CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE ON products
WHEN old.title     IS NOT new.title
  OR old.actresses IS NOT new.actresses
  OR old.genres    IS NOT new.genres
  OR old.label     IS NOT new.label
BEGIN
    DELETE FROM products_fts WHERE product_id = old.product_id;
    INSERT INTO products_fts(product_id, title, actresses, genres, label)
    VALUES (new.product_id, new.title, new.actresses, new.genres, new.label);
END;
