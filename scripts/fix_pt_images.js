/**
 * main_image_url が極小サムネ pt.jpg(90×122) で保存されている作品を、
 * 本来の大きい pl.jpg(800×538) に修正する。pl が無ければ ps.jpg にフォールバック。
 * ローカル fanza.db と D1(両シャード) の両方を更新する。
 *   node scripts/fix_pt_images.js
 */
const path = require('path');
const D = require('better-sqlite3');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { d1 } = require('./lib/d1.js');
const ROOT = path.join(__dirname, '..');

async function realSize(url) {
    try {
        const r = await fetch(url);
        if (!r.ok) return 0;
        const b = await r.arrayBuffer();
        return b.byteLength;
    } catch { return 0; }
}

// pt.jpg → pl.jpg(実在すれば) → ps.jpg(実在すれば) の順で最良URLを決める
async function bestUrl(ptUrl) {
    const pl = ptUrl.replace(/pt\.jpg$/, 'pl.jpg');
    if (await realSize(pl) > 2000) return pl;
    const ps = ptUrl.replace(/pt\.jpg$/, 'ps.jpg');
    if (await realSize(ps) > 2000) return ps;
    return null; // どちらも無ければ pt のまま据え置き
}

(async () => {
    const db = new D(path.join(ROOT, 'data', 'fanza.db'));
    const rows = db.prepare('SELECT product_id, main_image_url FROM products WHERE main_image_url LIKE ?').all('%pt.jpg');
    console.log('pt.jpg 保存:', rows.length, '件');

    // 並列でベストURLを解決
    const updates = []; // [product_id, newUrl]
    const CONC = 10;
    let idx = 0, resolved = 0;
    async function worker() {
        while (idx < rows.length) {
            const r = rows[idx++];
            const nu = await bestUrl(r.main_image_url);
            if (nu) updates.push([r.product_id, nu]);
            resolved++;
            if (resolved % 50 === 0) process.stdout.write(`  解決 ${resolved}/${rows.length}\r`);
        }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    const toPl = updates.filter(u => u[1].endsWith('pl.jpg')).length;
    const toPs = updates.filter(u => u[1].endsWith('ps.jpg')).length;
    console.log(`\n更新対象: ${updates.length}件 (pl:${toPl} / ps:${toPs}) / 据え置き:${rows.length - updates.length}件`);

    // ローカル fanza.db 更新
    const upd = db.prepare('UPDATE products SET main_image_url = ? WHERE product_id = ?');
    const tx = db.transaction((list) => { for (const [id, url] of list) upd.run(url, id); });
    tx(updates);
    db.close();
    console.log('✅ ローカル fanza.db 更新完了');

    // D1 両シャード更新（該当しないシャードは0行更新=書き込み計上されない）
    for (const sh of ['fanza-0', 'fanza-1']) {
        const c = d1(sh);
        const BATCH = 40;
        let done = 0;
        for (let i = 0; i < updates.length; i += BATCH) {
            const chunk = updates.slice(i, i + BATCH);
            const stmts = chunk.map(([id, url]) => ({ sql: 'UPDATE products SET main_image_url = ? WHERE product_id = ?', args: [url, id] }));
            for (let a = 0; a < 4; a++) {
                try { await c.batch(stmts); break; }
                catch (e) { if (/429|CPU/.test(e.message) && a < 3) { await new Promise(r => setTimeout(r, 3000 * (a + 1))); continue; } throw e; }
            }
            done += chunk.length;
            process.stdout.write(`  ${sh}: ${done}/${updates.length}\r`);
        }
        console.log(`\n✅ D1 ${sh} 更新完了`);
    }
    console.log('完了');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
