/**
 * avwiki_local_runner.js
 * AVWikiスクレイピングをローカルでバックグラウンド実行する常駐スクリプト。
 * GitHub Actions の avwiki-scraper.yml と同じ3ステップを順に実行し、
 * 完了後に進捗ファイルをGitにコミット&プッシュして次サイクルへ。
 *
 * 起動方法:
 *   npm run avwiki
 *   または
 *   node scripts/avwiki_local_runner.js
 *
 * バックグラウンド実行 (Windows):
 *   start /B node scripts/avwiki_local_runner.js >> logs/avwiki.log 2>&1
 *
 * 停止: Ctrl+C または タスクマネージャーでnodeプロセスを終了
 */

'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// .env 読み込み
try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (e) { /* dotenv任意 */ }

const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const TIMEOUT_MS    = 50 * 60 * 1000;  // 1スクリプトあたり最大50分 (GitHub Actionsと同じ)
const CYCLE_WAIT_MS =  5 * 60 * 1000;  // サイクル間インターバル: 5分

function log(msg) {
    const ts = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const line = `[${ts}] ${msg}`;
    console.log(line);
}

/** Node.jsスクリプトをタイムアウト付きで子プロセス実行 */
function runScript(scriptRelPath, args, extraEnv) {
    return new Promise((resolve) => {
        const scriptPath = path.join(ROOT, scriptRelPath);
        log(`▶ ${scriptRelPath} ${args.join(' ')}`);

        const child = spawn(process.execPath, [scriptPath, ...args], {
            cwd: ROOT,
            stdio: 'inherit',
            env: { ...process.env, CI: '', ...extraEnv },
        });

        const timer = setTimeout(() => {
            log(`⏱ タイムアウト (${TIMEOUT_MS / 60000}分) → ${scriptRelPath} を停止`);
            child.kill('SIGTERM');
            setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000);
        }, TIMEOUT_MS);

        child.on('close', (code) => {
            clearTimeout(timer);
            log(`✔ ${scriptRelPath} 終了 (code=${code ?? 'killed'})`);
            resolve(code);
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            log(`✗ ${scriptRelPath} エラー: ${err.message}`);
            resolve(1);
        });
    });
}

/** 進捗ファイルをGitにコミット&プッシュ */
function gitCommit() {
    const files = [
        'data/avwiki_full.jsonl',
        'data/avwiki_full_progress.json',
        'data/avwiki_product_map.jsonl',
        'data/avwiki_products_progress.json',
        'data/avwiki_url_list.json',
        'data/avwiki_product_urls.json',
    ];

    function exec(cmd) {
        try {
            execSync(cmd, { cwd: ROOT, stdio: 'pipe' });
            return true;
        } catch (_) { return false; }
    }

    exec('git config user.name "avwiki-local-runner"');
    exec('git config user.email "local@localhost"');

    // 存在するファイルだけ add
    const existing = files.filter(f => fs.existsSync(path.join(ROOT, f)));
    if (!existing.length) { log('git: コミット対象ファイルなし'); return; }

    exec('git add ' + existing.join(' '));

    try {
        const diff = execSync('git diff --staged --quiet', { cwd: ROOT });
        log('git: 変更なし、スキップ');
        return;
    } catch (_) { /* 変更あり → コミット続行 */ }

    if (exec('git commit -m "avwiki: local progress [skip ci] [vercel skip]"')) {
        log('git: コミット完了');
        exec('git pull --rebase origin main');
        if (exec('git push')) log('git: プッシュ完了');
        else log('git: プッシュ失敗 (次回リトライ)');
    } else {
        log('git: コミット失敗 (non-fatal)');
    }
}

/** 1サイクル実行 */
async function cycle() {
    log('========== AVWiki サイクル開始 ==========');

    // ① 女優プロフィールスクレイプ
    await runScript('scripts/scrape_avwiki_full.js', ['--interval', '30']);

    // ② 品番→女優マッピングスクレイプ
    await runScript('scripts/scrape_avwiki_products.js', ['--interval', '15'], {
        TURSO_MGS_URL:     process.env.TURSO_MGS_URL,
        TURSO_MGS_TOKEN:   process.env.TURSO_MGS_TOKEN,
        TURSO_FANZA_URL:   process.env.TURSO_FANZA_URL,
        TURSO_FANZA_TOKEN: process.env.TURSO_FANZA_TOKEN,
    });

    // ③ Turso actress_profiles に反映
    await runScript('scripts/build_avwiki_profiles.js', [], {
        TURSO_FANZA_URL:   process.env.TURSO_FANZA_URL,
        TURSO_FANZA_TOKEN: process.env.TURSO_FANZA_TOKEN,
    });

    // ④ 進捗をGitにコミット
    gitCommit();

    log(`========== サイクル完了 → ${CYCLE_WAIT_MS / 60000}分後に再開 ==========\n`);
    setTimeout(cycle, CYCLE_WAIT_MS);
}

// 未補足例外ハンドラ
process.on('unhandledRejection', (err) => log(`[UnhandledRejection] ${err}`));
process.on('uncaughtException',  (err) => log(`[UncaughtException] ${err}`));

cycle();
