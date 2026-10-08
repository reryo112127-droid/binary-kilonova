/**
 * X エンゲージメント計測 → 女優別パフォーマンス還流ループ
 *
 * x_browser_post.js が投稿時に x_post_metrics
 *   (tweet_id, account, genre, product_id, actresses, hook, posted_hour, posted_at)
 * を記録する。本スクリプトは各投稿のツイートページを実ブラウザ(Playwright)で開き、
 * いいね/返信/RT/インプレッションをスクレイプして metrics を更新し、
 *   - data/x_actress_perf.json … 女優 → 平均加重エンゲージ(伸びる女優ほど高い)
 *   - data/x_hour_perf.json    … 時間帯(0-23) → 平均加重エンゲージ
 * を書き出す。x_browser_post.js の prepareItems はこのスコアで承認キュー内の作品を
 * 並べ替える(実績の高い女優を優先)。
 *
 * Xの公開アルゴリズムに倣い weighted = replies*13.5 + reposts*1 + likes*0.5 + impressions/100。
 * （表示回数の項は、反応0件ばかりの時期でも「どれが多く見られたか」で差が付くようにするため）
 *
 * 返信数の注意: 投稿はツリー型で、2ポスト目（URL付き）を**自分で返信として付けている**。
 * そのまま数えると全投稿が「返信1」になり（2026-10-08 実測で全件 💬1）、全作品が同点になっていた。
 * 自分の1件を引いた値を記録する。
 *
 * 利用:
 *   node scripts/x_engagement_collect.js              # 直近7日・未計測 or 6h超を更新
 *   node scripts/x_engagement_collect.js --days=14 --show
 */
require('dotenv').config({ path: './site/.env.local' });
const fs = require('fs');
const path = require('path');
const { d1 } = require('./lib/d1');

const SHOW = process.argv.includes('--show');
const arg = (k) => { const a = process.argv.find(x => x.startsWith('--' + k)); return a ? (a.split('=')[1] ?? true) : null; };
const DAYS = parseInt(arg('days') || '7', 10) || 7;
const PERF_FILE = path.join(__dirname, '..', 'data', 'x_actress_perf.json');
const HOUR_FILE = path.join(__dirname, '..', 'data', 'x_hour_perf.json');
const ACCOUNT_LABEL = { '005': '新作', '004': 'セール', '007': 'VR', '002': '共演', '008': '素人', '006': '人妻' };

function actressNames(raw) {
    return String(raw || '').split(/[,、/／]+/).map(s => s.trim())
        .filter(n => n && n.length > 1 && !/\d+歳|[（()【】\[\]]/.test(n));
}
// aria-label や表示テキストから先頭の数値を抽出(1,234 / 1.2K / 3.4M / 5万 に対応)
function parseCount(s) {
    if (!s) return 0;
    const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([KMB万])?/i);
    if (!m) return 0;
    let n = parseFloat(m[1]); if (!isFinite(n)) return 0;
    const u = (m[2] || '').toUpperCase();
    if (u === 'K') n *= 1e3; else if (u === 'M') n *= 1e6; else if (u === 'B') n *= 1e9; else if (m[2] === '万') n *= 1e4;
    return Math.round(n);
}
const weighted = (m) => (m.replies || 0) * 13.5 + (m.reposts || 0) * 1 + (m.likes || 0) * 0.5 + (m.impressions || 0) / 100;

async function notifyDiscord(content) {
    const url = process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK;
    if (!url) return;
    try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }); } catch {}
}

// 1ツイートの指標をスクレイプ。失敗(削除/凍結/取得不可)時は null。
async function scrapeTweet(page, tweetId) {
    await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);
    const art = page.locator('article').first();
    const ok = await art.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
    if (!ok) return null;
    // 各アクションボタンの aria-label 先頭の数値(例: "12 件のリプライ"/"123 Likes. Like")
    async function countFor(testid) {
        const el = art.locator(`[data-testid="${testid}"]`).first();
        const label = await el.getAttribute('aria-label', { timeout: 3000 }).catch(() => null);
        return parseCount(label);
    }
    const replies = Math.max(0, (await countFor('reply')) - 1); // 自分で付けた2ポスト目を除く
    const reposts = await countFor('retweet');
    const likes = await countFor('like');
    // インプレッション(views): analytics リンクの aria-label もしくは表示テキスト
    let impressions = 0;
    const v = art.locator('a[href*="/analytics"]').first();
    if (await v.count().catch(() => 0)) {
        impressions = parseCount(await v.getAttribute('aria-label', { timeout: 3000 }).catch(() => null))
            || parseCount(await v.innerText().catch(() => ''));
    }
    return { replies, reposts, likes, impressions };
}

function launchBrowser() {
    const { chromium } = require('playwright');
    return chromium.launch({
        headless: !SHOW,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer'],
    });
}

