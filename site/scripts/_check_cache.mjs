import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(path.join(ROOT, 'data', 'makers_cache.json'), 'utf-8'));
console.log('総件数:', data.length);
const sorted = [...data].sort((a, b) => a.count - b.count);
console.log('最小count:', sorted[0]?.count, sorted[0]?.name);
console.log('最大count:', sorted[sorted.length-1]?.count, sorted[sorted.length-1]?.name);

const targets = ['はめちゃん。', 'NTR.net', 'セイキョウイク', 'ドキュメンTV', 'DIEGO'];
for (const t of targets) {
    const found = data.find(d => d.name === t);
    console.log(t + ':', found ? found.count + '件' : 'なし');
}
process.exit(0);
