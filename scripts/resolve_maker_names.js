/**
 * ユーザーが書いたメーカー/レーベル名を、DB での実際の表記に対応づける（削除リスト作成の補助）。2026-10-09
 *
 * 表記ゆれ（半角/全角かっこ、' と ’、全角英数字、空白）を NFKC＋記号の正規化でそろえて照合する。
 * 照合先はローカルDB（fanza.db / mgs.db）の maker・label と、site/data/makers_cache.json（D1 由来の一覧）。
 *
 *   node scripts/resolve_maker_names.js data/delete_makers_XXXX.json
 * → spec に dbNames（DBでの表記。複数あれば全部）を書き足し、見つからない名前を表示する。
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const specPath = path.resolve(ROOT, process.argv[2]);
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const norm = s => String(s || '').normalize('NFKC').replace(/[’‘`´]/g, "'").replace(/\s+/g, '').toLowerCase();

const found = new Map(); // norm → Map(raw → 件数の説明)
const add = (raw, note) => {
    if (!raw) return;
    const k = norm(raw);
    if (!found.has(k)) found.set(k, new Map());
    const m = found.get(k);
    m.set(raw, [m.get(raw), note].filter(Boolean).join(' '));
};
for (const [pf, file] of [['F', 'fanza.db'], ['M', 'mgs.db']]) {
    const db = new Database(path.join(ROOT, 'data', file), { readonly: true });
    for (const col of ['maker', 'label']) {
        for (const r of db.prepare(`SELECT ${col} v, COUNT(*) n FROM products GROUP BY ${col}`).all()) add(r.v, `${pf}:${col}(${r.n})`);
    }
    db.close();
}
for (const m of JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'data', 'makers_cache.json'), 'utf8'))) add(m.name, `一覧(${m.count})`);

const dbNames = [], missing = [];
for (const n of spec.names) {
    const hit = found.get(norm(n));
    if (!hit) { missing.push(n); dbNames.push(n); continue; }
    for (const [raw, note] of hit) { dbNames.push(raw); if (raw !== n) console.log(`  表記ちがい: ${n} → ${raw}  ${note}`); }
}
spec.dbNames = [...new Set(dbNames)];
fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
console.log(`\n${spec.names.length}件中 ${spec.names.length - missing.length}件がDBか一覧に見つかった（dbNames ${spec.dbNames.length}件）`);
console.log(`見つからない名前（完全一致で削除を試みる。0件なら何もしない）: ${missing.join(' / ') || 'なし'}`);
