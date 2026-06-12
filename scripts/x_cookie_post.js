/**
 * X(Twitter) Cookie方式 自動投稿（非公式・APIクレジット不要）
 * 公式アプリと同じ内部APIを、ログイン済みアカウントの認証Cookie(auth_token, ct0)で叩いて投稿する。
 * ⚠️ X利用規約上はグレー。凍結リスクあり。まず1アカウントで検証すること。
 *
 * 事前準備:
 *   1) npm install agent-twitter-client      （ルートで）
 *   2) site/.env.local にアカウントごとのCookieを設定:
 *        XCK_005_AUTH_TOKEN=...   (Xにログインした状態で取得)
 *        XCK_005_CT0=...
 *      （取得方法: X(x.com)にログイン → 開発者ツール → Application/アプリケーション
 *        → Cookies → https://x.com → auth_token と ct0 の値をコピー）
 *
 * 利用:
 *   node scripts/x_cookie_post.js --account=005          # 005で次の1件投稿
 *   node scripts/x_cookie_post.js --account=005 --dry-run # 投稿せず内容確認
 *   node scripts/x_cookie_post.js                         # キューの new ジャンル→005 等、自動割当で1件
 */
require('dotenv').config({ path: './site/.env.local' });
const { d1, fanzaShards } = require('./lib/d1');
const jpeg = require('jpeg-js');

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
const isDry = process.argv.includes('--dry-run');

function posterUrl(u) {
    if (!u) return '';
    if (u.includes('pb_e_')) return u.replace('pb_e_', 'pf_e_');
    if (u.includes('/digital/amateur/') && u.endsWith('jm.jpg')) return u.replace('jm.jpg', 'jp-001.jpg');
    return u;
}
// 縦長ならそのまま、横長なら縦長方形にクロップ（加工は最小限）
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
function actressTags(raw) {
    return String(raw || '').split(/[,、/／]+/).map(s => s.trim())
        .filter(n => n && n.length > 1 && !/\d+歳|[（()【】\[\]]/.test(n))
        .slice(0, 3).map(n => '#' + n.replace(/\s+/g, '_')).join(' ');
}

async function getScraper(acct) {
    let Scraper;
    try { ({ Scraper } = require('agent-twitter-client')); }
    catch { throw new Error('agent-twitter-client 未インストール。ルートで `npm install agent-twitter-client` を実行してください'); }
    const auth = process.env[`XCK_${acct}_AUTH_TOKEN`];
    const ct0  = process.env[`XCK_${acct}_CT0`];
    if (!auth || !ct0) throw new Error(`XCK_${acct}_AUTH_TOKEN / XCK_${acct}_CT0 が site/.env.local に未設定`);
    const s = new Scraper();
    // setCookies は twitter.com 基準で検証するため Domain=.twitter.com で設定
    await s.setCookies([
        `auth_token=${auth}; Domain=.twitter.com; Path=/; Secure; HttpOnly`,
        `ct0=${ct0}; Domain=.twitter.com; Path=/; Secure`,
    ]);
    // createTweet が x.com の場合に備え、同じ値を x.com 用にもjarへ追加
    try {
        const jar = s.auth.cookieJar();
        await jar.setCookie(`auth_token=${auth}; Domain=.x.com; Path=/; Secure; HttpOnly`, 'https://x.com');
        await jar.setCookie(`ct0=${ct0}; Domain=.x.com; Path=/; Secure`, 'https://x.com');
    } catch { /* jar 非公開なら無視 */ }
    return s;
}

(async () => {
    const site = d1('site');
    const accountArg = arg('account');
    // キューから次のX未投稿(approve, posted_at NULL)を取得。--account指定時はそのジャンルに限定しない（最古を1件）
    const dec = await site.execute({
        sql: `SELECT id, product_id, new_genre FROM x_post_decisions WHERE decision='approve' AND posted_at IS NULL ORDER BY decided_at ASC LIMIT 1`,
    });
    if (!dec.rows.length) { console.log('X未投稿の承認作品がありません（x_queue_fill.js でキュー補充を）'); return; }
    const d = dec.rows[0];
    const pid = String(d.product_id), genre = String(d.new_genre || 'new');
    const account = accountArg || GENRE_ACCOUNT[genre] || '005';

    const sel = `SELECT title, actresses, main_image_url FROM products WHERE product_id=? LIMIT 1`;
    let pr = await d1('mgs').execute({ sql: sel, args: [pid] }).catch(() => ({ rows: [] }));
    if (!pr.rows.length) pr = await fanzaShards().execute({ sql: sel, args: [pid] }).catch(() => ({ rows: [] }));
    if (!pr.rows.length) { console.log('作品情報なし:', pid); return; }
    const p = pr.rows[0];
    const phrase = PHRASES[genre] ? PHRASES[genre][Math.floor(Math.random() * PHRASES[genre].length)] : PHRASES.new[0];
    const tags = actressTags(String(p.actresses || ''));
    const text = [phrase, tags, `${SITE}/product/${pid}`].filter(Boolean).join('\n');

    console.log(`[投稿予定] アカウント:${account} ジャンル:${genre} 作品:${pid}`);
    console.log('---\n' + text + '\n---');

    // 画像
    let media;
    const iurl = posterUrl(String(p.main_image_url || ''));
    if (iurl) {
        try {
            const r = await fetch(iurl);
            if (r.ok) { media = [{ data: toPortrait(Buffer.from(await r.arrayBuffer())), mediaType: 'image/jpeg' }]; }
        } catch (e) { console.warn('画像取得失敗:', e.message); }
    }

    if (isDry) { console.log('[DRY RUN] 投稿せず終了'); return; }

    const scraper = await getScraper(account);
    try { console.log('[ログイン確認]', (await scraper.isLoggedIn()) ? 'OK' : '判定false（投稿は試行します）'); } catch (e) { console.log('[ログイン確認] スキップ:', e.message); }
    let res, body;
    try {
        res = await scraper.sendTweet(text, undefined, media);
        body = await res.json().catch(() => null);
    } catch (e) {
        console.error('[sendTweet例外]', e.message);
        throw e;
    }
    if (body && body.errors) { console.error('[X APIエラー]', JSON.stringify(body.errors).slice(0, 300)); throw new Error('投稿拒否'); }
    const tid = body?.data?.create_tweet?.tweet_results?.result?.rest_id || (res?.status ? `status ${res.status}` : 'posted');
    console.log('✅ 投稿成功:', tid);
    await site.execute({ sql: `UPDATE x_post_decisions SET posted_at=datetime('now'), tweet_id=? WHERE id=?`, args: [String(tid), d.id] });
})().catch(e => { console.error('❌ エラー:', e.message); process.exit(1); });
