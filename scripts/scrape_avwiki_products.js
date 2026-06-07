/**
 * scrape_avwiki_products.js
 *
 * av-wiki.net の品番ページ（約10,000件）から「AV女優名 / FANZA品番 / メーカー品番」を
 * 収集し、MGS・FANZA Turso DBの女優不明作品を更新する。
 *
 * avwikiは素人・企画単体作品の女優を特定するコミュニティサイトであり、
 * APIやDBに記録されていない匿名作品の出演者情報が掲載されている。
 *
 * 使い方:
 *   node scripts/scrape_avwiki_products.js              # 通常実行 (120秒間隔)
 *   node scripts/scrape_avwiki_products.js --fetch-urls # URLリスト取得のみ
 *   node scripts/scrape_avwiki_products.js --dry-run    # 最初の5件のみ
 *   node scripts/scrape_avwiki_products.js --interval 60  # 60秒間隔
 *   node scripts/scrape_avwiki_products.js --apply      # 収集済みデータをDBに反映のみ
 *   node scripts/scrape_avwiki_products.js --apply-videoc # videoc(素人)の女優不明作品に限定して反映
 *   node scripts/scrape_avwiki_products.js --scrape-videoc-direct # FANZAのvideoc女優不明作品のproduct_idでavwikiを直接検索
 *   node scripts/scrape_avwiki_products.js --search-all          # FANZA女優不明の全品番をavwikiで直接検索（並列5、約5〜7時間）
 *   node scripts/scrape_avwiki_products.js --search-mgs          # MGS女優不明の全品番をavwikiで直接検索（並列5、約30分）
 *   node scripts/scrape_avwiki_products.js --scrape-maker hunter       # avwiki fanza-video/fanza-shirouto メーカーページから女優情報を一括取得
 *   node scripts/scrape_avwiki_products.js --scrape-all-makers        # fanza-video/fanza-shirouto/mgstage 全790メーカーを巡回（推定5時間）
 *   node scripts/scrape_avwiki_products.js --search-by-label           # 専用ページなしレーベルを品番プレフィックスでavwiki検索して女優特定
 *   node scripts/scrape_avwiki_products.js --search-by-label pwife     # 特定プレフィックスのみ検索
 *   node scripts/scrape_avwiki_products.js --daily                     # RSSフィード新着から出演者情報を取得してDB更新（日次用）
 *   node scripts/scrape_avwiki_products.js --daily --count 200         # 取得件数指定（デフォルト100）
 *
 * 進捗: data/avwiki_products_progress.json
 * 出力: data/avwiki_product_map.jsonl  (女優名-品番マッピング)
 */

const fs   = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { d1, fanzaShards } = require('./lib/d1');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATA_DIR         = path.join(__dirname, '..', 'data');
const URL_LIST_FILE    = path.join(DATA_DIR, 'avwiki_product_urls.json');
const OUTPUT_JSONL     = path.join(DATA_DIR, 'avwiki_product_map.jsonl');
const PROGRESS_FILE    = path.join(DATA_DIR, 'avwiki_products_progress.json');

// ========== 引数 ==========
const args       = process.argv.slice(2);
const FETCH_ONLY          = args.includes('--fetch-urls');
const DRY_RUN             = args.includes('--dry-run');
const APPLY_ONLY          = args.includes('--apply');
const APPLY_VIDEOC        = args.includes('--apply-videoc');
const SCRAPE_VIDEOC_DIRECT = args.includes('--scrape-videoc-direct');
const SEARCH_ALL           = args.includes('--search-all');
const prefixIdx            = args.indexOf('--prefix');
const SEARCH_ALL_PREFIX    = prefixIdx !== -1 ? args[prefixIdx + 1] : null; // --search-all --prefix jul で特定ラベルのみ処理
const SEARCH_MGS           = args.includes('--search-mgs');
const SCRAPE_ALL_MAKERS    = args.includes('--scrape-all-makers');
const SCRAPE_MAKER         = args.includes('--scrape-maker');
const makerIdx             = args.indexOf('--scrape-maker');
const MAKER_SLUG           = makerIdx !== -1 ? args[makerIdx + 1] : null;
const SEARCH_BY_LABEL      = args.includes('--search-by-label');
const labelIdx             = args.indexOf('--search-by-label');
const LABEL_SLUG           = labelIdx !== -1 && args[labelIdx + 1] && !args[labelIdx + 1].startsWith('--') ? args[labelIdx + 1] : null;
const DAILY                = args.includes('--daily');
const countIdx             = args.indexOf('--count');
const DAILY_COUNT          = countIdx !== -1 ? parseInt(args[countIdx + 1], 10) : 100;
const intIdx        = args.indexOf('--interval');
const INTERVAL_MS   = intIdx !== -1 ? parseInt(args[intIdx + 1], 10) * 1000 : 120_000; // デフォルト2分

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ========== FTS5トリガー管理 ==========
// libsql HTTP経由のUPDATEではproducts_auトリガーがSQLITE_UNKNOWNを引き起こすため、
// トリガーを一時停止 → バッチUPDATE → FTS5再構築 → トリガー復元 の順で実行する。
const TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE ON products BEGIN
    INSERT INTO products_fts(products_fts, rowid, product_id, title, actresses, genres)
    VALUES('delete', old.rowid, old.product_id, old.title, old.actresses, old.genres);
    INSERT INTO products_fts(rowid, product_id, title, actresses, genres)
    VALUES (new.rowid, new.product_id, new.title, new.actresses, new.genres);
END`;

const withTimeout = (promise, ms, label) =>
    Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms))]);

async function managedBatchUpdate(client, statements) {
    if (statements.length === 0) return 0;
    // Drop trigger to avoid SQLITE_UNKNOWN from FTS5 trigger via libsql HTTP
    try {
        await withTimeout(client.execute('DROP TRIGGER IF EXISTS products_au'), 20000, 'DROP TRIGGER');
    } catch (e) {
        console.warn('  [DROP TRIGGER skipped]', e.message);
        // Proceed anyway — if trigger is missing, updates will work; if present, may fail
    }
    const results = await client.batch(statements, 'write');
    const updated = results.reduce((acc, r) => acc + (r.rowsAffected || 0), 0);
    // Recreate trigger (FTS5 rebuild omitted — let generate-static-cache handle it)
    try {
        await withTimeout(client.execute(TRIGGER_DDL), 20000, 'CREATE TRIGGER');
    } catch (e) {
        console.warn('  [CREATE TRIGGER skipped]', e.message);
    }
    return updated;
}

async function rebuildFts5(client) {
    try {
        await withTimeout(client.execute('DROP TRIGGER IF EXISTS products_au'), 15000, 'DROP TRIGGER');
        await withTimeout(
            client.execute("INSERT INTO products_fts(products_fts) VALUES('rebuild')"),
            30000, 'FTS5 rebuild'
        );
        await withTimeout(client.execute(TRIGGER_DDL), 15000, 'CREATE TRIGGER');
    } catch (e) {
        console.warn('  [rebuildFts5 error]', e.message);
    }
}

// ========== D1（旧Turso）==========
// FTS は site/migrations/0004 のトリガで自動同期されるため、本スクリプト内の
// DROP/CREATE TRIGGER・rebuild は d1.js 側で no-op 化される（素の UPDATE のみ有効）。
function createClients() {
    return { mgs: d1('mgs'), fanza: fanzaShards() };
}

// ========== HTTP取得 ==========
async function fetchHtml(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'ja' },
                signal: AbortSignal.timeout(30_000),
            });
            if (res.status === 429 || res.status === 503) {
                console.warn(`  [${res.status}] 60秒待機`);
                await sleep(60_000);
                continue;
            }
            if (res.status === 404) return null; // ページなし
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (e) {
            if (i === retries - 1) throw e;
            await sleep(10_000 * (i + 1));
        }
    }
}

// ========== フェーズ1: URLリスト収集 ==========
async function fetchAllProductUrls() {
    console.log('[フェーズ1] post-sitemap から全品番ページURLを収集...\n');
    const allUrls = [];

    for (let i = 1; i <= 15; i++) {
        const url = i === 1
            ? 'https://av-wiki.net/post-sitemap.xml'
            : `https://av-wiki.net/post-sitemap${i}.xml`;

        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!res.ok) { console.log(`  sitemap${i}: 終端 (${res.status})`); break; }

        const text = await res.text();
        const urls = [...text.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
        allUrls.push(...urls);
        console.log(`  sitemap${i}: ${urls.length}件 (累計: ${allUrls.length}件)`);
        await sleep(2_000);
    }

    const unique = [...new Set(allUrls)].sort();
    fs.writeFileSync(URL_LIST_FILE, JSON.stringify(unique, null, 2));
    console.log(`\n✅ 合計 ${unique.length.toLocaleString()} URLを保存`);
    console.log(`   ${INTERVAL_MS / 1000}秒間隔で: ${(unique.length * INTERVAL_MS / 1000 / 86400).toFixed(1)}日\n`);
    return unique;
}

// ========== フェーズ2: ページパース ==========
function parseProductPage(html, pageUrl) {
    const $      = cheerio.load(html);
    const result = { url: pageUrl, scraped_at: new Date().toISOString() };

    // URL からスラグ抽出 (e.g., "ebwh-019")
    result.slug = pageUrl.replace(/.*av-wiki\.net\/(.+?)\/?$/, '$1');

    // dl/dt テーブルから各フィールドを取得
    const fieldMap = {};
    $('dl dt').each((i, el) => {
        const label = $(el).text().trim().replace(/[：:]\s*$/, '');
        const $dd = $(el).next('dd');
        // 値は $dd オブジェクトごと保持（後でリンク解析するため）
        fieldMap[label] = $dd;
    });

    // フィールド値テキスト取得ヘルパー
    const getText = key => (fieldMap[key] ? fieldMap[key].text().trim() : '');

    // AV女優名: <a>タグが複数ある場合はそれぞれ別の女優
    const $actressDd = fieldMap['AV女優名'];
    if ($actressDd) {
        const links = $actressDd.find('a');
        if (links.length > 0) {
            // <a>タグから女優名を抽出（区切りなしで複数並んでいる）
            const names = [];
            links.each((i, a) => {
                const name = $(a).text().trim();
                if (name && name !== '不明' && name !== '–') names.push(name);
            });
            if (names.length > 0) result.actresses = names;
        } else {
            // リンクなしのテキスト（区切り文字で分割）
            const raw = $actressDd.text().trim();
            if (raw && raw !== '不明' && raw !== '–' && raw !== '---') {
                result.actresses = raw
                    .split(/[,、・\n／]+/)
                    .map(s => s.trim())
                    .filter(s => s && s !== '不明' && s !== '–');
            }
        }
    }

    // メーカー品番（MGS product_id形式: 大文字+ハイフン）
    const makerPid = getText('メーカー品番');
    if (makerPid) result.maker_pid = makerPid.toUpperCase();

    // FANZA品番（FANZA product_id形式: 小文字）
    const fanzaPid = getText('FANZA品番');
    if (fanzaPid) result.fanza_pid = fanzaPid.toLowerCase();

    // その他フィールド
    result.maker     = getText('メーカー') || null;
    result.sale_date = getText('配信開始日') || null;

    return result;
}

