/**
 * フェーズ1: URLリスト構築 ＆ 基本データ高速スクレイピング（JSONL版）
 * 
 * 検索一覧ページ（120件/ページ）を順次巡回し、
 * 品番・タイトル・出演者・画像URL・動画URLをJSONLファイルに追記保存する。
 * 
 * 使い方:
 *   node scripts/phase1_list_scrape.js              # フル実行（レジューム対応）
 *   node scripts/phase1_list_scrape.js --max-pages 3 # テスト（3ページのみ）
 *   node scripts/phase1_list_scrape.js --restart      # 最初からやり直し
 */
const fs = require('fs');
const path = require('path');
const { fetchPage, politeWait, buildSearchUrl } = require('../lib/fetcher');
const { parseSearchPage } = require('../lib/parser');

const ITEMS_PER_PAGE = 120;
const DATA_DIR = path.join(__dirname, '..', 'data');
const JSONL_PATH = path.join(DATA_DIR, 'mgs_products.jsonl');
const PROGRESS_PATH = path.join(DATA_DIR, 'phase1_progress.json');

// データディレクトリ作成
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * 進捗を読み込む
 */
function loadProgress() {
    if (fs.existsSync(PROGRESS_PATH)) {
        return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
    }
    return { last_page: 0, total_pages: null, total_items: 0 };
}

/**
 * 進捗を保存
 */
function saveProgress(progress) {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), 'utf-8');
}

/**
 * 商品データをJSONLに追記保存
 */
function appendProducts(products) {
    const lines = products.map(p => JSON.stringify(p)).join('\n') + '\n';
    fs.appendFileSync(JSONL_PATH, lines, 'utf-8');
}

async function main() {
    // 引数解析
    const args = process.argv.slice(2);
    const maxPagesIdx = args.indexOf('--max-pages');
    const maxPages = maxPagesIdx >= 0 ? parseInt(args[maxPagesIdx + 1], 10) : Infinity;
    const restart = args.includes('--restart');

    // 進捗確認
    let progress;
    if (restart) {
        // リスタート: ファイル初期化
        if (fs.existsSync(JSONL_PATH)) fs.unlinkSync(JSONL_PATH);
        if (fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH);
        progress = { last_page: 0, total_pages: null, total_items: 0 };
        console.log('[リスタート] データファイルを初期化しました\n');
    } else {
        progress = loadProgress();
    }

    const startPage = progress.last_page + 1;
    let totalPages = progress.total_pages;

    console.log('========================================');
    console.log('  MGS動画 フェーズ1: 一覧ページスクレイピング');
    console.log('========================================\n');

    if (startPage > 1) {
        console.log(`[レジューム] ページ ${startPage} から再開 (累計 ${progress.total_items.toLocaleString()}件)\n`);
    }

    let currentPage = startPage;
    let sessionInserted = 0;
    let pagesProcessed = 0;
    const startTime = Date.now();

    try {
        while (true) {
            // 最大ページ数制限チェック
            if (pagesProcessed >= maxPages) {
                console.log(`\n[完了] テスト制限: ${maxPages}ページ処理で終了`);
                break;
            }

            // 総ページ数が判明していれば終了判定
            if (totalPages && currentPage > totalPages) {
                console.log(`\n[完了] 全${totalPages}ページの処理が完了しました！`);
                break;
            }

            const url = buildSearchUrl(currentPage, ITEMS_PER_PAGE);
            console.log(`[ページ ${currentPage}${totalPages ? '/' + totalPages : ''}] ${url}`);

            // HTML取得
            const html = await fetchPage(url);

            // パース
            const { products, totalCount } = parseSearchPage(html);

            // 初回: 総ページ数を計算
            if (!totalPages && totalCount > 0) {
                totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
                console.log(`  [情報] 総件数: ${totalCount.toLocaleString()}件 → ${totalPages}ページ`);
                progress.total_pages = totalPages;
            }

            // 商品がなければ終了
            if (products.length === 0) {
                console.log('  [終了] 商品が見つかりません。スクレイピング完了。');
                break;
            }

            // JSONL追記保存
            appendProducts(products);
            sessionInserted += products.length;
            progress.total_items += products.length;

            console.log(`  [保存] ${products.length}件 (累計: ${progress.total_items.toLocaleString()}件)`);

            // 進捗ファイル保存
            progress.last_page = currentPage;
            saveProgress(progress);

            currentPage++;
            pagesProcessed++;

            // 紳士的待機
            if (totalPages && currentPage <= totalPages) {
                await politeWait();
            }
        }
    } catch (error) {
        console.error(`\n[エラー] ページ ${currentPage}: ${error.message}`);
        saveProgress(progress);
    } finally {
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

        // JSONLファイルサイズ
        let fileSize = '0';
        if (fs.existsSync(JSONL_PATH)) {
            const bytes = fs.statSync(JSONL_PATH).size;
            fileSize = (bytes / 1024 / 1024).toFixed(1) + ' MB';
        }

        console.log('\n========================================');
        console.log('  フェーズ1 サマリー');
        console.log('========================================');
        console.log(`  今回処理ページ数: ${pagesProcessed}`);
        console.log(`  今回保存件数: ${sessionInserted.toLocaleString()}`);
        console.log(`  累計保存件数: ${progress.total_items.toLocaleString()}`);
        console.log(`  経過時間: ${elapsed}分`);
        console.log(`  データファイル: ${fileSize}`);
        console.log('========================================\n');
    }
}

main().catch((err) => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
