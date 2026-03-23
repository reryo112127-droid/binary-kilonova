/**
 * X (Twitter) 自動投稿スクリプト — v2 (Turso対応・クッションページURL版)
 *
 * 変更点:
 * - sql.js (ローカルSQLite) → Turso (@libsql/client)
 * - アフィリエイト直リンク廃止 → lunar-zodiac.vercel.app の作品詳細URLを投稿
 * - twitter-api-v2 パッケージで実際のAPI呼び出し実装
 * - FANZA / MGS 両DB対応
 *
 * 利用方法:
 *   node scripts/x_autopost.js desireav-002
 *   node scripts/x_autopost.js desireav-006 --dry-run
 *   node scripts/x_autopost.js desireav-004 --source=fanza
 */

require('dotenv').config({ path: './site/.env.local' });
const { createClient } = require('@libsql/client');
const { TwitterApi } = require('twitter-api-v2');
const { rewritePhrase } = require('../lib/gemini_rewrite');

// ==============================
// 設定
// ==============================

const SITE_BASE_URL = 'https://lunar-zodiac.vercel.app';

// アカウントごとのX API認証情報（.env.local に追記して管理）
// 変数名例: DESIREAV_002_APP_KEY / DESIREAV_002_APP_SECRET
//           DESIREAV_002_ACCESS_TOKEN / DESIREAV_002_ACCESS_SECRET
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
// Tursoクライアント
// ==============================

function getMgsClient() {
    return createClient({
        url: process.env.TURSO_MGS_URL,
        authToken: process.env.TURSO_MGS_TOKEN,
    });
}

function getFanzaClient() {
    return createClient({
        url: process.env.TURSO_FANZA_URL,
        authToken: process.env.TURSO_FANZA_TOKEN,
    });
}

// ==============================
// アカウント別クエリ定義
// ==============================

function buildQuery(account, source) {
    const isMgs = source === 'mgs';
    // MGS: detail_scraped=1 かつ x_posted_at IS NULL で未投稿管理
    // FANZA: detail_scraped カラムなし → 条件なし
    const notPosted = isMgs ? 'x_posted_at IS NULL' : '1=1';
    const base = isMgs ? `detail_scraped = 1 AND ${notPosted}` : notPosted;

    switch (account) {
        case 'desireav-001': // 総合・高評価
            return isMgs
                ? `${base} AND wish_count > 200 ORDER BY wish_count DESC`
                : `${base} ORDER BY RANDOM()`;

        case 'desireav-002': // 共演作紹介（女優2人以上が出演している作品）
            // MGS: ' / ' 区切りで複数女優
            // FANZA: ',' 区切りで複数女優 → --source=fanza 推奨
            return isMgs
                ? `${base} AND actresses LIKE '% / %' ORDER BY RANDOM()`
                : `${base} AND actresses LIKE '%,%' ORDER BY RANDOM()`;

        case 'desireav-003': // 総合ランキング・名作
            return isMgs
                ? `${base} AND wish_count > 100 ORDER BY RANDOM()`
                : `${base} AND (discount_pct IS NULL OR discount_pct = 0) ORDER BY RANDOM()`;

        case 'desireav-004': // セール速報（FANZA向け）
            return isMgs
                ? `${base} AND wish_count > 50 ORDER BY RANDOM()`
                : `${base} AND discount_pct > 20 ORDER BY discount_pct DESC`;

        case 'desireav-005': // 新作・デビュー
            return `${base} AND sale_start_date >= date('now', '-30 days') ORDER BY sale_start_date DESC`;

        case 'desireav-006': // 人妻・熟女
            return `${base} AND (genres LIKE '%人妻%' OR genres LIKE '%熟女%' OR genres LIKE '%未亡人%' OR genres LIKE '%母%') ORDER BY RANDOM()`;

        case 'desireav-007': // VR
            return `${base} AND (title LIKE '%VR%' OR genres LIKE '%VR%') ORDER BY RANDOM()`;

        case 'desireav-008': // 素人
            return isMgs
                ? `${base} AND (genres LIKE '%素人%' OR maker LIKE '%素人%') ORDER BY RANDOM()`
                : `${base} AND genres LIKE '%素人%' ORDER BY RANDOM()`;

        default:
            throw new Error(`未定義のアカウント: ${account}`);
    }
}

// ==============================
// クッションページURL生成
// ==============================

function buildCushionUrl(productId, source) {
    // lunar-zodiac ルーティング: /product/[id]
    // FANZAはIDに 'fanza-' プレフィックスを付与（APIルートで判別）
    const prefix = source === 'fanza' ? 'fanza-' : '';
    return `${SITE_BASE_URL}/product/${prefix}${productId}`;
}

// ==============================
// ツイート文面生成
// ==============================

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

