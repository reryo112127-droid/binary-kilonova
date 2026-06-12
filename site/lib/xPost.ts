import { TwitterApi } from 'twitter-api-v2';
import jpeg from 'jpeg-js';
import { getSiteClient, getMgsClient } from './turso';
import { initSiteSchema } from './siteDb';

// ── シャドウバン対策: パッケージ画像を加工して投稿する ──
// X(旧Twitter)は「同一画像の使い回し」「広く出回った成人画像の完全一致」を
// スパム/センシティブ判定の材料にする。投稿前に画像を再加工してハッシュ(ファイル/知覚)を
// 変え、端を少しクロップして露骨な縁を落とすことで検知されにくくする。
function processPosterForX(buf: Buffer): Buffer {
    // 非JPEGや破損時はそのまま返す（最低限SOIだけ確認）
    if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return buf;
    try {
        const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
        const w = img.width, h = img.height, data = img.data; // RGBA
        if (!w || !h) return uniquifyJpeg(buf);
        // 端を約3%ずつクロップ（pHash変化＋縁の露骨部除去）
        const cx = Math.max(2, Math.round(w * 0.03));
        const cy = Math.max(2, Math.round(h * 0.03));
        const nw = w - cx * 2, nh = h - cy * 2;
        if (nw < 80 || nh < 80) return uniquifyJpeg(buf);
        const out = new Uint8Array(nw * nh * 4);
        for (let y = 0; y < nh; y++) {
            const srow = (y + cy) * w, drow = y * nw;
            for (let x = 0; x < nw; x++) {
                const si = (srow + x + cx) * 4, di = (drow + x) * 4;
                out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255;
            }
        }
        // 品質を変えて再エンコード（毎回ファイルが変わる）
        const q = 78 + Math.floor(Math.random() * 8); // 78〜85
        const enc = jpeg.encode({ data: out as unknown as Buffer, width: nw, height: nh }, q);
        return Buffer.from(enc.data);
    } catch {
        return uniquifyJpeg(buf); // デコード失敗時はファイル一意化のみ
    }
}

