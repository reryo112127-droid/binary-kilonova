/**
 * Bluesky 自動投稿スクリプト
 *
 * X（旧Twitter）との違い:
 * - API無料・制限が大幅に緩い（実質無制限に近い）
 * - アダルトコンテンツをラベル付きで公式に許可
 * - OGカード（リンクプレビュー）はembedで明示的に添付
 *
 * 認証: Bluesky App Password（設定 > アプリパスワード で発行）
 * 必要な環境変数（.env.local）:
 *   BSKY_MAIN_IDENTIFIER=yourhandle.bsky.social
 *   BSKY_MAIN_PASSWORD=xxxx-xxxx-xxxx-xxxx
 *   BSKY_SUB_IDENTIFIER=yourhandle2.bsky.social   （サブ用、任意）
 *   BSKY_SUB_PASSWORD=xxxx-xxxx-xxxx-xxxx
 *
 * 利用方法:
 *   node scripts/bluesky_autopost.js --account=main --genre=ranking
 *   node scripts/bluesky_autopost.js --account=main --genre=sale --source=fanza
 *   node scripts/bluesky_autopost.js --account=sub  --genre=kyouen --source=mgs
 *   node scripts/bluesky_autopost.js --account=main --genre=vr --dry-run
 */

require('dotenv').config({ path: './site/.env.local' });
const { AtpAgent, RichText } = require('@atproto/api');
const { rewritePhrase } = require('../lib/gemini_rewrite');
const { createClient } = require('@libsql/client');

// ==============================
// 設定
// ==============================

const SITE_BASE_URL = 'https://lunar-zodiac.vercel.app';

// Blueskyアカウント設定
const BSKY_ACCOUNTS = {
    main: {
        identifier: process.env.BSKY_MAIN_IDENTIFIER,
        password:   process.env.BSKY_MAIN_PASSWORD,
    },
    sub: {
        identifier: process.env.BSKY_SUB_IDENTIFIER,
        password:   process.env.BSKY_SUB_PASSWORD,
    },
};

// ジャンルとDBソースの対応
const GENRE_CONFIG = {
    ranking: {
        label: '総合ランキング',
        source: 'mgs',
        query: (isMgs) => isMgs
            ? 'detail_scraped = 1 AND wish_count > 100 ORDER BY RANDOM()'
            : '1=1 ORDER BY RANDOM()',
    },
    newwork: {
        label: '新作',
        source: 'mgs',
        query: () => "detail_scraped = 1 AND sale_start_date >= date('now', '-30 days') ORDER BY sale_start_date DESC",
    },
    sale: {
        label: 'セール',
        source: 'fanza',
        query: (isMgs) => isMgs
            ? 'detail_scraped = 1 AND wish_count > 50 ORDER BY RANDOM()'
            : 'discount_pct > 20 ORDER BY discount_pct DESC',
    },
    milf: {
        label: '人妻・熟女',
        source: 'mgs',
        query: (isMgs) => {
            const base = isMgs ? 'detail_scraped = 1' : '1=1';
            return `${base} AND (genres LIKE '%人妻%' OR genres LIKE '%熟女%' OR genres LIKE '%母%') ORDER BY RANDOM()`;
        },
    },
    vr: {
        label: 'VR',
        source: 'mgs',
        query: (isMgs) => {
            const base = isMgs ? 'detail_scraped = 1' : '1=1';
            return `${base} AND (title LIKE '%VR%' OR genres LIKE '%VR%') ORDER BY RANDOM()`;
        },
    },
    amateur: {
        label: '素人',
        source: 'mgs',
        query: (isMgs) => {
            const base = isMgs ? 'detail_scraped = 1' : '1=1';
            return isMgs
                ? `${base} AND (genres LIKE '%素人%' OR maker LIKE '%素人%') ORDER BY RANDOM()`
                : `${base} AND genres LIKE '%素人%' ORDER BY RANDOM()`;
        },
    },
    kyouen: {
        label: '共演作',
        source: 'mgs',
        query: (isMgs) => isMgs
            ? "detail_scraped = 1 AND actresses LIKE '% / %' ORDER BY RANDOM()"
            : "actresses LIKE '%,%' ORDER BY RANDOM()",
    },
};

// ==============================
// Tursoクライアント
// ==============================