const PHRASES = {
    'desireav-001': [
        'これランキング上位に入るやつだから間違いない',
        'みんなが選んだ作品には理由がある。見てみて',
        '評価数えぐいやつ。納得の内容だった',
    ],
    'desireav-002': [
        'この組み合わせ、神すぎる…二人いるだけで空気が変わる',
        '共演って奇跡だよね。この二人が揃ったのは今しかない',
        '単体より共演の方が好きな人、これは絶対刺さるやつ',
        'この二人同士の絡みが見たかった。ようやく実現した感じ',
    ],
    'desireav-003': [
        'これ今めちゃくちゃ話題になってるやつ。間違いないよ👍',
        'これは保存版。何回でも見返せるクオリティ',
        '友達に勧められて見たけどガチで当たりだった🎯',
    ],
    'desireav-004': [
        '今セール中だから今のうちにチェックしといて！',
        'このタイミング逃したらもったいない。お得すぎる',
        'セール情報きた！これはマジで買い。迷ってる暇ないやつ',
    ],
    'desireav-005': [
        '新作きた！！これ絶対チェックして',
        '今日配信開始のやつ。第一印象めちゃくちゃ良い✨',
        'ついに出た…！待ってた人多いでしょこれ',
    ],
    'desireav-006': [
        '大人の色気ってこういうことだよね…最高だった',
        '夜にゆっくり見てほしい。雰囲気が本当に良い',
        '癒されたい夜にぴったり。しっとり系の名作👑',
    ],
    'desireav-007': [
        'VRで見たら没入感やばすぎて現実に戻れなくなった笑',
        'これVR持ってる人は絶対見て。距離感バグるよ',
        '目の前にいる感覚がリアルすぎて心臓止まるかと思った',
    ],
    'desireav-008': [
        'この素人感がリアルでめちゃくちゃ良いんだよ…',
        'ガチ感がすごい。演技じゃ絶対出せないリアクション',
        'これ見つけた時テンション上がった。隠れた名作だよ',
    ],
};

async function buildTweetText(account, product, cushionUrl) {
    const pool = PHRASES[account] || ['これめっちゃ良かったから見てみて！'];
    const fallback = pool[Math.floor(Math.random() * pool.length)];
    // Gemini Flash でリライト（APIキー未設定時はfallbackをそのまま使用）
    const phrase = await rewritePhrase(account, fallback, { actresses: product.actresses });
    const tags = buildActressHashtags(product.actresses);
    // 構成: フレーズ + クッションページURL + 女優タグ（あれば）
    const parts = [phrase, cushionUrl];
    if (tags) parts.push(tags);
    return parts.join('\n\n');
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
// 投稿済みマーク（MGSのみ）
// ==============================

async function markAsPosted(mgsClient, productId, account) {
    await mgsClient.execute({
        sql: `UPDATE products SET x_posted_at = datetime('now','localtime'), x_posted_account = ? WHERE product_id = ?`,
        args: [account, productId],
    });
}

// ==============================
// メイン
// ==============================

const isDryRun = process.argv.includes('--dry-run');

async function main() {
    console.log('========================================');
    console.log('  X (Twitter) 自動投稿 v2');
    console.log('========================================\n');

    const account = process.argv[2];
    if (!account || !account.startsWith('desireav-')) {
        console.error('❌ アカウント名を指定してください (例: desireav-006)');
        process.exit(1);
    }

    // --source=fanza または --source=mgs（デフォルトはアカウントで自動判定）
    const sourceArg = process.argv.find(a => a.startsWith('--source='));
    const source = sourceArg
        ? sourceArg.split('=')[1]
        : (account === 'desireav-004' ? 'fanza' : 'mgs');

    console.log(`アカウント: ${account}  ソース: ${source.toUpperCase()}`);

    const dbClient = source === 'fanza' ? getFanzaClient() : getMgsClient();

    // 実投稿時はランダム遅延（ボット検知回避）
    if (!isDryRun) {
        await randomDelay(1000 * 60 * 2); // 最大2分
    }

    // 作品取得
    const query = buildQuery(account, source);
    const sql = `SELECT product_id, title, actresses FROM products WHERE ${query} LIMIT 1`;
    const result = await dbClient.execute(sql);

    if (!result.rows.length) {
        console.log(`[INFO] 未投稿作品が見つかりませんでした (${account})`);
        return;
    }

    const product = result.rows[0];
    console.log(`[抽出] ${product.product_id} : ${product.title}`);

    // クッションページURL & ツイート文面
    const cushionUrl = buildCushionUrl(product.product_id, source);
    const tweetText = await buildTweetText(account, product, cushionUrl);

    // 投稿
    if (isDryRun) {
        console.log('\n[DRY RUN] 投稿シミュレーション');
        console.log('─'.repeat(40));
        console.log(tweetText);
        console.log('─'.repeat(40));
        console.log(`\n✅ DryRun完了 (${account})`);
        return;
    }

    const twitterClient = getTwitterClient(account);
    const posted = await twitterClient.v2.tweet(tweetText);
    console.log(`[投稿] Tweet ID: ${posted.data.id}`);

    // MGSのみ投稿済みマーク
    if (source === 'mgs') {
        const mgsClient = getMgsClient();
        await markAsPosted(mgsClient, product.product_id, account);
    }

    console.log(`✅ 投稿完了 (${account})`);
}

main().catch(err => {
    console.error('❌ エラー:', err.message);
    process.exit(1);
});
