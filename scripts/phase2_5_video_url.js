/**
 * フェーズ2.5: サンプル動画 mp4 直URL取得
 * 
 * MGS動画のサンプル動画プレイヤーURLから実際のmp4直URLを取得し、
 * JSONLファイルに保存する。
 * 
 * 手順:
 *   1. フェーズ1 JSONLから sample_video_url を持つ品番を抽出
 *   2. URLからUUIDを抽出
 *   3. sampleRespons.php?pid={UUID} APIを呼び出し
 *   4. レスポンスの .ism/request → .mp4 変換
 * 
 * 使い方:
 *   node scripts/phase2_5_video_url.js              # フル実行（レジューム対応）
 *   node scripts/phase2_5_video_url.js --max-items 10 # テスト
 *   node scripts/phase2_5_video_url.js --restart     # 最初から
 *   node scripts/phase2_5_video_url.js --apply       # JSONL → DB適用のみ
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { fetchPage, politeWait } = require('../lib/fetcher');

const DATA_DIR = path.join(__dirname, '..', 'data');
const VIDEO_JSONL = path.join(DATA_DIR, 'mgs_video_urls.jsonl');
const PROGRESS_PATH = path.join(DATA_DIR, 'phase2_5_progress.json');

// フェーズ1のJSONLソース（sample_video_urlが入っている）
const PRODUCT_JSONLS = [
    path.join(DATA_DIR, 'mgs_products_by_maker.jsonl'),
    path.join(DATA_DIR, 'mgs_products_by_actress.jsonl'),
    path.join(DATA_DIR, 'mgs_products_by_month.jsonl'),
];

const SAMPLE_API_URL = 'https://www.mgstage.com/sampleplayer/sampleRespons.php?pid=';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1479858556726546523/fZSbfjBuRJN1fvRLWUkGu8wnZGPvx49hImkayKNol84ZOZqyvKzsf9K9ONCWhE0quKkJ';

/**
 * Discordにメッセージを送信する
 */
async function sendDiscordMessage(content) {
    if (!DISCORD_WEBHOOK_URL) return;
    try {
        await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
    } catch (e) {
        console.error('Discord通知エラー:', e.message);
    }
}

/**
 * ISM URL → mp4 直URL 変換
 */
function convertIsmToMp4(url) {
    if (!url) return null;
    // .ism/request?... → .mp4
    const mp4 = url.replace(/\.ism\/request.*$/, '.mp4');
    // http://dl → https://sample に変換（古い形式対応）
    return mp4.replace(/^http:\/\/dl\./, 'https://sample.');
}

/**
 * サンプル動画URLからUUIDを抽出
 */
function extractUuid(sampleUrl) {
    if (!sampleUrl) return null;
    const match = sampleUrl.match(/sampleplayer\.html\/([0-9a-f-]{36})/i);
    return match ? match[1] : null;
}

/**
 * 全品番＋サンプル動画URL一覧を取得（ユニーク品番）
 */
async function getProductsWithVideo() {
    const products = new Map(); // product_id → sample_video_url
    for (const file of PRODUCT_JSONLS) {
        if (!fs.existsSync(file)) continue;
        const rl = readline.createInterface({
            input: fs.createReadStream(file), crlfDelay: Infinity,
        });
        for await (const line of rl) {
            if (!line.trim()) continue;
            try {
                const d = JSON.parse(line);
                if (d.sample_video_url && !products.has(d.product_id)) {
                    const uuid = extractUuid(d.sample_video_url);
                    if (uuid) {
                        products.set(d.product_id, { uuid, sample_player_url: d.sample_video_url });
                    }
                }
            } catch (e) { }
        }
    }
    return products;
}

/**
 * 取得済み品番セットを読み込み
 */
function loadScrapedIds() {
    const ids = new Set();
    if (!fs.existsSync(VIDEO_JSONL)) return ids;
    const content = fs.readFileSync(VIDEO_JSONL, 'utf-8');
    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try { ids.add(JSON.parse(line).product_id); } catch (e) { }
    }
    return ids;
}

