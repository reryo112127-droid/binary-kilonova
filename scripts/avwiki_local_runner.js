/**
 * avwiki_local_runner.js  — 1週間完了スケジュール版
 *
 * 設計根拠:
 *   女優 9,247件 × 30秒インターバル ≈ 77時間 (3.2日)
 *   品番 14,550件 × 15秒インターバル ≈ 60時間 (2.5日)
 *   → 両方を並列実行することで最大 ≈3.2日 で完了 (1週間以内に収まる)
 *
 * 起動:
 *   npm run avwiki                              # フォアグラウンド
 *   npm run avwiki:bg                           # バックグラウンド (Windows cmd)
 *   node scripts/avwiki_local_runner.js >> logs/avwiki.log 2>&1 &  # bash
 *
 * 停止: Ctrl+C  (その時点の進捗は自動コミット)
 */

'use strict';

const { spawn, execSync } = require('child_process');
const path   = require('path');
const fs     = require('fs');
const https  = require('https');

// .env 読み込み
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}

const ROOT    = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ── インターバル設定 ────────────────────────────────────────────────────
// 5日完了ペース: 432,000秒 ÷ 女優9,447件 ≈ 46秒 / 品番15,000件 ≈ 29秒
const ACTRESS_INTERVAL_SEC = 46;  // 女優1件あたり待機秒
const PRODUCT_INTERVAL_SEC = 29;  // 品番1件あたり待機秒

// 定期タスク間隔
const GIT_COMMIT_INTERVAL_MS    =  60 * 60 * 1000;  // 1時間ごとにコミット
const BUILD_PROFILES_INTERVAL_MS = 2 * 60 * 60 * 1000;  // 2時間ごとにTurso反映
const DISCORD_CHECK_INTERVAL_MS  =  60 * 1000;       // 1分ごとに奇数時間チェック

// Discord Webhook
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1485815872688885892/78U4bkE7SNNTIMuW91ru_bJXH6D6hynnf88dYAnzkgq2hECA4gUSNa6hzq5DWquwRJYe';

// スクレイピング総件数 (完了判定・ETA計算用)
const ACTRESS_TOTAL = 9447;
const PRODUCT_TOTAL = 15000;

// 安全タイムアウト (スクリプトが終了しない場合の保険)
const SAFETY_TIMEOUT_MS = 9 * 24 * 60 * 60 * 1000; // 9日

// ── Discord 通知 ──────────────────────────────────────────────────────
function sendDiscord(content) {
    return new Promise((resolve) => {
        const url     = new URL(DISCORD_WEBHOOK);
        const payload = JSON.stringify({ content });
        const req = https.request({
            hostname: url.hostname,
            path:     url.pathname + url.search,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => { res.resume(); res.on('end', resolve); });
        req.on('error', (e) => { log(`Discord送信エラー: ${e.message}`); resolve(); });
        req.write(payload);
        req.end();
    });
}

function readProgress() {
    function load(file) {
        try { return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf-8')); }
        catch (_) { return {}; }
    }
    const a = load('data/avwiki_full_progress.json');
    const p = load('data/avwiki_products_progress.json');
    return {
        actressDone:   (a.completed || []).length,
        actressErrors: a.errors || 0,
        productDone:   (p.completed || []).length,
        productErrors: p.errors || 0,
        mgsUpdated:    p.mgs_updated || 0,
        fanzaUpdated:  p.fanza_updated || 0,
    };
}

function makeBar(done, total, len = 20) {
    const filled = Math.min(len, Math.round(done / total * len));
    return '█'.repeat(filled) + '░'.repeat(len - filled);
}

function etaStr(done, total, intervalSec) {
    const remain = Math.max(0, total - done);
    if (remain === 0) return '完了';
    const sec = remain * (intervalSec + 3);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `約${h}時間${m}分` : `約${m}分`;
}

async function notifyDiscord(label = '') {
    const pr  = readProgress();
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const aPct = (pr.actressDone  / ACTRESS_TOTAL * 100).toFixed(1);
    const pPct = (pr.productDone  / PRODUCT_TOTAL * 100).toFixed(1);
    const aBar = makeBar(pr.actressDone,  ACTRESS_TOTAL);
    const pBar = makeBar(pr.productDone,  PRODUCT_TOTAL);
    const aEta = etaStr(pr.actressDone,  ACTRESS_TOTAL, ACTRESS_INTERVAL_SEC);
    const pEta = etaStr(pr.productDone,  PRODUCT_TOTAL, PRODUCT_INTERVAL_SEC);

    const allDone = pr.actressDone >= ACTRESS_TOTAL && pr.productDone >= PRODUCT_TOTAL;
    const header  = allDone
        ? '🎉 **AVWiki スクレイピング 完了！**'
        : `📊 **AVWiki 経過報告** ${label}(${now})`;

    const msg = [
        header,
        '',
        '**👩 女優プロフィール**',
        `\`${aBar}\` **${aPct}%** (${pr.actressDone.toLocaleString()} / ${ACTRESS_TOTAL.toLocaleString()}件)`,
        `⏳ 残り ${(ACTRESS_TOTAL - pr.actressDone).toLocaleString()}件 — ${aEta}`,
        pr.actressErrors ? `❌ エラー ${pr.actressErrors}件` : '',
        '',
        '**📦 品番→女優マッピング**',
        `\`${pBar}\` **${pPct}%** (${pr.productDone.toLocaleString()} / ${PRODUCT_TOTAL.toLocaleString()}件)`,
        `⏳ 残り ${(PRODUCT_TOTAL - pr.productDone).toLocaleString()}件 — ${pEta}`,
        `💾 DB反映 MGS:${pr.mgsUpdated.toLocaleString()} / FANZA:${pr.fanzaUpdated.toLocaleString()}`,
        pr.productErrors ? `❌ エラー ${pr.productErrors}件` : '',
    ].filter(l => l !== null).join('\n');

    await sendDiscord(msg);
    log(`Discord通知送信完了 (女優${aPct}% / 品番${pPct}%)`);
}

// 奇数時間（1,3,5,...,23時）チェック用
let _lastNotifiedHour = -1;
function startDiscordScheduler() {
    return setInterval(async () => {
        const now = new Date();
        // JSTに変換
        const jstHour = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })).getHours();
        if (jstHour % 2 === 1 && jstHour !== _lastNotifiedHour) {
            _lastNotifiedHour = jstHour;
            await notifyDiscord();
        }
    }, DISCORD_CHECK_INTERVAL_MS);
}

