/**
 * X(Twitter) 自動投稿ツール（実ブラウザ自動操作 / Playwright）
 * 本物のChromiumでXを開き、Cookieでログイン→投稿画面で文＋画像を入れて投稿する。
 * Xの防bot対策(transaction-id等)はブラウザのJSが自動生成するので code 32 を回避できる。
 * ⚠️ 自動化はX規約上グレー・凍結リスクあり。まず1アカウントで検証すること。
 *
 * 事前準備:
 *   1) npm install playwright        （ルートで）
 *   2) npx playwright install chromium
 *   3) site/.env.local に Cookie:  XCK_005_AUTH_TOKEN=... / XCK_005_CT0=...
 *
 * 利用:
 *   node scripts/x_browser_post.js --account=005           # 1件投稿(ヘッドレス)
 *   node scripts/x_browser_post.js --account=005 --show    # ブラウザを表示して投稿(デバッグ)
 *   node scripts/x_browser_post.js --account=005 --dry-run # 文/画像の準備だけ
 */
require('dotenv').config({ path: './site/.env.local' });
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const { d1, fanzaShards } = require('./lib/d1');
const jpeg = require('jpeg-js');
let ffmpegBin = null;
try { ffmpegBin = require('ffmpeg-static'); } catch { /* 動画編集はffmpeg-static未導入なら画像にフォールバック */ }

const SITE = 'https://avrankings.com';
const GENRE_ACCOUNT = { new: '005', sale: '004', vr: '007', collab: '002', anon: '008', lady: '006' };
const PHRASES = {
    new:   ['新作きた！これ絶対チェックして', '今日配信開始のやつ。第一印象めちゃくちゃ良い', 'ついに出た…！待ってた人多いでしょこれ'],
    sale:  ['今セール中だから今のうちに！', 'このタイミング逃したらもったいない。お得すぎ', 'セール情報きた！これはマジで買い'],
    vr:    ['VRで見たら没入感やばすぎた', 'これVR持ってる人は絶対見て。距離感バグる', '目の前にいる感覚がリアルすぎる'],
    collab:['この組み合わせ、神すぎる…', '共演って奇跡だよね。この二人が揃ったのは今しかない', '単体より共演派にこれは刺さる'],
    anon:  ['この素人感がリアルでめちゃくちゃ良い', 'ガチ感がすごい。演技じゃ出せないリアクション', '隠れた名作見つけた'],
    lady:  ['大人の色気ってこういうことだよね', '夜にゆっくり見てほしい。雰囲気が良い', '癒されたい夜にぴったりの一本'],
};
const arg = (k) => { const a = process.argv.find(x => x.startsWith('--' + k)); return a ? (a.split('=')[1] ?? true) : null; };
const SHOW = process.argv.includes('--show');
const DRY = process.argv.includes('--dry-run');

function posterUrl(u) {
    if (!u) return '';
    if (u.includes('pb_e_')) return u.replace('pb_e_', 'pf_e_');
    if (u.includes('/digital/amateur/') && u.endsWith('jm.jpg')) return u.replace('jm.jpg', 'jp-001.jpg');
    return u;
}
function toPortrait(buf) {
    if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return buf;
    try {
        const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
        const w = img.width, h = img.height, data = img.data;
        if (!w || !h || h >= w) return buf;
        const nw = Math.max(40, Math.round(h * 0.7)), x0 = Math.round((w - nw) / 2);
        const out = new Uint8Array(nw * h * 4);
        for (let y = 0; y < h; y++) { const sr = y * w, dr = y * nw;
            for (let x = 0; x < nw; x++) { const si = (sr + x + x0) * 4, di = (dr + x) * 4;
                out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255; } }
        return Buffer.from(jpeg.encode({ data: out, width: nw, height: h }, 92).data);
    } catch { return buf; }
}
// FANZAの「Now Printing」プレースホルダ(=表紙未完成)を判定。標準サイズ 590x800。実パッケージはこのサイズにならない
function isNowPrinting(buf) {
    try {
        if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return false;
        const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
        return img.width === 590 && img.height === 800;
    } catch { return false; }
}
function actressTags(raw) {
    return String(raw || '').split(/[,、/／]+/).map(s => s.trim())
        .filter(n => n && n.length > 1 && !/\d+歳|[（()【】\[\]]/.test(n))
        .slice(0, 3).map(n => '#' + n.replace(/\s+/g, '_')).join(' ');
}

