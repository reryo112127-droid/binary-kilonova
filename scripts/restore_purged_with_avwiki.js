#!/usr/bin/env node
/**
 * purge で削除した作品のうち「av-wiki.net に出演者ページがあるもの」をバックアップから復元する。
 *
 * 背景: purge(出演者不明の旧作を削除)が avwiki バックフィルより先に走っていたため、
 * 「出演者は判明しうるのに未取得だっただけ」の作品まで消していた。
 * 実測でバックアップ118,280件のうち 11,711件 が avwiki にページを持つ。
 * 復元後に avwiki_backfill_actresses.js を回せば出演者が埋まり、
 * 「出演者不明は消す」という方針とも矛盾しなくなる。
 *
 * 使い方:
 *   node scripts/restore_purged_with_avwiki.js --dry-run
 *   node scripts/restore_purged_with_avwiki.js                 # 全件復元
 *   node scripts/restore_purged_with_avwiki.js --file purge_2026-08-22.jsonl
 *   node scripts/restore_purged_with_avwiki.js --limit 3000
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');
const { d1, fanzaShards } = require('./lib/d1');

const ROOT = path.join(__dirname, '..');
const PURGED = path.join(ROOT, 'data', 'purged');
const SLUG_FILE = path.join(ROOT, 'data', 'avwiki_sitemap_slugs.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const val = (f, d) => { const i = args.indexOf(f); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const ONLY_FILE = val('--file', '');
const LIMIT = parseInt(val('--limit', '0'), 10) || Infinity;

const slugs = new Set(JSON.parse(fs.readFileSync(SLUG_FILE, 'utf-8')));
function hasAvwikiPage(pid) {
    const l = String(pid).toLowerCase();
    if (slugs.has(l)) return true;
    const c = l.replace(/^h_\d+/, '').replace(/^\d+/, '');
    const m = c.match(/^([a-z]+)-?0*(\d+)$/);
    return m ? (slugs.has(`${m[1]}-${parseInt(m[2], 10)}`) || slugs.has(`${m[1]}-${m[2]}`)) : false;
}
// MGS品番は必ず '-' を含み、FANZAのcontent_idは含まない
const isMgs = pid => String(pid).includes('-');

async function targetColumns() {
    const out = {};
    const m = await d1('mgs').execute({ sql: 'SELECT * FROM products LIMIT 1', args: [] });
    out.mgsD1 = Object.keys((m.rows || m)[0] || {}).filter(k => isNaN(Number(k)));
    const f = await d1('fanza-0').execute({ sql: 'SELECT * FROM products LIMIT 1', args: [] });
    out.fanzaD1 = Object.keys((f.rows || f)[0] || {}).filter(k => isNaN(Number(k)));
    return out;
}

function buildInsert(cols, row) {
    // product_id を必ず先頭に置く（fanzaShards がこの第1引数でシャードを決めるため）
    const use = ['product_id', ...cols.filter(c => c !== 'product_id' && row[c] !== undefined)];
    const sql = `INSERT OR IGNORE INTO products (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`;
    return { sql, args: use.map(c => (row[c] === undefined ? null : row[c])) };
}

(async () => {
    const cols = await targetColumns();
    const files = fs.readdirSync(PURGED).filter(f => f.endsWith('.jsonl')).sort()
        .filter(f => !ONLY_FILE || f === ONLY_FILE);
    console.log(`対象バックアップ: ${files.join(', ')}`);

    // 復元候補を集める（product_id で重複排除）
    const byId = new Map();
    for (const f of files) {
        const rl = readline.createInterface({ input: fs.createReadStream(path.join(PURGED, f)), crlfDelay: Infinity });
        for await (const line of rl) {
            if (!line.trim()) continue;
            let r; try { r = JSON.parse(line); } catch { continue; }
            const pid = r && r.product_id;
            if (!pid || byId.has(pid) || !hasAvwikiPage(pid)) continue;
            byId.set(String(pid), r);
        }
        console.log(`  ${f} まで → 候補 ${byId.size.toLocaleString()}件`);
    }
    let rows = [...byId.values()];
    if (rows.length > LIMIT) rows = rows.slice(0, LIMIT);
    const mgsRows = rows.filter(r => isMgs(r.product_id));
    const fzRows = rows.filter(r => !isMgs(r.product_id));
    console.log(`\n復元候補: ${rows.length.toLocaleString()}件 (MGS ${mgsRows.length.toLocaleString()} / FANZA ${fzRows.length.toLocaleString()})`);
    if (DRY) { console.log('[DRY RUN] 何も書き込んでいません'); return; }

    // ---- D1 ----
    let d1Done = 0;
    for (const [name, list, db, colset] of [
        ['MGS', mgsRows, d1('mgs'), cols.mgsD1],
        ['FANZA', fzRows, fanzaShards(), cols.fanzaD1],
    ]) {
        for (let i = 0; i < list.length; i += 40) {
            const chunk = list.slice(i, i + 40).map(r => buildInsert(colset, r));
            try { await db.batch(chunk, 'write'); d1Done += chunk.length; }
            catch (e) { console.warn(`  [D1 ${name} 失敗 offset=${i}] ${e.message}`); }
            if ((i / 40) % 10 === 0) process.stdout.write(`  D1復元 ${d1Done.toLocaleString()}/${rows.length.toLocaleString()}\r`);
        }
    }
    console.log(`\n  D1へ復元: ${d1Done.toLocaleString()}件`);

    // ---- ローカルSQLite ----
    let localDone = 0;
    for (const [dbPath, list] of [['data/mgs.db', mgsRows], ['data/fanza.db', fzRows]]) {
        if (!list.length) continue;
        const db = new Database(path.join(ROOT, dbPath));
        const cs = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
        const tx = db.transaction(items => {
            for (const r of items) {
                const s = buildInsert(cs, r);
                try { db.prepare(s.sql).run(...s.args); localDone++; } catch { /* 列不一致等はスキップ */ }
            }
        });
        tx(list);
        db.close();
    }
    console.log(`  ローカルへ復元: ${localDone.toLocaleString()}件`);

    // ---- サイトマップへ戻す ----
    const ids = rows.map(r => String(r.product_id));
    for (const rel of ['site/data/sitemap_cache.json', 'site/public/data/sitemap_cache.json']) {
        const p = path.join(ROOT, rel);
        if (!fs.existsSync(p)) continue;
        const sm = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const set = new Set((sm.products || []).map(String));
        let added = 0;
        for (const id of ids) if (!set.has(id)) { set.add(id); added++; }
        sm.products = [...set];
        fs.writeFileSync(p, JSON.stringify(sm));
        console.log(`  サイトマップへ追加: ${added.toLocaleString()}件 (${rel})`);
    }
    console.log('\n次: node scripts/avwiki_backfill_actresses.js で出演者を埋める');
})().catch(e => { console.error(e); process.exit(1); });