// ── ユーティリティ ────────────────────────────────────────────────────
function log(msg) {
    const ts = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    process.stdout.write(`[${ts}] ${msg}\n`);
}

function eta(items, intervalSec) {
    const totalSec = items * (intervalSec + 3); // fetch overhead ~3s
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const days = (totalSec / 86400).toFixed(1);
    return `${h}h${m}m (約${days}日)`;
}

// ── 子プロセス実行 ─────────────────────────────────────────────────────
function runScript(label, scriptRelPath, args, extraEnv) {
    return new Promise((resolve) => {
        const scriptPath = path.join(ROOT, scriptRelPath);
        log(`▶ [${label}] 開始: ${scriptRelPath} ${args.join(' ')}`);

        const child = spawn(process.execPath, [scriptPath, ...args], {
            cwd:   ROOT,
            stdio: 'inherit',
            env:   { ...process.env, CI: '', ...extraEnv },
        });

        // 安全網タイムアウト
        const timer = setTimeout(() => {
            log(`⏱ [${label}] 安全タイムアウト → 停止`);
            child.kill('SIGTERM');
            setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000);
        }, SAFETY_TIMEOUT_MS);

        child.on('close', (code) => {
            clearTimeout(timer);
            log(`✔ [${label}] 完了 (code=${code ?? 'killed'})`);
            resolve(code);
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            log(`✗ [${label}] エラー: ${err.message}`);
            resolve(1);
        });
    });
}

// ── Git コミット ───────────────────────────────────────────────────────
function gitCommit() {
    const candidates = [
        'data/avwiki_full.jsonl',
        'data/avwiki_full_progress.json',
        'data/avwiki_product_map.jsonl',
        'data/avwiki_products_progress.json',
        'data/avwiki_url_list.json',
        'data/avwiki_product_urls.json',
    ];
    const files = candidates.filter(f => fs.existsSync(path.join(ROOT, f)));

    function exec(cmd) {
        try { execSync(cmd, { cwd: ROOT, stdio: 'pipe' }); return true; }
        catch (_) { return false; }
    }

    exec('git config user.name  "avwiki-local-runner"');
    exec('git config user.email "local@localhost"');
    if (files.length) exec('git add ' + files.join(' '));

    try { execSync('git diff --staged --quiet', { cwd: ROOT }); log('git: 変更なし'); return; }
    catch (_) {}

    if (exec('git commit -m "avwiki: local progress [skip ci] [vercel skip]"')) {
        exec('git pull --rebase origin main');
        if (exec('git push')) log('git: ✅ プッシュ完了');
        else log('git: ⚠ プッシュ失敗 (次回リトライ)');
    }
}

