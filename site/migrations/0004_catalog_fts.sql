-- D1: カタログ FTS5（avrankings-mgs と avrankings-fanza の両方に投入）
-- products データを投入し終えた後に実行すること（トリガによる二重書き込みを避けるため）。
-- 投入: wrangler d1 execute avrankings-mgs   --remote --file=migrations/0004_catalog_fts.sql
--       wrangler d1 execute avrankings-fanza --remote --file=migrations/0004_catalog_fts.sql
-- 実行後、export_catalog_to_d1.mjs が生成する *_fts_*.sql（FTS本体データ）を投入する。
--
-- トークナイザは trigram（日本語対応・3文字以上で部分一致）。
-- ランタイム（products/route.ts）は q が 3文字以上のとき MATCH、未満は LIKE に分岐する。
-- 列は MATCH で参照される product_id / title / actresses / genres / label / maker を網羅。

CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
    product_id UNINDEXED,
    title,
    actresses,
    genres,
    label,
    maker,
    tokenize = 'trigram'
);

-- products への変更を FTS に自動反映（日次更新で発火）
CREATE TRIGGER IF NOT EXISTS products_ai AFTER INSERT ON products BEGIN
    INSERT INTO products_fts(product_id, title, actresses, genres, label, maker)
    VALUES (new.product_id, new.title, new.actresses, new.genres, new.label, new.maker);
END;

CREATE TRIGGER IF NOT EXISTS products_ad AFTER DELETE ON products BEGIN
    DELETE FROM products_fts WHERE product_id = old.product_id;
END;

-- FTS 列が実際に変化したときだけ発火（価格更新など FTS 無関係な UPDATE で
-- 無駄な FTS 書き込みを発生させ D1 の書き込み枠を消費しないようにする）。
CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE ON products
WHEN old.title     IS NOT new.title
  OR old.actresses IS NOT new.actresses
  OR old.genres    IS NOT new.genres
  OR old.label     IS NOT new.label
  OR old.maker     IS NOT new.maker
BEGIN
    DELETE FROM products_fts WHERE product_id = old.product_id;
    INSERT INTO products_fts(product_id, title, actresses, genres, label, maker)
    VALUES (new.product_id, new.title, new.actresses, new.genres, new.label, new.maker);
END;
