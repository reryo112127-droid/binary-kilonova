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
 *
 * 進捗: data/avwiki_products_progress.json
 * 出力: data/avwiki_product_map.jsonl  (女優名-品番マッピング)
 */

const fs   = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { createClient } = require('@libsql/client');

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
const intIdx        = args.indexOf('--interval');
const INTERVAL_MS   = intIdx !== -1 ? parseInt(args[intIdx + 1], 10) * 1000 : 120_000; // デフォルト2分

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ========== Turso ==========
function createClients() {
    const mgs = createClient({
        url:       process.env.TURSO_MGS_URL,
        authToken: process.env.TURSO_MGS_TOKEN,
    });
    const fanza = createClient({
        url:       process.env.TURSO_FANZA_URL,
        authToken: process.env.TURSO_FANZA_TOKEN,
    });
    return { mgs, fanza };
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
        const results = await clients.mgs.batch(mgsStatements, 'write');
        mgsUpdated = results.reduce((acc, r) => acc + (r.rowsAffected || 0), 0);
    }
    if (fanzaStatements.length > 0) {
        const results = await clients.fanza.batch(fanzaStatements, 'write');
        fanzaUpdated = results.reduce((acc, r) => acc + (r.rowsAffected || 0), 0);
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

    const BATCH = 200;
    let totalMgs = 0, totalFanza = 0;

    for (let i = 0; i < entries.length; i += BATCH) {
        const chunk = entries.slice(i, i + BATCH);
        const { mgsUpdated, fanzaUpdated } = await updateDbs(clients, chunk);
        totalMgs   += mgsUpdated;
        totalFanza += fanzaUpdated;
        process.stdout.write(`  ${Math.min(i + BATCH, entries.length)}/${entries.length} 処理 | MGS: ${totalMgs} FANZA: ${totalFanza}\r`);
    }

    console.log(`\n✅ 適用完了 | MGS更新: ${totalMgs}件 / FANZA更新: ${totalFanza}件`);
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
