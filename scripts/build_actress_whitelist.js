/**
 * 実在女優名のホワイトリスト(名前のみ)を生成する。
 * filterActresses(site/lib/actressFilter.ts)が静的importしてWorkersでも同期参照できるようにする。
 * 素人作品の出演者から「役名/通称」を除去し、ホワイトリスト掲載の実在女優のみ残すために使う。
 *
 * ソース: actress_display_cache.json(FANZA登録6万) + actresses_all + avwiki(full/product_map) + aliases
 * 出力: site/data/actress_whitelist.json （名前配列・スペース正規化済み）
 * 使い方: node scripts/build_actress_whitelist.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// 名前正規化: 前後trim + 内部の空白を除去（avwikiの「佐々木 ひな」→「佐々木ひな」）
const norm = s => String(s || '').trim().replace(/\s+/g, '');

const names = new Set();
const add = s => { const n = norm(s); if (n) names.add(n); };

// 1) FANZA登録6万（public/data/actress_display_cache.json のキー）
try {
    const p = path.join(ROOT, 'site', 'public', 'data', 'actress_display_cache.json');
    const m = JSON.parse(fs.readFileSync(p, 'utf-8'));
    Object.keys(m).forEach(add);
    console.log(`actress_display_cache: ${Object.keys(m).length}`);
} catch (e) { console.warn('display_cache skip:', e.message); }

// 2) actresses_all.json
try {
    JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'actresses_all.json'), 'utf-8')).forEach(a => add(a.name));
} catch {}

// 3) actress_aliases.json（別名グループ）
try {
    JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'actress_aliases.json'), 'utf-8')).forEach(g => g.forEach(add));
} catch {}

// 4) avwiki_full.jsonl（女優プロフィール名）
try {
    fs.readFileSync(path.join(ROOT, 'data', 'avwiki_full.jsonl'), 'utf-8').split('\n').filter(Boolean)
        .forEach(l => { try { const j = JSON.parse(l); if (j.name) add(j.name); (j.aliases || []).forEach(add); } catch {} });
} catch {}

// 5) avwiki_product_map.jsonl（作品の出演者名）
try {
    fs.readFileSync(path.join(ROOT, 'data', 'avwiki_product_map.jsonl'), 'utf-8').split('\n').filter(Boolean)
        .forEach(l => { try { (JSON.parse(l).actresses || []).forEach(add); } catch {} });
} catch {}

const out = path.join(ROOT, 'site', 'data', 'actress_whitelist.json');
const arr = [...names].sort();
fs.writeFileSync(out, JSON.stringify(arr));
console.log(`✅ ${out}: ${arr.length.toLocaleString()} 名 (${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB)`);
