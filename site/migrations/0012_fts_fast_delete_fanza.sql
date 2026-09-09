-- @targets: fanza-0,fanza-1
-- ============================================================
--  products_fts の削除をテーブル全走査から外す（FANZAスリムスキーマ用 / 0006 の置き換え）
--
--  2026-09-09 実測: products の1行 UPDATE が **193,833行**（= products_fts の全行）を読んでいた。
--
--    EXPLAIN QUERY PLAN DELETE FROM products_fts WHERE product_id = ?
--      → SCAN products_fts VIRTUAL TABLE INDEX 0:      ← 全走査
--
--  原因は 0004/0006 の AFTER UPDATE / AFTER DELETE トリガが
--  `DELETE FROM products_fts WHERE product_id = old.product_id` と書いていること。
--  **product_id は FTS5 の UNINDEXED 列なので索引が無く、fts5 は全行を舐めるしかない**。
--  出演者バックフィル（avwiki / seesaawiki）は1件補完するたびにこれを踏むので、
--  2026-09-07〜09-08 は UPDATE だけで 1日 150万行以上を読んでいた。
--
--  対策: 削除対象の rowid を **title の trigram MATCH で引いてから** rowid で消す。
--    DELETE FROM products_fts
--     WHERE rowid IN (SELECT rowid FROM products_fts
--                      WHERE products_fts MATCH '{title} : "…"' AND product_id = old.product_id)
--      → SCAN products_fts VIRTUAL TABLE INDEX 0:M5（MATCH駆動）＋ rowid の点引き
--      実測 193,833行 → **1行**。
--
--  ・title は trigram で索引されているので MATCH で引ける（product_id は引けない）。
--  ・別作品が同じタイトルを持っていても `product_id = old.product_id` で絞るので誤削除しない。
--  ・trigram は3文字未満を索引できないため、title が NULL / 2文字以下のときだけ
--    従来どおりの全走査版（*_slow）にフォールバックする。
--  ・MATCH のフレーズは 60文字までに切る（長すぎるフレーズを避ける。部分一致なので引ける）。
--    フレーズ中の " は "" にエスケープする。
--
--  適用: node scripts/apply_fts_triggers.mjs（DDLなので0行。枠切れ中でも実行できる）
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
   OR old.label     IS NOT new.label)
  AND old.title IS NOT NULL AND LENGTH(old.title) >= 3
BEGIN
    DELETE FROM products_fts
     WHERE rowid IN (
        SELECT rowid FROM products_fts
         WHERE products_fts MATCH '{title} : "' || REPLACE(SUBSTR(old.title, 1, 60), '"', '""') || '"'
           AND product_id = old.product_id
     );
    INSERT INTO products_fts(product_id, title, actresses, genres, label)
    VALUES (new.product_id, new.title, new.actresses, new.genres, new.label);
END;

CREATE TRIGGER products_au_slow AFTER UPDATE ON products
WHEN (old.title     IS NOT new.title
   OR old.actresses IS NOT new.actresses
   OR old.genres    IS NOT new.genres
   OR old.label     IS NOT new.label)
  AND (old.title IS NULL OR LENGTH(old.title) < 3)
BEGIN
    DELETE FROM products_fts WHERE product_id = old.product_id;
    INSERT INTO products_fts(product_id, title, actresses, genres, label)
    VALUES (new.product_id, new.title, new.actresses, new.genres, new.label);
END;
