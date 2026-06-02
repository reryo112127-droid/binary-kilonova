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

// MGSの全product_idを取得
console.log('MGS product_idを取得中...');
const mgsIds = await mgs.execute('SELECT product_id FROM products').then(r => new Set(r.rows.map(r => String(r.product_id))));
console.log('MGS総件数:', mgsIds.size);

// FANZAで同じproduct_idを持つ作品を検索
console.log('FANZA重複チェック中...');
const fanzaRows = await fanza.execute('SELECT product_id, maker FROM products').then(r => r.rows);
console.log('FANZA総件数:', fanzaRows.length);

const duplicates = fanzaRows.filter(r => mgsIds.has(String(r.product_id)));
console.log('\n重複件数:', duplicates.length);

// メーカー別集計
const byMaker = {};
for (const r of duplicates) {
    const m = String(r.maker || '不明');
    byMaker[m] = (byMaker[m] || 0) + 1;
}
const sorted = Object.entries(byMaker).sort((a, b) => b[1] - a[1]);
console.log('\n上位20メーカー:');
sorted.slice(0, 20).forEach(([maker, cnt]) => console.log(`  ${maker}: ${cnt}件`));

// まんまんランド確認
const manman = duplicates.filter(r => String(r.maker || '').includes('まんまん'));
console.log(`\nまんまんランド重複: ${manman.length}件`);

process.exit(0);
