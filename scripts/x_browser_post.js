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
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const { d1, fanzaShards } = require('./lib/d1');
const jpeg = require('jpeg-js');
let ffmpegBin = null;
try { ffmpegBin = require('ffmpeg-static'); } catch { /* 動画編集はffmpeg-static未導入なら画像にフォールバック */ }

const SITE = 'https://avrankings.com';
const GENRE_ACCOUNT = { new: '005', sale: '004', vr: '007', collab: '002', anon: '008', lady: '006' };
const ACCOUNT_LABEL = { '005': '新作', '004': 'セール', '007': 'VR', '002': '共演', '008': '素人', '006': '人妻' };

// Discord通知(webhookは site/.env.local の DISCORD_WEBHOOK_URL から。未設定なら何もしない)
async function notifyDiscord(content) {
    const url = process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK;
    if (!url) { console.warn('  ⚠ DISCORD_WEBHOOK_URL 未設定のため通知スキップ'); return false; }
    try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
        if (r.status === 204 || r.ok) return true;
        console.warn('  ⚠ Discord通知失敗:', r.status); return false;
    } catch (e) { console.warn('  ⚠ Discord通知エラー:', e.message); return false; }
}
// Cookie失効アラート(同一アカウント6時間に1回まで。ログイン成功で解除)
const ALERT_FILE = path.join(__dirname, '..', 'data', 'x_cookie_alert.json');
// 女優別パフォーマンス(x_engagement_collect.js が生成。伸びる女優ほど高スコア)。承認キュー内の並べ替えに使う。
const PERF_FILE = path.join(__dirname, '..', 'data', 'x_actress_perf.json');
const loadAlerts = () => { try { return JSON.parse(fs.readFileSync(ALERT_FILE, 'utf-8')); } catch { return {}; } };
const saveAlerts = (a) => { try { fs.writeFileSync(ALERT_FILE, JSON.stringify(a)); } catch {} };
async function alertCookieExpired(account) {
    const a = loadAlerts(), now = Date.now();
    if (a[account] && now - a[account] < 6 * 3600000) return; // 直近6h以内に通知済みなら抑制
    const sent = await notifyDiscord(`⚠️ **X自動投稿: Cookie失効** @${account}（${ACCOUNT_LABEL[account] || ''}）\nアカウント ${account} のCookieが失効し、自動投稿できません。\n→ Xに再ログインして \`XCK_${account}_AUTH_TOKEN\` / \`XCK_${account}_CT0\` を取得し直し、\`site/.env.local\` を更新してください。`);
    if (sent) { a[account] = now; saveAlerts(a); } // 送信できた時だけ抑制(未設定/失敗時は次回リトライ)
}
function clearCookieAlert(account) {
    const a = loadAlerts();
    if (a[account]) { delete a[account]; saveAlerts(a); }
}
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
// 1枚目のサンプル画像URL(VR用)。FANZA videoa: pl.jpg → jp-1.jpg(本編1枚目, jp-001は2732bのプレースホルダ)
function firstSampleImage(u) {
    if (!u) return '';
    if (/\/digital\/video\/.*pl\.jpg$/.test(u)) return u.replace(/pl\.jpg$/, 'jp-1.jpg');
    return '';
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

// ─── 投稿文の動的生成（ルールベース） ───────────────────────────────
// Xは同一文の反復をスパム減点するため、固定3フレーズの使い回しをやめ、作品メタ
// (女優名/人数/割引率/配信日)から「固有名・数字・フック」入りの一文を毎回組み立てる。
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// 女優名の配列（#なし・slice なし。先頭/人数の判定に使う）
function actressNames(raw) {
    return String(raw || '').split(/[,、/／]+/).map(s => s.trim())
        .filter(n => n && n.length > 1 && !/\d+歳|[（()【】\[\]]/.test(n));
}
// 日付文字列(YYYY-MM-DD / YYYY/MM/DD 等)が「今日」かどうか
function isToday(dateStr) {
    const m = String(dateStr || '').match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (!m) return false;
    const now = new Date();
    return Number(m[1]) === now.getFullYear() && Number(m[2]) === now.getMonth() + 1 && Number(m[3]) === now.getDate();
}
// 1ポスト目のフック文。女優名・人数・割引・配信日を織り込む。素材が無い時は genre 既定フレーズ。
function buildHook(genre, p) {
    const names = actressNames(p.actresses);
    const a = names[0] || '';
    const pct = parseInt(p && p.discount_pct, 10) || 0;
    switch (genre) {
        case 'new': {
            const tag = isToday(p.sale_start_date) ? '【本日配信】' : '【新作】';
            if (a) return pick([
                `${tag}${a}の新作きた。これ待ってた人多いはず`,
                `${tag}${a}、第一印象めちゃくちゃ良い。今日チェックして`,
                `${tag}${a}の最新作。これは見逃せないやつ`,
            ]);
            return pick([`${tag}今日配信のこれ、第一印象がかなり良い`, `${tag}新作きた。完成度高い`]);
        }
        case 'sale': {
            const off = pct >= 1 ? `${pct}%OFF` : 'セール';
            if (a) return pick([
                `${a}の作品が今${off}。このタイミング逃すと損`,
                `${off}きた。${a}気になってた人は今のうち`,
            ]);
            return pick([`今${off}中。気になってたやつ今のうちに`, `${off}のお得情報。これはマジで買い`]);
        }
        case 'vr': {
            if (a) return pick([
                `${a}のVR、没入感やばすぎた。距離感バグる`,
                `${a}が目の前にいる感覚がリアルすぎるVR作品`,
            ]);
            return pick([`VRで見たら没入感やばすぎた`, `これVR持ってる人は絶対見て。距離感バグる`]);
        }
        case 'collab': {
            if (names.length >= 2) return pick([
                `${names[0]}×${names[1]}の共演、神すぎる…この組み合わせは今しかない`,
                `${names[0]}と${names[1]}が揃った。共演派にこれは刺さる`,
            ]);
            if (a) return `${a}の豪華共演作。この組み合わせは奇跡`;
            return pick([`この共演、神すぎる…`, `共演って奇跡だよね。この面子は今しかない`]);
        }
        case 'anon':
            return pick([`この素人感がリアルでめちゃくちゃ良い`, `ガチ感がすごい。演技じゃ出せないリアクション`, `隠れた名作見つけた。素人系の当たり`]);
        case 'lady': {
            if (a) return pick([`${a}の大人の色気、こういうことだよね`, `${a}、夜にゆっくり見てほしい一本`]);
            return pick([`大人の色気ってこういうことだよね`, `癒されたい夜にぴったりの一本`]);
        }
        default:
            return pick(PHRASES.new);
    }
}
// 2ポスト目に置く返信誘発の一言。Xは reply を最大級に重み付け(≒×13.5)するため会話のきっかけを作る。
const CTA = {
    new:   ['この女優の他のおすすめ作品あったら教えて', '気になった人はRT、感想はリプで'],
    sale:  ['気になってたやつあった？', 'セールで何買うか迷ってる人いる？'],
    vr:    ['VRゴーグル何使ってる？おすすめ教えて', 'VR派の人いる？'],
    collab:['単体派？共演派？', 'この共演どう？感想聞かせて'],
    anon:  ['素人系で当たり引いたことある？', 'ガチ系好きな人いる？'],
    lady:  ['こういう大人系もっと知りたい人いる？', '熟女・人妻好きな人RT'],
};
const replyCta = (genre) => pick(CTA[genre] || CTA.new);

// ─── エンゲージ計測の還流（女優別パフォーマンス） ───────────────────
// x_engagement_collect.js が書き出す女優→スコア表。無ければ空(=従来のFIFO順)。
function loadActressPerf() {
    try { return JSON.parse(fs.readFileSync(PERF_FILE, 'utf-8')) || {}; } catch { return {}; }
}
// 作品の出演女優のうち最も実績の高いスコア。候補の並べ替えに使う。
function actressScore(perf, actressesRaw) {
    let best = 0;
    for (const n of actressNames(actressesRaw)) { const v = perf[n]; if (typeof v === 'number' && v > best) best = v; }
    return best;
}
// 投稿実績テーブル(初回のみ作成)。投稿時にコンテキストを記録し、後で計測ジョブが指標を埋める。
async function ensureMetricsTable(site) {
    await site.execute(`CREATE TABLE IF NOT EXISTS x_post_metrics (
        tweet_id TEXT PRIMARY KEY,
        account TEXT, genre TEXT, product_id TEXT, actresses TEXT, hook TEXT,
        posted_hour INTEGER, posted_at TEXT,
        impressions INTEGER DEFAULT 0, likes INTEGER DEFAULT 0,
        replies INTEGER DEFAULT 0, reposts INTEGER DEFAULT 0,
        checked_at TEXT
    )`).catch(() => {});
}

// セールの下段表記: 割引率＋(あれば)終了日を「いつまで安いか」明記する。
// sale_end_date は FANZA='YYYY-MM-DD'/MGS='YYYY/MM/DD' 等まちまちなので正規表現でM/Dを抽出。
// 終了日がDBに無い(NULL)場合は割引率のみ。
function saleInfoLine(p) {
    const pct = parseInt(p && p.discount_pct, 10) || 0;
    const m = String((p && p.sale_end_date) || '').match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    const until = m ? ` ${Number(m[2])}/${Number(m[3])}まで` : '';
    if (pct >= 1) return `🔥${pct}%OFFセール中${until}`;
    return until ? `🔥セール中${until}` : '🔥セール中';
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
        // 動画の長さを取得(ffmpegのstderrから。ffmpeg-staticにffprobeは無い)
        let dsec = 0;
        try { execFileSync(ffmpegBin, ['-i', raw], { stdio: 'pipe' }); }
        catch (e) { const m = String(e.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/); if (m) dsec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]); }
        const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart'];
        const SEG = 4; // 1シーンの秒数
        if (dsec >= 20) {
            // 見栄え・テンポ重視: 30/50/70%地点から各SEG秒を抜き、繋いでダイジェスト(本編中盤〜後半なので女優も自然に写る)
            const starts = [0.30, 0.50, 0.70].map(p => Math.max(1, Math.round(dsec * p)));
            let fc = '', cc = '';
            starts.forEach((s, i) => {
                fc += `[0:v]trim=start=${s}:end=${s + SEG},setpts=PTS-STARTPTS,scale=720:-2,setsar=1[v${i}];`
                    + `[0:a]atrim=start=${s}:end=${s + SEG},asetpts=PTS-STARTPTS[a${i}];`;
                cc += `[v${i}][a${i}]`;
            });
            fc += `${cc}concat=n=${starts.length}:v=1:a=1[v][a]`;
            await execFileP(ffmpegBin, ['-y', '-i', raw, '-filter_complex', fc, '-map', '[v]', '-map', '[a]', ...ENC, out], { timeout: 180000 });
        } else {
            // 短い動画は中盤(30%)から10秒1カット
            const ss = String(Math.max(0, Math.round(dsec * 0.3)));
            await execFileP(ffmpegBin, ['-y', '-ss', ss, '-i', raw, '-t', '10', '-vf', 'scale=720:-2', ...ENC, out], { timeout: 120000 });
        }
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
    // 実ツイートIDをトーストの「表示」リンクから取得(計測に使う)。トーストは数秒で消えるので即座に拾う。
    let tweetId = '';
    if (ok && !scheduled) {
        const href = await page.locator('[data-testid="toast"] a[href*="/status/"]').first()
            .getAttribute('href', { timeout: 4000 }).catch(() => null);
        const m = href && href.match(/status\/(\d+)/);
        if (m) tweetId = m[1];
    }
    if (!ok) ok = !(await page.locator('[data-testid="tweetTextarea_0"]').first().isVisible().catch(() => true));
    return { ok, scheduled, tweetId };
}

