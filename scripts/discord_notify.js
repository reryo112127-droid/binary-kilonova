/**
 * Discord進捗通知スクリプト
 * フェーズ2の進捗をDiscord Webhookに送信する
 * 
 * 使い方:
 *   node scripts/discord_notify.js          # 進捗通知
 *   node scripts/discord_notify.js --test   # テスト送信
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DETAIL_JSONL = path.join(DATA_DIR, 'mgs_details.jsonl');
const PROGRESS_PATH = path.join(DATA_DIR, 'phase2_progress.json');

const WEBHOOK_URL = 'https://discord.com/api/webhooks/1485815872688885892/78U4bkE7SNNTIMuW91ru_bJXH6D6hynnf88dYAnzkgq2hECA4gUSNa6hzq5DWquwRJYe';
const TOTAL_PRODUCTS = 114563;

function sendDiscord(content) {
    console.log('Discord notification disabled by user request.');
    return Promise.resolve();
    const url = new URL(WEBHOOK_URL);
        const payload = JSON.stringify({ content });
        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function countLines(filePath) {
    if (!fs.existsSync(filePath)) return 0;
    let count = 0;
    const rl = readline.createInterface({
        input: fs.createReadStream(filePath), crlfDelay: Infinity,
    });
    for await (const line of rl) {
        if (line.trim()) count++;
    }
    return count;
}

async function main() {
    const isTest = process.argv.includes('--test');

    if (isTest) {
        await sendDiscord('🔔 **MGSスクレイピング通知テスト**\n接続成功！定時報告が届くようになります。');
        console.log('テスト通知を送信しました');
        return;
    }

    // 進捗データ収集
    const scraped = await countLines(DETAIL_JSONL);
    const progress = fs.existsSync(PROGRESS_PATH)
        ? JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'))
        : { scraped: 0, errors: 0 };

    const pct = (scraped / TOTAL_PRODUCTS * 100).toFixed(1);
    const remaining = TOTAL_PRODUCTS - scraped;
    const eta = (remaining * 4.5 / 3600).toFixed(1);
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

    // プログレスバー生成
    const barLen = 20;
    const filled = Math.round(scraped / TOTAL_PRODUCTS * barLen);
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);

    const msg = [
        `📊 **MGS動画 フェーズ2 定時報告** (${now})`,
        '',
        `\`${bar}\` **${pct}%**`,
        '',
        `📦 取得済み: **${scraped.toLocaleString()}** / ${TOTAL_PRODUCTS.toLocaleString()}`,
        `⏳ 残り: **${remaining.toLocaleString()}件** (推定 ${eta}時間)`,
        `❌ エラー: ${progress.errors || 0}件`,
    ].join('\n');

    await sendDiscord(msg);
    console.log(`Discord通知送信完了: ${scraped}/${TOTAL_PRODUCTS} (${pct}%)`);
}

main().catch(err => {
    console.error('通知エラー:', err.message);
    process.exit(1);
});
