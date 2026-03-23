/**
 * FANZA フェーズ2.5: サンプル動画プレイヤーURL取得
 *
 * DMM API v3 を月別に再フェッチし、sampleMovieURL を取得して fanza.db に保存する。
 * 約3,840リクエスト（100件/req）で全件対応。1req/secで約64分。
 *
 * 実行: node scripts/fanza_phase2_5_video.js
 * テスト: node scripts/fanza_phase2_5_video.js --max-months 2
 * DB適用のみ: node scripts/fanza_phase2_5_video.js --apply
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DMM_API_ID = process.env.DMM_API_ID || 'sXmYFJnNNfqnZ0WbB2Tc';
const DMM_AFFILIATE_ID = process.env.DMM_AFFILIATE_ID || 'desireav-990';

const DATA_DIR = path.join(__dirname, '..', 'data');
const VIDEO_JSONL = path.join(DATA_DIR, 'fanza_video_urls.jsonl');
const PROGRESS_PATH = path.join(DATA_DIR, 'fanza_phase2_5_progress.json');
const DB_PATH = path.join(DATA_DIR, 'fanza.db');

const HITS_PER_REQUEST = 100;
const RATE_LIMIT_MS = 1000;
const START_YEAR_MONTH = '2010-01';

const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1479858556726546523/fZSbfjBuRJN1fvRLWUkGu8wnZGPvx49hImkayKNol84ZOZqyvKzsf9K9ONCWhE0quKkJ';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getCurrentYearMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function getNextMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    const date = new Date(y, m, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function loadProgress() {
    if (fs.existsSync(PROGRESS_PATH)) {
        return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
    }
    return { completed_months: [], total_found: 0, total_fetched: 0 };
}

function saveProgress(p) {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2));
}

async function sendDiscord(content) {
    try {
        await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
    } catch (e) { /* ignore */ }
}

async function fetchMonthVideos(yearMonth, offset = 1) {
    const [year, month] = yearMonth.split('-');
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    const gteDate = `${year}-${month}-01T00:00:00`;
    const lteDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}T23:59:59`;

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

    const res = await fetch(`https://api.dmm.com/affiliate/v3/ItemList?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.result) throw new Error(`API Error: ${JSON.stringify(data)}`);

    const items = data.result.items || [];
    return {
        items: items.map(item => ({
            product_id: item.content_id,
            sample_video_url: item.sampleMovieURL?.size_720_480
                || item.sampleMovieURL?.size_644_414
                || item.sampleMovieURL?.size_560_360
                || item.sampleMovieURL?.size_476_306
                || null,
        })),
        total_count: data.result.result_count || 0,
    };
}

async function applyToDb() {
    console.log('[適用] fanza_video_urls.jsonl → fanza.db\n');

    if (!fs.existsSync(VIDEO_JSONL)) {
        console.error('❌ fanza_video_urls.jsonl が見つかりません');
        process.exit(1);
    }

    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_PATH));

    const lines = fs.readFileSync(VIDEO_JSONL, 'utf-8').split('\n').filter(Boolean);
    let applied = 0;

    db.run('BEGIN TRANSACTION');

    for (const line of lines) {
        try {
            const { product_id, sample_video_url } = JSON.parse(line);
            if (!sample_video_url) continue;
            db.run(
                `UPDATE products SET sample_video_url = ?, updated_at = datetime('now','localtime') WHERE product_id = ?`,
                [sample_video_url, product_id]
            );
            applied++;
            if (applied % 10000 === 0) {
                db.run('COMMIT');
                console.log(`  ${applied.toLocaleString()} 件適用済み`);
                db.run('BEGIN TRANSACTION');
            }
        } catch (e) { /* skip */ }
    }

    db.run('COMMIT');
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    db.close();

    console.log(`\n✅ ${applied.toLocaleString()} 件の動画URLをDBに適用`);
    console.log(`   DBサイズ: ${(fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1)} MB`);
}

