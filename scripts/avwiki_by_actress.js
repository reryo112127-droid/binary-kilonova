/**
 * AVWiki 女優ページベース 出演者特定スクリプト
 *
 * DBの既知女優名 → AVWiki女優ページ → 出演作一覧 → 女優不明作品を更新
 *
 * 現行の「作品ベース検索」(214,755リクエスト)と比べ、
 * 女優ページを1つ叩くだけで全作品を取得できるため大幅に効率的。
 *
 * 使い方:
 *   node scripts/avwiki_by_actress.js                # 全女優を処理
 *   node scripts/avwiki_by_actress.js --max 100      # テスト (100名)
 *   node scripts/avwiki_by_actress.js --restart      # 最初からやり直し
 *   node scripts/avwiki_by_actress.js --apply-only   # 収集済みmapデータをDBに反映のみ
 *   node scripts/avwiki_by_actress.js --min-works 10 # 10作品以上の女優のみ
 *
 * 出力:
 *   data/avwiki_actress_map.jsonl  女優名→FANZA product_id マッピング
 *   data/avwiki_actress_progress.json  進捗チェックポイント
 */

const fs      = require('fs');
const path    = require('path');
const cheerio = require('cheerio');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATA_DIR       = path.join(__dirname, '..', 'data');
const MAP_FILE       = path.join(DATA_DIR, 'avwiki_actress_map.jsonl');
const PROGRESS_FILE  = path.join(DATA_DIR, 'avwiki_actress_progress.json');

const RATE_LIMIT_MS  = 2000;   // 2秒インターバル
const MAX_PAGES      = 50;     // 1女優あたり最大ページ数（上限保険）

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---- 引数 ----
const args        = process.argv.slice(2);
const RESTART     = args.includes('--restart');
const APPLY_ONLY  = args.includes('--apply-only');
const maxIdx      = args.indexOf('--max');
const MAX_NAMES   = maxIdx !== -1 ? parseInt(args[maxIdx + 1], 10) : Infinity;
const minIdx      = args.indexOf('--min-works');
const MIN_WORKS   = minIdx !== -1 ? parseInt(args[minIdx + 1], 10) : 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ================================================================
//  Turso クライアント
// ================================================================
function getFanzaClient() {
    const url   = process.env.TURSO_FANZA_URL;
    const token = process.env.TURSO_FANZA_TOKEN;
    if (!url || !token) return null;
    return createClient({ url, authToken: token });
}

// ================================================================
//  HTTP取得（リトライ付き）
// ================================================================
async function fetchHtml(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'ja' },
                signal: AbortSignal.timeout(30_000),
            });
            if (res.status === 429 || res.status === 503) {
                console.warn(`\n  [${res.status}] 60秒待機...`);
                await sleep(60_000);
                continue;
            }
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (e) {
            if (i === retries - 1) throw e;
            await sleep(8_000 * (i + 1));
        }
    }
    return null;
}

// ================================================================
//  検索 → 女優ページURL取得
// ================================================================
async function findActressPageUrl(name) {
    const searchUrl = `https://av-wiki.net/?s=${encodeURIComponent(name)}`;
    const html = await fetchHtml(searchUrl);
    if (!html) return null;
    const $ = cheerio.load(html);

    // /av-actress/ を含むリンクを探す
    let found = null;
    $('a[href*="/av-actress/"]').each((i, el) => {
        if (!found) found = $(el).attr('href');
    });
    return found || null;
}

// ================================================================
//  女優ページの1ページから FANZA product_id を抽出
// ================================================================
function extractProductIds(html) {
    const $ = cheerio.load(html);
    const pids = new Set();

    // FANZA アフィリエイトリンクから product_id を取得
    // 形式: https://al.fanza.co.jp/?lurl=...%3Fid%3D{pid}%2F...
    //   or: https://video.dmm.co.jp/av/content/?id={pid}/
    $('a[href*="fanza"], a[href*="dmm"]').each((i, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/id%3D([a-z0-9]+)%2F/i)
               || href.match(/[?&]id=([a-z0-9]+)/i)
               || href.match(/content\/\?id=([a-z0-9]+)/i);
        if (m && m[1] && m[1].length >= 5) {
            pids.add(m[1].toLowerCase());
        }
    });

    // ページネーション最終ページ数も取得
    let maxPage = 1;
    $('a.page-numbers').each((i, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/page\/(\d+)\//);
        if (m) maxPage = Math.max(maxPage, parseInt(m[1]));
    });

    return { pids: Array.from(pids), maxPage };
}