// 予約日時をセット（Xのカレンダー(予約)機能）。when=Date。失敗時はfalse。
async function setSchedule(page, when) {
    await page.locator('[data-testid="scheduleOption"]').first().click();
    await page.waitForTimeout(2000);
    const M = when.getMonth() + 1, D = when.getDate(), Y = when.getFullYear();
    let H = when.getHours(); const AP = H >= 12 ? 'PM' : 'AM'; const H12 = (H % 12) || 12;
    const MIN = when.getMinutes();
    const monthName = when.toLocaleString('en-US', { month: 'long' });
    async function setSel(name, ...candidates) {
        const sel = page.getByRole('combobox', { name }).first();
        for (const c of candidates) {
            try { await sel.selectOption({ label: String(c) }); return true; } catch {}
            try { await sel.selectOption(String(c)); return true; } catch {}
        }
        return false;
    }
    await setSel('Month', monthName, M, M - 1);
    await setSel('Day', D);
    await setSel('Year', Y);
    await setSel('Hour', H12, String(H12).padStart(2, '0'));
    await setSel('Minute', String(MIN).padStart(2, '0'), MIN);
    await setSel('AM/PM', AP);
    await page.waitForTimeout(600);
    const confirm = page.locator('[data-testid="scheduledConfirmationPrimaryAction"]').first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    else await page.getByRole('button', { name: /Confirm|確認|設定|Update|完了/i }).first().click().catch(() => {});
    await page.waitForTimeout(1800);
    return true;
}

// goto（タスクスケジューラ実行時に稀に net::ERR_ABORTED が出るのでリトライ）
async function gotoRetry(page, url, tries = 3) {
    let last;
    for (let t = 0; t < tries; t++) {
        try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); return; }
        catch (e) { last = e; await page.waitForTimeout(2000); }
    }
    throw last;
}

// サンプル動画 → 実mp4(本番リゾルバ経由)をDLし、5秒目から10秒(=5〜15秒)を切り出してX互換に再エンコード。
// FANZA(litevideo)もMGS(sampleplayer)も対応。冒頭のタイトル/ロゴを避けて5秒スキップ。失敗時 null（→画像）。
async function makeSampleClip(pid, sampleUrl, account, dir) {
    if (!ffmpegBin || !sampleUrl) return null;
    const isFanza = /dmm\.co\.jp/.test(sampleUrl);
    const isMgs = /mgstage\.com\/sampleplayer/.test(sampleUrl);
    if (!isFanza && !isMgs) return null;
    const api = isFanza ? '/api/fanza-video' : '/api/mgs-video';
    const ref = isFanza ? 'https://www.dmm.co.jp/' : 'https://www.mgstage.com/';
    const safe = pid.replace(/[^a-zA-Z0-9_-]/g, '_');
    const raw = path.join(dir, `${account}_${safe}_src.mp4`);
    const out = path.join(dir, `${account}_${safe}.mp4`);
    try {
        // litevideo/sampleplayer → mp4 は本番API経由で解決（ローカル直リゾルブは各サイトにブロックされる）
        const j = await fetch(`${SITE}${api}?url=` + encodeURIComponent(sampleUrl)).then(r => r.json()).catch(() => null);
        if (!j || !j.mp4) return null;
        const dl = j.mp4.startsWith('http') ? j.mp4 : `${SITE}${j.mp4}`; // MGSはproxy相対URLのことがある
        const vr = await fetch(dl, { headers: { Referer: ref } });
        if (!vr.ok) return null;
        fs.writeFileSync(raw, Buffer.from(await vr.arrayBuffer()));
        // 切り出し位置: FANZAは冒頭にタイトルカードが出るので5秒目から10秒(5〜15秒)。MGSは冒頭5秒(0〜5秒)。
        const ss = isFanza ? '5' : '0';
        const dur = isFanza ? '10' : '5';
        await execFileP(ffmpegBin, ['-y', '-ss', ss, '-i', raw, '-t', dur,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '96k', '-vf', 'scale=720:-2', '-movflags', '+faststart', out],
            { timeout: 120000 });
        try { fs.unlinkSync(raw); } catch {}
        return fs.existsSync(out) && fs.statSync(out).size > 1000 ? out : null;
    } catch (e) { console.warn('動画編集失敗:', pid, e.message); try { fs.unlinkSync(raw); } catch {} return null; }
}

