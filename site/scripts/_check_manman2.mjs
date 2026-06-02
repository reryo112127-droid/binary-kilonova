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

// FANZA: maker='まんまんランド' 完全一致
const fanzaExact = await fanza.execute({
    sql: "SELECT product_id, title, actresses, maker, label FROM products WHERE maker = 'まんまんランド' OR label = 'まんまんランド' LIMIT 5",
    args: []
}).then(r => r.rows);

console.log(`FANZA maker='まんまんランド' 件数: ${fanzaExact.length}`);
fanzaExact.forEach(r => console.log(`  ${r.product_id} | ${r.maker} / ${r.label} | ${r.actresses} | ${String(r.title||'').slice(0,40)}`));

// MGS: maker='まんまんランド' サンプル5件（タイトル・役名確認用）
const mgsSample = await mgs.execute({
    sql: "SELECT product_id, title, actresses FROM products WHERE maker = 'まんまんランド' LIMIT 5",
    args: []
}).then(r => r.rows);
console.log(`\nMGS maker='まんまんランド' 件数（上位5件）:`);
mgsSample.forEach(r => console.log(`  ${r.product_id} | ${r.actresses} | ${String(r.title||'').slice(0,40)}`));

// FANZAで476MLAシリーズを検索（MGSと同じ品番がFANZAにあるか）
const fanza476 = await fanza.execute({
    sql: "SELECT product_id, title, maker FROM products WHERE product_id LIKE '476mla%' OR product_id LIKE '476MLA%' LIMIT 5",
    args: []
}).then(r => r.rows);
console.log(`\nFANZA 476MLAシリーズ: ${fanza476.length}件`);
fanza476.forEach(r => console.log(`  ${r.product_id} | ${r.maker}`));

process.exit(0);