async function main() {
    const args = process.argv.slice(2);
    const applyOnly = args.includes('--apply');
    const maxMonthsIdx = args.indexOf('--max-months');
    const maxMonths = maxMonthsIdx >= 0 ? parseInt(args[maxMonthsIdx + 1], 10) : Infinity;

    if (applyOnly) {
        await applyToDb();
        return;
    }

    const progress = loadProgress();
    const stream = fs.createWriteStream(VIDEO_JSONL, { flags: 'a' });
    const currentYM = getCurrentYearMonth();
    let targetMonth = START_YEAR_MONTH;
    let monthsProcessed = 0;
    const startTime = Date.now();
    let lastNotifyTime = Date.now();

    console.log('========================================');
    console.log('  FANZA フェーズ2.5: サンプル動画URL取得');
    console.log('========================================\n');
    console.log(`  完了月: ${progress.completed_months.length}ヶ月`);
    console.log(`  取得済み動画URL: ${progress.total_found.toLocaleString()}\n`);

    await sendDiscord(`🎬 **FANZA フェーズ2.5（動画URL取得）開始**\n完了済み: ${progress.completed_months.length}ヶ月 / 動画URL既取得: ${progress.total_found.toLocaleString()}件`);

    try {
        while (targetMonth <= currentYM && monthsProcessed < maxMonths) {
            if (progress.completed_months.includes(targetMonth)) {
                targetMonth = getNextMonth(targetMonth);
                continue;
            }

            let offset = 1;
            let monthFound = 0;
            let totalInMonth = null;

            try {
                while (true) {
                    const result = await fetchMonthVideos(targetMonth, offset);
                    if (totalInMonth === null) totalInMonth = result.total_count;

                    for (const item of result.items) {
                        stream.write(JSON.stringify(item) + '\n');
                        if (item.sample_video_url) monthFound++;
                    }

                    progress.total_fetched += result.items.length;

                    if (result.items.length < HITS_PER_REQUEST) break;
                    offset += HITS_PER_REQUEST;
                    await sleep(RATE_LIMIT_MS);
                }

                progress.total_found += monthFound;
                progress.completed_months.push(targetMonth);
                saveProgress(progress);

                process.stdout.write(`  ✅ ${targetMonth}: ${totalInMonth} 件処理 / 動画URL: ${monthFound} 件\n`);

                const now = Date.now();
                if (now - lastNotifyTime >= 30 * 60 * 1000) {
                    const elapsed = ((now - startTime) / 1000 / 60).toFixed(0);
                    await sendDiscord(`📊 **フェーズ2.5 途中経過** (${elapsed}分経過)\n✅ 完了月: ${progress.completed_months.length}ヶ月\n🎥 動画URL取得: ${progress.total_found.toLocaleString()}件\n現在処理中: ${targetMonth}`);
                    lastNotifyTime = now;
                }

            } catch (err) {
                console.error(`  ❌ ${targetMonth}: ${err.message}`);
                await sleep(5000);
                continue;
            }

            monthsProcessed++;
            targetMonth = getNextMonth(targetMonth);
            await sleep(RATE_LIMIT_MS);
        }
    } finally {
        stream.end();
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

        console.log('\n========================================');
        console.log('  フェーズ2.5 サマリー');
        console.log('========================================');
        console.log(`  完了月:      ${progress.completed_months.length}ヶ月`);
        console.log(`  処理件数:    ${progress.total_fetched.toLocaleString()}`);
        console.log(`  動画URL取得: ${progress.total_found.toLocaleString()}`);
        console.log(`  経過時間:    ${elapsed}分`);
        console.log('========================================');
        console.log('\n💡 DB適用: node scripts/fanza_phase2_5_video.js --apply\n');

        await sendDiscord(`✨ **FANZA フェーズ2.5 完了**\n⏱ ${elapsed}分\n🎥 動画URL取得: ${progress.total_found.toLocaleString()}件\n💡 次: --apply でDB反映`);
    }
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