// アカウントごとにブラウザを起動する。以前は1つのブラウザを全アカウントで使い回しており、
// 途中で "Page crashed" になると残り全アカウントが「browser has been closed」で全滅していた（2026-10-08）。
// ページが落ちたら作り直して続きから計測する（同じアカウントで3回まで）。
async function runAccount(site, account, rows) {
    const auth = process.env[`XCK_${account}_AUTH_TOKEN`], ct0 = process.env[`XCK_${account}_CT0`];
    if (!auth || !ct0) { console.log(`@${account}: Cookie未設定のためskip (${rows.length}件)`); return 0; }
    let browser = null, ctx = null, page = null, restarts = 0;
    const open = async () => {
        await browser?.close().catch(() => {});
        browser = await launchBrowser();
        ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' });
        const cookies = [];
        for (const dom of ['.x.com', '.twitter.com']) {
            cookies.push({ name: 'auth_token', value: auth, domain: dom, path: '/', secure: true, httpOnly: true });
            cookies.push({ name: 'ct0', value: ct0, domain: dom, path: '/', secure: true });
        }
        await ctx.addCookies(cookies);
        page = await ctx.newPage();
    };
    let updated = 0;
    try {
        await open();
        for (const r of rows) {
            let m = null;
            for (;;) {
                try { m = await scrapeTweet(page, String(r.tweet_id)); break; }
                catch (e) {
                    const dead = /closed|crash/i.test(e.message);
                    console.warn(`  ✗ ${r.tweet_id}: ${String(e.message).split(/\r?\n/)[0]}`);
                    if (!dead || restarts >= 3) break;
                    restarts++; console.warn(`  ↻ ブラウザを作り直して続行（${restarts}回目）`);
                    await open();
                }
            }
            if (!m) { console.warn(`  - ${r.tweet_id} 取得できず(削除/非公開?)`); continue; }
            await site.execute({
                sql: `UPDATE x_post_metrics SET impressions=?, likes=?, replies=?, reposts=?, checked_at=datetime('now') WHERE tweet_id=?`,
                args: [m.impressions, m.likes, m.replies, m.reposts, String(r.tweet_id)],
            }).catch(() => {});
            updated++;
            console.log(`  ✅ ${r.tweet_id} [${r.genre}] imp:${m.impressions} ♥${m.likes} 💬${m.replies} 🔁${m.reposts} (w=${weighted(m).toFixed(1)})`);
            await page.waitForTimeout(1500 + Math.random() * 1500);
        }
    } finally {
        await browser?.close().catch(() => {});
    }
    return updated;
}

// metrics 全体(直近DAYS)から女優別・時間帯別の平均加重エンゲージを再計算してJSON出力
async function rebuildPerf(site) {
    const rs = await site.execute({
        sql: `SELECT actresses, posted_hour, replies, reposts, likes, impressions FROM x_post_metrics WHERE posted_at >= datetime('now', ?) AND checked_at IS NOT NULL`,
        args: [`-${DAYS} days`],
    });
    const aAgg = {}, hAgg = {};
    for (const r of rs.rows) {
        const w = weighted(r);
        for (const n of actressNames(r.actresses)) { (aAgg[n] = aAgg[n] || { sum: 0, n: 0 }); aAgg[n].sum += w; aAgg[n].n++; }
        const h = Number(r.posted_hour);
        if (Number.isInteger(h)) { (hAgg[h] = hAgg[h] || { sum: 0, n: 0 }); hAgg[h].sum += w; hAgg[h].n++; }
    }
    const round2 = (x) => Math.round(x * 100) / 100;
    const perf = {}; for (const [k, v] of Object.entries(aAgg)) perf[k] = round2(v.sum / v.n);
    const hourPerf = {}; for (const [k, v] of Object.entries(hAgg)) hourPerf[k] = round2(v.sum / v.n);
    fs.writeFileSync(PERF_FILE, JSON.stringify(perf, null, 2));
    fs.writeFileSync(HOUR_FILE, JSON.stringify(hourPerf, null, 2));
    return { actresses: Object.keys(perf).length, hours: hourPerf };
}

(async () => {
    const site = d1('site');
    // テーブルが無い(まだ1件も投稿していない)場合は何もしない
    const have = await site.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name='x_post_metrics'`).catch(() => ({ rows: [] }));
    if (!have.rows.length) { console.log('x_post_metrics が未作成(まだ計測対象の投稿がありません)'); return; }

    // 計測対象: 実IDあり / 直近DAYS / 未計測 or 6h超経過
    const due = await site.execute({
        sql: `SELECT tweet_id, account, genre FROM x_post_metrics
              WHERE tweet_id GLOB '[0-9]*' AND posted_at >= datetime('now', ?)
                AND (checked_at IS NULL OR checked_at <= datetime('now','-6 hours'))
              ORDER BY posted_at DESC LIMIT 300`,
        args: [`-${DAYS} days`],
    });
    console.log(`計測対象: ${due.rows.length}件 (直近${DAYS}日)`);

    if (due.rows.length) {
        try { require.resolve('playwright'); }
        catch { throw new Error('playwright 未インストール。ルートで `npm install playwright` → `npx playwright install chromium`'); }
        // アカウントごとにまとめて(Cookieコンテキストを使い回す)
        const byAcct = {};
        for (const r of due.rows) (byAcct[r.account] = byAcct[r.account] || []).push(r);
        let total = 0;
        for (const [account, rows] of Object.entries(byAcct)) {
            console.log(`@${account}(${ACCOUNT_LABEL[account] || ''}) ${rows.length}件`);
            total += await runAccount(site, account, rows).catch((e) => { console.warn(`@${account} 中断: ${e.message}`); return 0; });
        }
        console.log(`\n計測更新: ${total}/${due.rows.length}件`);
    }

    // 女優別・時間帯別スコアを再生成(投稿側がこれを読んで並べ替え)
    const stat = await rebuildPerf(site);
    const topHours = Object.entries(stat.hours).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h, s]) => `${h}時:${s}`).join(' / ');
    console.log(`perf更新: 女優${stat.actresses}人 / 高反応の時間帯 ${topHours || '(データ不足)'}`);
    await notifyDiscord(`📊 X計測還流: 女優${stat.actresses}人のスコア更新。高反応の時間帯 → ${topHours || 'データ不足'}`);
})().catch(e => { console.error('❌ エラー:', e.message); process.exit(1); });
