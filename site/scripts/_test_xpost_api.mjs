import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const ADMIN_KEY = process.env.ADMIN_KEY;
const BASE = 'https://avrankings.com';

// 新作1件の詳細を確認
const res = await fetch(`${BASE}/api/admin/x-post?genre=new&limit=1`, {
    headers: { 'x-admin-key': ADMIN_KEY }
});
const data = await res.json();
console.log('status:', res.status);
console.log('件数:', data.length);
if (data[0]) {
    console.log('product_id:', data[0].product_id);
    console.log('title:', String(data[0].title || '').slice(0, 40));
    console.log('main_image_url:', String(data[0].main_image_url || '').slice(0, 60));
    console.log('actresses:', data[0].actresses);
    console.log('discount_pct:', data[0].discount_pct);
    console.log('sample_images:', data[0].sample_images?.length, '枚');
    console.log('全キー:', Object.keys(data[0]));
}
process.exit(0);
