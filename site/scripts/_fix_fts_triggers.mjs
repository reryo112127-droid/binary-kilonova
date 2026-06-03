import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const mgs = createClient({ url: process.env.TURSO_MGS_URL, authToken: process.env.TURSO_MGS_TOKEN });

console.log('既存トリガーを削除...');
await mgs.execute('DROP TRIGGER IF EXISTS products_ai');
await mgs.execute('DROP TRIGGER IF EXISTS products_au');
console.log('✓ 削除完了');

console.log('トリガーを再作成（maker/label追加）...');
await mgs.execute(`
  CREATE TRIGGER products_ai AFTER INSERT ON products BEGIN
    INSERT INTO products_fts(rowid, product_id, title, actresses, genres, maker, label)
    VALUES (new.rowid, new.product_id, new.title, new.actresses, new.genres, new.maker, new.label);
  END
`);
await mgs.execute(`
  CREATE TRIGGER products_au AFTER UPDATE ON products BEGIN
    INSERT INTO products_fts(products_fts, rowid, product_id, title, actresses, genres, maker, label)
    VALUES('delete', old.rowid, old.product_id, old.title, old.actresses, old.genres, old.maker, old.label);
    INSERT INTO products_fts(rowid, product_id, title, actresses, genres, maker, label)
    VALUES (new.rowid, new.product_id, new.title, new.actresses, new.genres, new.maker, new.label);
  END
`);
console.log('✓ トリガー再作成完了');

// UPDATEテスト
const pid = await mgs.execute('SELECT product_id FROM products LIMIT 1').then(r => String(r.rows[0].product_id));
await mgs.execute({ sql: 'UPDATE products SET x_safe = 1 WHERE product_id = ?', args: [pid] });
console.log('✓ UPDATEテスト成功:', pid);

process.exit(0);