// ================================================================
//  女優ページ全ページをスクレイプ
// ================================================================
async function scrapeActressAllPages(actressUrl, actressName) {
    const allPids = new Set();

    const firstHtml = await fetchHtml(actressUrl);
    if (!firstHtml) return { pids: [], pages: 0 };

    const { pids: page1Pids, maxPage } = extractProductIds(firstHtml);
    page1Pids.forEach(p => allPids.add(p));

    const totalPages = Math.min(maxPage, MAX_PAGES);
    process.stdout.write(` (${totalPages}p)`);

    for (let p = 2; p <= totalPages; p++) {
        await sleep(RATE_LIMIT_MS);
        const pageUrl = `${actressUrl.replace(/\/$/, '')}/page/${p}/`;
        const html = await fetchHtml(pageUrl);
        if (!html) break;
        const { pids } = extractProductIds(html);
        pids.forEach(pid => allPids.add(pid));
    }

    return { pids: Array.from(allPids), pages: totalPages };
}

// ================================================================
//  収集済みデータをDBに反映
// ================================================================
async function applyToDb() {
    if (!fs.existsSync(MAP_FILE)) {
        console.log('マッピングファイルが存在しません:', MAP_FILE);
        return;
    }

    const fanza = getFanzaClient();
    if (!fanza) {
        console.error('TURSO_FANZA_URL/TOKEN 未設定');
        return;
    }

    console.log('\n[DB反映] avwiki_actress_map.jsonl → Turso FANZA DB...');

    const lines = fs.readFileSync(MAP_FILE, 'utf-8').split('\n').filter(Boolean);
    let totalProcessed = 0, totalUpdated = 0;

    for (const line of lines) {
        const { actress, pids } = JSON.parse(line);
        if (!actress || !pids || pids.length === 0) continue;

        // product_ids のうち actresses IS NULL のものだけ更新
        const CHUNK = 100;
        for (let i = 0; i < pids.length; i += CHUNK) {
            const chunk = pids.slice(i, i + CHUNK);
            const placeholders = chunk.map(() => '?').join(',');
            try {
                // 既存の actresses 値を取得
                const existing = await fanza.execute({
                    sql: `SELECT product_id, actresses FROM products WHERE product_id IN (${placeholders})`,
                    args: chunk,
                });

                const updates = [];
                for (const row of existing.rows) {
                    const pid = row.product_id;
                    const current = (row.actresses || '').trim();
                    // すでに同じ名前が含まれていればスキップ
                    const names = current ? current.split(',').map(n => n.trim()) : [];
                    if (!names.includes(actress)) {
                        const newVal = current ? `${current}, ${actress}` : actress;
                        updates.push({ pid, newVal });
                    }
                }

                if (updates.length > 0) {
                    await fanza.batch(
                        updates.map(({ pid, newVal }) => ({
                            sql: `UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ?`,
                            args: [newVal, new Date().toISOString(), pid],
                        })),
                        'write'
                    );
                    totalUpdated += updates.length;
                }
                totalProcessed += chunk.length;
            } catch (e) {
                console.warn(`\n  [エラー] ${actress}: ${e.message}`);
            }
        }

        process.stdout.write(`\r  反映中: ${totalProcessed.toLocaleString()}件確認 / ${totalUpdated.toLocaleString()}件更新`);
    }

    console.log(`\n  完了: ${totalUpdated.toLocaleString()}件のproductにactress情報を追加`);
    fanza.close();
}