// ========== フェーズ3: DB更新 ==========
async function updateDbs(clients, entries) {
    // entries = [{ actress, maker_pid, fanza_pid }]
    let mgsUpdated = 0, fanzaUpdated = 0;

    const mgsStatements   = [];
    const fanzaStatements = [];
    const now = new Date().toISOString();

    for (const entry of entries) {
        if (!entry.actresses || entry.actresses.length === 0) continue;
        const actressStr = entry.actresses.join(', ');

        // MGS: メーカー品番で検索
        if (entry.maker_pid) {
            mgsStatements.push({
                sql:  `UPDATE products SET actresses = ?, updated_at = ?
                       WHERE product_id = ? AND (actresses IS NULL OR actresses = '')`,
                args: [actressStr, now, entry.maker_pid],
            });
        }

        // FANZA: FANZA品番で検索
        if (entry.fanza_pid) {
            fanzaStatements.push({
                sql:  `UPDATE products SET actresses = ?, updated_at = ?
                       WHERE product_id = ? AND (actresses IS NULL OR actresses = '')`,
                args: [actressStr, now, entry.fanza_pid],
            });
        }
    }

    if (mgsStatements.length > 0) {
        mgsUpdated = await managedBatchUpdate(clients.mgs, mgsStatements);
    }
    if (fanzaStatements.length > 0) {
        fanzaUpdated = await managedBatchUpdate(clients.fanza, fanzaStatements);
    }

    return { mgsUpdated, fanzaUpdated };
}

// ========== --apply モード: 既存JSONLからDB反映 ==========
async function applyFromJsonl(clients) {
    console.log('[適用] avwiki_product_map.jsonl → Turso DB\n');
    if (!fs.existsSync(OUTPUT_JSONL)) {
        console.error('❌ avwiki_product_map.jsonl が見つかりません。先にスクレイプを実行してください。');
        process.exit(1);
    }

    const lines = fs.readFileSync(OUTPUT_JSONL, 'utf-8').split('\n').filter(l => l.trim());
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Drop FTS5 triggers once before all batches to avoid SQLITE_UNKNOWN via libsql HTTP.
    // FTS5 rebuild is skipped here — generate-static-cache.mjs will rebuild it on next deploy.
    // If DROP TRIGGER fails/times out for a DB, skip ALL updates for that DB to avoid
    // cascading timeouts from the libsql client's pending request queue.
    console.log('  [setup] dropping FTS5 triggers...');
    let mgsReady = false, fanzaReady = false;
    try {
        await withTimeout(clients.mgs.execute('DROP TRIGGER IF EXISTS products_au'), 60000, 'MGS DROP TRIGGER');
        console.log('  [setup] MGS trigger dropped');
        mgsReady = true;
    } catch (e) {
        console.warn('  [setup] MGS DROP TRIGGER failed:', e.message, '— skipping MGS updates');
    }
    try {
        await withTimeout(clients.fanza.execute('DROP TRIGGER IF EXISTS products_au'), 60000, 'FANZA DROP TRIGGER');
        console.log('  [setup] FANZA trigger dropped');
        fanzaReady = true;
    } catch (e) {
        console.warn('  [setup] FANZA DROP TRIGGER failed:', e.message, '— skipping FANZA updates');
    }
    console.log(`  MGS updates: ${mgsReady ? 'enabled' : 'SKIPPED'} / FANZA updates: ${fanzaReady ? 'enabled' : 'SKIPPED'}\n`);

    const BATCH = 200;
    let totalMgs = 0, totalFanza = 0;
    const now = new Date().toISOString();

    for (let i = 0; i < entries.length; i += BATCH) {
        const chunk = entries.slice(i, i + BATCH);
        const mgsStmts = [];
        const fanzaStmts = [];

        for (const entry of chunk) {
            if (!entry.actresses || entry.actresses.length === 0) continue;
            // 名前ごとに内部スペースを除去（avwikiの「佐々木 ひな」→「佐々木ひな」。検索FTS・女優照合の精度向上）
            const actressStr = entry.actresses.map(a => String(a).trim().replace(/\s+/g, '')).filter(Boolean).join(', ');
            if (entry.maker_pid) {
                mgsStmts.push({
                    sql:  `UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ? AND (actresses IS NULL OR actresses = '')`,
                    args: [actressStr, now, entry.maker_pid],
                });
            }
            if (entry.fanza_pid) {
                fanzaStmts.push({
                    sql:  `UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ? AND (actresses IS NULL OR actresses = '')`,
                    args: [actressStr, now, entry.fanza_pid],
                });
            }
        }

        if (mgsReady && mgsStmts.length > 0) {
            try {
                const res = await withTimeout(clients.mgs.batch(mgsStmts, 'write'), 30000, 'MGS batch');
                totalMgs += res.reduce((acc, r) => acc + (r.rowsAffected || 0), 0);
            } catch (e) {
                console.warn(`\n  [MGS batch ${i}] error: ${e.message}`);
                mgsReady = false; // disable MGS on first batch failure to avoid cascading timeouts
            }
        }
        if (fanzaReady && fanzaStmts.length > 0) {
            try {
                const res = await withTimeout(clients.fanza.batch(fanzaStmts, 'write'), 30000, 'FANZA batch');
                totalFanza += res.reduce((acc, r) => acc + (r.rowsAffected || 0), 0);
            } catch (e) {
                console.warn(`\n  [FANZA batch ${i}] error: ${e.message}`);
                fanzaReady = false; // disable FANZA on first batch failure
            }
        }

        process.stdout.write(`  ${Math.min(i + BATCH, entries.length)}/${entries.length} 処理 | MGS: ${totalMgs} FANZA: ${totalFanza}\r`);
    }

    // Recreate triggers after all updates
    console.log('\n  [teardown] recreating triggers...');
    try {
        await withTimeout(clients.mgs.execute(TRIGGER_DDL), 20000, 'MGS CREATE TRIGGER');
    } catch (e) {
        console.warn('  [MGS trigger recreate skipped]', e.message);
    }
    try {
        await withTimeout(clients.fanza.execute(TRIGGER_DDL), 20000, 'FANZA CREATE TRIGGER');
    } catch (e) {
        console.warn('  [FANZA trigger recreate skipped]', e.message);
    }

    console.log(`✅ 適用完了 | MGS更新: ${totalMgs}件 / FANZA更新: ${totalFanza}件`);
}

const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1485815872688885892/78U4bkE7SNNTIMuW91ru_bJXH6D6hynnf88dYAnzkgq2hECA4gUSNa6hzq5DWquwRJYe';

async function sendDiscord(content) {
    try {
        await fetch(DISCORD_WEBHOOK, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ content }),
        });
    } catch (e) {
        console.warn('[Discord] 通知失敗:', e.message);
    }
}

