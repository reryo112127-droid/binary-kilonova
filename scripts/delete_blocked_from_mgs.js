/**
 * blocked_makers.json のメーカー作品を MGS（ローカルmgs.db + D1 avrankings-mgs）から削除する。
 * D1のCPU時間制限を避けるため products_ad(FTS削除)トリガを止めて product_id を小分けDELETE。
 *   node scripts/delete_blocked_from_mgs.js
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { d1 } = require('./lib/d1.js');

const ROOT = path.join(__dirname, '..');
const blocked = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'blocked_makers.json'), 'utf-8')).makers || [];
const mph = blocked.map(() => '?').join(',');

const PRODUCTS_AD = `CREATE TRIGGER IF NOT EXISTS products_ad AFTER DELETE ON products BEGIN
    DELETE FROM products_fts WHERE product_id = old.product_id;
END`;

(async () => {
    // 1) ローカル mgs.db から削除
    const local = new Database(path.join(ROOT, 'data', 'mgs.db'));
    const localN = local.prepare(`DELETE FROM products WHERE maker IN (${mph})`).run(...blocked).changes;
    local.close();
    console.log(`✅ ローカル mgs.db 削除: ${localN.toLocaleString()} 件`);

    // 2) D1 avrankings-mgs から削除
    const db = d1('mgs');
    const ids = [];
    const PAGE = 5000;
    for (let off = 0; ; off += PAGE) {
        const r = await db.execute({ sql: `SELECT product_id FROM products WHERE maker IN (${mph}) LIMIT ? OFFSET ?`, args: [...blocked, PAGE, off] });
        ids.push(...r.rows.map(x => String(x.product_id)));
        if (r.rows.length < PAGE) break;
    }
    console.log(`[MGS D1] 削除対象: ${ids.length.toLocaleString()} 件`);
    if (ids.length === 0) { console.log('対象なし'); return; }

    await db.execute('DROP TRIGGER IF EXISTS products_au');  // d1.jsでno-op
    await db.execute('DROP TRIGGER IF EXISTS products_ad');
    let done = 0;
    const CH = 90;
    try {
        for (let i = 0; i < ids.length; i += CH) {
            const chunk = ids.slice(i, i + CH);
            const ph = chunk.map(() => '?').join(',');
            await db.execute({ sql: `DELETE FROM products WHERE product_id IN (${ph})`, args: chunk });
            done += chunk.length;
            if (done % 1800 === 0) process.stdout.write(`  MGS: ${done}/${ids.length}\r`);
        }
    } finally {
        await db.execute(PRODUCTS_AD);
    }
    console.log(`\n✅ MGS D1 削除完了: ${done.toLocaleString()} 件`);
    console.log('次: node site/scripts/generate-static-cache-local.mjs → cd site && npm run deploy:cf');
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
