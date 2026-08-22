#!/usr/bin/env node
/**
 * D1 の出演者情報をローカルSQLite(data/mgs.db, data/fanza.db)へ同期する。
 *
 * AVWIKI/seesaawiki 由来の出演者補完は **D1 だけ** を更新してきたため、ローカルDBが
 * 大きく取り残されている(実測: FANZA 出演者不明 ローカル94,294件 vs D1 36,104件)。
 * ホームの新作/人気/ランキングの静的キャッシュは generate-static-cache-local.mjs が
 * **ローカルSQLIte から** 生成するので、この乖離があると
 * 「D1には出演者があるのにサイトのカードは女優名が空」という状態になる。
 *
 * 方向は D1 → ローカルの一方向で、**ローカルが空の行だけ** を埋める（上書きしない）。
 *
 * 使い方:
 *   node scripts/sync_actresses_d1_to_local.js --dry-run
 *   node scripts/sync_actresses_d1_to_local.js
 *   node scripts/sync_actresses_d1_to_local.js --only mgs
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const Database = require('better-sqlite3');
const { d1, fanzaShards } = require('./lib/d1');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const oi = args.indexOf('--only');
const ONLY = oi !== -1 && args[oi + 1] ? String(args[oi + 1]).toLowerCase() : '';

const EMPTY = "(actresses IS NULL OR TRIM(actresses)='' OR TRIM(actresses)='----')";
const CHUNK = 50; // D1のバインド変数は1クエリ100個まで。余裕を持って50。

async function syncOne(name, dbPath, getRemote) {
    const local = new Database(path.join(__dirname, '..', dbPath), { readonly: DRY });
    const pids = local.prepare(`SELECT product_id FROM products WHERE ${EMPTY}`).all().map(r => String(r.product_id));
    console.log(`\n[${name}] ローカルで出演者が空: ${pids.length.toLocaleString()}件`);
    if (pids.length === 0) { local.close(); return 0; }

    const upd = DRY ? null : local.prepare(`UPDATE products SET actresses = ? WHERE product_id = ? AND ${EMPTY}`);
    const applyBatch = DRY ? null : local.transaction(rows => { for (const r of rows) upd.run(r.actresses, r.product_id); });

    let filled = 0;
    for (let i = 0; i < pids.length; i += CHUNK) {
        const chunk = pids.slice(i, i + CHUNK);
        const ph = chunk.map(() => '?').join(',');
        let rows = [];
        try {
            const r = await getRemote().execute({
                sql: `SELECT product_id, actresses FROM products WHERE product_id IN (${ph}) AND NOT ${EMPTY}`,
                args: chunk,
            });
            rows = (r.rows || r).map(x => ({ product_id: String(x.product_id), actresses: String(x.actresses) }));
        } catch (e) {
            console.warn(`  [取得エラー offset=${i}] ${e.message}`);
            continue;
        }
        if (rows.length) {
            if (!DRY) applyBatch(rows);
            filled += rows.length;
        }
        if ((i / CHUNK) % 20 === 0) process.stdout.write(`  ${Math.min(i + CHUNK, pids.length).toLocaleString()}/${pids.length.toLocaleString()} 照合 / ${filled.toLocaleString()}件補完\r`);
    }
    console.log(`\n[${name}] ${DRY ? '補完できる' : '補完した'}件数: ${filled.toLocaleString()}`);
    local.close();
    return filled;
}

(async () => {
    console.log(`D1 → ローカルSQLite 出演者同期${DRY ? ' [DRY RUN]' : ''}`);
    let total = 0;
    if (!ONLY || ONLY === 'mgs')   total += await syncOne('MGS',   'data/mgs.db',   () => d1('mgs'));
    if (!ONLY || ONLY === 'fanza') total += await syncOne('FANZA', 'data/fanza.db', () => fanzaShards());
    console.log(`\n合計: ${total.toLocaleString()}件`);
    if (!DRY) console.log('※ 次回の generate-static-cache-local.mjs でサイトのカードにも反映されます');
})().catch(e => { console.error(e); process.exit(1); });
