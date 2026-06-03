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

const rows = await mgs.execute("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='products'").then(r => r.rows);
rows.forEach(r => { console.log('=== ' + r.name + ' ==='); console.log(r.sql); console.log(); });

// FTSの定義も確認
const fts = await mgs.execute("SELECT sql FROM sqlite_master WHERE name='products_fts'").then(r => r.rows[0]);
console.log('=== products_fts ==='); console.log(fts?.sql);

process.exit(0);
