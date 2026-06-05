/**
 * MGS から videoc重複判定用インデックス data/videoc_dedup_index.json を生成。
 *   { fanzaPid: mgsTitle }  （MGS品番を変換した fanzaPid をキー、MGSタイトルを値）
 *
 * 優先: ローカル data/mgs.db（better-sqlite3）。無ければ MGS D1 からページング取得。
 * MGS日次更新(phase3)の後に実行して最新化する。
 *
 * 使い方: node scripts/build_dedup_index.js
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { toFanzaPid, nameCore } = require('./lib/dedup.cjs');

const MGS_DB = path.join(__dirname, '..', 'data', 'mgs.db');
const OUT    = path.join(__dirname, '..', 'data', 'videoc_dedup_index.json');

async function loadRows() {
    if (fs.existsSync(MGS_DB)) {
        const Database = require('better-sqlite3');
        const db = new Database(MGS_DB, { readonly: true });
        const rows = db.prepare('SELECT product_id, title FROM products').all();
        db.close();
        console.log(`[local] mgs.db から ${rows.length.toLocaleString()} 件`);
        return rows;
    }
    // D1 フォールバック（ページング）
    const { d1 } = require('./lib/d1.js');
    const db = d1('mgs');
    const rows = [];
    const PAGE = 10000;
    for (let off = 0; ; off += PAGE) {
        const r = await db.execute({ sql: 'SELECT product_id, title FROM products LIMIT ? OFFSET ?', args: [PAGE, off] });
        rows.push(...r.rows);
        if (r.rows.length < PAGE) break;
    }
    console.log(`[D1] avrankings-mgs から ${rows.length.toLocaleString()} 件`);
    return rows;
}

(async () => {
    const rows = await loadRows();
    const index = {};
    let n = 0;
    for (const r of rows) {
        const fp = toFanzaPid(r.product_id);
        if (!fp || (fp in index)) continue;
        const core = nameCore(r.title);
        if (!core) continue;           // タイトルコアが空なら判定不能なのでインデックスに入れない
        index[fp] = core;
        n++;
    }
    fs.writeFileSync(OUT, JSON.stringify(index));
    const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
    console.log(`✅ ${OUT} 生成: ${n.toLocaleString()} エントリ (${kb} KB)`);
})().catch(e => { console.error(e); process.exit(1); });