function getMgsClient() {
    return createClient({ url: process.env.TURSO_MGS_URL, authToken: process.env.TURSO_MGS_TOKEN });
}
function getFanzaClient() {
    return createClient({ url: process.env.TURSO_FANZA_URL, authToken: process.env.TURSO_FANZA_TOKEN });
}

// ==============================
// クッションページURL
// ==============================

function buildCushionUrl(productId, source) {
    const prefix = source === 'fanza' ? 'fanza-' : '';
    return `${SITE_BASE_URL}/product/${prefix}${productId}`;
}

// ==============================
// 投稿テキスト生成
// ==============================

function buildActressHashtags(actressesRaw, source) {
    if (!actressesRaw) return [];
    const sep = source === 'fanza' ? /,\s*/ : /\s*\/\s*/;
    const names = actressesRaw.split(sep).map(n => n.trim()).filter(Boolean);
    return names
        .filter(name => {
            if (/\d+歳/.test(name)) return false;
            if (name.length <= 1) return false;
            if (name.length === 2 && /^[\u3040-\u309F]+$/.test(name)) return false;
            if (/[（()【】\[\]]/.test(name)) return false;
            if (/[Ａ-Ｚａ-ｚ●○]/.test(name)) return false;
            return true;
        })
        .slice(0, 3);
}

const PHRASES = {
    ranking: [
        'みんなが選んだ作品には理由がある',
        'これ評価数えぐかった。納得の内容',
        '話題になってるやつを改めて見たら最高だった',
    ],
    newwork: [
        '新作きた。これ絶対チェックして',
        'ついに出た。待ってた人多いはず',
        '今日配信開始。第一印象めちゃくちゃ良い',
    ],
    sale: [
        '今セール中。このタイミング逃したらもったいない',
        'お得すぎて二度見した。今だけの価格',
        '普段の値段知ってると驚く割引率',
    ],
    milf: [
        '大人の色気ってこういうことだよね',
        '夜にゆっくり見てほしい。雰囲気が本当に良い',
        '癒されたい夜にぴったりな一本',
    ],
    vr: [
        'VRで見たら没入感やばすぎて現実に戻れなくなった',
        'これVR持ってる人は絶対見て。距離感バグる',
        '目の前にいる感覚がリアルすぎた',
    ],
    amateur: [
        'この素人感がリアルでめちゃくちゃ良い',
        'ガチ感がすごい。演技じゃ絶対出せないリアクション',
        'これ見つけた時テンション上がった。隠れた名作',
    ],
    kyouen: [
        'この組み合わせが実現した作品。二人いるだけで空気が変わる',
        '共演って奇跡だよね。この顔ぶれが揃ったのは今しかない',
        '単体より共演の方が好きな人、これは絶対刺さる',
        'この二人の絡みが見たかった。ようやく実現',
    ],
};

async function buildPostText(genre, product, actressNames) {
    const pool = PHRASES[genre] || ['これ良かった。見てみて'];
    const fallback = pool[Math.floor(Math.random() * pool.length)];
    const phrase = await rewritePhrase(genre, fallback, { actresses: product.actresses });

    // ハッシュタグ（テキスト内に入れる）
    const tags = actressNames.map(n => `#${n}`).join(' ');
    const genreConfig = GENRE_CONFIG[genre];
    const genreTag = `#AV${genreConfig.label}`;

    const parts = [phrase];
    if (tags) parts.push(tags);
    parts.push(genreTag);

    return parts.join('\n');
}

// ==============================
// Bluesky OGカード取得
// ==============================

async function fetchOgCard(url) {
    // OGカードはBlueskyクライアントがfetchしてembedに使う
    // lunar-zodiac は Next.js で OGP メタタグを出力しているので問題ない
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Blueskybot/1.0' },
            signal: AbortSignal.timeout(8000),
        });
        const html = await res.text();

        const getMetaContent = (property) => {
            const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'))
                || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, 'i'));
            return m ? m[1] : null;
        };

        return {
            uri: url,
            title: getMetaContent('og:title') || getMetaContent('title') || url,
            description: getMetaContent('og:description') || '',
            thumb: getMetaContent('og:image') || null,
        };
    } catch {
        return { uri: url, title: url, description: '', thumb: null };
    }
}

// ==============================
// Blueskyへの投稿
// ==============================

const isDryRun = process.argv.includes('--dry-run');