// JPEGのSOI直後にCOM(コメント)セグメントを挿入してファイルを一意化（ピクセル不変・ハッシュ変化）
function uniquifyJpeg(buf: Buffer): Buffer {
    if (buf.length < 2 || buf[0] !== 0xFF || buf[1] !== 0xD8) return buf;
    const comment = Buffer.from('av-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), 'utf8');
    const len = comment.length + 2;
    if (len > 0xFFFF) return buf;
    const seg = Buffer.concat([Buffer.from([0xFF, 0xFE, (len >> 8) & 0xFF, len & 0xFF]), comment]);
    return Buffer.concat([buf.subarray(0, 2), seg, buf.subarray(2)]);
}

export const GENRE_ACCOUNT_MAP: Record<string, string> = {
    new:    '002',
    sale:   '004',
    anon:   '005',
    lady:   '006',
    vr:     '007',
    collab: '008',
};

function getTwitterClient(accountNum: string): TwitterApi | null {
    const appKey     = process.env[`DESIREAV_${accountNum}_APP_KEY`];
    const appSecret  = process.env[`DESIREAV_${accountNum}_APP_SECRET`];
    const accessToken  = process.env[`DESIREAV_${accountNum}_ACCESS_TOKEN`];
    const accessSecret = process.env[`DESIREAV_${accountNum}_ACCESS_SECRET`];
    if (!appKey || !appSecret || !accessToken || !accessSecret) return null;
    return new TwitterApi({ appKey, appSecret, accessToken, accessSecret });
}

function posterUrl(url: string): string {
    if (!url) return '';
    if (url.includes('pb_e_')) return url.replace('pb_e_', 'pf_e_');
    return url;
}

// ジャンル別テンプレート（シャドウバン対策でパターンをランダム選択）
const TEMPLATES: Record<string, string[]> = {
    new: [
        '新着作品をお届け📢',
        '今週の注目作品✨',
        'チェックしてほしい新作🔥',
        '見逃せない新作情報💫',
        '新作のご紹介🎬',
    ],
    sale: [
        'セール中の注目作品💰',
        'お得な割引中🏷️',
        '期間限定セール情報📣',
        'コスパ最高の一本💎',
        'セール中でお得に視聴可能📽️',
    ],
    anon: [
        '素人系の注目作品📸',
        'リアル感が魅力の一本🎥',
        '素人シリーズの新作✨',
        'ナチュラル系の注目作🌿',
        '素朴な魅力が光る作品💡',
    ],
    lady: [
        '大人の女性が輝く作品👑',
        '熟練の魅力が詰まった一本💐',
        '上品で魅力的な作品🌸',
        '大人の色気が光る作品✨',
        'エレガントな魅力の一本💄',
    ],
    vr: [
        'VR体験ができる没入感抜群の作品🥽',
        'VRで楽しむ臨場感あふれる一本🎮',
        '360度の世界観が魅力のVR作品🌐',
        'VRで体験する新感覚コンテンツ💫',
        '最新VR技術で楽しむ話題作🔮',
    ],
    collab: [
        '豪華共演が実現した注目作品🌟',
        '人気キャスト共演の話題作💥',
        '贅沢な共演が楽しめる一本🎭',
        '豪華メンバーが揃った注目作✨',
        '夢のコラボが実現した作品👥',
    ],
};

function generateTweetText(genre: string): string {
    const templates = TEMPLATES[genre] || TEMPLATES.new;
    return templates[Math.floor(Math.random() * templates.length)];
}

export interface PostResult {
    success: boolean;
    tweetId?: string;
    productId?: string;
    error?: string;
}

export async function postNextForGenre(genre: string): Promise<PostResult> {
    const accountNum = GENRE_ACCOUNT_MAP[genre];
    if (!accountNum) return { success: false, error: `未対応ジャンル: ${genre}` };

    const siteDb = await getSiteClient();
    const mgsDb  = await getMgsClient();
    if (!siteDb || !mgsDb) return { success: false, error: 'DB接続エラー' };

    await initSiteSchema();

    // 未投稿の承認済み作品を取得（事前生成テキストがあるものを優先）
    const decRes = await siteDb.execute({
        sql: `SELECT id, product_id, post_type, tweet_text FROM x_post_decisions
              WHERE decision = 'approve' AND (new_genre = ? OR (new_genre IS NULL AND ? = 'new'))
                AND posted_at IS NULL
              ORDER BY (tweet_text IS NOT NULL AND tweet_text != '') DESC, decided_at ASC LIMIT 1`,
        args: [genre, genre],
    });
    if (decRes.rows.length === 0) return { success: false, error: 'キュー空' };

    const dec = decRes.rows[0];
    const decId    = Number(dec.id);
    const productId = String(dec.product_id);

    // MGS DBから作品情報を取得
    const prodRes = await mgsDb.execute({
        sql: `SELECT title, actresses, genres, main_image_url FROM products WHERE product_id = ?`,
        args: [productId],
    });
    if (prodRes.rows.length === 0) {
        // 作品がDBにない場合はスキップ
        await siteDb.execute({ sql: `UPDATE x_post_decisions SET posted_at = datetime('now'), tweet_id = 'skipped' WHERE id = ?`, args: [decId] });
        return { success: false, error: '作品情報なし（スキップ済み）' };
    }

    const prod = prodRes.rows[0];
    const title    = String(prod.title    || '');
    const actresses = String(prod.actresses || '');
    const genres   = String(prod.genres   || '');
    const imageUrl = posterUrl(String(prod.main_image_url || ''));

    // ツイート文: 事前生成テキストがあればそれを使用、なければテンプレート
    const savedText = String(dec.tweet_text || '').trim();
    let tweetText: string;
    if (savedText) {
        tweetText = savedText; // generate-tweet-texts.mjs で生成済み
    } else {
        const introText = generateTweetText(genre);
        const hashtag   = actresses ? '#' + actresses.split(/[,、]/)[0].trim().replace(/\s+/g, '_') : '';
        const detailUrl = `https://avrankings.com/product/${productId}`;
        tweetText = [introText, hashtag, detailUrl].filter(Boolean).join('\n');
    }

    // Twitterクライアント取得
    const twitter = getTwitterClient(accountNum);
    if (!twitter) return { success: false, error: `アカウント${accountNum}の認証情報未設定` };

    try {
        let mediaId: string | undefined;

        // パケ画像をアップロード（シャドウバン対策で加工してから）
        if (imageUrl) {
            const imgRes = await fetch(imageUrl);
            if (imgRes.ok) {
                const rawBuf = Buffer.from(await imgRes.arrayBuffer());
                // クロップ＋再エンコードでハッシュを変える（同一画像の使い回し検知を回避）
                const imgBuf = processPosterForX(rawBuf);
                // 加工後は常にJPEGとして扱う（processPosterForXはJPEG出力）
                mediaId = await twitter.v1.uploadMedia(imgBuf, { mimeType: 'image/jpeg' });
            }
        }

        // ツイート投稿
        const tweet = await twitter.v2.tweet({
            text: tweetText,
            ...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
        });

        const tweetId = tweet.data.id;

        // 投稿済みとして記録
        await siteDb.execute({
            sql: `UPDATE x_post_decisions SET posted_at = datetime('now'), tweet_id = ? WHERE id = ?`,
            args: [tweetId, decId],
        });

        return { success: true, tweetId, productId };

    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, error: msg, productId };
    }
}

export async function getQueueStatus(): Promise<Record<string, { queued: number; lastPostedAt: string | null; lastTweetId: string | null }>> {
    const siteDb = await getSiteClient();
    if (!siteDb) return {};
    await initSiteSchema();

    const genres = Object.keys(GENRE_ACCOUNT_MAP);
    const result: Record<string, { queued: number; lastPostedAt: string | null; lastTweetId: string | null }> = {};

    await Promise.all(genres.map(async (genre) => {
        const [queuedRes, lastRes] = await Promise.all([
            siteDb.execute({
                sql: `SELECT COUNT(*) as cnt FROM x_post_decisions WHERE decision = 'approve' AND (new_genre = ? OR (new_genre IS NULL AND ? = 'new')) AND posted_at IS NULL`,
                args: [genre, genre],
            }),
            siteDb.execute({
                sql: `SELECT posted_at, tweet_id FROM x_post_decisions WHERE decision = 'approve' AND (new_genre = ? OR (new_genre IS NULL AND ? = 'new')) AND posted_at IS NOT NULL ORDER BY posted_at DESC LIMIT 1`,
                args: [genre, genre],
            }),
        ]);
        result[genre] = {
            queued:       Number(queuedRes.rows[0]?.cnt ?? 0),
            lastPostedAt: lastRes.rows[0] ? String(lastRes.rows[0].posted_at) : null,
            lastTweetId:  lastRes.rows[0] ? String(lastRes.rows[0].tweet_id)  : null,
        };
    }));

    return result;
}
