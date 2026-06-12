/**
 * MGSとFANZAに同一作品が両方ある場合の品番対応表を作る。
 * 品番を共通コア(label+番号)に正規化し、MGS品番 ⇔ FANZA品番 を相互マッピング。
 * 商品詳細ページで両プラットフォームのアフィリリンク・価格比較を出すために使う。
 *   node scripts/build_cross_platform.js
 * 出力: data/cross_platform.json + site/public/data/cross_platform.json
 *   { "<id>": "<counterpartId>", ... }（両方向）
 */
const path = require('path');
const fs = require('fs');
const D = require('better-sqlite3');
const ROOT = path.join(__dirname, '..');

function coreId(id) {
    let s = String(id || '').toLowerCase().replace(/^h_\d+/, '').replace(/^\d+/, '').replace(/[^a-z0-9]/g, '');
    const m = s.match(/^([a-z]+)0*(\d+)$/);
    return m ? m[1] + m[2] : s;
}

function loadIds(dbPath) {
    const db = new D(dbPath, { readonly: true });
    const map = new Map(); // core -> id（同コア複数なら先頭=代表）
    for (const r of db.prepare('SELECT product_id FROM products').all()) {
        const c = coreId(r.product_id);
        if (c && !map.has(c)) map.set(c, String(r.product_id));
    }
    db.close();
    return map;
}

const mgs = loadIds(path.join(ROOT, 'data', 'mgs.db'));
const fanza = loadIds(path.join(ROOT, 'data', 'fanza.db'));
console.log('MGS品番コア:', mgs.size, '| FANZA品番コア:', fanza.size);

const out = {};
let pairs = 0;
for (const [core, mgsId] of mgs) {
    const fanzaId = fanza.get(core);
    if (fanzaId) { out[mgsId] = fanzaId; out[fanzaId] = mgsId; pairs++; }
}
console.log('両プラットフォーム対応:', pairs, '作品');

const json = JSON.stringify(out);
fs.writeFileSync(path.join(ROOT, 'data', 'cross_platform.json'), json);
fs.writeFileSync(path.join(ROOT, 'site', 'public', 'data', 'cross_platform.json'), json);
console.log('✅ cross_platform.json 出力 (', (json.length / 1024).toFixed(0), 'KB )');