function nowJST() {
    return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

// ========== --apply-videoc モード: 素人作品に限定して女優情報を反映 ==========
async function applyToVideoc(clients) {
    console.log('[apply-videoc] FANZA videoc(素人)の女優不明作品に avwiki データを反映\n');

    if (!fs.existsSync(OUTPUT_JSONL)) {
        console.error('❌ avwiki_product_map.jsonl が見つかりません。先にスクレイプを実行してください。');
        process.exit(1);
    }

    // avwiki_product_map.jsonl を読み込んでfanza_pid→女優名 マップを作成
    const lines = fs.readFileSync(OUTPUT_JSONL, 'utf-8').split('\n').filter(l => l.trim());
    const entries = lines
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(e => e && e.fanza_pid && e.actresses && e.actresses.length > 0);

    console.log(`  avwikiマップ: ${entries.length.toLocaleString()}件（女優特定済み）`);

    // FANZA DBで actresses が空の全品番を取得
    const emptyResult = await clients.fanza.execute(
        'SELECT product_id FROM products WHERE actresses IS NULL OR actresses = \'\''
    );
    const emptySet = new Set(emptyResult.rows.map(r => r.product_id));
    console.log(`  FANZA DB 女優不明件数: ${emptySet.size.toLocaleString()}件`);

    // マッチするものだけ抽出
    const matched = entries.filter(e => emptySet.has(e.fanza_pid));
    console.log(`  avwikiでマッチ: ${matched.length.toLocaleString()}件\n`);

    if (matched.length === 0) {
        console.log('✅ 反映対象なし（すでに全件更新済み or avwikiデータなし）');
        return;
    }

    const BATCH = 200;
    let totalUpdated = 0;
    const now = new Date().toISOString();

    // トリガー一時停止 → 全バッチ更新 → FTS5再構築 → トリガー復元
    await clients.fanza.execute('DROP TRIGGER IF EXISTS products_au');
    for (let i = 0; i < matched.length; i += BATCH) {
        const chunk = matched.slice(i, i + BATCH);
        const statements = chunk.map(e => ({
            sql:  'UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ? AND (actresses IS NULL OR actresses = \'\')',
            args: [e.actresses.join(', '), now, e.fanza_pid],
        }));
        const results = await clients.fanza.batch(statements, 'write');
        totalUpdated += results.reduce((acc, r) => acc + (r.rowsAffected || 0), 0);
        process.stdout.write(`  ${Math.min(i + BATCH, matched.length)}/${matched.length} 処理 | 更新: ${totalUpdated}\r`);
    }
    await clients.fanza.execute("INSERT INTO products_fts(products_fts) VALUES('rebuild')");
    await clients.fanza.execute(TRIGGER_DDL);

    const afterResult = await clients.fanza.execute(
        'SELECT COUNT(*) as cnt FROM products WHERE actresses IS NULL OR actresses = \'\''
    );
    const remaining = Number(afterResult.rows[0].cnt);

    console.log(`\n✅ apply-videoc 完了`);
    console.log(`   マッチ件数: ${matched.length.toLocaleString()}件`);
    console.log(`   FANZA DB 更新: ${totalUpdated.toLocaleString()}件`);
    console.log(`   更新後 女優不明残数: ${remaining.toLocaleString()}件`);

    await sendDiscord(
        `🎭 **AVWIKI → FANZA videoc 女優情報反映完了** (${nowJST()})\n` +
        `avwikiマッチ: **${matched.length.toLocaleString()}件**\n` +
        `FANZA DB 更新: **${totalUpdated.toLocaleString()}件**\n` +
        `女優不明 残: **${remaining.toLocaleString()}件**`
    );
}

// ========== --scrape-videoc-direct モード ==========
// avwiki サイトマップ × FANZA DB 女優不明作品の積集合だけをスクレイプして女優を特定する。
// 218K全件を試さず約3,000件に絞るため効率的。
async function scrapeVideocDirect(clients) {
    const CHECKED_FILE     = path.join(DATA_DIR, 'avwiki_videoc_direct_checked.txt');
    const STATS_FILE       = path.join(DATA_DIR, 'avwiki_videoc_direct_stats.json');
    const WAIT_MS          = 1200;  // ページ取得後の待機
    const SAVE_INTERVAL    = 100;   // N件ごとに進捗保存
    const DISCORD_INTERVAL = 500;   // N件ごとにDiscord通知

    console.log('══════════════════════════════════════════');
    console.log('  avwiki 直接スクレイプ (videoc 女優特定)');
    console.log('══════════════════════════════════════════\n');

    // ① avwiki サイトマップ URL リストを読み込んでスラグマップを作成
    //    slug → avwiki URL の対応 (直接形式 + ハイフン除去形式 の両方)
    if (!fs.existsSync(URL_LIST_FILE)) {
        console.error('❌ avwiki_product_urls.json が見つかりません。先に --fetch-urls を実行してください。');
        process.exit(1);
    }
    const allWikiUrls = JSON.parse(fs.readFileSync(URL_LIST_FILE, 'utf-8'));
    // slug → wikiUrl マップ (直接形式)
    const slugToUrl = new Map();
    for (const u of allWikiUrls) {
        const slug = u.replace(/^https:\/\/av-wiki\.net\//, '').replace(/\/$/, '');
        slugToUrl.set(slug, u);
        // ハイフン除去形式も登録 (cmd-004 → cmd004)
        const noHyphen = slug.replace(/-/g, '');
        if (noHyphen !== slug) slugToUrl.set(noHyphen, u);
    }
    console.log(`  avwiki スラグ数: ${slugToUrl.size.toLocaleString()}件 (元URL: ${allWikiUrls.length.toLocaleString()}件)`);

    // ② FANZA DB 女優不明 product_id を取得
    const emptyResult = await clients.fanza.execute(
        "SELECT product_id FROM products WHERE actresses IS NULL OR actresses = ''"
    );
    const emptyPids = emptyResult.rows.map(r => r.product_id);
    console.log(`  FANZA 女優不明: ${emptyPids.length.toLocaleString()}件`);

    // ③ 交差集合: avwiki にあり かつ FANZA DB で女優不明のもの
    //    product_id が直接スラグに一致するもの
    const targets = emptyPids
        .filter(pid => slugToUrl.has(pid))
        .map(pid => ({ pid, url: slugToUrl.get(pid) }));
    console.log(`  avwiki×FANZA 交差: ${targets.length.toLocaleString()}件\n`);

    // ④ 進捗ロード
    const checkedSet = new Set(
        fs.existsSync(CHECKED_FILE)
            ? fs.readFileSync(CHECKED_FILE, 'utf-8').split('\n').filter(Boolean)
            : []
    );
    let stats = { found: 0, updated: 0, errors: 0 };
    if (fs.existsSync(STATS_FILE)) Object.assign(stats, JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8')));

    const todo = targets.filter(t => !checkedSet.has(t.pid));
    console.log(`  既チェック: ${checkedSet.size.toLocaleString()}件 / 残り: ${todo.length.toLocaleString()}件`);
    console.log(`  発見済み: ${stats.found.toLocaleString()}件 / 更新済み: ${stats.updated.toLocaleString()}件\n`);

    if (todo.length === 0) {
        console.log('✅ 全対象スクレイプ済み');
        return;
    }

    // トリガーを一時停止（個別executeでのSQLITE_UNKNOWN回避）
    await clients.fanza.execute('DROP TRIGGER IF EXISTS products_au');

    await sendDiscord(
        `🔍 **avwiki videoc 直接スクレイプ 開始** (${nowJST()})\n` +
        `対象: **${targets.length.toLocaleString()}件** (avwiki×FANZA女優不明の交差)\n` +
        `残り: **${todo.length.toLocaleString()}件** / 既チェック: ${checkedSet.size.toLocaleString()}件`
    );

    const newlyChecked = [];
    const now = new Date().toISOString();
    let sessionChecked = 0, sessionFound = 0, sessionUpdated = 0;

    for (const { pid, url } of todo) {
        let pageData = null;
        try {
            const html = await fetchHtml(url);
            if (html) pageData = parseProductPage(html, url);
        } catch (e) {
            stats.errors++;
        }

        checkedSet.add(pid);
        newlyChecked.push(pid);
        sessionChecked++;

        if (pageData && pageData.actresses && pageData.actresses.length > 0) {
            sessionFound++;
            stats.found++;
            const actressStr = pageData.actresses.join(', ');
            try {
                const res = await clients.fanza.execute({
                    sql: "UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ? AND (actresses IS NULL OR actresses = '')",
                    args: [actressStr, now, pid],
                });
                if (res.rowsAffected > 0) {
                    sessionUpdated++;
                    stats.updated++;
                }
                process.stdout.write(`\n  [発見] ${pid}: ${actressStr.substring(0, 40)}\n`);
            } catch (e) {
                stats.errors++;
            }
        }

        if (sessionChecked % 20 === 0) {
            process.stdout.write(`  ${sessionChecked}/${todo.length} | 発見: ${sessionFound} | 更新: ${sessionUpdated}\r`);
        }

        if (newlyChecked.length >= SAVE_INTERVAL) {
            fs.appendFileSync(CHECKED_FILE, newlyChecked.join('\n') + '\n');
            fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
            newlyChecked.length = 0;
        }

        if (sessionChecked % DISCORD_INTERVAL === 0) {
            await sendDiscord(
                `🔍 **avwiki videoc 直接スクレイプ 進捗** (${nowJST()})\n` +
                `${sessionChecked.toLocaleString()}/${todo.length.toLocaleString()}件\n` +
                `今回発見: **${sessionFound}件** / 今回更新: **${sessionUpdated}件**`
            );
        }

        await sleep(WAIT_MS);
    }

    if (newlyChecked.length > 0) {
        fs.appendFileSync(CHECKED_FILE, newlyChecked.join('\n') + '\n');
    }
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));

    // FTS5再構築 + トリガー復元
    console.log('\n  FTS5インデックス再構築中...');
    await rebuildFts5(clients.fanza);

    const afterResult = await clients.fanza.execute(
        "SELECT COUNT(*) as cnt FROM products WHERE actresses IS NULL OR actresses = ''"
    );
    const remaining = Number(afterResult.rows[0].cnt);

    console.log(`\n\n✅ scrape-videoc-direct 完了`);
    console.log(`   チェック: ${sessionChecked.toLocaleString()}件 / 発見: ${sessionFound.toLocaleString()}件 / 更新: ${sessionUpdated.toLocaleString()}件`);
    console.log(`   女優不明 残: ${remaining.toLocaleString()}件`);

    await sendDiscord(
        `✅ **avwiki videoc 直接スクレイプ 完了** (${nowJST()})\n` +
        `チェック: **${sessionChecked.toLocaleString()}件** | 発見: **${sessionFound.toLocaleString()}件** | 更新: **${sessionUpdated.toLocaleString()}件**\n` +
        `女優不明 残: **${remaining.toLocaleString()}件**`
    );
}

// ========== --search-all モード ==========
// FANZA DB 女優不明の全品番を avwiki で直接 URL 試打して女優を特定する。
// サイトマップ外の作品も含む全量対象。並列5で404は高速スキップ。
async function scrapeSearchAll(clients) {
    const CHECKED_FILE     = path.join(DATA_DIR, 'avwiki_search_all_checked.txt');
    const STATS_FILE       = path.join(DATA_DIR, 'avwiki_search_all_stats.json');
    const CONCURRENCY      = 5;
    const WAIT_HIT_MS      = 1200;   // ヒット時の待機
    const WAIT_MISS_MS     = 80;     // 404 時の待機
    const SAVE_INTERVAL    = 500;    // N件ごとに進捗保存
    const DISCORD_INTERVAL = 10000;  // N件ごとにDiscord通知

    console.log('══════════════════════════════════════════');
    console.log(SEARCH_ALL_PREFIX
        ? `  avwiki 全品番検索 (search-all --prefix ${SEARCH_ALL_PREFIX})`
        : '  avwiki 全品番検索 (search-all)');
    console.log('══════════════════════════════════════════\n');

    // 既チェック読み込み
    const checkedSet = new Set(
        fs.existsSync(CHECKED_FILE)
            ? fs.readFileSync(CHECKED_FILE, 'utf-8').split('\n').filter(Boolean)
            : []
    );
    let stats = { checked: 0, found: 0, updated: 0, errors: 0 };
    if (fs.existsSync(STATS_FILE)) Object.assign(stats, JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8')));

    // FANZA DB 女優不明 product_id 取得
    const emptyResult = SEARCH_ALL_PREFIX
        ? await clients.fanza.execute({
            sql: "SELECT product_id FROM products WHERE (actresses IS NULL OR actresses = '') AND product_id LIKE ?",
            args: [`${SEARCH_ALL_PREFIX}%`],
          })
        : await clients.fanza.execute(
            "SELECT product_id FROM products WHERE actresses IS NULL OR actresses = ''"
          );
    const allPids = emptyResult.rows.map(r => r.product_id);
    if (SEARCH_ALL_PREFIX) {
        console.log(`  プレフィックスフィルター: ${SEARCH_ALL_PREFIX}`);
    }
    console.log(`  FANZA 女優不明: ${allPids.length.toLocaleString()}件`);

    const todo = allPids.filter(pid => !checkedSet.has(pid));
    console.log(`  既チェック: ${checkedSet.size.toLocaleString()}件 / 残り: ${todo.length.toLocaleString()}件`);
    console.log(`  発見済み: ${stats.found.toLocaleString()}件 / 更新済み: ${stats.updated.toLocaleString()}件`);

    // ETA（404が大半として平均 ~100ms/件、並列5）
    const etaSec = Math.round(todo.length * 0.1 / CONCURRENCY);
    const etaH = Math.floor(etaSec / 3600);
    const etaM = Math.floor((etaSec % 3600) / 60);
    console.log(`  推定時間: 約 ${etaH}時間${etaM}分 (並列${CONCURRENCY}、404=80ms想定)\n`);

    if (todo.length === 0) {
        console.log('✅ 全対象スクレイプ済み');
        return;
    }

    await sendDiscord(
        `🔍 **avwiki 全品番検索 開始** (${nowJST()})\n` +
        `対象: **${todo.length.toLocaleString()}件** (FANZA女優不明全量)\n` +
        `並列: ${CONCURRENCY} / 推定: 約${etaH}時間${etaM}分`
    );

    // トリガーを一時停止（個別executeでトリガーが発火するとSQLITE_UNKNOWNになるため）
    try {
        await withTimeout(clients.fanza.execute('DROP TRIGGER IF EXISTS products_au'), 30000, 'FANZA DROP TRIGGER');
    } catch (e) {
        console.warn('  [警告] FANZA DROP TRIGGER 失敗:', e.message, '— 更新時にエラーが出る可能性あり');
    }

    const newlyChecked = [];
    let sessionChecked = 0, sessionFound = 0, sessionUpdated = 0;
    const startTime = Date.now();
    let taskIdx = 0;

    async function flushChecked() {
        if (newlyChecked.length === 0) return;
        fs.appendFileSync(CHECKED_FILE, newlyChecked.join('\n') + '\n');
        fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
        newlyChecked.length = 0;
    }

    // avwikiはハイフン形式(jul-777)を使用する場合がある。標準形式(jul00777)が404の場合に試みる。
    function toHyphenUrl(productId) {
        const m = productId.match(/^([a-z]+?)0*(\d+)$/i);
        if (!m) return null;
        const slug = `${m[1].toLowerCase()}-${m[2]}`;
        return slug !== productId ? `https://av-wiki.net/${slug}` : null;
    }

    async function worker() {
        while (true) {
            const idx = taskIdx++;
            if (idx >= todo.length) break;

            const pid = todo[idx];
            const url = `https://av-wiki.net/${pid}`;
            let hit = false;

            try {
                let html = await fetchHtml(url);
                let usedUrl = url;
                // 404の場合はハイフン形式(例: jul-777)でも試みる
                if (!html) {
                    const hyphenUrl = toHyphenUrl(pid);
                    if (hyphenUrl) {
                        html = await fetchHtml(hyphenUrl);
                        if (html) usedUrl = hyphenUrl;
                    }
                }
                if (html) {
                    const pageData = parseProductPage(html, usedUrl);
                    if (pageData?.actresses?.length > 0) {
                        hit = true;
                        const actressStr = pageData.actresses.join(', ');
                        try {
                            const res = await clients.fanza.execute({
                                sql: "UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ? AND (actresses IS NULL OR actresses = '')",
                                args: [actressStr, new Date().toISOString(), pid],
                            });
                            if (res.rowsAffected > 0) {
                                sessionUpdated++;
                                stats.updated++;
                                process.stdout.write(`\n  [発見] ${pid}: ${actressStr.substring(0, 50)}\n`);
                            }
                        } catch (e) {
                            stats.errors++;
                        }
                        sessionFound++;
                        stats.found++;
                    }
                }
            } catch (e) {
                stats.errors++;
            }

            checkedSet.add(pid);
            newlyChecked.push(pid);
            sessionChecked++;
            stats.checked++;

            // 進捗表示
            if (sessionChecked % 100 === 0) {
                const elapsed = (Date.now() - startTime) / 1000;
                const rate = sessionChecked / elapsed;
                const remaining = todo.length - sessionChecked;
                const etaRemSec = Math.round(remaining / rate);
                const etaRemH = Math.floor(etaRemSec / 3600);
                const etaRemM = Math.floor((etaRemSec % 3600) / 60);
                process.stdout.write(
                    `  ${sessionChecked.toLocaleString()}/${todo.length.toLocaleString()} | 発見: ${sessionFound} | ETA: 約${etaRemH}h${etaRemM}m\r`
                );
            }

            // 進捗保存
            if (newlyChecked.length >= SAVE_INTERVAL) await flushChecked();

            // Discord 通知
            if (sessionChecked % DISCORD_INTERVAL === 0) {
                await flushChecked();
                const elapsed = (Date.now() - startTime) / 1000;
                const rate = sessionChecked / elapsed;
                const remaining = todo.length - sessionChecked;
                const etaRemH = Math.floor(remaining / rate / 3600);
                const etaRemM = Math.floor((remaining / rate % 3600) / 60);
                await sendDiscord(
                    `🔍 **avwiki 全品番検索 進捗** (${nowJST()})\n` +
                    `${sessionChecked.toLocaleString()}/${todo.length.toLocaleString()}件\n` +
                    `発見: **${sessionFound.toLocaleString()}件** | 更新: **${sessionUpdated.toLocaleString()}件**\n` +
                    `残り: 約${etaRemH}時間${etaRemM}分`
                );
            }

            await sleep(hit ? WAIT_HIT_MS : WAIT_MISS_MS);
        }
    }

    // 並列実行
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    // 最終保存
    await flushChecked();

    // FTS5再構築 + トリガー復元
    console.log('\n  FTS5インデックス再構築中...');
    await rebuildFts5(clients.fanza);

    const remaining = await clients.fanza.execute(
        "SELECT COUNT(*) as c FROM products WHERE actresses IS NULL OR actresses = ''"
    );

    console.log(`\n\n✅ search-all 完了`);
    console.log(`   チェック: ${sessionChecked.toLocaleString()}件 / 発見: ${sessionFound.toLocaleString()}件 / 更新: ${sessionUpdated.toLocaleString()}件`);
    console.log(`   女優不明 残: ${remaining.rows[0].c.toLocaleString()}件`);

    await sendDiscord(
        `✅ **avwiki 全品番検索 完了** (${nowJST()})\n` +
        `チェック: **${sessionChecked.toLocaleString()}件** | 発見: **${sessionFound.toLocaleString()}件** | 更新: **${sessionUpdated.toLocaleString()}件**\n` +
        `女優不明 残: **${remaining.rows[0].c.toLocaleString()}件**`
    );
}

// ========== --search-mgs モード ==========
// MGS DB 女優不明の全品番を avwiki で直接 URL 試打して女優を特定する。
// MGS品番 (例: SIRO-5674) を小文字化して https://av-wiki.net/siro-5674/ を試す。
async function scrapeSearchMgs(clients) {
    const CHECKED_FILE     = path.join(DATA_DIR, 'avwiki_search_mgs_checked.txt');
    const STATS_FILE       = path.join(DATA_DIR, 'avwiki_search_mgs_stats.json');
    const CONCURRENCY      = 5;
    const WAIT_HIT_MS      = 1200;
    const WAIT_MISS_MS     = 80;
    const SAVE_INTERVAL    = 500;
    const DISCORD_INTERVAL = 5000;

    console.log('══════════════════════════════════════════');
    console.log('  avwiki MGS品番検索 (search-mgs)');
    console.log('══════════════════════════════════════════\n');

    const checkedSet = new Set(
        fs.existsSync(CHECKED_FILE)
            ? fs.readFileSync(CHECKED_FILE, 'utf-8').split('\n').filter(Boolean)
            : []
    );
    let stats = { checked: 0, found: 0, updated: 0, errors: 0 };
    if (fs.existsSync(STATS_FILE)) Object.assign(stats, JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8')));

    // MGS DB 女優不明 product_id 取得
    const emptyResult = await clients.mgs.execute(
        "SELECT product_id FROM products WHERE actresses IS NULL OR actresses = ''"
    );
    const allPids = emptyResult.rows.map(r => String(r.product_id));
    console.log(`  MGS 女優不明: ${allPids.length.toLocaleString()}件`);

    const todo = allPids.filter(pid => !checkedSet.has(pid));
    console.log(`  既チェック: ${checkedSet.size.toLocaleString()}件 / 残り: ${todo.length.toLocaleString()}件`);
    console.log(`  発見済み: ${stats.found.toLocaleString()}件 / 更新済み: ${stats.updated.toLocaleString()}件`);

    const etaSec = Math.round(todo.length * 0.1 / CONCURRENCY);
    const etaH = Math.floor(etaSec / 3600);
    const etaM = Math.floor((etaSec % 3600) / 60);
    console.log(`  推定時間: 約 ${etaH}時間${etaM}分 (並列${CONCURRENCY}、404=80ms想定)\n`);

    if (todo.length === 0) {
        console.log('✅ 全対象スクレイプ済み');
        return;
    }

    await sendDiscord(
        `🔍 **avwiki MGS品番検索 開始** (${nowJST()})\n` +
        `対象: **${todo.length.toLocaleString()}件** (MGS女優不明全量)\n` +
        `並列: ${CONCURRENCY} / 推定: 約${etaH}時間${etaM}分`
    );

    // トリガーを一時停止
    try {
        await withTimeout(clients.mgs.execute('DROP TRIGGER IF EXISTS products_au'), 30000, 'MGS DROP TRIGGER');
    } catch (e) {
        console.warn('  [警告] MGS DROP TRIGGER 失敗:', e.message, '— 更新時にエラーが出る可能性あり');
    }

    const newlyChecked = [];
    let sessionChecked = 0, sessionFound = 0, sessionUpdated = 0;
    const startTime = Date.now();
    let taskIdx = 0;

    async function flushChecked() {
        if (newlyChecked.length === 0) return;
        fs.appendFileSync(CHECKED_FILE, newlyChecked.join('\n') + '\n');
        fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
        newlyChecked.length = 0;
    }

    async function worker() {
        while (true) {
            const idx = taskIdx++;
            if (idx >= todo.length) break;

            const pid = todo[idx];
            // MGS品番を小文字化してURLに変換 (SIRO-5674 → siro-5674)
            const slug = pid.toLowerCase();
            const url = `https://av-wiki.net/${slug}/`;
            let hit = false;

            try {
                const html = await fetchHtml(url);
                if (html) {
                    const pageData = parseProductPage(html, url);
                    if (pageData?.actresses?.length > 0) {
                        hit = true;
                        const actressStr = pageData.actresses.join(', ');
                        // JSONL にも追記
                        const entry = { url, scraped_at: new Date().toISOString(), slug,
                            actresses: pageData.actresses, maker_pid: pid,
                            fanza_pid: pageData.fanza_pid || null,
                            maker: pageData.maker || null, sale_date: pageData.sale_date || null };
                        fs.appendFileSync(OUTPUT_JSONL, JSON.stringify(entry) + '\n');

                        try {
                            const res = await clients.mgs.execute({
                                sql: "UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ? AND (actresses IS NULL OR actresses = '')",
                                args: [actressStr, new Date().toISOString(), pid],
                            });
                            if (res.rowsAffected > 0) {
                                sessionUpdated++;
                                stats.updated++;
                                process.stdout.write(`\n  [発見] ${pid}: ${actressStr.substring(0, 50)}\n`);
                            }
                        } catch (e) {
                            stats.errors++;
                        }
                        sessionFound++;
                        stats.found++;
                    }
                }
            } catch (e) {
                stats.errors++;
            }

            checkedSet.add(pid);
            newlyChecked.push(pid);
            sessionChecked++;
            stats.checked++;

            if (sessionChecked % 100 === 0) {
                const elapsed = (Date.now() - startTime) / 1000;
                const rate = sessionChecked / elapsed;
                const remaining = todo.length - sessionChecked;
                const etaRemSec = Math.round(remaining / rate);
                const etaRemH = Math.floor(etaRemSec / 3600);
                const etaRemM = Math.floor((etaRemSec % 3600) / 60);
                process.stdout.write(
                    `  ${sessionChecked.toLocaleString()}/${todo.length.toLocaleString()} | 発見: ${sessionFound} | ETA: 約${etaRemH}h${etaRemM}m\r`
                );
            }

            if (newlyChecked.length >= SAVE_INTERVAL) await flushChecked();

            if (sessionChecked % DISCORD_INTERVAL === 0) {
                await flushChecked();
                const elapsed = (Date.now() - startTime) / 1000;
                const rate = sessionChecked / elapsed;
                const remaining = todo.length - sessionChecked;
                const etaRemH = Math.floor(remaining / rate / 3600);
                const etaRemM = Math.floor((remaining / rate % 3600) / 60);
                await sendDiscord(
                    `🔍 **avwiki MGS品番検索 進捗** (${nowJST()})\n` +
                    `${sessionChecked.toLocaleString()}/${todo.length.toLocaleString()}件\n` +
                    `発見: **${sessionFound.toLocaleString()}件** | 更新: **${sessionUpdated.toLocaleString()}件**\n` +
                    `残り: 約${etaRemH}時間${etaRemM}分`
                );
            }

            await sleep(hit ? WAIT_HIT_MS : WAIT_MISS_MS);
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    await flushChecked();

    // FTS5再構築 + トリガー復元
    console.log('\n  FTS5インデックス再構築中...');
    await rebuildFts5(clients.mgs);

    const remaining = await clients.mgs.execute(
        "SELECT COUNT(*) as c FROM products WHERE actresses IS NULL OR actresses = ''"
    );

    console.log(`\n\n✅ search-mgs 完了`);
    console.log(`   チェック: ${sessionChecked.toLocaleString()}件 / 発見: ${sessionFound.toLocaleString()}件 / 更新: ${sessionUpdated.toLocaleString()}件`);
    console.log(`   MGS女優不明 残: ${remaining.rows[0].c.toLocaleString()}件`);

    await sendDiscord(
        `✅ **avwiki MGS品番検索 完了** (${nowJST()})\n` +
        `チェック: **${sessionChecked.toLocaleString()}件** | 発見: **${sessionFound.toLocaleString()}件** | 更新: **${sessionUpdated.toLocaleString()}件**\n` +
        `MGS女優不明 残: **${remaining.rows[0].c.toLocaleString()}件**`
    );
}

// ========== --daily モード ==========
// avwiki RSSフィードから新着product URLを取得し、出演者情報をDB更新する。
// 毎日1回実行することで新作の女優情報を自動取得する。
async function dailyScrape(clients, count = 100) {
    const CHECKED_FILE = path.join(DATA_DIR, 'avwiki_daily_checked.json');
    const WAIT_MS      = 1500;

    console.log('══════════════════════════════════════════');
    console.log('  avwiki 日次スクレイプ (新着RSSから出演者取得)');
    console.log('══════════════════════════════════════════\n');

    // 既チェック済みURL読み込み
    let checkedUrls = {};
    if (fs.existsSync(CHECKED_FILE)) {
        checkedUrls = JSON.parse(fs.readFileSync(CHECKED_FILE, 'utf-8'));
    }

    // RSSフィードから新着URL取得
    console.log(`  RSSフィード取得中 (最大${count}件)...`);
    const rssUrl = `https://av-wiki.net/feed/?posts_per_page=${count}`;
    const rssHtml = await fetchHtml(rssUrl);
    if (!rssHtml) {
        console.error('❌ RSSフィード取得失敗');
        return;
    }

    // <link> と <pubDate> を対で抽出
    const items = [];
    const itemMatches = [...rssHtml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    for (const m of itemMatches) {
        const block = m[1];
        const linkM = block.match(/<link>(https:\/\/av-wiki\.net\/[^<]+)<\/link>/);
        const dateM = block.match(/<pubDate>([^<]+)<\/pubDate>/);
        if (linkM) {
            items.push({
                url:     linkM[1].trim(),
                pubDate: dateM ? new Date(dateM[1].trim()) : new Date(0),
            });
        }
    }
    console.log(`  RSS取得: ${items.length}件`);

    // 未チェックのみ絞り込み
    const todo = items.filter(item => !checkedUrls[item.url]);
    console.log(`  既チェック済み: ${items.length - todo.length}件 / 新規: ${todo.length}件\n`);

    if (todo.length === 0) {
        console.log('✅ 新着なし（全件チェック済み）');
        await sendDiscord(`📰 **avwiki 日次スクレイプ** (${nowJST()})\n新着なし（全件チェック済み）`);
        return;
    }

    let fanzaUpdated = 0, mgsUpdated = 0, found = 0, errors = 0;
    const now = new Date().toISOString();
    const newChecked = {};

    for (const { url, pubDate } of todo) {
        try {
            const html = await fetchHtml(url);
            if (!html) {
                newChecked[url] = 1;
                continue;
            }
            const data = parseProductPage(html, url);

            if (data.actresses && data.actresses.length > 0) {
                found++;
                const actressStr = data.actresses.join(', ');

                // FANZA DB更新
                if (data.fanza_pid) {
                    const r = await clients.fanza.execute({
                        sql:  `UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ? AND (actresses IS NULL OR actresses = '')`,
                        args: [actressStr, now, data.fanza_pid],
                    });
                    fanzaUpdated += r.rowsAffected || 0;
                }
                // MGS DB更新
                if (data.maker_pid) {
                    const r = await clients.mgs.execute({
                        sql:  `UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ? AND (actresses IS NULL OR actresses = '')`,
                        args: [actressStr, now, data.maker_pid],
                    });
                    mgsUpdated += r.rowsAffected || 0;
                }

                // product_map.jsonl にも追記
                fs.appendFileSync(OUTPUT_JSONL, JSON.stringify(data) + '\n');

                if (fanzaUpdated + mgsUpdated > 0) {
                    process.stdout.write(`\n  [更新] ${data.fanza_pid || data.maker_pid}: ${actressStr.substring(0, 50)}\n`);
                }
            }
        } catch (e) {
            errors++;
            console.warn(`  [エラー] ${url}: ${e.message}`);
        }

        newChecked[url] = 1;
        process.stdout.write(`  ${Object.keys(newChecked).length}/${todo.length} | FANZA+${fanzaUpdated} MGS+${mgsUpdated}\r`);
        await sleep(WAIT_MS);
    }

    // 進捗保存（古いエントリは30日で削除）
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const merged = { ...checkedUrls, ...newChecked };
    // checked fileのサイズ管理（古いURLは削除しないためシンプルに上書き）
    fs.writeFileSync(CHECKED_FILE, JSON.stringify(merged, null, 0));

    console.log(`\n\n✅ 日次スクレイプ完了`);
    console.log(`   新着: ${todo.length}件 | 女優特定: ${found}件 | FANZA更新: ${fanzaUpdated}件 | MGS更新: ${mgsUpdated}件 | エラー: ${errors}件`);

    await sendDiscord(
        `📰 **avwiki 日次スクレイプ完了** (${nowJST()})\n` +
        `新着: **${todo.length}件** | 女優特定: **${found}件**\n` +
        `FANZA更新: **${fanzaUpdated}件** / MGS更新: **${mgsUpdated}件**`
    );
}

// ========== --scrape-all-makers モード ==========
// fanza-video-index / fanza-shirouto-index / mgstage-index の全メーカーページを巡回して
// 品番・女優名を取得し FANZA / MGS Turso DB を更新する。
async function scrapeAllMakers(clients) {
    const ALL_MAKERS_PROGRESS = path.join(DATA_DIR, 'avwiki_makers_progress.json');
    const WAIT_PAGE_MS        = 1500;  // ページ間の待機
    const WAIT_MAKER_MS       = 2000;  // メーカー間の待機

    const INDEX_PAGES = [
        { url: 'https://av-wiki.net/fanza-video-index/',    base: 'fanza-video',    dbType: 'fanza' },
        { url: 'https://av-wiki.net/fanza-shirouto-index/', base: 'fanza-shirouto', dbType: 'fanza' },
        { url: 'https://av-wiki.net/mgstage/',              base: 'mgstage',        dbType: 'mgs'   },
    ];

    console.log('══════════════════════════════════════════');
    console.log('  avwiki 全メーカーページ スクレイプ (scrape-all-makers)');
    console.log('══════════════════════════════════════════\n');

    // 進捗読み込み
    let progressData = { completed: [] };
    if (fs.existsSync(ALL_MAKERS_PROGRESS)) {
        progressData = JSON.parse(fs.readFileSync(ALL_MAKERS_PROGRESS, 'utf-8'));
    }
    const completedSet = new Set(progressData.completed || []);

    // インデックスページから全メーカースラグを収集
    async function fetchMakerSlugs(indexUrl, base) {
        const html = await fetchHtml(indexUrl);
        if (!html) return [];
        const $ = cheerio.load(html);
        const slugs = [];
        const re = new RegExp(`/${base}/([^/]+)/?$`);
        $('a[href]').each((i, el) => {
            const href = $(el).attr('href') || '';
            const m = href.match(re);
            if (m && m[1]) slugs.push(m[1]);
        });
        return [...new Set(slugs)];
    }

    // メーカーページの1ページ分のarticleを解析 (FANZA or MGS共通)
    function parseArticlesGeneric(html, dbType) {
        const $ = cheerio.load(html);
        const results = [];
        $('article').each((i, el) => {
            const htmlStr = $(el).html() || '';
            let pid = null;
            if (dbType === 'fanza') {
                // FANZA: cid%3D または cid= の後ろ
                const m = htmlStr.match(/cid(?:%3D|=)([a-z0-9_]+)/i);
                pid = m ? m[1].toLowerCase() : null;
            } else {
                // MGS: mgstage.com/product/product_detail/{PID}/
                const m = htmlStr.match(/mgstage\.com\/product\/product_detail\/([A-Z0-9]+-\d+)\//i);
                pid = m ? m[1].toUpperCase() : null;
            }
            // 「#名前1 #名前2 …」と1要素に連結される場合があるため # で分割して個別化
            const actresses = [];
            $(el).find('li.actress-name').each((j, a) => {
                $(a).text().trim().split('#').map(s => s.trim()).filter(Boolean).forEach(n => {
                    if (!actresses.includes(n)) actresses.push(n);
                });
            });
            if (pid && actresses.length > 0) results.push({ pid, actresses });
        });
        return results;
    }

    // インデックスページから全メーカー一覧を収集
    console.log('  インデックスページからメーカー一覧を取得中...');
    const allMakers = [];
    for (const { url, base, dbType } of INDEX_PAGES) {
        const slugs = await fetchMakerSlugs(url, base);
        console.log(`  ${base}: ${slugs.length}件`);
        for (const slug of slugs) allMakers.push({ base, slug, dbType, key: `${base}/${slug}` });
        await sleep(2000);
    }
    console.log(`\n  合計メーカー数: ${allMakers.length}件`);

    const todo = allMakers.filter(m => !completedSet.has(m.key));
    console.log(`  既完了: ${completedSet.size}件 / 残り: ${todo.length}件\n`);

    if (todo.length === 0) {
        console.log('✅ 全メーカー スクレイプ済み');
        return;
    }

    await sendDiscord(
        `🏭 **avwiki 全メーカースクレイプ 開始** (${nowJST()})\n` +
        `対象: **${todo.length}件** / 合計: ${allMakers.length}件\n既完了: ${completedSet.size}件`
    );

    let totalFanza = 0, totalMgs = 0, makersDone = 0;
    const now = new Date().toISOString();

    for (const { base, slug, dbType, key } of todo) {
        const baseUrl = `https://av-wiki.net/${base}/${slug}/`;
        process.stdout.write(`\n[${makersDone + 1}/${todo.length}] ${key} ... `);

        try {
            const firstHtml = await fetchHtml(baseUrl);
            if (!firstHtml) {
                process.stdout.write('404\n');
                completedSet.add(key);
                progressData.completed.push(key);
                fs.writeFileSync(ALL_MAKERS_PROGRESS, JSON.stringify(progressData, null, 2));
                makersDone++;
                continue;
            }

            // 総ページ数
            const $first = cheerio.load(firstHtml);
            const pageNums = [];
            $first('.page-numbers').each((i, el) => {
                const n = parseInt($first(el).text());
                if (!isNaN(n)) pageNums.push(n);
            });
            const totalPages = pageNums.length > 0 ? Math.max(...pageNums) : 1;

            const allEntries = [...parseArticlesGeneric(firstHtml, dbType)];
            for (let page = 2; page <= totalPages; page++) {
                const pageUrl = `${baseUrl}page/${page}/`;
                try {
                    const html = await fetchHtml(pageUrl);
                    if (html) allEntries.push(...parseArticlesGeneric(html, dbType));
                } catch (e) {
                    console.warn(`\n  [page ${page} error]`, e.message);
                }
                await sleep(WAIT_PAGE_MS);
            }

            process.stdout.write(`${totalPages}ページ / ${allEntries.length}件`);

            // Turso 更新
            if (allEntries.length > 0) {
                const stmts = allEntries.map(({ pid, actresses }) => ({
                    // MGS: 疑似名（素人コンテンツ）を上書きするため actress IS NULL 条件なし
                    // FANZA: 空のもののみ更新
                    sql: dbType === 'mgs'
                        ? "UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ?"
                        : "UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ? AND (actresses IS NULL OR actresses = '')",
                    args: [actresses.join(', '), now, pid],
                }));
                if (dbType === 'fanza') {
                    const updated = await managedBatchUpdate(clients.fanza, stmts);
                    totalFanza += updated;
                    process.stdout.write(` → FANZA+${updated}`);
                } else {
                    const updated = await managedBatchUpdate(clients.mgs, stmts);
                    totalMgs += updated;
                    process.stdout.write(` → MGS+${updated}`);
                }
            }
        } catch (e) {
            console.warn(`\n  [error] ${key}:`, e.message);
        }

        completedSet.add(key);
        progressData.completed.push(key);
        makersDone++;

        // 10件ごとに進捗保存
        if (makersDone % 10 === 0) {
            fs.writeFileSync(ALL_MAKERS_PROGRESS, JSON.stringify(progressData, null, 2));
            console.log(`\n  [${makersDone}/${todo.length}] FANZA累計: ${totalFanza} / MGS累計: ${totalMgs}`);
        }

        // 50件ごとにDiscord通知
        if (makersDone % 50 === 0) {
            fs.writeFileSync(ALL_MAKERS_PROGRESS, JSON.stringify(progressData, null, 2));
            await sendDiscord(
                `🏭 **avwiki 全メーカースクレイプ 進捗** (${nowJST()})\n` +
                `${makersDone}/${todo.length}件完了\n` +
                `FANZA更新: **${totalFanza}件** / MGS更新: **${totalMgs}件**`
            );
        }

        await sleep(WAIT_MAKER_MS);
    }

    // 最終保存
    fs.writeFileSync(ALL_MAKERS_PROGRESS, JSON.stringify(progressData, null, 2));

    // FTS5再構築
    console.log('\n\n  FANZA FTS5再構築中...');
    await rebuildFts5(clients.fanza);
    console.log('  MGS FTS5再構築中...');
    await rebuildFts5(clients.mgs);

    const fanzaRem = await clients.fanza.execute("SELECT COUNT(*) as c FROM products WHERE actresses IS NULL OR actresses = ''");
    const mgsRem   = await clients.mgs.execute("SELECT COUNT(*) as c FROM products WHERE actresses IS NULL OR actresses = ''");

    console.log(`\n✅ scrape-all-makers 完了`);
    console.log(`   FANZA更新: ${totalFanza}件 / MGS更新: ${totalMgs}件`);
    console.log(`   FANZA女優不明 残: ${fanzaRem.rows[0].c.toLocaleString()}件`);
    console.log(`   MGS女優不明 残: ${mgsRem.rows[0].c.toLocaleString()}件`);

    await sendDiscord(
        `✅ **avwiki 全メーカースクレイプ 完了** (${nowJST()})\n` +
        `メーカー: ${makersDone}件完了\n` +
        `FANZA更新: **${totalFanza}件** / MGS更新: **${totalMgs}件**\n` +
        `FANZA女優不明 残: **${fanzaRem.rows[0].c.toLocaleString()}件** / MGS: **${mgsRem.rows[0].c.toLocaleString()}件**`
    );
}

// ========== --scrape-maker モード ==========
// avwiki のメーカーカテゴリページを全ページ巡回して品番・女優名を取得し Turso DB を更新する。
// /mgstage/{slug}/ → MGS DB 更新（product_id は MGS形式 例: 390JNT-119）
// /fanza-video/{slug}/ or /fanza-shirouto/{slug}/ → FANZA DB 更新（product_id は FANZA形式 例: hunta00246）
async function scrapeMakerPage(clients, makerSlug) {
    const cheerio = require('cheerio');

    // mgstage / fanza-shirouto / fanza-video の順に試す
    // リダイレクト先がメーカーインデックスページかを確認するため res.url を検証
    async function resolveBaseUrl(slug) {
        // 1) MGS動画メーカーページを優先チェック
        const mgsUrl = `https://av-wiki.net/mgstage/${slug}/`;
        const mgsRes = await fetch(mgsUrl, { headers: { 'User-Agent': UA } });
        if (mgsRes.ok && mgsRes.url.includes(`/mgstage/${slug}`)) {
            return { url: mgsUrl, isMgs: true };
        }
        // 2) FANZA系メーカーページ
        for (const base of ['fanza-shirouto', 'fanza-video']) {
            const url = `https://av-wiki.net/${base}/${slug}/`;
            const res = await fetch(url, { headers: { 'User-Agent': UA } });
            // リダイレクト先が同じパスならOK（製品ページへのリダイレクトは除外）
            if (res.ok && res.url.includes(`/${base}/${slug}`)) {
                return { url, isMgs: false };
            }
        }
        return null;
    }

    const resolved = await resolveBaseUrl(makerSlug);
    if (!resolved) { console.error(`❌ avwiki にメーカーページが見つかりません: ${makerSlug}`); return; }
    const { url: BASE_URL, isMgs } = resolved;
    const WAIT_MS = 1500;

    console.log('══════════════════════════════════════════');
    console.log(`  avwiki メーカーページ スクレイプ: ${makerSlug} (${isMgs ? 'MGS' : 'FANZA'})`);
    console.log('══════════════════════════════════════════\n');
    console.log(`  URL: ${BASE_URL}`);

    // ① 1ページ目取得して総ページ数を確認
    const firstHtml = await fetchHtml(BASE_URL);
    if (!firstHtml) { console.error('❌ ページ取得失敗:', BASE_URL); return; }

    const $first = cheerio.load(firstHtml);
    const pageNums = [];
    $first('.page-numbers').each((i, el) => {
        const n = parseInt($first(el).text());
        if (!isNaN(n)) pageNums.push(n);
    });
    const totalPages = pageNums.length > 0 ? Math.max(...pageNums) : 1;
    console.log(`  総ページ数: ${totalPages}`);

    // ② 1ページのアーティクル情報を抽出
    function parseArticles(html) {
        const $ = cheerio.load(html);
        const results = [];
        $('article').each((i, el) => {
            const elHtml = $(el).html() || '';

            // 女優名: li.actress-name
            // 1要素に「#名前1 #名前2 …」と連結される場合があるため # で分割して個別化する
            const actresses = [];
            $(el).find('li.actress-name').each((j, a) => {
                const raw = $(a).text().trim();
                raw.split('#').map(s => s.trim()).filter(Boolean).forEach(n => {
                    if (!actresses.includes(n)) actresses.push(n);
                });
            });
            if (actresses.length === 0) return;

            let pid = null;
            if (isMgs) {
                // MGS: mgstage.com/product/product_detail/390JNT-119/ からproduct_idを取得
                const m = elHtml.match(/product_detail\/([A-Z0-9]+-\d+)\//i);
                pid = m ? m[1].toUpperCase() : null;
            } else {
                // FANZA: cid%3D or cid= からproduct_idを取得
                const m = elHtml.match(/cid(?:%3D|=)([a-z0-9_]+)/i);
                pid = m ? m[1].toLowerCase() : null;
            }

            if (pid) results.push({ pid, actresses });
        });
        return results;
    }

    let totalUpdated = 0;
    const allEntries = [];

    // ③ 全ページ巡回
    for (let page = 1; page <= totalPages; page++) {
        const url = page === 1 ? BASE_URL : `${BASE_URL}page/${page}/`;
        try {
            const html = page === 1 ? firstHtml : await fetchHtml(url);
            if (!html) { console.warn(`  [skip] page ${page}: 取得失敗`); continue; }

            const entries = parseArticles(html);
            allEntries.push(...entries);
            process.stdout.write(`  ${page}/${totalPages} | 累計: ${allEntries.length}件\r`);
        } catch (e) {
            console.warn(`  [error] page ${page}:`, e.message);
        }
        if (page < totalPages) await sleep(WAIT_MS);
    }

    console.log(`\n\n  取得完了: ${allEntries.length}件 → Turso更新中...`);

    // ④ Turso 一括更新
    const now = new Date().toISOString();
    const db = isMgs ? clients.mgs : clients.fanza;
    const updateStatements = allEntries.map(({ pid, actresses }) => ({
        // MGS: 疑似名を上書きするため actresses 条件なし / FANZA: 空のもののみ更新
        sql: isMgs
            ? "UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ?"
            : "UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ? AND (actresses IS NULL OR actresses = '')",
        args: isMgs ? [actresses.join(', '), now, pid] : [actresses.join(', '), now, pid],
    }));
    totalUpdated = await managedBatchUpdate(db, updateStatements);
    const totalFound = allEntries.length;

    const remaining = await db.execute(
        "SELECT COUNT(*) as c FROM products WHERE actresses IS NULL OR actresses = ''"
    );

    // scrape-all-makers の進捗ファイルにも記録（重複実行防止）
    const ALL_MAKERS_PROGRESS = path.join(DATA_DIR, 'avwiki_makers_progress.json');
    try {
        let prog = fs.existsSync(ALL_MAKERS_PROGRESS) ? JSON.parse(fs.readFileSync(ALL_MAKERS_PROGRESS, 'utf-8')) : { completed: [] };
        if (!prog.completed) prog.completed = [];
        const key = `${isMgs ? 'mgstage' : 'fanza-video'}/${makerSlug}`;
        if (!prog.completed.includes(key)) { prog.completed.push(key); fs.writeFileSync(ALL_MAKERS_PROGRESS, JSON.stringify(prog, null, 2)); }
    } catch (e) { /* ignore */ }

    console.log(`\n✅ scrape-maker (${makerSlug}) 完了`);
    console.log(`   DB: ${isMgs ? 'MGS' : 'FANZA'} | 取得: ${allEntries.length}件 | 更新: ${totalUpdated}件`);
    console.log(`   女優不明 残: ${remaining.rows[0].c.toLocaleString()}件`);

    await sendDiscord(
        `✅ **avwiki メーカースクレイプ完了** (${nowJST()})\n` +
        `メーカー: **${makerSlug}** [${isMgs ? 'MGS' : 'FANZA'}] (${totalPages}ページ)\n` +
        `取得: **${allEntries.length}件** | 更新: **${totalUpdated}件**\n` +
        `女優不明 残: **${remaining.rows[0].c.toLocaleString()}件**`
    );
}

// ========== --search-by-label モード ==========
// DBの女優不明product_idのアルファベットプレフィックス（例: spay, pwife）でグループ化し、
// 各product_idをavwikiのURL（例: https://av-wiki.net/spay013/）として直接試打する。
// サイトマップ外の作品ページを直接ヒットさせる。並列5でスクレイプ。
async function searchByLabel(clients, targetSlug) {
    const CHECKED_FILE     = path.join(DATA_DIR, 'avwiki_label_search_checked.json');
    const CONCURRENCY      = 5;
    const WAIT_HIT_MS      = 1200;  // ヒット時の待機
    const WAIT_MISS_MS     = 80;    // 404時の待機
    const SAVE_INTERVAL    = 200;   // N件ごとに進捗保存
    const DISCORD_INTERVAL = 2000;  // N件ごとにDiscord通知

    console.log('══════════════════════════════════════════');
    console.log('  avwiki ラベル直接試打 (search-by-label)');
    if (targetSlug) console.log(`  対象ラベル: ${targetSlug}`);
    console.log('══════════════════════════════════════════\n');

    // 既チェック済みproduct_idの読み込み
    let checkedState = { checked: {}, labels: {} }; // checked: pid→true, labels: prefix→stats
    if (fs.existsSync(CHECKED_FILE)) {
        checkedState = JSON.parse(fs.readFileSync(CHECKED_FILE, 'utf-8'));
        if (!checkedState.checked) checkedState.checked = {};
        if (!checkedState.labels) checkedState.labels = {};
    }
    const checkedSet = new Set(Object.keys(checkedState.checked));

    // FANZA DB 女優不明 product_id を取得
    const emptyResult = await clients.fanza.execute(
        "SELECT product_id FROM products WHERE actresses IS NULL OR actresses = ''"
    );
    const emptyPids = emptyResult.rows.map(r => r.product_id);
    console.log(`  FANZA 女優不明: ${emptyPids.length.toLocaleString()}件`);

    // product_id からアルファベットプレフィックスを抽出してグループ化
    // 例: spay013 → spay, pwife006 → pwife, mkmp00561 → mkmp
    // h_244rsama00081 のようなアンダースコア形式や数字混じりプレフィックスはスキップ
    function extractPrefix(pid) {
        // アンダースコアを含む or 先頭に数字 → スキップ
        if (pid.includes('_') || /^\d/.test(pid)) return null;
        const m = pid.match(/^([a-z]{2,})/i); // 最低2文字以上のアルファベット
        return m ? m[1].toLowerCase() : null;
    }

    const prefixMap = new Map(); // prefix → [pid, ...]
    for (const pid of emptyPids) {
        const prefix = extractPrefix(pid);
        if (!prefix) continue;
        if (!prefixMap.has(prefix)) prefixMap.set(prefix, []);
        prefixMap.get(prefix).push(pid);
    }

    // 対象ラベルを絞り込む
    let targetPrefixes;
    if (targetSlug) {
        targetPrefixes = [targetSlug.toLowerCase()];
    } else {
        // 未チェック品番があるプレフィックスのみ（件数多い順）
        targetPrefixes = [...prefixMap.entries()]
            .filter(([p, pids]) => pids.some(pid => !checkedSet.has(pid)))
            .sort((a, b) => b[1].length - a[1].length)
            .map(([p]) => p);
        console.log(`  ラベルプレフィックス数: ${prefixMap.size.toLocaleString()}種 / 未チェックあり: ${targetPrefixes.length.toLocaleString()}種`);
        // 上位20件を表示
        console.log('  上位20件:');
        [...prefixMap.entries()]
            .sort((a, b) => b[1].length - a[1].length)
            .slice(0, 20)
            .forEach(([p, pids]) => {
                const stats = checkedState.labels[p];
                const status = stats ? `✅ 発見:${stats.found} 更新:${stats.updated}` : '未';
                console.log(`    ${p}: ${pids.length}件 ${status}`);
            });
        console.log('');
    }

    let totalChecked = 0, totalFound = 0, totalUpdated = 0, totalErrors = 0;
    const now = new Date().toISOString();
    const newlyChecked = [];

    function saveProgress() {
        for (const pid of newlyChecked) checkedState.checked[pid] = 1;
        newlyChecked.length = 0;
        fs.writeFileSync(CHECKED_FILE, JSON.stringify(checkedState, null, 2));
    }

    // トリガーを一時停止（個別executeでのSQLITE_UNKNOWN回避）
    await clients.fanza.execute('DROP TRIGGER IF EXISTS products_au');

    for (const prefix of targetPrefixes) {
        const pidsForLabel = (prefixMap.get(prefix) || []).filter(pid => !checkedSet.has(pid));
        if (pidsForLabel.length === 0) continue;

        process.stdout.write(`\n[${prefix}] 対象: ${pidsForLabel.length}件\n`);
        let labelFound = 0, labelUpdated = 0;
        let taskIdx = 0;

        async function worker() {
            while (true) {
                const idx = taskIdx++;
                if (idx >= pidsForLabel.length) break;

                const pid = pidsForLabel[idx];
                const url = `https://av-wiki.net/${pid}/`;
                let hit = false;

                try {
                    const html = await fetchHtml(url);
                    if (html) {
                        const pageData = parseProductPage(html, url);
                        if (pageData?.actresses?.length > 0) {
                            hit = true;
                            const actressStr = pageData.actresses.join(', ');
                            try {
                                const res = await clients.fanza.execute({
                                    sql: "UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ? AND (actresses IS NULL OR actresses = '')",
                                    args: [actressStr, now, pid],
                                });
                                if (res.rowsAffected > 0) {
                                    labelUpdated++;
                                    totalUpdated++;
                                    process.stdout.write(`\n  [更新] ${pid}: ${actressStr.substring(0, 50)}\n`);
                                }
                            } catch (e) { totalErrors++; }
                            labelFound++;
                            totalFound++;
                        }
                    }
                } catch (e) { totalErrors++; }

                checkedSet.add(pid);
                newlyChecked.push(pid);
                totalChecked++;

                if (totalChecked % 50 === 0) {
                    process.stdout.write(`  ${prefix}: ${idx + 1}/${pidsForLabel.length} | 発見:${labelFound} | 全体更新:${totalUpdated}\r`);
                }
                if (newlyChecked.length >= SAVE_INTERVAL) saveProgress();
                if (totalChecked % DISCORD_INTERVAL === 0) {
                    saveProgress();
                    await sendDiscord(
                        `🔍 **avwiki ラベル試打 進捗** (${nowJST()})\n` +
                        `チェック: **${totalChecked.toLocaleString()}件** | 発見: **${totalFound.toLocaleString()}件** | 更新: **${totalUpdated.toLocaleString()}件**`
                    );
                }

                await sleep(hit ? WAIT_HIT_MS : WAIT_MISS_MS);
            }
        }

        await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

        checkedState.labels[prefix] = { found: labelFound, updated: labelUpdated, checkedAt: now };
        saveProgress();
        console.log(`\n  ${prefix} 完了: 発見:${labelFound}件 / 更新:${labelUpdated}件`);
    }

    // FTS5再構築 + トリガー復元
    console.log('\n  FTS5インデックス再構築中...');
    await rebuildFts5(clients.fanza);

    const afterResult = await clients.fanza.execute(
        "SELECT COUNT(*) as c FROM products WHERE actresses IS NULL OR actresses = ''"
    );
    const remaining = Number(afterResult.rows[0].c);

    console.log(`\n\n✅ search-by-label 完了`);
    console.log(`   チェック: ${totalChecked.toLocaleString()}件 | 発見: ${totalFound.toLocaleString()}件 | 更新: ${totalUpdated.toLocaleString()}件`);
    console.log(`   女優不明 残: ${remaining.toLocaleString()}件`);

    await sendDiscord(
        `✅ **avwiki ラベル試打 完了** (${nowJST()})\n` +
        `チェック: **${totalChecked.toLocaleString()}件** | 発見: **${totalFound.toLocaleString()}件** | 更新: **${totalUpdated.toLocaleString()}件**\n` +
        `女優不明 残: **${remaining.toLocaleString()}件**`
    );
}

// ========== 進捗管理 ==========
function loadProgress() {
    if (fs.existsSync(PROGRESS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
        raw.completed = new Set(raw.completed || []);
        return raw;
    }
    return {
        completed: new Set(),
        scraped: 0, with_actress: 0, mgs_updated: 0, fanza_updated: 0, errors: 0,
    };
}

function saveProgress(p) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ ...p, completed: [...p.completed] }, null, 2));
}

// ========== メイン ==========
async function main() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    console.log('══════════════════════════════════════════');
    console.log('  av-wiki.net 品番ページ 女優特定スクレイパー');
    console.log('══════════════════════════════════════════');
    console.log(`  間隔: ${INTERVAL_MS / 1000}秒 / 推定: ${(0 * INTERVAL_MS / 1000 / 86400).toFixed(1)}日`);
    if (DRY_RUN)    console.log('  [DRY RUN] 最初の5件のみ');
    if (APPLY_ONLY) console.log('  [APPLY] DB反映のみ');
    console.log('');

    const clients = createClients();

    // --apply モード
    if (APPLY_ONLY) {
        await applyFromJsonl(clients);
        return;
    }

    // --apply-videoc モード
    if (APPLY_VIDEOC) {
        await applyToVideoc(clients);
        return;
    }

    // --scrape-videoc-direct モード
    if (SCRAPE_VIDEOC_DIRECT) {
        await scrapeVideocDirect(clients);
        return;
    }

    // --search-all モード
    if (SEARCH_ALL) {
        await scrapeSearchAll(clients);
        return;
    }

    // --search-mgs モード
    if (SEARCH_MGS) {
        await scrapeSearchMgs(clients);
        return;
    }

    // --scrape-all-makers モード
    if (SCRAPE_ALL_MAKERS) {
        await scrapeAllMakers(clients);
        return;
    }

    // --scrape-maker モード
    if (SCRAPE_MAKER) {
        if (!MAKER_SLUG) { console.error('❌ --scrape-maker の後にメーカースラグを指定してください (例: hunter)'); process.exit(1); }
        await scrapeMakerPage(clients, MAKER_SLUG);
        return;
    }

    // --daily モード
    if (DAILY) {
        await dailyScrape(clients, DAILY_COUNT);
        return;
    }

    // --search-by-label モード
    if (SEARCH_BY_LABEL) {
        await searchByLabel(clients, LABEL_SLUG);
        return;
    }

    // URLリスト取得
    let urls;
    if (!fs.existsSync(URL_LIST_FILE) || FETCH_ONLY) {
        urls = await fetchAllProductUrls();
        if (FETCH_ONLY) return;
    } else {
        urls = JSON.parse(fs.readFileSync(URL_LIST_FILE, 'utf-8'));
        console.log(`[URLリスト] 既存: ${urls.length.toLocaleString()}件`);
    }

    const progress = loadProgress();
    const pending  = urls.filter(u => !progress.completed.has(u));

    console.log(`[進捗] 完了: ${progress.completed.size.toLocaleString()} / ${urls.length.toLocaleString()} | 残り: ${pending.length.toLocaleString()}件`);
    console.log(`       MGS更新済み: ${progress.mgs_updated} / FANZA更新済み: ${progress.fanza_updated}`);
    console.log(`       推定残り: ${(pending.length * INTERVAL_MS / 1000 / 86400).toFixed(1)}日\n`);

    const outputStream = fs.createWriteStream(OUTPUT_JSONL, { flags: 'a' });

    // Ctrl+C / timeout(SIGTERM) で安全終了
    const handleExit = (signal) => {
        console.log(`\n\n[${signal}] 進捗を保存...`);
        saveProgress(progress);
        outputStream.end();
        process.exit(0);
    };
    process.on('SIGINT',  () => handleExit('SIGINT'));
    process.on('SIGTERM', () => handleExit('SIGTERM'));

    let pendingBatch = [];
    const limit = DRY_RUN ? 5 : Infinity;
    let processed = 0;

    const flushBatch = async () => {
        if (pendingBatch.length === 0 || DRY_RUN) return;
        const { mgsUpdated, fanzaUpdated } = await updateDbs(clients, pendingBatch);
        progress.mgs_updated   += mgsUpdated;
        progress.fanza_updated += fanzaUpdated;
        if (mgsUpdated + fanzaUpdated > 0) {
            console.log(`  💾 DB更新 MGS:+${mgsUpdated} FANZA:+${fanzaUpdated}`);
        }
        pendingBatch = [];
    };

    for (const url of pending) {
        if (processed >= limit) break;

        const idx = progress.completed.size + 1;
        const slug = url.replace(/.*av-wiki\.net\/(.+?)\/?$/, '$1');
        process.stdout.write(`[${idx}/${urls.length}] ${slug} ... `);

        try {
            const html = await fetchHtml(url);
            if (!html) {
                process.stdout.write('404\n');
                progress.completed.add(url);
                processed++;
                continue;
            }

            const data = parseProductPage(html, url);
            outputStream.write(JSON.stringify(data) + '\n');

            if (data.actresses && data.actresses.length > 0) {
                progress.with_actress++;
                pendingBatch.push(data);

                const parts = [data.actresses.join('・')];
                if (data.maker_pid) parts.push(data.maker_pid);
                if (data.fanza_pid) parts.push(data.fanza_pid);
                process.stdout.write(`OK [${parts.join(' | ')}]\n`);
            } else {
                process.stdout.write('OK [女優不明]\n');
            }

        } catch (e) {
            process.stdout.write(`ERR: ${e.message}\n`);
            progress.errors++;
        }

        progress.completed.add(url);
        progress.scraped++;
        processed++;

        // 50件ごとにDB更新と進捗保存
        if (progress.scraped % 50 === 0) {
            saveProgress(progress); // DB更新の前に保存（エラーでも進捗は守る）
            try {
                await flushBatch();
            } catch (e) {
                console.warn(`  [DB更新エラー] ${e.message} — スクレイプは継続`);
            }
            console.log(
                `\n  📊 MGS累計: ${progress.mgs_updated} / FANZA累計: ${progress.fanza_updated}` +
                ` | 女優あり: ${progress.with_actress} / エラー: ${progress.errors}\n`
            );
        }

        if (processed < pending.length && !DRY_RUN) {
            const jitter = Math.floor(INTERVAL_MS * 0.1 * (Math.random() * 2 - 1));
            await sleep(INTERVAL_MS + jitter);
        }
    }

    await flushBatch();
    saveProgress(progress);
    outputStream.end();

    console.log('\n══════════════════════════════════════════');
    console.log('  完了サマリー');
    console.log('══════════════════════════════════════════');
    console.log(`  スクレイプ数:   ${progress.scraped.toLocaleString()}件`);
    console.log(`  女優特定:       ${progress.with_actress.toLocaleString()}件`);
    console.log(`  MGS DB更新:     ${progress.mgs_updated.toLocaleString()}件`);
    console.log(`  FANZA DB更新:   ${progress.fanza_updated.toLocaleString()}件`);
    console.log(`  エラー:         ${progress.errors.toLocaleString()}件`);
    console.log('══════════════════════════════════════════\n');
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
