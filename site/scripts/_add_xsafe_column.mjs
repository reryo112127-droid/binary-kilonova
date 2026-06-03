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

// カラム存在確認
const info = await mgs.execute("PRAGMA table_info(products)").then(r => r.rows);
const hasXSafe = info.some(r => String(r.name) === 'x_safe');
console.log('x_safe カラム存在:', hasXSafe);
if (!hasXSafe) {
    console.log('カラム追加中...');
    await mgs.execute('ALTER TABLE products ADD COLUMN x_safe INTEGER DEFAULT NULL');
    console.log('✓ 追加成功');
} else {
    console.log('既に存在します');
}

// 簡単なUPDATEテスト
const testRow = await mgs.execute("SELECT product_id FROM products LIMIT 1").then(r => r.rows[0]);
console.log('UPDATEテスト:', testRow.product_id);
await mgs.execute({ sql: 'UPDATE products SET x_safe = 1 WHERE product_id = ?', args: [testRow.product_id] });
console.log('✓ UPDATE成功');

process.exit(0);