async function postToBluesky(agent, text, ogCard, isAdult) {
    // RichTextでハッシュタグをfacetに変換
    const rt = new RichText({ text });
    await rt.detectFacets(agent);

    // 外部リンクのembedを構築
    let embed = undefined;
    if (ogCard) {
        const extEmbed = {
            $type: 'app.bsky.embed.external',
            external: {
                uri: ogCard.uri,
                title: ogCard.title,
                description: ogCard.description,
            },
        };

        // サムネイル画像のアップロード（あれば）
        if (ogCard.thumb && !isDryRun) {
            try {
                const imgRes = await fetch(ogCard.thumb);
                const imgBuf = Buffer.from(await imgRes.arrayBuffer());
                const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
                const uploaded = await agent.uploadBlob(imgBuf, { encoding: contentType });
                extEmbed.external.thumb = uploaded.data.blob;
            } catch {
                // サムネ取得失敗は無視して続行
            }
        }

        embed = extEmbed;
    }

    // アダルトラベル
    const labels = isAdult
        ? { $type: 'com.atproto.label.defs#selfLabels', values: [{ val: 'sexual' }] }
        : undefined;

    const postRecord = {
        text: rt.text,
        facets: rt.facets,
        embed,
        labels,
        createdAt: new Date().toISOString(),
    };

    if (isDryRun) {
        console.log('\n[DRY RUN] Bluesky投稿シミュレーション');
        console.log('─'.repeat(40));
        console.log('テキスト:', rt.text);
        console.log('URL:', ogCard?.uri);
        console.log('OGタイトル:', ogCard?.title);
        console.log('ラベル:', isAdult ? 'sexual' : 'なし');
        console.log('─'.repeat(40));
        return { uri: 'dry_run' };
    }

    const res = await agent.post(postRecord);
    return res;
}

// ==============================
// メイン
// ==============================

async function main() {
    console.log('========================================');
    console.log('  Bluesky 自動投稿');
    console.log('========================================\n');

    // 引数パース
    const getArg = (name) => {
        const a = process.argv.find(a => a.startsWith(`--${name}=`));
        return a ? a.split('=')[1] : null;
    };

    const accountKey = getArg('account') || 'main';
    const genre      = getArg('genre');
    const sourceOverride = getArg('source');

    if (!genre || !GENRE_CONFIG[genre]) {
        console.error(`❌ --genre を指定してください: ${Object.keys(GENRE_CONFIG).join(', ')}`);
        process.exit(1);
    }

    const genreConf = GENRE_CONFIG[genre];
    const source = sourceOverride || genreConf.source;
    const isMgs = source === 'mgs';

    console.log(`アカウント: ${accountKey}  ジャンル: ${genreConf.label}  ソース: ${source.toUpperCase()}`);

    // DB作品取得
    const dbClient = isMgs ? getMgsClient() : getFanzaClient();
    const queryStr = genreConf.query(isMgs);
    const sql = `SELECT product_id, title, actresses FROM products WHERE ${queryStr} LIMIT 1`;
    const result = await dbClient.execute(sql);

    if (!result.rows.length) {
        console.log(`[INFO] 作品が見つかりませんでした (${genre})`);
        return;
    }

    const product = result.rows[0];
    console.log(`[抽出] ${product.product_id} : ${product.title}`);

    // URL & テキスト生成
    const cushionUrl = buildCushionUrl(product.product_id, source);
    const actressNames = buildActressHashtags(product.actresses, source);
    const postText = await buildPostText(genre, product, actressNames);

    // OGカード取得（dry-runでも取得して確認できるよう）
    console.log('[OGカード取得中...]');
    const ogCard = await fetchOgCard(cushionUrl);

    // Blueskyエージェント初期化
    const agent = new AtpAgent({ service: 'https://bsky.social' });

    if (!isDryRun) {
        const creds = BSKY_ACCOUNTS[accountKey];
        if (!creds?.identifier || !creds?.password) {
            throw new Error(
                `BSKY_${accountKey.toUpperCase()}_IDENTIFIER / BSKY_${accountKey.toUpperCase()}_PASSWORD が .env.local に未設定です`
            );
        }
        await agent.login({ identifier: creds.identifier, password: creds.password });
        console.log(`[ログイン] ${creds.identifier}`);
    }

    // 投稿（アダルトラベル付き）
    const posted = await postToBluesky(agent, postText, ogCard, true);
    console.log(`[投稿URI] ${posted.uri}`);
    console.log(`✅ 完了 (${accountKey} / ${genreConf.label})`);
}

main().catch(err => {
    console.error('❌ エラー:', err.message);
    process.exit(1);
});