// 動画アップロード後、Xの変換完了(進捗バー消滅)を待つ。完了しないと投稿でメディアが付かない/拒否される。
async function waitVideoReady(page, timeout = 90000) {
    const start = Date.now();
    // まず進捗バーの出現を少し待つ（出ないまま即完了の場合もある）
    await page.locator('[role="progressbar"]').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    while (Date.now() - start < timeout) {
        const busy = await page.locator('[role="progressbar"]').count().catch(() => 0);
        if (!busy) { await page.waitForTimeout(2000); return; }
        await page.waitForTimeout(2000);
    }
}

// コンポーザのテキスト欄に入力（_label ではなく contenteditable 本体を狙う。マスク遮蔽時は force）
async function fillBox(page, idx, text) {
    const box = page.locator(`[data-testid="tweetTextarea_${idx}"]`).first();
    await box.waitFor({ state: 'visible', timeout: 20000 });
    await box.click({ timeout: 8000 }).catch(async () => { await box.click({ force: true }); });
    await page.keyboard.insertText(text);
    await page.waitForTimeout(900);
}

// 1作品をツリー型(本文＋画像 / リプライにURL)でコンポーズして投稿(または予約)。成功でtrue。
async function composeOne(page, item, scheduleAt) {
    await gotoRetry(page, 'https://x.com/compose/post');
    await page.waitForTimeout(1500);
    // 1ポスト目: 紹介文（ハッシュタグは2ポスト目へ）＋ サンプル動画 or パッケージ画像
    await fillBox(page, 0, item.text1);
    const mediaPath = item.videoPath || item.imgPath;
    if (mediaPath) {
        await page.locator('input[type="file"]').first().setInputFiles(mediaPath).catch(() => {});
        if (item.videoPath) {
            await page.locator('[data-testid="attachments"], video, div[aria-label*="メディア"]').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
            await waitVideoReady(page); // Xの動画変換完了まで待つ
        } else {
            await page.locator('[data-testid="attachments"], img[alt*="Image"], div[aria-label*="メディア"]').first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(3500);
        }
    }
    // 2ポスト目(ツリー): サイトURL を追加（画像アップ中はクリックが弾かれるので 2件目が出るまでリトライ）
    if (item.text2) {
        let added = false;
        for (let t = 0; t < 5 && !added; t++) {
            const add = page.locator('[data-testid="addButton"]').first();
            await add.scrollIntoViewIfNeeded().catch(() => {});
            await add.click({ timeout: 6000 }).catch(async () => { await add.click({ force: true }).catch(() => {}); });
            added = await page.locator('[data-testid="tweetTextarea_1"]').first()
                .waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
        }
        if (!added) throw new Error('ツリー2件目(URL)の追加に失敗');
        await fillBox(page, 1, item.text2);
        await page.waitForTimeout(800);
    }
    // Xはツリー(複数ポスト)の予約を許可しない（Scheduleボタンがdisabledになる）。
    // 予約指定でも、予約ボタンが無効なら即時投稿にフォールバックする。
    let scheduled = false;
    if (scheduleAt) {
        const schedBtn = page.locator('[data-testid="scheduleOption"]').first();
        const canSchedule = await schedBtn.isEnabled().catch(() => false);
        if (!canSchedule) {
            console.warn('  ⚠ ツリー型はX予約不可のため即時投稿します（時間調整はタスクスケジューラ側で）');
        } else {
            await setSchedule(page, scheduleAt);
            const btnText = await page.locator('[data-testid="tweetButton"]').first().innerText().catch(() => '');
            if (!/schedul|予約/i.test(btnText)) throw new Error('予約が反映されていません（ボタン:"' + btnText.trim() + '"）— 即時投稿を回避して中止');
            scheduled = true;
        }
    }
    const btn = page.locator('[data-testid="tweetButton"]').first();
    await btn.waitFor({ state: 'visible', timeout: 15000 });
    await btn.click();
    const toast = page.locator('[data-testid="toast"]');
    let ok = await toast.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
    if (!ok) ok = !(await page.locator('[data-testid="tweetTextarea_0"]').first().isVisible().catch(() => true));
    return { ok, scheduled };
}

