/**
 * fix_alias_contamination.js
 *
 * avwiki_by_actress.js のエイリアス汚染を修正する。
 *
 * 問題:
 *   同一女優の複数の別名義（例: 心 / 愛澤らな / ことり）が同じ AVWIKI URL を持つため、
 *   --apply-only 実行時に全別名が全作品に追加されてしまう。
 *
 * 修正方針:
 *   1. エイリアスグループ（同一 AVWIKI URL を持つ名前の集合）を特定
 *   2. 各グループの中から「正規名」を1つ選ぶ
 *      - avwiki_product_map.jsonl に記載がある名前（作品ページ由来、最も正確）
 *      - なければ DB 内の出現頻度が最多の名前
 *   3. 各作品について、同一グループの複数名が入っている場合は正規名1つに統一
 *
 * 使い方:
 *   node scripts/fix_alias_contamination.js --dry-run              # 変更内容の確認のみ
 *   node scripts/fix_alias_contamination.js                        # 実際に修正
 *   node scripts/fix_alias_contamination.js --min-group 3          # 3名以上のグループのみ対象
 *   node scripts/fix_alias_contamination.js --max-group 8          # 8名以下のグループのみ対象（大グループは偽エイリアスが多いため除外）
 */

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATA_DIR    = path.join(__dirname, '..', 'data');
const MAP_FILE    = path.join(DATA_DIR, 'avwiki_actress_map.jsonl');
const PRODUCT_MAP = path.join(DATA_DIR, 'avwiki_product_map.jsonl');

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const minIdx  = args.indexOf('--min-group');
const MIN_GROUP = minIdx !== -1 ? parseInt(args[minIdx + 1], 10) : 2;
const maxIdx  = args.indexOf('--max-group');
const MAX_GROUP = maxIdx !== -1 ? parseInt(args[maxIdx + 1], 10) : 8; // デフォルト8名以下（それ以上は偽エイリアス疑い）

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Turso クライアント ──────────────────────────────────────
function getFanzaClient() {
    const url   = process.env.TURSO_FANZA_URL;
    const token = process.env.TURSO_FANZA_TOKEN;
    if (!url || !token) return null;
    return createClient({ url, authToken: token });
}

// FTS5 トリガー DDL
const TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE ON products BEGIN
    INSERT INTO products_fts(products_fts, rowid, product_id, title, actresses, genres)
    VALUES('delete', old.rowid, old.product_id, old.title, old.actresses, old.genres);
    INSERT INTO products_fts(rowid, product_id, title, actresses, genres)
    VALUES (new.rowid, new.product_id, new.title, new.actresses, new.genres);
