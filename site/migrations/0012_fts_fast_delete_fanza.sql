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