// account -> 担当ジャンル一覧（GENRE_ACCOUNTの逆引き）
const ACCOUNT_GENRES = {};
for (const [g, a] of Object.entries(GENRE_ACCOUNT)) (ACCOUNT_GENRES[a] = ACCOUNT_GENRES[a] || []).push(g);

// 指定アカウントの担当ジャンルの未投稿作品から、文＋画像を準備
async function prepareItems(site, account, batch, dir) {
    const genres = ACCOUNT_GENRES[account] || [];
    if (!genres.length) return [];
    const ph = genres.map(() => '?').join(',');
    // Now Printing をスキップする分、多めに取得して batch 件そろうまで回す
    const dec = await site.execute({
        sql: `SELECT id, product_id, new_genre FROM x_post_decisions WHERE decision='approve' AND posted_at IS NULL AND new_genre IN (${ph}) ORDER BY decided_at ASC LIMIT ?`,
        args: [...genres, batch * 6],
    });
    const items = [];
    for (const d of dec.rows) {
        if (items.length >= batch) break;
        const pid = String(d.product_id), genre = String(d.new_genre || 'new');
        const sel = `SELECT title, actresses, main_image_url, sample_video_url FROM products WHERE product_id=? LIMIT 1`;
        let pr = await d1('mgs').execute({ sql: sel, args: [pid] }).catch(() => ({ rows: [] }));
        if (!pr.rows.length) pr = await fanzaShards().execute({ sql: sel, args: [pid] }).catch(() => ({ rows: [] }));
        if (!pr.rows.length) continue;
        const p = pr.rows[0];
        const phrase = PHRASES[genre] ? PHRASES[genre][Math.floor(Math.random() * PHRASES[genre].length)] : PHRASES.new[0];
        // ツリー型: 1ポスト目=紹介文＋(サンプル動画 or 画像) / 2ポスト目(リプライ)=女優ハッシュタグ＋URL
        const text1 = phrase;
        const text2 = [actressTags(String(p.actresses || '')), `${SITE}/product/${pid}`].filter(Boolean).join('\n');
        // まずサンプル動画(FANZA)を5〜15秒に編集。取れなければパッケージ画像にフォールバック
        let videoPath = await makeSampleClip(pid, String(p.sample_video_url || ''), account, dir);
        let imgPath = '';
        if (!videoPath) {
            const iurl = posterUrl(String(p.main_image_url || ''));
            if (iurl) {
                try {
                    const r = await fetch(iurl);
                    if (r.ok) {
                        const raw = Buffer.from(await r.arrayBuffer());
                        // 表紙未完成(Now Printing)はパッケージとして投稿しない→この作品はスキップ(次へ)
                        if (isNowPrinting(raw)) { console.log(`  - skip(Now Printing): [${genre}] ${pid}`); continue; }
                        imgPath = path.join(dir, `${account}_${pid.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`);
                        fs.writeFileSync(imgPath, toPortrait(raw));
                    }
                } catch (e) { console.warn('画像取得失敗:', pid, e.message); }
            }
        }
        items.push({ id: d.id, pid, genre, text1, text2, videoPath, imgPath });
    }
    return items;
}

