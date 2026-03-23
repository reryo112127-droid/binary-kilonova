/**
 * メーカー別分割スクレイピング
 * 
 * 全504メーカー/レーベルを順次スクレイピングし、
 * 10,000件制限を回避して全作品を取得する。
 * 
 * 使い方:
 *   node scripts/phase1_by_maker.js              # フル実行（レジューム対応）
 *   node scripts/phase1_by_maker.js --max-makers 3 # テスト（3メーカーのみ）
 *   node scripts/phase1_by_maker.js --restart     # 最初からやり直し
 */
const fs = require('fs');
const path = require('path');
const { fetchPage, politeWait, sleep } = require('../lib/fetcher');
const { parseSearchPage } = require('../lib/parser');

const ITEMS_PER_PAGE = 120;
const DATA_DIR = path.join(__dirname, '..', 'data');
const MAKERS_PATH = path.join(DATA_DIR, 'makers_all.json');
const JSONL_PATH = path.join(DATA_DIR, 'mgs_products_by_maker.jsonl');
const PROGRESS_PATH = path.join(DATA_DIR, 'phase1_maker_progress.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 既存のJSONLから取得済み品番を読み込む（重複防止用）
function loadExistingIds() {
    const ids = new Set();
    if (fs.existsSync(JSONL_PATH)) {
        const content = fs.readFileSync(JSONL_PATH, 'utf-8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
                const p = JSON.parse(line);
                ids.add(p.product_id);
            } catch (e) { }
        }
    }
    return ids;
}

function loadProgress() {
    if (fs.existsSync(PROGRESS_PATH)) {
        return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
    }
    return { completed_makers: [], total_products: 0, unique_products: 0 };
}

function saveProgress(progress) {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), 'utf-8');
}

function appendProducts(products) {
    if (products.length === 0) return;
    const lines = products.map(p => JSON.stringify(p)).join('\n') + '\n';
    fs.appendFileSync(JSONL_PATH, lines, 'utf-8');
}

async function scrapeMaker(maker, existingIds, progress) {
    const baseUrl = `https://www.mgstage.com/search/cSearch.php?${maker.search_param}&sort=new&list_cnt=${ITEMS_PER_PAGE}&type=top`;

    let page = 1;
    let makerTotal = 0;
    let makerNew = 0;
    let totalPages = null;

    while (true) {
        const url = `${baseUrl}&page=${page}`;

        const html = await fetchPage(url);
        const { products, totalCount } = parseSearchPage(html);

        if (!totalPages && totalCount > 0) {
            totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
        }

        if (products.length === 0) break;

        // 新規のみフィルタ
        const newProducts = products.filter(p => !existingIds.has(p.product_id));

        // 保存 & IDを記録
        appendProducts(newProducts);
        for (const p of newProducts) {
            existingIds.add(p.product_id);
        }

        makerTotal += products.length;
        makerNew += newProducts.length;
        progress.total_products += products.length;
        progress.unique_products += newProducts.length;

        process.stdout.write(`    p.${page}${totalPages ? '/' + totalPages : ''}: ${products.length}件(新規${newProducts.length}) `);

        page++;

        // 最大ページ超過 or 新規IDが0件が連続2ページなら終了
        if (totalPages && page > totalPages) break;
        if (newProducts.length === 0 && page > 2) {
            // 最後に全部既知だったらもう終了
            if (products.every(p => existingIds.has(p.product_id))) break;
        }

        await politeWait();
    }

    return { total: makerTotal, new: makerNew };
}

async function main() {
    const args = process.argv.slice(2);
    const maxMakersIdx = args.indexOf('--max-makers');
    const maxMakers = maxMakersIdx >= 0 ? parseInt(args[maxMakersIdx + 1], 10) : Infinity;
    const restart = args.includes('--restart');

    // メーカー一覧読み込み
    if (!fs.existsSync(MAKERS_PATH)) {
        console.error('❌ メーカー一覧がありません。先に get_makers.js を実行してください。');
        process.exit(1);
    }
    const makers = JSON.parse(fs.readFileSync(MAKERS_PATH, 'utf-8'));

    // 進捗
    let progress;
    if (restart) {
        if (fs.existsSync(JSONL_PATH)) fs.unlinkSync(JSONL_PATH);
        if (fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH);
        progress = { completed_makers: [], total_products: 0, unique_products: 0 };
        console.log('[リスタート] データファイルを初期化しました\n');
    } else {
        progress = loadProgress();
    }

    // 既存品番を読み込み
    const existingIds = loadExistingIds();
    console.log('========================================');
    console.log('  MGS動画 メーカー別分割スクレイピング');
    console.log('========================================\n');
    console.log(`  メーカー数: ${makers.length}`);
    console.log(`  完了済み: ${progress.completed_makers.length}`);
    console.log(`  既存品番数: ${existingIds.size.toLocaleString()}\n`);

    const completedSet = new Set(progress.completed_makers);
    const pendingMakers = makers.filter(m => !completedSet.has(m.name));

    let processed = 0;
    const startTime = Date.now();

    try {
        for (const maker of pendingMakers) {
            if (processed >= maxMakers) {
                console.log(`\n[テスト制限] ${maxMakers}メーカーで終了`);
                break;
            }

            console.log(`\n[${progress.completed_makers.length + 1}/${makers.length}] ${maker.name} (${maker.type})`);

            const result = await scrapeMaker(maker, existingIds, progress);
            console.log(`\n    → 合計: ${result.total}件, 新規: ${result.new}件`);

            progress.completed_makers.push(maker.name);
            saveProgress(progress);
            processed++;

            // メーカー間の待機
            if (processed < pendingMakers.length) {
                await politeWait();
            }
        }
    } catch (error) {
        console.error(`\n[エラー] ${error.message}`);
        saveProgress(progress);
    } finally {
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        let fileSize = '0';
        if (fs.existsSync(JSONL_PATH)) {
            fileSize = (fs.statSync(JSONL_PATH).size / 1024 / 1024).toFixed(1) + ' MB';
        }

        console.log('\n========================================');
        console.log('  メーカー別スクレイピング サマリー');
        console.log('========================================');
        console.log(`  処理メーカー数: ${processed}`);
        console.log(`  完了メーカー数: ${progress.completed_makers.length} / ${makers.length}`);
        console.log(`  累計ユニーク品番: ${existingIds.size.toLocaleString()}`);
        console.log(`  経過時間: ${elapsed}分`);
        console.log(`  データファイル: ${fileSize}`);
        console.log('========================================\n');
    }
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
