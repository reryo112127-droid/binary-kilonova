/**
 * 女優別分割スクレイピング
 * 
 * 全女優を順次スクレイピングし、メーカー別で漏れた作品を補完する。
 * メーカー別で取得済みの品番は自動的にスキップ（JSONL重複排除）。
 * 
 * 使い方:
 *   node scripts/phase1_by_actress.js              # フル実行（レジューム対応）
 *   node scripts/phase1_by_actress.js --max-actresses 5 # テスト
 *   node scripts/phase1_by_actress.js --restart    # 最初からやり直し
 */
const fs = require('fs');
const path = require('path');
const { fetchPage, politeWait } = require('../lib/fetcher');
const { parseSearchPage } = require('../lib/parser');

const ITEMS_PER_PAGE = 120;
const DATA_DIR = path.join(__dirname, '..', 'data');
const ACTRESSES_PATH = path.join(DATA_DIR, 'actresses_all.json');
const MAKER_JSONL = path.join(DATA_DIR, 'mgs_products_by_maker.jsonl');
const JSONL_PATH = path.join(DATA_DIR, 'mgs_products_by_actress.jsonl');
const PROGRESS_PATH = path.join(DATA_DIR, 'phase1_actress_progress.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * 既存の全JSONLファイルから品番を読み込む（重複防止）
 */
function loadExistingIds() {
    const ids = new Set();
    // メーカー別のJSONLも読み込み
    for (const file of [MAKER_JSONL, JSONL_PATH]) {
        if (!fs.existsSync(file)) continue;
        const content = fs.readFileSync(file, 'utf-8');
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
    return { completed_actresses: [], total_new: 0 };
}

function saveProgress(progress) {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), 'utf-8');
}

function appendProducts(products) {
    if (products.length === 0) return;
    const lines = products.map(p => JSON.stringify(p)).join('\n') + '\n';
    fs.appendFileSync(JSONL_PATH, lines, 'utf-8');
}

async function scrapeActress(actress, existingIds) {
    const baseUrl = `https://www.mgstage.com/search/cSearch.php?${actress.search_param}&sort=new&list_cnt=${ITEMS_PER_PAGE}&type=top`;

    let page = 1;
    let actressNew = 0;
    let totalPages = null;

    while (true) {
        const url = `${baseUrl}&page=${page}`;
        const html = await fetchPage(url);
        const { products, totalCount } = parseSearchPage(html);

        if (!totalPages && totalCount > 0) {
            totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
        }
        if (products.length === 0) break;

        const newProducts = products.filter(p => !existingIds.has(p.product_id));
        appendProducts(newProducts);
        for (const p of newProducts) existingIds.add(p.product_id);
        actressNew += newProducts.length;

        process.stdout.write(`    p.${page}${totalPages ? '/' + totalPages : ''}: ${products.length}件(新規${newProducts.length}) `);

        page++;
        if (totalPages && page > totalPages) break;
        // 新規が0なら次ページへの意味なし
        if (newProducts.length === 0 && products.length > 0) break;

        await politeWait();
    }

    return actressNew;
}

async function main() {
    const args = process.argv.slice(2);
    const maxIdx = args.indexOf('--max-actresses');
    const maxActresses = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : Infinity;
    const restart = args.includes('--restart');

    if (!fs.existsSync(ACTRESSES_PATH)) {
        console.error('❌ 女優一覧がありません。先に get_actresses.js を実行してください。');
        process.exit(1);
    }
    const actresses = JSON.parse(fs.readFileSync(ACTRESSES_PATH, 'utf-8'));

    let progress;
    if (restart) {
        if (fs.existsSync(JSONL_PATH)) fs.unlinkSync(JSONL_PATH);
        if (fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH);
        progress = { completed_actresses: [], total_new: 0 };
    } else {
        progress = loadProgress();
    }

    const existingIds = loadExistingIds();
    console.log('========================================');
    console.log('  MGS動画 女優別分割スクレイピング');
    console.log('========================================\n');
    console.log(`  女優数: ${actresses.length}`);
    console.log(`  完了済み: ${progress.completed_actresses.length}`);
    console.log(`  既存品番数（メーカー別含む）: ${existingIds.size.toLocaleString()}\n`);

    const completedSet = new Set(progress.completed_actresses);
    const pending = actresses.filter(a => !completedSet.has(a.name));

    let processed = 0;
    const startTime = Date.now();

    try {
        for (const actress of pending) {
            if (processed >= maxActresses) {
                console.log(`\n[テスト制限] ${maxActresses}女優で終了`);
                break;
            }

            console.log(`\n[${progress.completed_actresses.length + 1}/${actresses.length}] ${actress.name}`);

            const newCount = await scrapeActress(actress, existingIds);
            if (newCount > 0) {
                console.log(`\n    → 新規: ${newCount}件`);
            } else {
                console.log(`(全件取得済み)`);
            }

            progress.completed_actresses.push(actress.name);
            progress.total_new += newCount;
            saveProgress(progress);
            processed++;

            await politeWait();
        }
    } catch (error) {
        console.error(`\n[エラー] ${error.message}`);
        saveProgress(progress);
    } finally {
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        console.log('\n========================================');
        console.log('  女優別スクレイピング サマリー');
        console.log('========================================');
        console.log(`  処理女優数: ${processed}`);
        console.log(`  完了女優数: ${progress.completed_actresses.length} / ${actresses.length}`);
        console.log(`  新規追加品番: ${progress.total_new.toLocaleString()}`);
        console.log(`  累計ユニーク品番: ${existingIds.size.toLocaleString()}`);
        console.log(`  経過時間: ${elapsed}分`);
        console.log('========================================\n');
    }
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