function loadProgress() {
    if (fs.existsSync(PROGRESS_PATH)) {
        return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
    }
    return { scraped: 0, errors: 0, found: 0 };
}

function saveProgress(progress) {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), 'utf-8');
}

function appendResult(result) {
    fs.appendFileSync(VIDEO_JSONL, JSON.stringify(result) + '\n', 'utf-8');
}

/**
 * JSONL → SQLite DB適用
 */
async function applyToDb() {
    console.log('[適用] JSONL → SQLiteDB...\n');

    if (!fs.existsSync(VIDEO_JSONL)) {
        console.error('❌ 動画URLデータJSONLがありません');
        process.exit(1);
    }

    const initSqlJs = require('sql.js');
    const DB_PATH = path.join(DATA_DIR, 'mgs.db');

    if (!fs.existsSync(DB_PATH)) {
        console.error('❌ DBが見つかりません');
        process.exit(1);
    }

    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_PATH));

    const rl = readline.createInterface({
        input: fs.createReadStream(VIDEO_JSONL), crlfDelay: Infinity,
    });

    let applied = 0;
    db.run('BEGIN TRANSACTION');

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const d = JSON.parse(line);
            if (!d.mp4_url) continue; // mp4 URL が無いものはスキップ

            db.run(`
                UPDATE products SET
                    sample_video_url = ?,
                    updated_at = datetime('now','localtime')
                WHERE product_id = ?
            `, [d.mp4_url, d.product_id]);
            applied++;

            if (applied % 10000 === 0) {
                db.run('COMMIT');
                process.stdout.write(`  ${applied.toLocaleString()}件適用済み\n`);
                db.run('BEGIN TRANSACTION');
            }
        } catch (e) { }
    }

    db.run('COMMIT');

    // 保存
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    db.close();

    console.log(`\n✅ ${applied.toLocaleString()}件の動画URLをDBに適用`);
    console.log(`   DBサイズ: ${(fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1)} MB`);
}

/**
 * sampleRespons.php API からmp4 URLを取得
 */
