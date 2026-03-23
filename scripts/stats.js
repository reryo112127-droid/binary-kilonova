/**
 * DB統計表示ユーティリティ（JSONL対応版）
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, '..', 'data');
const JSONL_PATH = path.join(DATA_DIR, 'mgs_products.jsonl');
const PROGRESS_PATH = path.join(DATA_DIR, 'phase1_progress.json');

async function main() {
    console.log('═══════════════════════════════════════');
    console.log('  MGS動画 データベース統計');
    console.log('═══════════════════════════════════════\n');

    // フェーズ1進捗
    if (fs.existsSync(PROGRESS_PATH)) {
        const progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
        console.log('  --- フェーズ1 進捗 ---');
        console.log(`  最終ページ: ${progress.last_page} / ${progress.total_pages || '?'}`);
        console.log(`  累計保存件数: ${progress.total_items?.toLocaleString() || '?'}`);
    }

    // JSONLファイル統計
    if (!fs.existsSync(JSONL_PATH)) {
        console.log('\n  ❌ データファイルが見つかりません');
        return;
    }

    const bytes = fs.statSync(JSONL_PATH).size;
    console.log(`\n  📁 データファイル: ${(bytes / 1024 / 1024).toFixed(1)} MB`);

    // 行カウントとサンプリング
    let total = 0;
    let withTitle = 0;
    let withActress = 0;
    let withVideo = 0;
    let uniqueIds = new Set();

    const rl = readline.createInterface({
        input: fs.createReadStream(JSONL_PATH),
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const p = JSON.parse(line);
            total++;
            uniqueIds.add(p.product_id);
            if (p.title) withTitle++;
            if (p.actresses) withActress++;
            if (p.sample_video_url) withVideo++;
        } catch (e) {
            // skip malformed lines
        }
    }

    console.log(`\n  📦 総行数:          ${total.toLocaleString()}`);
    console.log(`  🔑 ユニーク品番数:  ${uniqueIds.size.toLocaleString()}`);
    console.log(`  📝 タイトルあり:    ${withTitle.toLocaleString()}`);
    console.log(`  👩 出演者あり:      ${withActress.toLocaleString()}`);
    console.log(`  🎬 サンプル動画あり: ${withVideo.toLocaleString()}`);

    if (total !== uniqueIds.size) {
        console.log(`\n  ⚠️  重複: ${(total - uniqueIds.size).toLocaleString()}件（UPSERT解消前）`);
    }

    console.log('\n═══════════════════════════════════════\n');
}

main().catch(console.error);