// ── Turso 反映 ─────────────────────────────────────────────────────────
function buildProfiles() {
    return runScript('Turso反映', 'scripts/build_avwiki_profiles.js', [], {
        TURSO_FANZA_URL:   process.env.TURSO_FANZA_URL,
        TURSO_FANZA_TOKEN: process.env.TURSO_FANZA_TOKEN,
    });
}

// ── メイン ─────────────────────────────────────────────────────────────
async function main() {
    const actressRemain = 9247;
    const productRemain = 14550;

    log('╔══════════════════════════════════════════════════════╗');
    log('║        AVWiki 1週間完了スケジュール                  ║');
    log('╠══════════════════════════════════════════════════════╣');
    log(`║  女優スクレイプ  ${actressRemain}件 × ${ACTRESS_INTERVAL_SEC}秒 → ETA: ${eta(actressRemain, ACTRESS_INTERVAL_SEC)}`);
    log(`║  品番スクレイプ  ${productRemain}件 × ${PRODUCT_INTERVAL_SEC}秒 → ETA: ${eta(productRemain, PRODUCT_INTERVAL_SEC)}`);
    log('║  実行方式: 並列 (同時実行) → 最大5日で完了予定       ║');
    log('║  Git進捗コミット: 1時間ごと                          ║');
    log('║  Turso反映:       2時間ごと                          ║');
    log('╚══════════════════════════════════════════════════════╝');
    log('');

    // ── 定期タスク ────────────────────────────────────────────────
    const commitTimer  = setInterval(() => {
        log('⏰ 定期 Git コミット');
        gitCommit();
    }, GIT_COMMIT_INTERVAL_MS);

    let buildRunning = false;
    const buildTimer = setInterval(async () => {
        if (buildRunning) return;
        buildRunning = true;
        log('⏰ 定期 Turso 反映');
        await buildProfiles();
        buildRunning = false;
    }, BUILD_PROFILES_INTERVAL_MS);

    // Discord 奇数時間通知
    log('🔔 Discord奇数時間通知スケジューラー起動 (JST 1,3,5,...,23時)');
    await notifyDiscord('🚀 スクレイピング開始 ');  // 起動時にまず1回送信
    const discordTimer = startDiscordScheduler();

    // ── 女優 + 品番 を並列実行 ────────────────────────────────────
    log('🚀 女優スクレイプ & 品番スクレイプ を同時開始');
    await Promise.all([
        runScript(
            '女優',
            'scripts/scrape_avwiki_full.js',
            ['--interval', String(ACTRESS_INTERVAL_SEC)],
            {}
        ),
        runScript(
            '品番',
            'scripts/scrape_avwiki_products.js',
            ['--interval', String(PRODUCT_INTERVAL_SEC)],
            {
                TURSO_MGS_URL:     process.env.TURSO_MGS_URL,
                TURSO_MGS_TOKEN:   process.env.TURSO_MGS_TOKEN,
                TURSO_FANZA_URL:   process.env.TURSO_FANZA_URL,
                TURSO_FANZA_TOKEN: process.env.TURSO_FANZA_TOKEN,
            }
        ),
    ]);

    // ── 完了後処理 ────────────────────────────────────────────────
    clearInterval(commitTimer);
    clearInterval(buildTimer);
    clearInterval(discordTimer);

    log('');
    log('✅ 全スクレイピング完了 — 最終 Turso 反映中...');
    await buildProfiles();
    gitCommit();

    // 完了通知
    await notifyDiscord();

    log('');
    log('🎉 AVWiki スクレイピング 全完了');
    log('   次回起動時は進捗ファイルがリセットされた状態から再スクレイプします。');
}

// ── 割り込みハンドラ ───────────────────────────────────────────────────
process.on('SIGINT', async () => {
    log('\n⛔ 中断 (Ctrl+C) — 進捗をコミット・Discord通知中...');
    gitCommit();
    await notifyDiscord('⛔ 中断 ').catch(() => {});
    process.exit(0);
});
process.on('SIGTERM', async () => {
    log('\n⛔ SIGTERM — 進捗をコミット・Discord通知中...');
    gitCommit();
    await notifyDiscord('⛔ 停止 ').catch(() => {});
    process.exit(0);
});
process.on('unhandledRejection', (err) => log(`[UnhandledRejection] ${err}`));
process.on('uncaughtException',  (err) => log(`[UncaughtException]  ${err}`));

main();
