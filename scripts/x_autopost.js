/**
 * X (Twitter) 自動投稿スクリプト — v3 (管理画面キュー対応)
 *
 * 管理画面（/admin/x-post）で承認された作品を順番にX投稿する。
 * x_post_decisions テーブルの decision='approve' かつ posted_at IS NULL を処理。
 *
 * 利用方法:
 *   node scripts/x_autopost.js                      # キューから1件投稿
 *   node scripts/x_autopost.js --dry-run            # 投稿シミュレーション
 *   node scripts/x_autopost.js --account=desireav-005  # アカウント固定
 */

require('dotenv').config({ path: './site/.env.local' });
const { d1, fanzaShards } = require('./lib/d1');
const { TwitterApi } = require('twitter-api-v2');
const { rewritePhrase } = require('../lib/gemini_rewrite');
const jpeg = require('jpeg-js');

// ── シャドウバン対策: パッケージ画像を加工してハッシュを変える ──
// MGSは pb_e_(裏)→pf_e_(表紙) に変換してから使う
function posterUrl(url) {
    if (!url) return '';
    if (url.includes('pb_e_')) return url.replace('pb_e_', 'pf_e_');
    if (url.includes('/digital/amateur/') && url.endsWith('jm.jpg')) return url.replace('jm.jpg', 'jp-001.jpg');
    return url;
}
function uniquifyJpeg(buf) {
    if (buf.length < 2 || buf[0] !== 0xFF || buf[1] !== 0xD8) return buf;
    const c = Buffer.from('av-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), 'utf8');
    const len = c.length + 2;
    if (len > 0xFFFF) return buf;
    const seg = Buffer.concat([Buffer.from([0xFF, 0xFE, (len >> 8) & 0xFF, len & 0xFF]), c]);
    return Buffer.concat([buf.subarray(0, 2), seg, buf.subarray(2)]);
}
// 端を約3%クロップ＋品質ランダムで再エンコード → ファイル/知覚ハッシュを変える
function processPosterForX(buf) {
    if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return buf;
    try {
        const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
        const w = img.width, h = img.height, data = img.data;
        if (!w || !h) return uniquifyJpeg(buf);
        const cx = Math.max(2, Math.round(w * 0.03)), cy = Math.max(2, Math.round(h * 0.03));
        const nw = w - cx * 2, nh = h - cy * 2;
        if (nw < 80 || nh < 80) return uniquifyJpeg(buf);
        const out = new Uint8Array(nw * nh * 4);
        for (let y = 0; y < nh; y++) {
            const sr = (y + cy) * w, dr = y * nw;
            for (let x = 0; x < nw; x++) {
                const si = (sr + x + cx) * 4, di = (dr + x) * 4;
                out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255;
            }
        }
        const q = 78 + Math.floor(Math.random() * 8);
        const enc = jpeg.encode({ data: out, width: nw, height: nh }, q);
        return Buffer.from(enc.data);
    } catch {
        return uniquifyJpeg(buf);
    }
}

// ==============================
// 設定
// ==============================

const SITE_BASE_URL = 'https://avrankings.com';

// ジャンル → 投稿アカウント対応表
const GENRE_ACCOUNT_MAP = {
    new:     'desireav-005',
    sale:    'desireav-004',
    vr:      'desireav-007',
    collab:  'desireav-002',
    anon:    'desireav-008',
    lady:    'desireav-006',
    ranking: 'desireav-001',
};

// ジャンル → ツイートフレーズ
const GENRE_PHRASES = {
    new: [
        '新作きた！！これ絶対チェックして',
        '今日配信開始のやつ。第一印象めちゃくちゃ良い✨',
        'ついに出た…！待ってた人多いでしょこれ',
    ],
    sale: [
        '今セール中だから今のうちにチェックしといて！',
        'このタイミング逃したらもったいない。お得すぎる',
        'セール情報きた！これはマジで買い。迷ってる暇ないやつ',
    ],
    vr: [
        'VRで見たら没入感やばすぎて現実に戻れなくなった笑',
        'これVR持ってる人は絶対見て。距離感バグるよ',
        '目の前にいる感覚がリアルすぎて心臓止まるかと思った',
    ],
    collab: [
        'この組み合わせ、神すぎる…二人いるだけで空気が変わる',
        '共演って奇跡だよね。この二人が揃ったのは今しかない',
        '単体より共演の方が好きな人、これは絶対刺さるやつ',
    ],
    anon: [
        'この素人感がリアルでめちゃくちゃ良いんだよ…',
        'ガチ感がすごい。演技じゃ絶対出せないリアクション',
        'これ見つけた時テンション上がった。隠れた名作だよ',
    ],
    lady: [
        '大人の色気ってこういうことだよね…最高だった',
        '夜にゆっくり見てほしい。雰囲気が本当に良い',
        '癒されたい夜にぴったり。しっとり系の名作👑',
    ],
    ranking: [
        'これランキング上位に入るやつだから間違いない',
        'みんなが選んだ作品には理由がある。見てみて',
        '評価数えぐいやつ。納得の内容だった',
    ],
};

// ==============================
// Tursoクライアント
// ==============================

function getSiteClient() {
    return d1('site');
}

function getFanzaClient() {
    return fanzaShards();
}

// ==============================
// X APIクライアント
// ==============================

function getTwitterClient(account) {
    const key = account.toUpperCase().replace(/-/g, '_');
    const appKey      = process.env[`${key}_APP_KEY`];
    const appSecret   = process.env[`${key}_APP_SECRET`];
    const accessToken = process.env[`${key}_ACCESS_TOKEN`];
    const accessSecret = process.env[`${key}_ACCESS_SECRET`];

    if (!appKey || !appSecret || !accessToken || !accessSecret) {
        throw new Error(
            `${account} のX API認証情報が .env.local に未設定です。\n` +
            `必要な変数: ${key}_APP_KEY, ${key}_APP_SECRET, ${key}_ACCESS_TOKEN, ${key}_ACCESS_SECRET`
        );
    }
    return new TwitterApi({ appKey, appSecret, accessToken, accessSecret });
}

// ==============================
// URL・テキスト生成
// ==============================

function buildCushionUrl(productId) {
    // 作品詳細URL（/product/[id] はMGS/FANZA両方のidを解決する）
    return `${SITE_BASE_URL}/product/${productId}`;
}

function buildActressHashtags(actressesRaw) {
    if (!actressesRaw || !actressesRaw.trim()) return '';
    const names = actressesRaw.split(/[\s,、/／]+/).map(n => n.trim()).filter(Boolean);
    const real = names.filter(name => {
        if (/\d+歳/.test(name)) return false;
        if (/[さちくん]$/.test(name)) return false;
        if (/[Ａ-Ｚａ-ｚ０-９●○■□▲★☆]/.test(name)) return false;
        if (/[\/()（）【】\[\]]/.test(name)) return false;
        if (name.length <= 1) return false;
        if (name.length === 2 && /^[\u3040-\u309F]+$/.test(name)) return false;
        return true;
    });
    return real.length > 0 ? real.slice(0, 3).map(n => `#${n}`).join(' ') : '';
}

async function buildTweetText(genre, product, cushionUrl) {
    const pool = GENRE_PHRASES[genre] || GENRE_PHRASES.ranking;
    const fallback = pool[Math.floor(Math.random() * pool.length)];
    const phrase = await rewritePhrase(genre, fallback, { actresses: product.actresses });
    const tags = buildActressHashtags(product.actresses);
    const parts = [phrase, cushionUrl];
    if (tags) parts.push(tags);
    return parts.join('\n\n');
}

// ==============================
// siteDb: posted_at カラム追加・キュー取得・投稿済みマーク
// ==============================

async function ensurePostedAtColumn(siteDb) {
    try {
        await siteDb.execute(`ALTER TABLE x_post_decisions ADD COLUMN posted_at TEXT`);
    } catch {
        // すでにカラムがある場合は無視
    }
}

async function fetchNextPending(siteDb, accountFilter) {
    let sql = `SELECT id, product_id, new_genre FROM x_post_decisions
               WHERE decision = 'approve' AND posted_at IS NULL`;
    if (accountFilter) {
        // new_genre からアカウントを逆引き
        const targetGenres = Object.entries(GENRE_ACCOUNT_MAP)
            .filter(([, acc]) => acc === accountFilter)
            .map(([g]) => `'${g}'`);
        if (targetGenres.length > 0) {
            sql += ` AND new_genre IN (${targetGenres.join(',')})`;
        }
    }
    sql += ` ORDER BY decided_at ASC LIMIT 1`;
    const result = await siteDb.execute(sql);
    return result.rows[0] || null;
}

async function markAsPosted(siteDb, id) {
    await siteDb.execute({
        sql: `UPDATE x_post_decisions SET posted_at = datetime('now') WHERE id = ?`,
        args: [id],
    });
}

// ==============================
// ランダム遅延
// ==============================

function randomDelay(maxMs) {
    const delay = Math.floor(Math.random() * maxMs);
    console.log(`[待機] ${Math.round(delay / 1000)}秒...`);
    return new Promise(r => setTimeout(r, delay));
}

// ==============================
// メイン
// ==============================

const isDryRun = process.argv.includes('--dry-run');
const accountArg = process.argv.find(a => a.startsWith('--account='))?.split('=')[1] || null;

async function main() {
    console.log('========================================');
    console.log('  X (Twitter) 自動投稿 v3（キューモード）');
    console.log('========================================\n');

    const siteDb = getSiteClient();
    await ensurePostedAtColumn(siteDb);

    // キューから次の未投稿作品を取得
    const pending = await fetchNextPending(siteDb, accountArg);
    if (!pending) {
        console.log('[INFO] 投稿待ちの作品がありません（管理画面で作品を承認してください）');
        return;
    }

    const { id, product_id, new_genre } = pending;
    const genre = new_genre || 'ranking';
    const account = accountArg || GENRE_ACCOUNT_MAP[genre] || 'desireav-001';

    console.log(`[キュー] ID:${id}  作品:${product_id}  ジャンル:${genre}  アカウント:${account}`);

    // 作品詳細取得: MGS優先 → FANZAフォールバック（画像URLも取得）
    const sqlSel = `SELECT product_id, title, actresses, main_image_url FROM products WHERE product_id = ? LIMIT 1`;
    let productResult = await d1('mgs').execute({ sql: sqlSel, args: [product_id] }).catch(() => ({ rows: [] }));
    if (!productResult.rows.length) {
        productResult = await getFanzaClient().execute({ sql: sqlSel, args: [product_id] }).catch(() => ({ rows: [] }));
    }

    if (!productResult.rows.length) {
        console.error(`[ERROR] 作品が見つかりません: ${product_id}`);
        return;
    }

    const product = productResult.rows[0];
    console.log(`[作品] ${product.product_id} : ${product.title}`);

    // URL & ツイート文面
    const cushionUrl = buildCushionUrl(product.product_id);
    const tweetText = await buildTweetText(genre, product, cushionUrl);

    if (isDryRun) {
        console.log('\n[DRY RUN] 投稿シミュレーション');
        console.log('─'.repeat(40));
        console.log('アカウント:', account);
        console.log('テキスト:\n' + tweetText);
        console.log('─'.repeat(40));
        console.log(`\n✅ DryRun完了`);
        return;
    }

    // ランダム遅延（ボット検知回避）。--now で省略（テスト用）
    if (!process.argv.includes('--now')) await randomDelay(1000 * 60 * 2);

    // X投稿
    const twitterClient = getTwitterClient(account);

    // シャドウバン対策: パッケージ画像を加工(クロップ+再エンコード)して添付
    let mediaId = null;
    const imgUrl = posterUrl(String(product.main_image_url || ''));
    if (imgUrl && !process.argv.includes('--no-image')) {
        try {
            const res = await fetch(imgUrl);
            if (res.ok) {
                const raw = Buffer.from(await res.arrayBuffer());
                const processed = processPosterForX(raw);
                mediaId = await twitterClient.v1.uploadMedia(processed, { mimeType: 'image/jpeg' });
                console.log(`[画像] 加工添付: ${raw.length} → ${processed.length} bytes`);
            }
        } catch (e) {
            console.warn('[画像] 添付スキップ(テキストのみ投稿):', e.message);
        }
    }

    const posted = await twitterClient.v2.tweet({
        text: tweetText,
        ...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
    });
    console.log(`[投稿] Tweet ID: ${posted.data.id}${mediaId ? ' (画像付き)' : ' (テキストのみ)'}`);

    // 投稿済みマーク
    await markAsPosted(siteDb, id);
    console.log(`✅ 投稿完了 (${account})`);
}

main().catch(err => {
    console.error('❌ エラー:', err.message);
    process.exit(1);
});