END`;

// ── Step 1: エイリアスグループを構築 ──────────────────────────
function buildAliasGroups() {
    if (!fs.existsSync(MAP_FILE)) throw new Error('avwiki_actress_map.jsonl が見つかりません');

    const urlToNames = new Map(); // url → Set<名前>
    const urlToPids  = new Map(); // url → Set<product_id>

    for (const line of fs.readFileSync(MAP_FILE, 'utf8').split('\n').filter(Boolean)) {
        const e = JSON.parse(line);
        if (!e.actressUrl || !e.actress) continue;
        const url = e.actressUrl;
        if (!urlToNames.has(url)) urlToNames.set(url, new Set());
        if (!urlToPids.has(url))  urlToPids.set(url,  new Set());
        urlToNames.get(url).add(e.actress);
        (e.pids || []).forEach(p => urlToPids.get(url).add(p));
    }

    // MIN_GROUP 名以上・MAX_GROUP 名以下のグループのみ対象
    // 大グループ（MAX_GROUP 超）は AVWIKI 検索の誤マッチが多く偽エイリアスのリスクあり
    // "unknown/" 等の特殊URLも除外
    const groups = [];
    for (const [url, names] of urlToNames.entries()) {
        if (names.size < MIN_GROUP) continue;
        if (names.size > MAX_GROUP) continue;
        if (url.includes('unknown') || url.endsWith('/***/') || url.endsWith('/****/')) continue;
        groups.push({ url, names: Array.from(names), pids: Array.from(urlToPids.get(url)) });
    }

    return groups;
}

// ── Step 2: avwiki_product_map.jsonl から品番→女優名マップ ──────
function buildProductActressMap() {
    const map = new Map(); // product_id → Set<actress_name>
    if (!fs.existsSync(PRODUCT_MAP)) return map;

    for (const line of fs.readFileSync(PRODUCT_MAP, 'utf8').split('\n').filter(Boolean)) {
        const e = JSON.parse(line);
        const pids = [e.maker_pid, e.fanza_pid].filter(Boolean);
        for (const pid of pids) {
            if (!map.has(pid)) map.set(pid, new Set());
            (e.actresses || []).forEach(a => map.get(pid).add(a));
        }
    }
    return map;
}

// ── Step 3: 各グループの正規名を決定 ──────────────────────────
async function resolveCanonical(group, productActressMap, nameFreq) {
    const { names, pids } = group;

    // 方針: 各 product_id について
    //   1. product_map に記載がある名前 → その名前を使う
    //   2. なければ DB 出現頻度が最多の名前を正規名とする

    // グループ内で frequency が最大の名前（フォールバック用）
    const fallbackCanonical = names.reduce((best, n) =>
        (nameFreq.get(n) || 0) > (nameFreq.get(best) || 0) ? n : best
    , names[0]);

    return { names, pids, fallbackCanonical, productActressMap };
}

// ── Step 4: DB を修正 ───────────────────────────────────────
async function fixDb(groups, productActressMap, fanza) {
    // 女優名の出現頻度を取得（正規名決定のため）
    console.log('  [1/4] 女優名の出現頻度を取得中...');
    const freqResult = await fanza.execute(
        "SELECT actresses FROM products WHERE actresses IS NOT NULL AND actresses != ''"
    );
    const nameFreq = new Map();
    for (const row of freqResult.rows) {
        for (const n of String(row.actresses || '').split(/,/).map(s => s.trim()).filter(Boolean)) {
            nameFreq.set(n, (nameFreq.get(n) || 0) + 1);
        }
    }
    console.log(`  出現頻度マップ: ${nameFreq.size.toLocaleString()} 名`);

    // エイリアス名の全セット
    const allAliasNames = new Set();
    const nameToGroup   = new Map(); // 名前 → グループ
    for (const g of groups) {
        for (const n of g.names) {
            allAliasNames.add(n);
            nameToGroup.set(n, g);
        }
    }
    console.log(`  [2/4] 対象エイリアス名: ${allAliasNames.size.toLocaleString()} 件 / グループ数: ${groups.length.toLocaleString()}`);

    // エイリアス名を含む作品を取得
    console.log('  [3/4] エイリアス汚染が疑われる作品を検索中...');
    const allResult = await fanza.execute(
        "SELECT product_id, actresses FROM products WHERE actresses IS NOT NULL AND actresses != ''"
    );

    let fixNeeded = 0;
    const updates = [];

    for (const row of allResult.rows) {
        const pid     = String(row.product_id);
        const current = String(row.actresses || '');
        const entries = current.split(/,/).map(s => s.trim()).filter(Boolean);

        // このproductに含まれるエイリアス名をグループ別にまとめる
        const groupHits = new Map(); // グループURL → [ヒットした名前リスト]
        for (const name of entries) {
            const g = nameToGroup.get(name);
            if (g) {
                if (!groupHits.has(g.url)) groupHits.set(g.url, []);
                groupHits.get(g.url).push(name);
            }
        }

        // 同一グループから2名以上ヒット → 汚染の疑い
        let newEntries = [...entries];
        let changed    = false;

        for (const [url, hitNames] of groupHits.entries()) {
            if (hitNames.length < 2) continue; // 1名だけなら問題なし

            const g = groups.find(x => x.url === url);
            if (!g) continue;

            // 正規名を決定
            let canonical = null;

            // 1. avwiki_product_map で品番が記録されている名前
            const productMapped = productActressMap.get(pid);
            if (productMapped) {
                for (const n of hitNames) {
                    if (productMapped.has(n)) { canonical = n; break; }
                }
            }

            // 2. なければ DB 出現頻度最多
            if (!canonical) {
                canonical = hitNames.reduce((best, n) =>
                    (nameFreq.get(n) || 0) > (nameFreq.get(best) || 0) ? n : best
                , hitNames[0]);
            }

            // canonical 以外のエイリアスを除去
            const toRemove = new Set(hitNames.filter(n => n !== canonical));
            if (toRemove.size > 0) {
                newEntries = newEntries.filter(n => !toRemove.has(n));
                changed = true;
                fixNeeded++;
            }
        }

        if (changed) {
            const newVal = newEntries.join(', ');
            updates.push({ pid, oldVal: current, newVal });
        }
    }

    console.log(`  修正対象: ${updates.length.toLocaleString()} 件（グループ汚染検出: ${fixNeeded.toLocaleString()} 件）`);

    if (DRY_RUN) {
        console.log('\n[dry-run] 変更例（最初の20件）:');
        updates.slice(0, 20).forEach(u => {
            console.log(`  ${u.pid}`);
            console.log(`    修正前: ${u.oldVal.slice(0, 80)}`);
            console.log(`    修正後: ${u.newVal.slice(0, 80)}`);
        });
        return;
    }

    // [4/4] バッチ更新
    console.log('  [4/4] DB 更新中...');
    await fanza.execute('DROP TRIGGER IF EXISTS products_au');

    const BATCH = 200;
    let totalUpdated = 0;
    const now = new Date().toISOString();

    for (let i = 0; i < updates.length; i += BATCH) {
        const chunk = updates.slice(i, i + BATCH);
        const stmts = chunk.map(u => ({
            sql:  'UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ?',
            args: [u.newVal, now, u.pid],
        }));
        const results = await fanza.batch(stmts, 'write');
        totalUpdated += results.reduce((acc, r) => acc + (r.rowsAffected || 0), 0);
        process.stdout.write(`\r  ${Math.min(i + BATCH, updates.length)}/${updates.length} 処理 | 更新: ${totalUpdated}`);
    }

    console.log('\n  FTS5 rebuild 中...');
    await fanza.execute("INSERT INTO products_fts(products_fts) VALUES('rebuild')");
    await fanza.execute(TRIGGER_DDL);
    console.log(`\n✅ 完了: ${totalUpdated.toLocaleString()} 件更新`);
}

// ── メイン ──────────────────────────────────────────────────
async function main() {
    console.log('========================================');
    console.log('  エイリアス汚染修正スクリプト');
    console.log('========================================');
    if (DRY_RUN) console.log('  [DRY-RUN] 実際のDB変更は行いません');
    console.log('');

    console.log('Step 1: エイリアスグループ構築中...');
    const groups = buildAliasGroups();
    console.log(`  ${groups.length.toLocaleString()} グループ検出（${MIN_GROUP}名以上）`);

    console.log('Step 2: 品番→女優名マップ読み込み中...');
    const productActressMap = buildProductActressMap();
    console.log(`  ${productActressMap.size.toLocaleString()} 品番のマップ`);

    const fanza = getFanzaClient();
    if (!fanza) { console.error('FANZA Turso 接続失敗'); process.exit(1); }

    console.log('Step 3: DB 修正中...');
    await fixDb(groups, productActressMap, fanza);

    fanza.close();
}

main().catch(e => { console.error('エラー:', e.message); process.exit(1); });
