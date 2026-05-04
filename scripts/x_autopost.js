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
const { createClient } = require('@libsql/client');
const { TwitterApi } = require('twitter-api-v2');
const { rewritePhrase } = require('../lib/gemini_rewrite');

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
    const url = process.env.TURSO_SITE_URL;
    const authToken = process.env.TURSO_SITE_TOKEN;
    if (!url || !authToken) throw new Error('TURSO_SITE_URL / TURSO_SITE_TOKEN が未設定です');
    return createClient({ url, authToken });
}

function getFanzaClient() {
    return createClient({
        url: process.env.TURSO_FANZA_URL,
        authToken: process.env.TURSO_FANZA_TOKEN,
    });
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
    // FANZAの作品詳細URL（管理画面はFANZAのみ）
    return `${SITE_BASE_URL}/product/fanza-${productId}`;
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

    // FANZA DBから作品詳細取得
    const fanzaDb = getFanzaClient();
    const productResult = await fanzaDb.execute({
        sql: `SELECT product_id, title, actresses FROM products WHERE product_id = ? LIMIT 1`,
        args: [product_id],
    });

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

    // ランダム遅延（ボット検知回避）
    await randomDelay(1000 * 60 * 2);

    // X投稿
    const twitterClient = getTwitterClient(account);
    const posted = await twitterClient.v2.tweet(tweetText);
    console.log(`[投稿] Tweet ID: ${posted.data.id}`);

    // 投稿済みマーク
    await markAsPosted(siteDb, id);
    console.log(`✅ 投稿完了 (${account})`);
}

main().catch(err => {
    console.error('❌ エラー:', err.message);
    process.exit(1);
});
