import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const mgs   = createClient({ url: process.env.TURSO_MGS_URL,   authToken: process.env.TURSO_MGS_TOKEN });
const fanza = createClient({ url: process.env.TURSO_FANZA_URL, authToken: process.env.TURSO_FANZA_TOKEN });

const [mgsRows, fanzaRows] = await Promise.all([
    mgs.execute({
        sql: "SELECT product_id, title FROM products WHERE maker LIKE '%まんまん%' LIMIT 5",
        args: []
    }).then(r => r.rows),
    fanza.execute({
        sql: "SELECT product_id, title FROM products WHERE maker LIKE '%まんまん%' LIMIT 5",
        args: []
    }).then(r => r.rows),
]);

console.log('=== MGS まんまんランド ===');
mgsRows.forEach(r => console.log(`  ${r.product_id} | ${String(r.title || '').slice(0,40)}`));
console.log('\n=== FANZA まんまんランド ===');
fanzaRows.forEach(r => console.log(`  ${r.product_id} | ${String(r.title || '').slice(0,40)}`));

// タイトルの類似検索（MGS側タイトルをFANZAで検索）
if (mgsRows.length > 0) {
    const sampleTitle = String(mgsRows[0].title || '').slice(0, 10);
    const fanzaMatch = await fanza.execute({
        sql: "SELECT product_id, title FROM products WHERE title LIKE ? LIMIT 3",
        args: [`%${sampleTitle}%`]
    }).then(r => r.rows);
    console.log(`\n=== タイトル検索「${sampleTitle}」FANZA結果 ===`);
    fanzaMatch.forEach(r => console.log(`  ${r.product_id} | ${String(r.title || '').slice(0,50)}`));
}

process.exit(0);
