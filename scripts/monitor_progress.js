/**
 * バックグラウンド処理の進捗をDiscordに定期報告するモニタースクリプト
 *
 * 監視対象:
 *   1. fanza_refresh_all_reviews.js  (レビュー収集)
 *   2. avwiki_by_actress.js          (AVWiki女優スクレイプ)
 *   3. seesaawiki_by_actress.js      (Seesaawiki女優スクレイプ)
 *
 * 使い方:
 *   node scripts/monitor_progress.js               # 30分ごとに報告
 *   node scripts/monitor_progress.js --interval 10 # 10分ごと
 *   node scripts/monitor_progress.js --odd-hours   # 奇数時刻(1,3,5...23時)に報告
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1485815872688885892/78U4bkE7SNNTIMuW91ru_bJXH6D6hynnf88dYAnzkgq2hECA4gUSNa6hzq5DWquwRJYe';

const args        = process.argv.slice(2);
const ODD_HOURS   = args.includes('--odd-hours');
const intIdx      = args.indexOf('--interval');
const INTERVAL_M  = intIdx !== -1 ? parseInt(args[intIdx + 1], 10) : 30;
const INTERVAL_MS = INTERVAL_M * 60 * 1000;

// 次の奇数時刻(JST)までのミリ秒を返す
function msUntilNextOddHour() {
    const now = new Date();
    const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const h = jst.getHours();
    // 現在が偶数時 → +1h、奇数時 → +2h で次の奇数時へ
    const nextOdd = h % 2 === 0 ? h + 1 : h + 2;
    const target = new Date(jst);
    target.setHours(nextOdd % 24, 0, 0, 0);
    if (nextOdd >= 24) target.setDate(target.getDate() + 1);
    return target - jst;
}

const DATA_DIR    = path.join(__dirname, '..', 'data');
const REVIEW_CKPT = path.join(__dirname, 'fanza_review_checkpoint.json');
const AVWIKI_PROG   = path.join(DATA_DIR, 'avwiki_actress_progress.json');
const AVWIKI_MAP    = path.join(DATA_DIR, 'avwiki_actress_map.jsonl');
const SEESAA_PROG   = path.join(DATA_DIR, 'seesaawiki_progress.json');
const SEESAA_MAP    = path.join(DATA_DIR, 'seesaawiki_actress_map.jsonl');
const SEESAA_TOTAL  = 9665;

// 全月リスト (2010-01 〜 2026-03)
function allMonths(start, end) {
    const months = [];
    let [y, m] = start.split('-').map(Number);
    const [ey, em] = end.split('-').map(Number);
    while (y < ey || (y === ey && m <= em)) {
        months.push(`${y}-${String(m).padStart(2,'0')}`);
        if (++m > 12) { m = 1; y++; }
    }
    return months;
}

const TOTAL_MONTHS = allMonths('2010-01', '2026-03').length; // 195ヶ月

// プロセス生存確認
function isProcessAlive(scriptName) {
    try {
        const out = execSync('ps aux', { encoding: 'utf-8' });
        return out.includes(scriptName);
    } catch { return false; }
}

// ── レビュー進捗 ──────────────────────────────────────
function getReviewProgress() {
    if (!fs.existsSync(REVIEW_CKPT)) return null;
    try {
        const p = JSON.parse(fs.readFileSync(REVIEW_CKPT, 'utf-8'));
        const months = allMonths('2010-01', '2026-03');
        const doneIdx = months.indexOf(p.lastYM);
        const doneCnt = doneIdx >= 0 ? doneIdx + 1 : 0;
        return {
            lastYM:      p.lastYM,
            done:        doneCnt,
            total:       TOTAL_MONTHS,
            pct:         ((doneCnt / TOTAL_MONTHS) * 100).toFixed(1),
            fetched:     p.stats?.totalFetched  ?? 0,
            updated:     p.stats?.totalUpdated  ?? 0,
            completed:   p.stats?.completed === true || p.lastYM === '2026-03',
            alive:       isProcessAlive('fanza_refresh_all_reviews'),
        };
    } catch { return null; }
}

// ── AVWiki進捗 ────────────────────────────────────────
function getAvwikiProgress() {
    if (!fs.existsSync(AVWIKI_PROG)) return null;
    try {
        const p    = JSON.parse(fs.readFileSync(AVWIKI_PROG, 'utf-8'));
        const done = Object.keys(p.completed).length;

        // mapファイルから作品合計
        let mapPids = 0;
        if (fs.existsSync(AVWIKI_MAP)) {
            const lines = fs.readFileSync(AVWIKI_MAP, 'utf-8').split('\n').filter(Boolean);
            for (const l of lines) {
                try { mapPids += JSON.parse(l).pids.length; } catch {}
            }
        }

        const total = p.totalTargets || Object.keys(p.completed).length + 1;

        return {
            done,
            total,
            pct:      ((done / total) * 100).toFixed(1),
            found:    p.found    ?? 0,
            notFound: p.notFound ?? 0,
            mapPids,
            alive:    isProcessAlive('avwiki_by_actress'),
        };
    } catch { return null; }
}

// ── Seesaawiki進捗 ───────────────────────────────────
function getSeesaaProgress() {
    if (!fs.existsSync(SEESAA_PROG)) return null;
    try {
        const p = JSON.parse(fs.readFileSync(SEESAA_PROG, 'utf-8'));
        let mapPids = 0;
        if (fs.existsSync(SEESAA_MAP)) {
            const lines = fs.readFileSync(SEESAA_MAP, 'utf-8').split('\n').filter(Boolean);
            for (const l of lines) {
                try { mapPids += JSON.parse(l).pids.length; } catch {}
            }
        }
        const done = p.done ?? 0;
        return {
            done,
            total:    SEESAA_TOTAL,
            pct:      ((done / SEESAA_TOTAL) * 100).toFixed(1),
            found:    p.found    ?? 0,
            notFound: p.notFound ?? 0,
            mapPids,
            completed: p.completed === true || done >= SEESAA_TOTAL,
            alive:    isProcessAlive('seesaawiki_by_actress'),
        };
    } catch { return null; }
}

// ── Discord送信 ───────────────────────────────────────
async function sendDiscord(content) {
    try {
        const res = await fetch(DISCORD_WEBHOOK, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ content }),
        });
        if (!res.ok) console.warn('[Discord] 送信失敗:', res.status);
    } catch (e) {
        console.warn('[Discord] エラー:', e.message);
    }
}

// ── 進捗メッセージ組み立て ────────────────────────────
function buildMessage(rev, avw, see, isComplete = false) {
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const lines = [];

    if (isComplete) {
        lines.push(`✅ **バックグラウンド処理 完了報告** (${now})`);
    } else {
        lines.push(`📊 **進捗報告** (${now})`);
    }

    // レビュー収集
    if (rev) {
        const status = rev.completed ? '✅ 完了' : rev.alive ? '🔄 実行中' : '⏸️ 停止';
        lines.push('');
        lines.push(`**📝 FANZAレビュー収集** ${status}`);
        lines.push(`  進捗: ${rev.done}/${rev.total}ヶ月 (${rev.pct}%) — 最終: ${rev.lastYM}`);
        lines.push(`  取得: ${rev.fetched.toLocaleString()}件 / DB更新: ${rev.updated.toLocaleString()}件`);
    }

    // AVWiki女優スクレイプ
    if (avw) {
        const status = avw.done >= avw.total ? '✅ 完了' : avw.alive ? '🔄 実行中' : '⏸️ 停止';
        lines.push('');
        lines.push(`**🎭 AVWiki女優スクレイプ** ${status}`);
        lines.push(`  進捗: ${avw.done.toLocaleString()}/${avw.total.toLocaleString()}名 (${avw.pct}%)`);
        lines.push(`  発見: ${avw.found}名 / 未発見: ${avw.notFound}名`);
        lines.push(`  作品マッピング: ${avw.mapPids.toLocaleString()}件`);
    }

    // Seesaawiki女優スクレイプ
    if (see) {
        const status = see.completed ? '✅ 完了' : see.alive ? '🔄 実行中' : '⏸️ 停止';
        lines.push('');
        lines.push(`**📖 Seesaawiki女優スクレイプ** ${status}`);
        lines.push(`  進捗: ${see.done.toLocaleString()}/${see.total.toLocaleString()}件 (${see.pct}%)`);
        lines.push(`  作品あり: ${see.found}件 / なし: ${see.notFound}件`);
        lines.push(`  作品マッピング: ${see.mapPids.toLocaleString()}件`);
    }

    return lines.join('\n');
}

// ── 進捗収集・送信 ───────────────────────────────────
async function report(isFirst = false) {
    const rev = getReviewProgress();
    const avw = getAvwikiProgress();
    const see = getSeesaaProgress();

    const revDone = !rev || rev.completed || (!rev.alive && rev.done >= rev.total);
    const avwDone = !avw || avw.done >= avw.total || (!avw.alive && avw.done > 0);
    const seeDone = !see || see.completed || (!see.alive && see.done > 0);
    const allDone = !isFirst && revDone && avwDone && seeDone;

    const msg = buildMessage(rev, avw, see, allDone);
    console.log((isFirst ? '' : '\n') + msg);
    await sendDiscord(msg);

    return allDone;
}

// ── メインループ ──────────────────────────────────────
async function main() {
    if (ODD_HOURS) {
        console.log('モニター開始: 奇数時刻(JST)にDiscordへ報告');
    } else {
        console.log(`モニター開始: ${INTERVAL_M}分ごとにDiscordへ報告`);
    }

    // 即時初回報告
    await report(true);

    // 次回以降のスケジューリング
    async function scheduleNext() {
        const delay = ODD_HOURS ? msUntilNextOddHour() : INTERVAL_MS;
        const nextTime = new Date(Date.now() + delay).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        console.log(`\n次回報告: ${nextTime}`);

        setTimeout(async () => {
            const allDone = await report(false);
            if (allDone) {
                console.log('\n全プロセス完了。モニター終了。');
                process.exit(0);
            }
            scheduleNext();
        }, delay);
    }

    scheduleNext();
}

main().catch(e => { console.error(e); process.exit(1); });
