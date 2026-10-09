/**
 * 指定メーカー/レーベルの作品と、指定ジャンル（イメージビデオ）の作品を削除する（D1 + ローカルSQLite）。2026-10-09
 *
 * 対象リストは data/delete_makers_YYYY-MM-DD.json の dbNames（DBでの実表記）と deleteGenres。
 *   - メーカー/レーベル: maker または label の **完全一致**。候補は D1 から索引で引く（D1 にしか無い新しい作品も拾う）。
 *     D1 のバインド変数は1文100個までなので maker 用と label 用を分けて問い合わせる。
 *   - ジャンル: genres に含む作品。genres には索引が無く D1 では全表走査になるので、候補はローカルから選ぶ。
 * 今後の登録は data/blocked_makers.json（makers / blockedGenres）で止める（fanza_daily_update.js / phase3_daily_update.js）。
 *
 * 書き込み枠: 1件あたり約2行（products＋FTSトリガ）。--limit は全体の件数上限（既定30,000件）。
 *
 * 使い方:
 *   node scripts/purge_makers.js --dry-run
 *   node scripts/purge_makers.js [--spec=data/delete_makers_2026-10-09.json] [--limit=30000]
 * 削除した行は data/purged/makers_YYYY-MM-DD.jsonl に全カラム保存する（復旧用）。
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { d1, fanzaShards } = require('./lib/d1');
const { openLocal } = require('./lib/localsqlite.cjs');

const ROOT = path.join(__dirname, '..');
const arg = (name, def) => {
    const a = process.argv.find(x => x.startsWith(`--${name}`));
    if (!a) return def;
    const v = a.split('=')[1];
    return v === undefined ? true : v;
};
const DRY = !!arg('dry-run', false);
const LIMIT = parseInt(arg('limit', '30000'), 10) || 30000;
const SPEC = path.resolve(ROOT, String(arg('spec', 'data/delete_makers_2026-10-09.json')));
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf-8'));
const NAMES = spec.dbNames || spec.names || [];
const GENRES = spec.deleteGenres || [];

const DEL_SQL = ids => `DELETE FROM products WHERE product_id IN (${ids.map(() => '?').join(',')})`;
const today = new Date().toISOString().slice(0, 10);

function appendBackup(rows, label) {
    if (!rows.length) return null;
    const dir = path.join(ROOT, 'data', 'purged');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `makers_${today}.jsonl`);
    fs.appendFileSync(file, rows.map(r => JSON.stringify({ _src: label, ...r })).join('\n') + '\n');
    return file;
}

/** D1 → ローカルの順に同じチャンクを消す */
async function deleteChunked(d1Client, local, ids) {
    let d1Done = 0, localDone = 0;
    for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90);
        await d1Client.execute({ sql: DEL_SQL(chunk), args: chunk });
        d1Done += chunk.length;
        if (local) localDone += (await local.execute({ sql: DEL_SQL(chunk), args: chunk })).rowsAffected ?? 0;
    }
    return { d1Done, localDone };
}

