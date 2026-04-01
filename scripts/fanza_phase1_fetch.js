/**
 * FANZA フェーズ1: 全作品取得スクリプト
 *
 * DMM API v3 を使用して、月別に全FANZA videoa作品を取得しJSONL形式で保存する。
 * 進捗はJSONファイルに保存し、中断・再開が可能。
 *
 * 実行: node scripts/fanza_phase1_fetch.js
 */
const fs = require('fs');
const path = require('path');

// ========== 設定 ==========
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DMM_API_ID = process.env.DMM_API_ID || 'sXmYFJnNNfqnZ0WbB2Tc';
const DMM_AFFILIATE_ID = process.env.DMM_AFFILIATE_ID || 'desireav-990';

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'fanza_products.jsonl');
const PROGRESS_FILE = path.join(DATA_DIR, 'fanza_phase1_progress.json');

const HITS_PER_REQUEST = 100;        // DMM APIの最大値
const RATE_LIMIT_MS = 1000;          // リクエスト間隔(ms) - 1秒
const START_YEAR_MONTH = '2010-01';  // 取得開始年月
const MAX_OFFSET_PER_MONTH = 10000;  // 1ヶ月あたりの最大取得件数 (DMM API上限=50000)

// ========== ユーティリティ ==========
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getCurrentYearMonth() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

function getNextMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    const date = new Date(y, m, 1); // m は0-indexed なので m (1月=1) → new Date(y, 1, 1) = 2月1日
    const ny = date.getFullYear();
    const nm = String(date.getMonth() + 1).padStart(2, '0');
    return `${ny}-${nm}`;
}

function loadProgress() {
    if (fs.existsSync(PROGRESS_FILE)) {
        return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    }
    return { completed_months: [], current_month: null, total_fetched: 0 };
}

function saveProgress(progress) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ========== DMM API 呼び出し ==========
async function fetchMonthProducts(yearMonth, offset = 1) {
    const [year, month] = yearMonth.split('-');
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    const lastDayStr = String(lastDay).padStart(2, '0');
    // DMM API v3 は YYYY-MM-DDThh:mm:ss 形式
    const gteDate = `${year}-${month}-01T00:00:00`;
    const lteDate = `${year}-${month}-${lastDayStr}T23:59:59`;

    const params = new URLSearchParams({
        api_id: DMM_API_ID,
        affiliate_id: DMM_AFFILIATE_ID,
        site: 'FANZA',
        service: 'digital',
        floor: 'videoa',
        hits: HITS_PER_REQUEST.toString(),
        offset: offset.toString(),
        sort: 'date',
        gte_date: gteDate,
        lte_date: lteDate,
        output: 'json',
    });

    const url = `https://api.dmm.com/affiliate/v3/ItemList?${params.toString()}`;

    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();

    if (!data.result) {
        throw new Error(`API Error: ${JSON.stringify(data)}`);
    }

    return {
        items: data.result.items || [],
        total_count: data.result.result_count || 0,
        returned_count: (data.result.items || []).length,
    };
}

// ========== アイテム変換 ==========
function convertItem(item) {
    // サンプル画像URLリスト
    const sampleImages = [];
    if (item.sampleImageURL) {
        const si = item.sampleImageURL;
        // sample_s は small, sample_l は large
        const entries = si.sample_s?.image || si.sample_l?.image || [];
        // largeを優先
        const largeEntries = si.sample_l?.image || [];
        const useEntries = largeEntries.length > 0 ? largeEntries : entries;
        sampleImages.push(...useEntries);
    }

    // 収録時間(分)をパース
    let durationMin = null;
    if (item.volume) {
        const match = String(item.volume).match(/(\d+)/);
        if (match) durationMin = parseInt(match[1], 10);
    }

    // 発売日をYYYY-MM-DD形式に
    let saleDate = item.date || null;
    if (saleDate) {
        saleDate = saleDate.replace(' 00:00:00', '').trim();
    }

    return {
        product_id: item.content_id,
        title: item.title || null,
        actresses: item.iteminfo?.actress?.map(a => a.name).join(', ') || null,
        maker: item.iteminfo?.maker?.[0]?.name || null,
        label: item.iteminfo?.label?.[0]?.name || null,
        duration_min: durationMin,
        genres: item.iteminfo?.genre?.map(g => g.name).join(', ') || null,
        sale_start_date: saleDate,
        main_image_url: item.imageURL?.large || item.imageURL?.list || null,
        sample_images: sampleImages.length > 0 ? sampleImages : null,
        affiliate_url: item.affiliateURL || null,
        detail_url: item.URL || null,
        series_id:    item.iteminfo?.series?.[0]?.id   ? String(item.iteminfo.series[0].id) : null,
        series_name:  item.iteminfo?.series?.[0]?.name || null,
        vr_flag:      (item.title || '').includes('【VR】') ? 1 : 0,
    };
}

// ========== メイン ==========
async function main() {
    console.log('========================================');
    console.log('  FANZA フェーズ1: 全作品取得');
    console.log('========================================\n');

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const progress = loadProgress();
    console.log(`[進捗] 完了月: ${progress.completed_months.length}ヶ月 / 取得済み: ${progress.total_fetched.toLocaleString()}件\n`);

    // 出力ファイルはappend mode
    const outputStream = fs.createWriteStream(OUTPUT_FILE, { flags: 'a' });

    const currentYM = getCurrentYearMonth();
    let targetMonth = START_YEAR_MONTH;
    let totalFetched = progress.total_fetched;

    while (targetMonth <= currentYM) {
        if (progress.completed_months.includes(targetMonth)) {
            targetMonth = getNextMonth(targetMonth);
            continue;
        }

        console.log(`\n[${targetMonth}] 取得開始...`);
        progress.current_month = targetMonth;
        saveProgress(progress);

        let offset = 1;
        let monthFetched = 0;
        let totalInMonth = null;

        try {
            while (offset < MAX_OFFSET_PER_MONTH) {
                const result = await fetchMonthProducts(targetMonth, offset);

                if (totalInMonth === null) {
                    totalInMonth = result.total_count;
                    console.log(`  総件数: ${totalInMonth.toLocaleString()}件`);
                }

                if (result.items.length === 0) break;

                for (const item of result.items) {
                    const converted = convertItem(item);
                    outputStream.write(JSON.stringify(converted) + '\n');
                }

                monthFetched += result.items.length;
                totalFetched += result.items.length;
                process.stdout.write(`  取得中: ${monthFetched}/${totalInMonth} (offset=${offset})\r`);

                if (result.items.length < HITS_PER_REQUEST) break;

                offset += HITS_PER_REQUEST;
                await sleep(RATE_LIMIT_MS);
            }

            console.log(`\n  ✅ ${targetMonth}: ${monthFetched.toLocaleString()}件取得完了`);
            progress.completed_months.push(targetMonth);
            progress.total_fetched = totalFetched;
            saveProgress(progress);

        } catch (err) {
            console.error(`\n  ❌ ${targetMonth}: エラー - ${err.message}`);
            console.error('  5秒後にリトライします...');
            await sleep(5000);
            continue; // 同じ月を再試行
        }

        targetMonth = getNextMonth(targetMonth);
        await sleep(RATE_LIMIT_MS);
    }

    outputStream.end();
    console.log('\n========================================');
    console.log(`  ✅ 完了！ 総取得件数: ${totalFetched.toLocaleString()}件`);
    console.log(`  📄 出力: ${OUTPUT_FILE}`);
    console.log('========================================\n');
    console.log('次のステップ: node scripts/fanza_build_db.js\n');
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
