/**
 * 月別スクレイピング（100%カバー達成用）
 * 
 * sale_start_range パラメータで月ごとに絞り込むことで、
 * メーカー/女優紐づけのない作品も含め全件を取得する。
 * 
 * 使い方:
 *   node scripts/phase1_by_month.js               # フル実行
 *   node scripts/phase1_by_month.js --restart      # 最初から
 *   node scripts/phase1_by_month.js --max-months 3 # テスト
 */
const fs = require('fs');
const path = require('path');
const { fetchPage, politeWait } = require('../lib/fetcher');
const { parseSearchPage, parseTotalCount } = require('../lib/parser');

const ITEMS_PER_PAGE = 120;
const DATA_DIR = path.join(__dirname, '..', 'data');
const JSONL_PATH = path.join(DATA_DIR, 'mgs_products_by_month.jsonl');
const PROGRESS_PATH = path.join(DATA_DIR, 'phase1_month_progress.json');

// 既存の全JSONLを読み込む
const EXISTING_JSONLS = [
    path.join(DATA_DIR, 'mgs_products_by_maker.jsonl'),
    path.join(DATA_DIR, 'mgs_products_by_actress.jsonl'),
    path.join(DATA_DIR, 'mgs_products.jsonl'),      // 旧フェーズ1
    JSONL_PATH,
];

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadExistingIds() {
    const ids = new Set();
    for (const file of EXISTING_JSONLS) {
        if (!fs.existsSync(file)) continue;
        const content = fs.readFileSync(file, 'utf-8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try { ids.add(JSON.parse(line).product_id); } catch (e) { }
        }
    }
    return ids;
}

function loadProgress() {
    if (fs.existsSync(PROGRESS_PATH)) {
        return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
    }
    return { completed_months: [], total_new: 0 };
}

function saveProgress(progress) {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), 'utf-8');
}

function appendProducts(products) {
    if (products.length === 0) return;
    const lines = products.map(p => JSON.stringify(p)).join('\n') + '\n';
    fs.appendFileSync(JSONL_PATH, lines, 'utf-8');
}

/**
 * 月のリストを生成 (YYYY.MM.01-YYYY.MM.末日)
 */
function generateMonths(startYear, startMonth, endYear, endMonth) {
    const months = [];
    let y = startYear, m = startMonth;
    while (y < endYear || (y === endYear && m <= endMonth)) {
        const lastDay = new Date(y, m, 0).getDate();
        const from = `${y}.${String(m).padStart(2, '0')}.01`;
        const to = `${y}.${String(m).padStart(2, '0')}.${String(lastDay).padStart(2, '0')}`;
        months.push({ label: `${y}年${m}月`, range: `${from}-${to}` });
        m++;
        if (m > 12) { m = 1; y++; }
    }
    return months;
}

async function scrapeMonth(monthRange, existingIds) {
    let page = 1;
    let monthNew = 0;
    let totalPages = null;

    while (true) {
        const url = `https://www.mgstage.com/search/cSearch.php?sale_start_range=${monthRange}&sort=new&list_cnt=${ITEMS_PER_PAGE}&type=top&page=${page}`;
        const html = await fetchPage(url);
        const { products, totalCount } = parseSearchPage(html);

        if (!totalPages && totalCount > 0) {
            totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
        }
        if (products.length === 0) break;

        const newProducts = products.filter(p => !existingIds.has(p.product_id));
        appendProducts(newProducts);
        for (const p of newProducts) existingIds.add(p.product_id);
        monthNew += newProducts.length;

        const pagesStr = totalPages ? `/${totalPages}` : '';
        process.stdout.write(`  p.${page}${pagesStr}: ${products.length}件(新規${newProducts.length}) `);

        page++;
        if (totalPages && page > totalPages) break;
        if (newProducts.length === 0 && products.length < ITEMS_PER_PAGE) break;

        await politeWait();
    }

    return monthNew;
}

async function main() {
    const args = process.argv.slice(2);
    const maxIdx = args.indexOf('--max-months');
    const maxMonths = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : Infinity;
    const restart = args.includes('--restart');

    if (restart) {
        if (fs.existsSync(JSONL_PATH)) fs.unlinkSync(JSONL_PATH);
        if (fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH);
    }

    // まず最古の配信日を調べる（古い順で1ページ目を取得）
    console.log('[調査] 配信開始年月を確認中...');
    const oldestHtml = await fetchPage(
        'https://www.mgstage.com/search/cSearch.php?sort=old&list_cnt=30&type=top&page=1'
    );
    const { products: oldestProducts } = parseSearchPage(oldestHtml);
    // 最古の品番を表示
    if (oldestProducts.length > 0) {
        console.log(`  最古の品番: ${oldestProducts[0].product_id} / ${oldestProducts[0].title}`);
    }
    await politeWait();

    // 配信開始範囲: 2013年1月 〜 現在
    const now = new Date();
    const months = generateMonths(2013, 1, now.getFullYear(), now.getMonth() + 1);

    let progress = restart
        ? { completed_months: [], total_new: 0 }
        : loadProgress();

    const existingIds = loadExistingIds();

    console.log('========================================');
    console.log('  MGS動画 月別スクレイピング');
    console.log('========================================\n');
    console.log(`  月数: ${months.length}`);
    console.log(`  完了済み: ${progress.completed_months.length}`);
    console.log(`  既存品番数: ${existingIds.size.toLocaleString()}\n`);

    const completedSet = new Set(progress.completed_months);
    const pending = months.filter(m => !completedSet.has(m.label));

    let processed = 0;
    const startTime = Date.now();

    try {
        for (const month of pending) {
            if (processed >= maxMonths) {
                console.log(`\n[テスト制限] ${maxMonths}ヶ月で終了`);
                break;
            }

            process.stdout.write(`\n[${progress.completed_months.length + 1}/${months.length}] ${month.label} (${month.range})\n`);

            const newCount = await scrapeMonth(month.range, existingIds);
            if (newCount > 0) {
                console.log(`\n  → 新規: ${newCount}件`);
            } else {
                console.log(`(全件取得済み)`);
            }

            progress.completed_months.push(month.label);
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
        console.log('  月別スクレイピング サマリー');
        console.log('========================================');
        console.log(`  処理月数: ${processed}`);
        console.log(`  完了月数: ${progress.completed_months.length} / ${months.length}`);
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
