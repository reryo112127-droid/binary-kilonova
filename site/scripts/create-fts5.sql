CREATE VIRTUAL TABLE IF NOT EXISTS products_fts
  USING fts5(product_id, title, actresses, genres,
             content=products, content_rowid=rowid,
             tokenize='trigram');

INSERT INTO products_fts(products_fts) VALUES('rebuild');

CREATE TRIGGER IF NOT EXISTS products_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(rowid, product_id, title, actresses, genres)
  VALUES (new.rowid, new.product_id, new.title, new.actresses, new.genres);
END;

CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, product_id, title, actresses, genres)
  VALUES('delete', old.rowid, old.product_id, old.title, old.actresses, old.genres);
  INSERT INTO products_fts(rowid, product_id, title, actresses, genres)
  VALUES (new.rowid, new.product_id, new.title, new.actresses, new.genres);
END;
