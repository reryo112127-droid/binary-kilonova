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
 * Xの公開アルゴリズムに倣い weighted = replies*13.5 + reposts*1 + likes*0.5。
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
const weighted = (m) => (m.replies || 0) * 13.5 + (m.reposts || 0) * 1 + (m.likes || 0) * 0.5;

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
    const replies = await countFor('reply');
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

async function runAccount(browser, site, account, rows) {
    const auth = process.env[`XCK_${account}_AUTH_TOKEN`], ct0 = process.env[`XCK_${account}_CT0`];
    if (!auth || !ct0) { console.log(`@${account}: Cookie未設定のためskip (${rows.length}件)`); return 0; }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' });
    let updated = 0;
    try {
        const cookies = [];
        for (const dom of ['.x.com', '.twitter.com']) {
            cookies.push({ name: 'auth_token', value: auth, domain: dom, path: '/', secure: true, httpOnly: true });
            cookies.push({ name: 'ct0', value: ct0, domain: dom, path: '/', secure: true });
        }
        await ctx.addCookies(cookies);
        const page = await ctx.newPage();
        for (const r of rows) {
            const m = await scrapeTweet(page, String(r.tweet_id)).catch((e) => { console.warn(`  ✗ ${r.tweet_id}: ${e.message}`); return null; });
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
        await ctx.close().catch(() => {});
    }
    return updated;
}

// metrics 全体(直近DAYS)から女優別・時間帯別の平均加重エンゲージを再計算してJSON出力
async function rebuildPerf(site) {
    const rs = await site.execute({
        sql: `SELECT actresses, posted_hour, replies, reposts, likes FROM x_post_metrics WHERE posted_at >= datetime('now', ?) AND checked_at IS NOT NULL`,
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
        let chromium;
        try { ({ chromium } = require('playwright')); }
        catch { throw new Error('playwright 未インストール。ルートで `npm install playwright` → `npx playwright install chromium`'); }
        const browser = await chromium.launch({
            headless: !SHOW,
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer'],
        });
        // アカウントごとにまとめて(Cookieコンテキストを使い回す)
        const byAcct = {};
        for (const r of due.rows) (byAcct[r.account] = byAcct[r.account] || []).push(r);
        let total = 0;
        try {
            for (const [account, rows] of Object.entries(byAcct)) {
                console.log(`@${account}(${ACCOUNT_LABEL[account] || ''}) ${rows.length}件`);
                total += await runAccount(browser, site, account, rows);
            }
        } finally { await browser.close(); }
        console.log(`\n計測更新: ${total}/${due.rows.length}件`);
    }

    // 女優別・時間帯別スコアを再生成(投稿側がこれを読んで並べ替え)
    const stat = await rebuildPerf(site);
    const topHours = Object.entries(stat.hours).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h, s]) => `${h}時:${s}`).join(' / ');
    console.log(`perf更新: 女優${stat.actresses}人 / 高反応の時間帯 ${topHours || '(データ不足)'}`);
    await notifyDiscord(`📊 X計測還流: 女優${stat.actresses}人のスコア更新。高反応の時間帯 → ${topHours || 'データ不足'}`);
})().catch(e => { console.error('❌ エラー:', e.message); process.exit(1); });