// ================================================================
//  女優名リストを DB から取得（ローカルDB優先、なければTurso）
// ================================================================
function loadActressNamesFromDb() {
    const DB_PATH = path.join(__dirname, '..', 'data', 'fanza.db');

    let rows;
    if (fs.existsSync(DB_PATH)) {
        // ローカルDB（高速）
        const Database = require('better-sqlite3');
        const db = new Database(DB_PATH, { readonly: true });
        db.pragma('busy_timeout = 5000');
        console.log('DBから女優名一覧を取得中（ローカル）...');
        rows = db.prepare(
            "SELECT actresses FROM products WHERE actresses IS NOT NULL AND actresses != '' "
        ).all().map(r => ({ actresses: r.actresses }));
        db.close();
    } else {
        throw new Error('ローカルDB(data/fanza.db)が見つかりません。--apply-onlyモードでTurso接続を使用してください。');
    }

    const nameCount = new Map();
    for (const row of rows) {
        const val = String(row.actresses || '');
        for (const name of val.split(',').map(n => n.trim()).filter(Boolean)) {
            nameCount.set(name, (nameCount.get(name) || 0) + 1);
        }
    }

    // 作品数で降順ソート
    const sorted = Array.from(nameCount.entries())
        .filter(([, cnt]) => cnt >= MIN_WORKS)
        .sort((a, b) => b[1] - a[1])
        .map(([name, cnt]) => ({ name, cnt }));

    console.log(`  ユニーク女優名: ${nameCount.size.toLocaleString()}名`);
    console.log(`  MIN_WORKS(${MIN_WORKS})以上: ${sorted.length.toLocaleString()}名`);
    return sorted;
}

// ================================================================
//  メイン
// ================================================================
async function main() {
    console.log('========================================');
    console.log('  AVWiki 女優ベース 出演者特定');
    console.log('========================================');

    if (APPLY_ONLY) {
        await applyToDb();
        return;
    }

    // 進捗ロード
    let progress = { completed: {}, found: 0, notFound: 0, totalPids: 0 };
    if (!RESTART && fs.existsSync(PROGRESS_FILE)) {
        progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    }
    const completed = new Set(Object.keys(progress.completed));

    // 女優名リスト取得
    const actresses = loadActressNamesFromDb();

    // MAPファイルのappendストリーム
    const mapStream = fs.createWriteStream(MAP_FILE, { flags: RESTART ? 'w' : 'a' });

    const targets = actresses
        .filter(a => !completed.has(a.name))
        .slice(0, MAX_NAMES);

    progress.totalTargets = actresses.length;

    console.log(`  処理対象: ${targets.length.toLocaleString()}名 (スキップ: ${completed.size.toLocaleString()}名)`);
    console.log('');

    let idx = 0;
    for (const { name, cnt } of targets) {
        idx++;
        process.stdout.write(`[${idx}/${targets.length}] ${name} (${cnt}作品)`);

        try {
            // AVWikiで女優ページURL検索
            const actressUrl = await findActressPageUrl(name);
            await sleep(RATE_LIMIT_MS);

            if (!actressUrl) {
                process.stdout.write(' → not found\n');
                progress.notFound++;
                completed.add(name);
                progress.completed[name] = null;
            } else {
                // 全ページスクレイプ
                const { pids, pages } = await scrapeActressAllPages(actressUrl, name);
                process.stdout.write(` → ${pids.length}作品 (${actressUrl.split('/av-actress/')[1]})\n`);

                // マッピング保存
                mapStream.write(JSON.stringify({ actress: name, actressUrl, pids, pages, scrapedAt: new Date().toISOString() }) + '\n');

                progress.found++;
                progress.totalPids += pids.length;
                progress.completed[name] = actressUrl;
            }
        } catch (e) {
            process.stdout.write(` → エラー: ${e.message}\n`);
            // エラーはスキップ（未完了扱いで次回リトライ可能）
        }

        // 進捗保存（10名ごと）
        if (idx % 10 === 0) {
            fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
            process.stdout.write(
                `  [進捗] 処理:${idx} / 発見:${progress.found} / 未発見:${progress.notFound} / 作品マッピング:${progress.totalPids.toLocaleString()}\n`
            );
        }

        await sleep(RATE_LIMIT_MS);
    }

    mapStream.end();
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));

    console.log('\n========================================');
    console.log('  スクレイプ完了');
    console.log(`  処理女優数:   ${idx.toLocaleString()}名`);
    console.log(`  AVWiki発見:   ${progress.found.toLocaleString()}名`);
    console.log(`  未発見:       ${progress.notFound.toLocaleString()}名`);
    console.log(`  作品マッピング: ${progress.totalPids.toLocaleString()}件`);
    console.log('========================================');
    console.log('\nDBに反映するには:');
    console.log('  node scripts/avwiki_by_actress.js --apply-only');
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