// 1アカウント分を投稿（browserは共有、contextはアカウントごとに分離）
async function runAccount(browser, site, account, opts) {
    const { items, immediate, firstH, everyH, dir } = opts;
    const auth = process.env[`XCK_${account}_AUTH_TOKEN`], ct0 = process.env[`XCK_${account}_CT0`];
    if (!auth || !ct0) { console.log(`@${account}: Cookie未設定のためskip`); return 0; }
    if (!items.length) { console.log(`@${account}: 対象なし`); return 0; }
    console.log(`@${account} 対象${items.length}件 / ${immediate ? '即時投稿' : `予約(最初${firstH}h後・${everyH}h間隔)`}`);
    items.forEach((it, i) => console.log(`  ${i + 1}. [${it.genre}] ${it.pid}`));

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' });
    let done = 0;
    try {
        const cookies = [];
        for (const dom of ['.x.com', '.twitter.com']) {
            cookies.push({ name: 'auth_token', value: auth, domain: dom, path: '/', secure: true, httpOnly: true });
            cookies.push({ name: 'ct0', value: ct0, domain: dom, path: '/', secure: true });
        }
        await ctx.addCookies(cookies);
        const page = await ctx.newPage();
        await gotoRetry(page, 'https://x.com/home');
        await page.waitForTimeout(3000);
        if (/\/(login|i\/flow\/login)/.test(page.url())) throw new Error('Cookieでログインできていません（再取得が必要）');
        await page.getByRole('button', { name: /Got it|閉じる|OK/i }).first().click({ timeout: 3000 }).catch(() => {});

        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const when = immediate ? null : new Date(Date.now() + (firstH + i * everyH) * 3600000);
            const res = await composeOne(page, it, when).catch(async (e) => {
                const shot = path.join(dir, `fail_${account}_${Date.now()}.png`);
                await page.screenshot({ path: shot }).catch(() => {});
                console.warn(`  ✗ ${it.pid} 失敗: ${e.message}（${shot}）`); return { ok: false, scheduled: false };
            });
            if (res.ok) {
                done++;
                await site.execute({ sql: `UPDATE x_post_decisions SET posted_at=datetime('now'), tweet_id=? WHERE id=?`, args: [res.scheduled ? 'scheduled' : 'browser', it.id] });
                console.log(`  ✅ ${it.pid} ${res.scheduled ? '予約' : '投稿'}完了`);
            } else {
                const shot = path.join(dir, `fail_${account}_${it.pid}_${Date.now()}.png`);
                await page.screenshot({ path: shot }).catch(() => {});
                console.warn(`  ✗ ${it.pid} 完了判定できず（${shot}）`);
            }
            await page.waitForTimeout(2500 + Math.random() * 2500);
        }
    } finally {
        await ctx.close().catch(() => {});
        items.forEach(it => { for (const f of [it.imgPath, it.videoPath]) if (f) try { fs.unlinkSync(f); } catch {} });
    }
    return done;
}

(async () => {
    const site = d1('site');
    const batch = Math.max(1, parseInt(arg('batch') || '1', 10) || 1);
    const everyH = parseFloat(arg('every') || '2') || 2;
    const firstH = parseFloat(arg('first') || '2') || 2;
    const immediate = process.argv.includes('--now');
    // --all で全アカウント、未指定は --account（既定005）
    const all = process.argv.includes('--all');
    const accounts = all
        ? Object.keys(ACCOUNT_GENRES).filter(a => process.env[`XCK_${a}_AUTH_TOKEN`] && process.env[`XCK_${a}_CT0`])
        : [arg('account') || '005'];

    const dir = path.join(__dirname, '..', 'data', 'x_tmp');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // 全アカウント分の対象を先に準備（DRYならここまで）
    const plan = [];
    for (const account of accounts) {
        const items = await prepareItems(site, account, batch, dir);
        plan.push({ account, items });
    }
    const total = plan.reduce((n, p) => n + p.items.length, 0);
    if (!total) { console.log('X未投稿の承認作品がありません（x_queue_fill.js でキュー補充を）'); return; }
    if (DRY) {
        plan.forEach(p => { console.log(`@${p.account}: ${p.items.map(it => `[${it.genre}]${it.pid}${it.videoPath ? '(動画)' : ''}`).join(', ') || 'なし'}`); p.items.forEach(it => { for (const f of [it.imgPath, it.videoPath]) if (f) try { fs.unlinkSync(f); } catch {} }); });
        console.log('[DRY RUN] 終了'); return;
    }

    let chromium;
    try { ({ chromium } = require('playwright')); }
    catch { throw new Error('playwright 未インストール。ルートで `npm install playwright` → `npx playwright install chromium`'); }

    // タスクスケジューラ等のバックグラウンドセッションで "Page crashed" を防ぐ安定化フラグ
    const browser = await chromium.launch({
        headless: !SHOW,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer'],
    });
    let grand = 0;
    try {
        for (const p of plan) {
            grand += await runAccount(browser, site, p.account, { items: p.items, immediate, firstH, everyH, dir });
        }
    } finally {
        await browser.close();
    }
    console.log(`\n総完了: ${grand}/${total} 件`);
})().catch(e => { console.error('❌ エラー:', e.message); process.exit(1); });
