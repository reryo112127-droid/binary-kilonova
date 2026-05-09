/**
 * merge_avwiki_aliases.js
 *
 * avwiki_full.jsonl の aliases・retired・romaji データを反映する
 *
 * 処理:
 *   1. actress_aliases.json に AVWiki 別名を統合（グループマージ）
 *   2. actress_profiles (Turso) の aliases・augmented フィールドを更新
 *   3. Turso に retired カラムを追加してフラグを設定
 */

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATA_DIR    = path.join(__dirname, '..', 'data');
const AVWIKI_FILE = path.join(DATA_DIR, 'avwiki_full.jsonl');
const ALIAS_FILE  = path.join(DATA_DIR, 'actress_aliases.json');

// ── AVWiki データ読み込み ─────────────────────────────
const avwikiRecords = fs.readFileSync(AVWIKI_FILE, 'utf-8')
    .trim().split('\n').filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(d => d.name); // 名前なしは除外

console.log('AVWiki レコード数:', avwikiRecords.length);

// ── 1. actress_aliases.json 統合 ──────────────────────
console.log('\n[1] actress_aliases.json に AVWiki 別名を統合...');

const existing = JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf-8'));

// Union-Find でグループ管理
const parent = new Map();
function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
}
function union(a, b) {
    const pa = find(a), pb = find(b);
    if (pa !== pb) parent.set(pa, pb);
}

// 既存グループを登録
for (const group of existing) {
    for (let i = 1; i < group.length; i++) union(group[0], group[i]);
}

// AVWiki の別名を追加
let added = 0;
for (const rec of avwikiRecords) {
    if (!rec.aliases || rec.aliases.length === 0) continue;
    for (const alias of rec.aliases) {
        if (alias && alias !== rec.name) {
            const before = find(rec.name) !== find(alias);
            union(rec.name, alias);
            if (before) added++;
        }
    }
}
console.log('  新規エイリアスペア追加:', added, '件');

// グループ再構築
const groups = new Map();
const allNames = new Set();
for (const group of existing) group.forEach(n => allNames.add(n));
for (const rec of avwikiRecords) {
    allNames.add(rec.name);
    (rec.aliases || []).forEach(a => a && allNames.add(a));
}
for (const name of allNames) {
    const root = find(name);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root).add(name);
}

const newAliases = [...groups.values()]
    .filter(g => g.size > 1)
    .map(g => [...g].sort());

console.log('  統合後グループ数:', newAliases.length, '(旧:', existing.length, ')');
console.log('  統合後総名数:', newAliases.reduce((s,g)=>s+g.length,0));

fs.writeFileSync(ALIAS_FILE, JSON.stringify(newAliases, null, 4), 'utf-8');
console.log('  -> actress_aliases.json 更新完了');

// ── 2. Turso actress_profiles 更新 ───────────────────
async function updateTurso() {
    const db = createClient({
        url:       process.env.TURSO_FANZA_URL,
        authToken: process.env.TURSO_FANZA_TOKEN,
    });

    // retired カラム追加（冪等）
    try { await db.execute('ALTER TABLE actress_profiles ADD COLUMN retired INTEGER DEFAULT 0'); } catch {}

    console.log('\n[2] Turso actress_profiles 更新...');

    const withAliases = avwikiRecords.filter(d => d.aliases && d.aliases.length > 0);
    const withRetired = avwikiRecords.filter(d => d.retired === true);

    // aliases 更新
    let aliasUpdated = 0;
    const BATCH = 50;
    for (let i = 0; i < withAliases.length; i += BATCH) {
        const chunk = withAliases.slice(i, i + BATCH);
        await db.batch(chunk.map(d => ({
            sql: `UPDATE actress_profiles
                  SET aliases = CASE
                    WHEN aliases IS NULL OR aliases = '' THEN ?
                    ELSE aliases
                  END,
                  avwiki_url = COALESCE(avwiki_url, ?)
                  WHERE name = ?`,
            args: [
                JSON.stringify(d.aliases),
                d.url,
                d.name,
            ],
        })));
        aliasUpdated += chunk.length;
        process.stdout.write(`\r  aliases: ${aliasUpdated}/${withAliases.length}件処理`);
    }
    console.log(`\n  aliasesを ${withAliases.length} 人分更新試行`);

    // retired フラグ更新
    let retiredUpdated = 0;
    for (let i = 0; i < withRetired.length; i += BATCH) {
        const chunk = withRetired.slice(i, i + BATCH);
        await db.batch(chunk.map(d => ({
            sql: 'UPDATE actress_profiles SET retired = 1 WHERE name = ?',
            args: [d.name],
        })));
        retiredUpdated += chunk.length;
    }
    console.log(`  retired フラグ: ${retiredUpdated} 人分更新試行`);

    // 結果確認
    const [al, re] = await Promise.all([
        db.execute("SELECT COUNT(*) as c FROM actress_profiles WHERE aliases IS NOT NULL AND aliases != ''"),
        db.execute('SELECT COUNT(*) as c FROM actress_profiles WHERE retired = 1'),
    ]);
    console.log(`  -> aliases設定済み: ${Number(al.rows[0].c)}人`);
    console.log(`  -> retired設定済み: ${Number(re.rows[0].c)}人`);

    db.close();
}

updateTurso()
    .then(() => console.log('\n✅ 完了'))
    .catch(e => { console.error(e); process.exit(1); });
