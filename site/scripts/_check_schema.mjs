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

const [mgsSchema, fanzaSchema] = await Promise.all([
    mgs.execute("PRAGMA table_info(products)").then(r => r.rows),
    fanza.execute("PRAGMA table_info(products)").then(r => r.rows),
]);

console.log('=== MGS columns ===');
mgsSchema.forEach(r => console.log(`  ${r.name} (${r.type})`));

console.log('\n=== FANZA columns ===');
fanzaSchema.forEach(r => console.log(`  ${r.name} (${r.type})`));

// まんまんランドのサンプルを全カラム取得
const [mgsSample, fanzaSample] = await Promise.all([
    mgs.execute({
        sql: "SELECT * FROM products WHERE maker LIKE '%まんまん%' LIMIT 2",
        args: []
    }).then(r => r.rows),
    fanza.execute({
        sql: "SELECT * FROM products WHERE maker LIKE '%まんまん%' LIMIT 2",
        args: []
    }).then(r => r.rows),
]);

console.log('\n=== MGS サンプル ===');
if (mgsSample[0]) Object.entries(mgsSample[0]).forEach(([k,v]) => { if (v) console.log(`  ${k}: ${String(v).slice(0,60)}`); });

console.log('\n=== FANZA サンプル ===');
if (fanzaSample[0]) Object.entries(fanzaSample[0]).forEach(([k,v]) => { if (v) console.log(`  ${k}: ${String(v).slice(0,60)}`); });

process.exit(0);
