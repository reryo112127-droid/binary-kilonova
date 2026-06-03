import { Jimp } from 'jimp';
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
const row = await mgs.execute('SELECT product_id, main_image_url FROM products WHERE main_image_url IS NOT NULL LIMIT 1').then(r => r.rows[0]);
console.log('product_id:', row.product_id);
console.log('main_image_url:', row.main_image_url);

const url = String(row.main_image_url);
const thumbUrl = url.includes('pf_e_') ? url.replace('pf_e_', 'pb_e_') : url;
console.log('fetch URL:', thumbUrl);

// Refererなしで試す
try {
    const res = await fetch(thumbUrl, { signal: AbortSignal.timeout(8000) });
    console.log('Status (no referer):', res.status, res.statusText);
} catch(e) { console.log('Error (no referer):', e.message); }

// Refererありで試す
try {
    const res = await fetch(thumbUrl, {
        headers: { 'Referer': 'https://www.mgstage.com/', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
    });
    console.log('Status (with referer):', res.status, res.statusText);
    if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        console.log('Buffer size:', buf.length, 'bytes');
        const img = await Jimp.fromBuffer(buf);
        console.log('Image size:', img.bitmap.width, 'x', img.bitmap.height);
        console.log('✓ 成功！');
    }
} catch(e) { console.log('Error (with referer):', e.message); }

process.exit(0);
