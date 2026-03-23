/**
 * フェーズ2: 詳細ページスクレイピング (JSONL版)
 * 
 * 各品番の詳細ページからメーカー名・レーベル・収録時間を取得し、
 * JSONLファイルに保存する。sql.jsのexport問題を回避。
 * 
 * 使い方:
 *   node scripts/phase2_detail_scrape.js              # フル実行（レジューム対応）
 *   node scripts/phase2_detail_scrape.js --max-items 10 # テスト
 *   node scripts/phase2_detail_scrape.js --restart     # 最初から
 *   node scripts/phase2_detail_scrape.js --apply       # JSONL → DB適用のみ
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { fetchPage, politeWait, buildDetailUrl } = require('../lib/fetcher');
const { parseDetailPage } = require('../lib/parser');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DETAIL_JSONL = path.join(DATA_DIR, 'mgs_details.jsonl');
const PROGRESS_PATH = path.join(DATA_DIR, 'phase2_progress.json');

// 全品番リストを取得するためのJSONLソース
const PRODUCT_JSONLS = [
    path.join(DATA_DIR, 'mgs_products_by_maker.jsonl'),
    path.join(DATA_DIR, 'mgs_products_by_actress.jsonl'),
    path.join(DATA_DIR, 'mgs_products_by_month.jsonl'),
];

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/** 全ユニーク品番リストを取得 */
async function getAllProductIds() {
    const ids = new Set();
    for (const file of PRODUCT_JSONLS) {
        if (!fs.existsSync(file)) continue;
        const rl = readline.createInterface({
            input: fs.createReadStream(file), crlfDelay: Infinity,
        });
        for await (const line of rl) {
            if (!line.trim()) continue;
            try { ids.add(JSON.parse(line).product_id); } catch (e) { }
        }
    }
    return Array.from(ids);
}

/** 取得済み品番セットを読み込み */
function loadScrapedIds() {
    const ids = new Set();
    if (!fs.existsSync(DETAIL_JSONL)) return ids;
    const content = fs.readFileSync(DETAIL_JSONL, 'utf-8');
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
    return { scraped: 0, errors: 0 };
}

function saveProgress(progress) {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), 'utf-8');
}

function appendDetail(detail) {
    fs.appendFileSync(DETAIL_JSONL, JSON.stringify(detail) + '\n', 'utf-8');
}

/** JSONL → SQLite DB適用 */
async function applyToDb() {
    console.log('[適用] JSONL → SQLiteDB...\n');

    if (!fs.existsSync(DETAIL_JSONL)) {
        console.error('❌ 詳細データJSONLがありません');
        process.exit(1);
    }

    const initSqlJs = require('sql.js');
    const DB_PATH = path.join(DATA_DIR, 'mgs.db');

    if (!fs.existsSync(DB_PATH)) {
        console.error('❌ DBが見つかりません。先にbuild_db.jsを実行してください');
        process.exit(1);
    }

    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_PATH));

    const rl = readline.createInterface({
        input: fs.createReadStream(DETAIL_JSONL), crlfDelay: Infinity,
    });

    let applied = 0;
    db.run('BEGIN TRANSACTION');

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const d = JSON.parse(line);
            db.run(`
        UPDATE products SET
          maker = COALESCE(?, maker),
          label = COALESCE(?, label),
          duration_min = COALESCE(?, duration_min),
          wish_count = COALESCE(?, wish_count),
          genres = COALESCE(?, genres),
          sale_start_date = COALESCE(?, sale_start_date),
          detail_scraped = 1,
          updated_at = datetime('now','localtime')
        WHERE product_id = ?
      `, [d.maker || null, d.label || null, d.duration_min || null, d.wish_count || null, d.genres || null, d.sale_start_date || null, d.product_id]);
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

    console.log(`\n✅ ${applied.toLocaleString()}件の詳細データをDBに適用`);
    console.log(`   DBサイズ: ${(fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1)} MB`);
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
        if (fs.existsSync(DETAIL_JSONL)) fs.unlinkSync(DETAIL_JSONL);
        if (fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH);
    }

    // 全品番リスト取得
    console.log('[準備] 品番リストを読み込み中...');
    const allIds = await getAllProductIds();
    const scrapedIds = loadScrapedIds();
    const pendingIds = allIds.filter(id => !scrapedIds.has(id));

    console.log('========================================');
    console.log('  MGS動画 フェーズ2: 詳細ページスクレイピング');
    console.log('========================================\n');
    console.log(`  全品番数:     ${allIds.length.toLocaleString()}`);
    console.log(`  取得済み:     ${scrapedIds.size.toLocaleString()}`);
    console.log(`  残り:         ${pendingIds.length.toLocaleString()}`);
    console.log(`  推定所要時間: ${(pendingIds.length * 4.5 / 3600).toFixed(1)}時間\n`);

    let progress = restart ? { scraped: 0, errors: 0 } : loadProgress();
    let processed = 0;
    const startTime = Date.now();

    try {
        for (const id of pendingIds) {
            if (processed >= maxItems) {
                console.log(`\n[テスト制限] ${maxItems}件で終了`);
                break;
            }

            const url = buildDetailUrl(id);

            try {
                const html = await fetchPage(url);
                const detail = parseDetailPage(html);
                appendDetail({ product_id: id, ...detail });
                progress.scraped++;

                if ((progress.scraped + scrapedIds.size) % 100 === 0) {
                    const total = scrapedIds.size + progress.scraped;
                    const pct = (total / allIds.length * 100).toFixed(1);
                    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
                    console.log(`  [${total.toLocaleString()} / ${allIds.length.toLocaleString()}] ${pct}% (${elapsed}分経過) 直近: ${id} ${detail.maker || ''}`);
                }
            } catch (err) {
                console.log(`  [エラー] ${id}: ${err.message}`);
                // エラーでもスキップせず記録
                appendDetail({ product_id: id, maker: '', label: '', duration_min: null, error: err.message });
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
        console.log('  フェーズ2 サマリー');
        console.log('========================================');
        console.log(`  今回処理:     ${processed.toLocaleString()}`);
        console.log(`  累計取得済み: ${totalScraped.toLocaleString()} / ${allIds.length.toLocaleString()}`);
        console.log(`  エラー:       ${progress.errors}`);
        console.log(`  経過時間:     ${elapsed}分`);
        console.log('========================================');
        console.log('\n💡 DB適用: node scripts/phase2_detail_scrape.js --apply\n');
    }
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
