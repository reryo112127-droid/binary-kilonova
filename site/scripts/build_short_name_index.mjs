/**
 * 3文字未満の絞り込み（女優名・レーベル名）を D1 の全表走査から救うための静的インデックス。
 *
 * なぜ必要か:
 *   FTS5 の trigram トークナイザは **3文字未満を索引できない**。そのため
 *   /api/products の actress / label 絞り込みは、名前が2文字のときだけ
 *   `actresses LIKE '%X%'` / `label LIKE '%X%'` の全表走査に落ちていた。
 *   2026-09-06 の実測（直近10h、日次枠500万行に対して）:
 *     actresses LIKE  … FANZA 1回 134,760行 / MGS 1回 34,531行 … 計 約93万行（19%）
 *     label LIKE      … 1回 65,000〜71,000行 × 12回          … 計 約81万行（10%）
 *
 * どう直すか:
 *   1) 女優: 短名は延べ数千件しかないので、名前→品番をそのまま焼く。
 *      ランタイムは `actresses LIKE '%X%'` → `product_id IN ('...')` に置き換える。
 *   2) レーベル: 部分一致の総当たりを焼くと50MB超になるので焼かない。代わりに
 *      **カタログに存在するレーベル名の一覧**（全4,700件・50KB）を配り、
 *      「どのレーベル名にも含まれない2文字」なら走査せず 0 件で返す。
 *      高コストなのは一致が疎な（=ほぼ一致しない）クエリなので、これで大半が消える。
 *      1件でも含むレーベルがあれば従来どおり LIKE（一致が密なので LIMIT で早く止まる）。
 *
 * データ源は **ローカルSQLite**（D1は読まない＝枠切れ中でも再生成できる）。
 * ローカルDBはD1より件数が少ないので、レーベル一覧は「取りこぼしうる」ことに注意。
 * 取りこぼすと、そのレーベルの2文字検索が一時的に0件になる（翌日の再生成で自然に直る）。
 *
 * 出力: site/data/short_name_index.json と site/public/data/short_name_index.json
 *   { "actress": { "fanza": {"蘭々": ["ssis00123", ...]}, "mgs": {...} },
 *     "labels":  { "fanza": ["本中", ...], "mgs": [...] } }
 *
 * 実行: node scripts/build_short_name_index.mjs   （npm run build:short-names）
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');

// 名前の「文字数」はコードポイント単位で数える（サロゲートペアを2文字と数えないため）。
const cpLen = (s) => [...s].length;

// 1名前あたりの上限。これを超える名前は SQL の IN リストが長くなりすぎるので
// LIKE のまま（＝従来動作）に落とす。実測の最大は 342 件なので通常は効かない。
const MAX_IDS_PER_NAME = 2000;

// actress_aliases.json に出てくる3文字未満の別名。
// 別名グループは「長い名前(FTSで引ける) OR 短い別名」という条件になるため、短い別名側が
// `actresses LIKE '%X%'` のままだと **OR のせいで FTS 駆動が捨てられ全表走査**になる
// （2026-09-08 実測: MGS 1回 65,226行＝テーブル全件 × 6回/h。その時間帯の90%）。
// しかも別名の照合は本来 **部分一致** で、DBの実体は「汐世（有栖花あか）」のように
// 別名を含むより長い文字列。だから完全一致で作った索引には載らず、必ずLIKEに落ちていた。
// → 別名の短名だけは **部分一致で** 索引する（該当は実測4名なので件数は小さい）。
function loadShortAliasNames() {
    for (const p of [
        path.join(ROOT, 'public', 'data', 'actress_aliases.json'),
        path.join(ROOT, 'data', 'actress_aliases.json'),
    ]) {
        try {
            const groups = JSON.parse(fs.readFileSync(p, 'utf-8'));
            if (!Array.isArray(groups)) continue;
            const out = new Set();
            for (const g of groups) for (const a of g) if (cpLen(String(a)) < 3) out.add(String(a));
            return out;
        } catch { /* 次の候補へ */ }
    }
    return new Set();
}
const SHORT_ALIASES = loadShortAliasNames();

