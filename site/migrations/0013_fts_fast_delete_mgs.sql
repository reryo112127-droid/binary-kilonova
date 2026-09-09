-- @targets: mgs
-- ============================================================
--  0012 と同じ「products_fts の削除を全走査から外す」修正の MGS 版（0004 スキーマの置き換え）。
--  MGS の products_fts は maker 列を持つ（FANZAスリムは持たない）ので INSERT 列が1つ多い。
--  背景・実測値・仕組みは 0012_fts_fast_delete_fanza.sql のコメントを参照。
--
--  適用: node scripts/apply_fts_triggers.mjs
-- ============================================================

DROP TRIGGER IF EXISTS products_ad;
DROP TRIGGER IF EXISTS products_au;
DROP TRIGGER IF EXISTS products_ad_slow;
DROP TRIGGER IF EXISTS products_au_slow;

CREATE TRIGGER products_ad AFTER DELETE ON products
WHEN old.title IS NOT NULL AND LENGTH(old.title) >= 3
BEGIN
    DELETE FROM products_fts
     WHERE rowid IN (
        SELECT rowid FROM products_fts
         WHERE products_fts MATCH '{title} : "' || REPLACE(SUBSTR(old.title, 1, 60), '"', '""') || '"'
           AND product_id = old.product_id
     );
END;

CREATE TRIGGER products_ad_slow AFTER DELETE ON products
WHEN old.title IS NULL OR LENGTH(old.title) < 3
BEGIN
    DELETE FROM products_fts WHERE product_id = old.product_id;
END;

CREATE TRIGGER products_au AFTER UPDATE ON products
WHEN (old.title     IS NOT new.title
   OR old.actresses IS NOT new.actresses
   OR old.genres    IS NOT new.genres
   OR old.label     IS NOT new.label
   OR old.maker     IS NOT new.maker)
  AND old.title IS NOT NULL AND LENGTH(old.title) >= 3
BEGIN
    DELETE FROM products_fts
     WHERE rowid IN (
        SELECT rowid FROM products_fts
         WHERE products_fts MATCH '{title} : "' || REPLACE(SUBSTR(old.title, 1, 60), '"', '""') || '"'
           AND product_id = old.product_id
     );
    INSERT INTO products_fts(product_id, title, actresses, genres, label, maker)
    VALUES (new.product_id, new.title, new.actresses, new.genres, new.label, new.maker);
END;

CREATE TRIGGER products_au_slow AFTER UPDATE ON products
WHEN (old.title     IS NOT new.title
   OR old.actresses IS NOT new.actresses
   OR old.genres    IS NOT new.genres
   OR old.label     IS NOT new.label
   OR old.maker     IS NOT new.maker)
  AND (old.title IS NULL OR LENGTH(old.title) < 3)
BEGIN
    DELETE FROM products_fts WHERE product_id = old.product_id;
    INSERT INTO products_fts(product_id, title, actresses, genres, label, maker)
    VALUES (new.product_id, new.title, new.actresses, new.genres, new.label, new.maker);
END;