async function fetchMp4Url(uuid) {
    const url = SAMPLE_API_URL + uuid;
    const response = await fetchPage(url);

    try {
        const json = JSON.parse(response);
        if (json.url) {
            return convertIsmToMp4(json.url);
        }
    } catch (e) {
        // JSONパースに失敗した場合、HTMLからURLを探す
        const mp4Match = response.match(/https?:\/\/[^"'\s]+\.mp4/i);
        if (mp4Match) return mp4Match[0];
    }

    return null;
}

async function main() {
    const args = process.argv.slice(2);
    const maxIdx = args.indexOf('--max-items');
    const maxItems = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : Infinity;
    const restart = args.includes('--restart');
    const applyOnly = args.includes('--apply');

    if (applyOnly) {
        await applyToDb();
        return;
    }

    if (restart) {
        if (fs.existsSync(VIDEO_JSONL)) fs.unlinkSync(VIDEO_JSONL);
        if (fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH);
    }

    // 全品番＋動画URLリスト取得
    console.log('[準備] 品番リストを読み込み中...');
    const productsWithVideo = await getProductsWithVideo();
    const scrapedIds = loadScrapedIds();

    // 未取得のものだけ抽出
    const pendingProducts = [];
    for (const [productId, data] of productsWithVideo) {
        if (!scrapedIds.has(productId)) {
            pendingProducts.push({ product_id: productId, ...data });
        }
    }

    console.log('========================================');
    console.log('  MGS動画 フェーズ2.5: サンプル動画mp4 URL取得');
    console.log('========================================\n');
    console.log(`  動画あり品番数: ${productsWithVideo.size.toLocaleString()}`);
    console.log(`  取得済み:       ${scrapedIds.size.toLocaleString()}`);
    console.log(`  残り:           ${pendingProducts.length.toLocaleString()}`);
    console.log(`  推定所要時間:   ${(pendingProducts.length * 4.5 / 3600).toFixed(1)}時間\n`);

    let progress = restart ? { scraped: 0, errors: 0, found: 0 } : loadProgress();
    let processed = 0;
    const startTime = Date.now();
    let lastNotifyTime = Date.now();

    try {
        await sendDiscordMessage(`🎬 **フェーズ2.5（サンプル動画取得）稼働中**\n残り: ${pendingProducts.length.toLocaleString()}件\n推定所要時間: ${(pendingProducts.length * 4.5 / 3600).toFixed(1)}時間`);
        for (const product of pendingProducts) {
            if (processed >= maxItems) {
                console.log(`\n[テスト制限] ${maxItems}件で終了`);
                break;
            }

            try {
                const mp4Url = await fetchMp4Url(product.uuid);

                appendResult({
                    product_id: product.product_id,
                    uuid: product.uuid,
                    mp4_url: mp4Url || null,
                });

                progress.scraped++;
                if (mp4Url) progress.found++;

                if (progress.scraped % 100 === 0) {
                    const total = progress.scraped;
                    const pct = (total / productsWithVideo.size * 100).toFixed(1);
                    const elapsed = ((Date.now() - startTime) / 1000 / 3600).toFixed(1);
                    const foundRate = (progress.found / progress.scraped * 100).toFixed(0);

                    const now = Date.now();
                    if (now - lastNotifyTime >= 60 * 60 * 1000) {
                        const progressMsg = `📊 **フェーズ2.5 途中経過** (直近再開から ${elapsed}時間経過)\n` +
                            `✅ 処理済み: ${total.toLocaleString()} / ${productsWithVideo.size.toLocaleString()} (${pct}%)\n` +
                            `🎥 mp4取得率: ${foundRate}%\n` +
                            `⏳ 残り: ${(productsWithVideo.size - total).toLocaleString()}件`;
                        await sendDiscordMessage(progressMsg);
                        lastNotifyTime = now;
                    }
                    console.log(`  [${total.toLocaleString()} / ${productsWithVideo.size.toLocaleString()}] ${pct}% (再開から ${elapsed}時間経過) URL取得率: ${foundRate}% 直近: ${product.product_id}`);
                }
            } catch (err) {
                console.log(`  [エラー] ${product.product_id}: ${err.message}`);
                appendResult({
                    product_id: product.product_id,
                    uuid: product.uuid,
                    mp4_url: null,
                    error: err.message,
                });
                progress.errors++;
            }

            processed++;
            saveProgress(progress);
            await politeWait();
        }
    } catch (error) {
        console.error(`\n[致命的エラー] ${error.message}`);
    } finally {
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        const totalScraped = scrapedIds.size + progress.scraped;

        console.log('\n========================================');
        console.log('  フェーズ2.5 サマリー');
        console.log('========================================');
        console.log(`  今回処理:     ${processed.toLocaleString()}`);
        console.log(`  累計取得済み: ${totalScraped.toLocaleString()} / ${productsWithVideo.size.toLocaleString()}`);
        console.log(`  mp4取得成功:  ${progress.found}`);
        console.log(`  エラー:       ${progress.errors}`);
        console.log(`  経過時間:     ${elapsed}分`);
        console.log('========================================');
        console.log('\n💡 DB適用: node scripts/phase2_5_video_url.js --apply\n');

        const endMsg = `✨ **フェーズ2.5 完了**\n` +
            `⏱ 処理時間: ${elapsed}分\n` +
            `✅ 完了数: ${totalScraped.toLocaleString()} / ${productsWithVideo.size.toLocaleString()}\n` +
            `🎥 mp4取得成功: ${progress.found}件`;
        await sendDiscordMessage(endMsg);
    }
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