async function collect(dbPath, label) {
    if (!fs.existsSync(dbPath)) {
        console.warn(`  ${label}: ${dbPath} が無いのでスキップ`);
        return { actress: {}, labels: [] };
    }
    const { openLocal } = require(path.join(REPO, 'scripts', 'lib', 'localsqlite.cjs'));
    const db = openLocal(dbPath);
    const map = new Map();
    // 別名の短名は「0件だった」ことも記録する必要がある（キーが無い＝未知＝LIKEへ落とす、
    // キーがあって空＝一致なし＝条件ごと落とす、とランタイムで区別するため）
    const aliasMap = new Map([...SHORT_ALIASES].map((n) => [n, []]));
    const labels = new Set();
    try {
        const r = await db.execute(
            `SELECT product_id, actresses, label FROM products
              WHERE (actresses IS NOT NULL AND TRIM(actresses) <> '')
                 OR (label IS NOT NULL AND TRIM(label) <> '')`
        );
        for (const row of r.rows) {
            const pid = String(row.product_id);
            if (row.actresses) {
                const raw = String(row.actresses);
                for (const name of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
                    if (cpLen(name) >= 3) continue;
                    if (!map.has(name)) map.set(name, []);
                    map.get(name).push(pid);
                }
                // 別名の短名は部分一致（ランタイムの LIKE '%X%' と同じ意味にする）
                for (const alias of SHORT_ALIASES) if (raw.includes(alias)) aliasMap.get(alias).push(pid);
            }
            if (row.label) {
                const l = String(row.label).trim();
                if (l) labels.add(l);
            }
        }
    } finally {
        db.close();
    }
    // 別名は部分一致の結果で上書きする（部分一致 ⊇ 完全一致なので情報は減らない）
    for (const [name, ids] of aliasMap) map.set(name, ids);
    const actress = {};
    let dropped = 0;
    for (const [name, ids] of map) {
        if (ids.length > MAX_IDS_PER_NAME) { dropped++; continue; }
        actress[name] = ids;
    }
    console.log(`  ${label}: 短名女優 ${Object.keys(actress).length}名 / 延べ${[...map.values()].reduce((a, b) => a + b.length, 0)}出演`
        + (dropped ? `（${dropped}名は${MAX_IDS_PER_NAME}件超のため除外）` : '')
        + ` / レーベル ${labels.size}件`);
    return { actress, labels: [...labels] };
}

async function main() {
    console.log('短名インデックスを生成中（ローカルSQLite）…');
    const fanza = await collect(path.join(REPO, 'data', 'fanza.db'), 'fanza');
    const mgs = await collect(path.join(REPO, 'data', 'mgs.db'), 'mgs');
    const index = {
        actress: { fanza: fanza.actress, mgs: mgs.actress },
        labels: { fanza: fanza.labels, mgs: mgs.labels },
    };

    const isEmpty = Object.keys(index.actress.fanza).length === 0
        && Object.keys(index.actress.mgs).length === 0
        && index.labels.fanza.length === 0 && index.labels.mgs.length === 0;

    const json = JSON.stringify(index);
    for (const t of [
        path.join(ROOT, 'data', 'short_name_index.json'),
        path.join(ROOT, 'public', 'data', 'short_name_index.json'),
    ]) {
        fs.mkdirSync(path.dirname(t), { recursive: true });
        // 0件のときは既存を潰さない（他の静的キャッシュ生成と同じガード）。
        // 空のまま配ると「レーベルが1件も無い」＝全部0件返し になってしまうため特に重要。
        if (isEmpty && fs.existsSync(t)) {
            console.warn(`  ${path.basename(t)}: 生成結果が空のため既存ファイルを保持`);
            continue;
        }
        fs.writeFileSync(t, json);
        console.log(`  → ${path.relative(REPO, t)} (${(json.length / 1024).toFixed(1)} KB)`);
    }
}

main().catch((e) => { console.error('失敗:', e.message); process.exitCode = 1; });
