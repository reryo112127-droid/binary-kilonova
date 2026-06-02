import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const mgs = createClient({ url: process.env.TURSO_MGS_URL, authToken: process.env.TURSO_MGS_TOKEN });
const r = await mgs.execute({
    sql: 'SELECT maker, COUNT(*) as cnt FROM products WHERE maker LIKE ? OR maker LIKE ? GROUP BY maker ORDER BY cnt DESC',
    args: ['%ドキュメン%', '%DIEGO%']
});
if (r.rows.length === 0) console.log('該当なし（DBに未登録）');
r.rows.forEach(row => console.log(row.maker + ': ' + row.cnt + '件'));
process.exit(0);