(async () => {
    console.log(`メーカー/レーベル ${NAMES.length}件・ジャンル ${GENRES.join('/') || 'なし'} の作品を削除 — 上限 ${LIMIT}件${DRY ? ' [DRY RUN]' : ''}`);
    const targets = [
        { name: 'MGS',   db: path.join(ROOT, 'data', 'mgs.db'),   d1: () => d1('mgs') },
        { name: 'FANZA', db: path.join(ROOT, 'data', 'fanza.db'), d1: () => fanzaShards() },
    ];
    let grand = 0, budget = LIMIT;
    const deletedIds = new Set();
    const perName = {};
    for (const t of targets) {
        const remote = t.d1();
        const local = fs.existsSync(t.db) ? openLocal(t.db, { readonly: DRY }) : null;
        const byId = new Map();

        // ① メーカー/レーベル（D1 から索引で）。D1 のバインド変数は1文100個までなので名前を90件ずつに分ける
        const chunks = [];
        for (let i = 0; i < NAMES.length; i += 90) chunks.push(NAMES.slice(i, i + 90));
        for (const col of ['maker', 'label']) for (const ch of chunks) {
            const r = await remote.execute({ sql: `SELECT * FROM products WHERE ${col} IN (${ch.map(() => '?').join(',')})`, args: ch });
            for (const row of (r.rows || r)) {
                byId.set(String(row.product_id), row);
                const k = NAMES.includes(row.maker) ? row.maker : row.label;
                perName[k] = (perName[k] || 0) + 1;
            }
        }
        // ローカルにだけ残っている行も消す（D1 では既に消えている・表記が古いなど。D1 側の DELETE は空振りで済む）
        if (local) {
            for (const col of ['maker', 'label']) for (const ch of chunks) {
                const r = await local.execute({ sql: `SELECT * FROM products WHERE ${col} IN (${ch.map(() => '?').join(',')})`, args: ch });
                for (const row of r.rows) if (!byId.has(String(row.product_id))) byId.set(String(row.product_id), row);
            }
        }
        const byName = byId.size;

        // ② ジャンル（ローカルから。D1 の genres は全表走査になるので）
        let byGenre = 0;
        if (local && GENRES.length) {
            const cond = GENRES.map(() => 'genres LIKE ?').join(' OR ');
            const rows = (await local.execute({ sql: `SELECT * FROM products WHERE ${cond}`, args: GENRES.map(g => `%${g}%`) })).rows;
            for (const row of rows) { if (!byId.has(String(row.product_id))) byGenre++; byId.set(String(row.product_id), row); }
        }

        const rows = [...byId.values()].slice(0, Math.max(0, budget));
        console.log(`\n[${t.name}] メーカー/レーベル一致 ${byName}件 ＋ ジャンル一致 ${byGenre}件 → 今回 ${rows.length}件`);
        if (!rows.length || DRY) continue;
        console.log(`  バックアップ: ${appendBackup(rows, t.name)}`);
        const ids = rows.map(r => String(r.product_id));
        const res = await deleteChunked(remote, local, ids);
        console.log(`  削除完了: D1 ${res.d1Done}件 / ローカル ${res.localDone}件`);
        ids.forEach(id => deletedIds.add(id));
        budget -= ids.length; grand += ids.length;
    }
    console.log('\nメーカー/レーベル別（D1で一致した件数）:');
    for (const n of NAMES) console.log(`  ${n.padEnd(24)} ${perName[n] || 0}`);

    // サイトマップから外す（sitemap_lastmod.json は件数が一致しているときだけ同じ位置を落とす）
    if (!DRY && deletedIds.size > 0) {
        for (const dir of [path.join(ROOT, 'site', 'data'), path.join(ROOT, 'site', 'public', 'data')]) {
            const sp = path.join(dir, 'sitemap_cache.json'), lp = path.join(dir, 'sitemap_lastmod.json');
            if (!fs.existsSync(sp)) continue;
            const sm = JSON.parse(fs.readFileSync(sp, 'utf-8'));
            const prods = sm.products || [];
            const keep = prods.map(id => !deletedIds.has(String(id)));
            const removed = keep.filter(k => !k).length;
            if (!removed) continue;
            const lm = fs.existsSync(lp) ? JSON.parse(fs.readFileSync(lp, 'utf-8')) : null;
            sm.products = prods.filter((_, i) => keep[i]);
            fs.writeFileSync(sp, JSON.stringify(sm));
            if (lm && Array.isArray(lm.products) && lm.products.length === prods.length) {
                lm.products = lm.products.filter((_, i) => keep[i]);
                fs.writeFileSync(lp, JSON.stringify(lm));
            }
            console.log(`  サイトマップから除外: ${removed}件 (${path.relative(ROOT, dir)})`);
        }
    }
    console.log(`\n${DRY ? '[DRY RUN] 実際には削除していません' : `✅ 合計 ${grand}件を削除しました`}`);
})().catch(e => { console.error('ERR', e); process.exit(1); });
