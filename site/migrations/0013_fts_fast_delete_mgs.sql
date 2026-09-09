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

-- ============================================================
--  INSERT OR REPLACE が **FTSの重複行**を作り続けていたのを止める（2026-09-09）
--
--  SQLite は `INSERT OR REPLACE` の置き換え削除で **AFTER DELETE トリガを発火しない**
--  （recursive_triggers が off のときの仕様。D1 では off）。一方 AFTER INSERT は発火するので、
--  日次更新が既存作品を入れ直すたびに **古い内容のFTS行が残ったまま新しい行が増える**。
--  実測(2026-09-09, fanza-0): products 135,367行 に対し products_fts 193,832行＝**58,465行が余分**。
--    ・検索が「古いタイトル/古い出演者」でも当たる（出演者を直しても旧名で引ける）
--    ・FTSの全走査・密な語のMATCHが4割増しになる
--  実験でも 1作品を INSERT OR REPLACE すると FTS行が2本になることを確認した。
--
--  → BEFORE INSERT で「同じ product_id の既存行があれば、その **古いタイトル** で
--    FTS行を先に消す」。BEFORE INSERT は置き換え削除より前に走るので products には
--    まだ旧行があり、旧タイトルを引ける。
-- ============================================================

DROP TRIGGER IF EXISTS products_bi;
DROP TRIGGER IF EXISTS products_bi_slow;

CREATE TRIGGER products_bi BEFORE INSERT ON products
WHEN EXISTS (SELECT 1 FROM products p WHERE p.product_id = new.product_id
              AND p.title IS NOT NULL AND LENGTH(p.title) >= 3)
BEGIN
    DELETE FROM products_fts
     WHERE rowid IN (
        SELECT rowid FROM products_fts
         WHERE products_fts MATCH '{title} : "' || REPLACE(SUBSTR(
                   (SELECT p.title FROM products p WHERE p.product_id = new.product_id), 1, 60), '"', '""') || '"'
           AND product_id = new.product_id
     );
END;

CREATE TRIGGER products_bi_slow BEFORE INSERT ON products
WHEN EXISTS (SELECT 1 FROM products p WHERE p.product_id = new.product_id
              AND (p.title IS NULL OR LENGTH(p.title) < 3))
BEGIN
    DELETE FROM products_fts WHERE product_id = new.product_id;
END;