// account -> 担当ジャンル一覧（GENRE_ACCOUNTの逆引き）
const ACCOUNT_GENRES = {};
for (const [g, a] of Object.entries(GENRE_ACCOUNT)) (ACCOUNT_GENRES[a] = ACCOUNT_GENRES[a] || []).push(g);

// 指定アカウントの担当ジャンルの未投稿作品から、文＋画像を準備
async function prepareItems(site, account, batch, dir) {
    const genres = ACCOUNT_GENRES[account] || [];
    if (!genres.length) return [];
    const ph = genres.map(() => '?').join(',');
    // Now Printing をスキップする分、多めに取得して batch 件そろうまで回す。
    // 単純な decided_at ASC の FIFO だと、FANZAの巨大な滞留(例: lady は FANZA 3,131件が
    // MGS 149件より前に積まれている)に阻まれて MGS が候補ウィンドウに一生入らず、
    // 「MGS動画の作品が投稿されない」状態になる。→ プラットフォーム別に同数ずつ取り、
    // 交互に並べてから実績スコアで並べ替えることで MGS に必ず枠を確保する。
    // MGS品番は必ず '-' を含み、FANZAのcontent_idは含まない(承認キュー13,858件で検証済み)。
    const want = batch * 6;
    const perPf = Math.max(1, Math.ceil(want / 2));
    const pick = async (pfCond) => (await site.execute({
        sql: `SELECT id, product_id, new_genre FROM x_post_decisions
              WHERE decision='approve' AND posted_at IS NULL AND new_genre IN (${ph}) AND ${pfCond}
              ORDER BY decided_at ASC LIMIT ?`,
        args: [...genres, perPf],
    }).catch(() => ({ rows: [] }))).rows;
    const mgsRows = await pick(`product_id GLOB '*-*'`);
    const fzRows  = await pick(`product_id NOT GLOB '*-*'`);
    // 交互マージ(片方が尽きたらもう片方で埋める=片PFしか無いジャンルは従来どおり)
    const merged = [];
    for (let i = 0; i < Math.max(mgsRows.length, fzRows.length) && merged.length < want; i++) {
        if (i < mgsRows.length && merged.length < want) merged.push(mgsRows[i]);
        if (i < fzRows.length  && merged.length < want) merged.push(fzRows[i]);
    }
    const dec = { rows: merged };
    // 候補の作品メタを先読みし、過去実績の高い女優を優先(枯渇防止のため候補は承認キュー内に限定)。
    // 同点は元のFIFO順(decided_at ASC)を維持。実績データが無い初期は全員0=従来どおりFIFO。
    const perf = loadActressPerf();
    const cands = [];
    for (let idx = 0; idx < dec.rows.length; idx++) {
        const d = dec.rows[idx];
        const pid = String(d.product_id), genre = String(d.new_genre || 'new');
        const sel = `SELECT title, actresses, main_image_url, sample_video_url, discount_pct, sale_start_date, sale_end_date FROM products WHERE product_id=? LIMIT 1`;
        let pr = await d1('mgs').execute({ sql: sel, args: [pid] }).catch(() => ({ rows: [] }));
        if (!pr.rows.length) pr = await fanzaShards().execute({ sql: sel, args: [pid] }).catch(() => ({ rows: [] }));
        if (!pr.rows.length) continue;
        cands.push({ d, pid, genre, p: pr.rows[0], idx, score: actressScore(perf, pr.rows[0].actresses) });
    }
    cands.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));

    const items = [];
    for (const c of cands) {
        if (items.length >= batch) break;
        const { d, pid, genre, p } = c;
        // ツリー型: 1ポスト目=動的フック文＋(サンプル動画 or 画像) / 2ポスト目(リプライ)=セール情報＋返信CTA＋女優ハッシュタグ＋URL
        const text1 = buildHook(genre, p);
        // セールジャンルは下段に割引率と終了日を明記(終了日がDBにあれば「〜M/Dまで」、無ければ割引率のみ)
        const saleLine = genre === 'sale' ? saleInfoLine(p) : '';
        // 返信誘発のCTA(reply は最大級の重み)。本文URLの減点を避けるためURLは2ポスト目のまま。
        const text2 = [saleLine, replyCta(genre), actressTags(String(p.actresses || '')), `${SITE}/product/${pid}`].filter(Boolean).join('\n');
        const safe = pid.replace(/[^a-zA-Z0-9_-]/g, '_');
        let videoPath = '', imgPath = '';
        if (genre === 'vr') {
            // VRは動画(VR形式は平面で歪む)を使わず、パッケージでもなく「1枚目のサンプル画像」を投稿
            const su = firstSampleImage(String(p.main_image_url || '')) || posterUrl(String(p.main_image_url || ''));
            if (su) {
                try {
                    const r = await fetch(su, { headers: { Referer: 'https://www.dmm.co.jp/' } });
                    if (r.ok) {
                        const raw = Buffer.from(await r.arrayBuffer());
                        if (isNowPrinting(raw)) { console.log(`  - skip(Now Printing): [${genre}] ${pid}`); continue; }
                        imgPath = path.join(dir, `${account}_${safe}.jpg`);
                        fs.writeFileSync(imgPath, toPortrait(raw));
                    }
                } catch (e) { console.warn('VRサンプル画像取得失敗:', pid, e.message); }
            }
            if (!imgPath) continue; // サンプル画像が取れなければ次の作品へ
        } else {
            // VR以外はサンプル動画のみ投稿。動画が取れない作品はスキップ(パッケージ画像へはフォールバックしない)
            videoPath = await makeSampleClip(pid, String(p.sample_video_url || ''), account, dir);
            if (!videoPath) { console.log(`  - skip(サンプル動画なし): [${genre}] ${pid}`); continue; }
        }
        items.push({ id: d.id, pid, genre, text1, text2, videoPath, imgPath, actresses: String(p.actresses || '') });
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
        if (/\/(login|i\/flow\/login)/.test(page.url())) {
            await alertCookieExpired(account); // Cookie失効 → Discord通知(6h抑制)
            throw new Error('Cookieでログインできていません（再取得が必要）');
        }
        clearCookieAlert(account); // ログイン成功 → 失効フラグ解除(次回失効時に再通知できるよう)
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
                const tid = res.tweetId || (res.scheduled ? 'scheduled' : 'browser');
                await site.execute({ sql: `UPDATE x_post_decisions SET posted_at=datetime('now'), tweet_id=? WHERE id=?`, args: [tid, it.id] });
                // 実IDが取れた即時投稿のみ計測対象として記録(予約は live IDが無いので除外)
                if (res.tweetId) {
                    await site.execute({
                        sql: `INSERT OR IGNORE INTO x_post_metrics (tweet_id, account, genre, product_id, actresses, hook, posted_hour, posted_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
                        args: [res.tweetId, account, it.genre, it.pid, it.actresses || '', it.text1, new Date().getHours()],
                    }).catch(() => {});
                }
                console.log(`  ✅ ${it.pid} ${res.scheduled ? '予約' : '投稿'}完了${res.tweetId ? ` (id:${res.tweetId})` : ''}`);
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
    // 時間帯の重み付け: ゴールデンタイム(22-26時=22,23,0,1時JST)は初速が伸びやすいので1回あたりの投稿数を増やす。
    // --batch 明示時はそれを優先。投稿の発火間隔自体はタスクスケジューラ(2時間毎)が制御する。
    const PRIMETIME_HOURS = [22, 23, 0, 1];
    const batchArg = arg('batch');
    const batch = batchArg ? Math.max(1, parseInt(batchArg, 10) || 1)
        : (PRIMETIME_HOURS.includes(new Date().getHours()) ? 2 : 1);
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
        plan.forEach(p => {
            console.log(`@${p.account}: ${p.items.length ? '' : 'なし'}`);
            p.items.forEach(it => {
                console.log(`  ┌ [${it.genre}] ${it.pid}${it.videoPath ? ' (動画)' : it.imgPath ? ' (画像)' : ''}`);
                console.log(`  │ ①: ${it.text1}`);
                console.log(`  └ ②: ${String(it.text2).replace(/\n/g, ' / ')}`);
                for (const f of [it.imgPath, it.videoPath]) if (f) try { fs.unlinkSync(f); } catch {}
            });
        });
        console.log('[DRY RUN] 終了'); return;
    }
    await ensureMetricsTable(site); // 投稿実績テーブルを用意(計測の還流ループ用)

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
