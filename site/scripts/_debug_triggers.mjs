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

// トリガー一覧
const triggers = await mgs.execute("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='products'").then(r => r.rows);
console.log('トリガー数:', triggers.length);
triggers.forEach(t => console.log(' -', t.name));

// 既存カラムだけのUPDATEテスト（wish_count）
const pid = '001BTG-001';
try {
    await mgs.execute({ sql: 'UPDATE products SET wish_count = wish_count WHERE product_id = ?', args: [pid] });
    console.log('wish_count UPDATE: ✓');
} catch(e) { console.log('wish_count UPDATE error:', e.message); }

// x_safeのUPDATEテスト
try {
    await mgs.execute({ sql: 'UPDATE products SET x_safe = 1 WHERE product_id = ?', args: [pid] });
    console.log('x_safe UPDATE: ✓');
} catch(e) { console.log('x_safe UPDATE error:', e.message); }

// FTSテーブル確認
const fts = await mgs.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%'").then(r => r.rows);
console.log('\nFTSテーブル:', fts.map(r => r.name));

process.exit(0);
