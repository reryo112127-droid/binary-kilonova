/**
 * X 手動投稿の準備（半自動）。
 * 承認キューの「X未投稿(posted_at IS NULL)」作品について、
 *   - 投稿文（ジャンル別フレーズ＋出演者ハッシュタグ＋作品URL）
 *   - シャドウバン対策済みの加工画像（端クロップ＋再エンコード）
 * を data/x_outbox/ に出力し、一覧 index.html を生成する。
 * あなたは index.html を開き、文をコピー＋画像を添付して X(アプリ/Web)から手動投稿するだけ。
 * 準備した作品は posted_at を埋めて消化する（Bluesky側 posted_bsky_at は別管理なので影響なし）。
 *   node scripts/x_prepare.js            # 既定5件準備
 *   node scripts/x_prepare.js --count 10
 */
require('dotenv').config({ path: './site/.env.local' });
const fs = require('fs');
const path = require('path');
const { d1, fanzaShards } = require('./lib/d1');
const jpeg = require('jpeg-js');

const COUNT = parseInt((process.argv.find(a => a.startsWith('--count')) || '').split(/[=\s]/)[1] || '5', 10) || 5;
const OUT_DIR = path.join(__dirname, '..', 'data', 'x_outbox');
const SITE = 'https://avrankings.com';

const PHRASES = {
    new:   ['新作きた！これ絶対チェックして', '今日配信開始のやつ。第一印象めちゃくちゃ良い', 'ついに出た…！待ってた人多いでしょこれ'],
    sale:  ['今セール中だから今のうちに！', 'このタイミング逃したらもったいない。お得すぎ', 'セール情報きた！これはマジで買い'],
    vr:    ['VRで見たら没入感やばすぎた', 'これVR持ってる人は絶対見て。距離感バグる', '目の前にいる感覚がリアルすぎる'],
    collab:['この組み合わせ、神すぎる…', '共演って奇跡だよね。この二人が揃ったのは今しかない', '単体より共演派にこれは刺さる'],
    anon:  ['この素人感がリアルでめちゃくちゃ良い', 'ガチ感がすごい。演技じゃ出せないリアクション', '隠れた名作見つけた'],
    lady:  ['大人の色気ってこういうことだよね', '夜にゆっくり見てほしい。雰囲気が良い', '癒されたい夜にぴったりの一本'],
};
function posterUrl(url) {
    if (!url) return '';
    if (url.includes('pb_e_')) return url.replace('pb_e_', 'pf_e_');
    if (url.includes('/digital/amateur/') && url.endsWith('jm.jpg')) return url.replace('jm.jpg', 'jp-001.jpg');
    return url;
}
// 画像は基本そのまま。縦長(高さ>=幅)なら無加工で返す。横長なら中央を縦長方形にクロップ。
function toPortrait(buf) {
    if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return buf;
    try {
        const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
        const w = img.width, h = img.height, data = img.data;
        if (!w || !h) return buf;
        if (h >= w) return buf; // 既に縦長 → 無加工
        const nw = Math.max(40, Math.round(h * 0.7)); // 幅=高さの0.7 → 縦に長い長方形
        const x0 = Math.round((w - nw) / 2);
        const out = new Uint8Array(nw * h * 4);
        for (let y = 0; y < h; y++) { const sr = y * w, dr = y * nw;
            for (let x = 0; x < nw; x++) { const si = (sr + x + x0) * 4, di = (dr + x) * 4;
                out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = 255; } }
        return Buffer.from(jpeg.encode({ data: out, width: nw, height: h }, 92).data);
    } catch { return buf; }
}
function actressTags(raw) {
    if (!raw) return '';
    return raw.split(/[,、/／]+/).map(s => s.trim()).filter(n => n && n.length > 1 && !/\d+歳|[（()【】\[\]]/.test(n))
        .slice(0, 3).map(n => '#' + n.replace(/\s+/g, '_')).join(' ');
}
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

(async () => {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const site = d1('site');
    const dec = await site.execute({
        sql: `SELECT id, product_id, new_genre FROM x_post_decisions WHERE decision='approve' AND posted_at IS NULL ORDER BY decided_at ASC LIMIT ?`,
        args: [COUNT],
    });
    if (!dec.rows.length) { console.log('X未投稿の承認作品がありません（x_queue_fill.js でキュー補充してください）'); return; }

    const items = [];
    for (const d of dec.rows) {
        const pid = String(d.product_id);
        const genre = String(d.new_genre || 'new');
        // 作品情報: MGS優先→FANZA
        const sel = `SELECT title, actresses, main_image_url FROM products WHERE product_id=? LIMIT 1`;
        let pr = await d1('mgs').execute({ sql: sel, args: [pid] }).catch(() => ({ rows: [] }));
        if (!pr.rows.length) pr = await fanzaShards().execute({ sql: sel, args: [pid] }).catch(() => ({ rows: [] }));
        if (!pr.rows.length) { console.warn('  作品なしスキップ:', pid); continue; }
        const p = pr.rows[0];
        const pool = PHRASES[genre] || PHRASES.new;
        const phrase = pool[Math.floor(Math.random() * pool.length)];
        const tags = actressTags(String(p.actresses || ''));
        const url = `${SITE}/product/${pid}`;
        const text = [phrase, tags, url].filter(Boolean).join('\n');

        // 画像取得＋加工
        let imgFile = '';
        const iurl = posterUrl(String(p.main_image_url || ''));
        if (iurl) {
            try {
                const r = await fetch(iurl);
                if (r.ok) {
                    const processed = toPortrait(Buffer.from(await r.arrayBuffer()));
                    imgFile = `${pid.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`;
                    fs.writeFileSync(path.join(OUT_DIR, imgFile), processed);
                }
            } catch (e) { console.warn('  画像失敗:', pid, e.message); }
        }
        items.push({ id: d.id, pid, genre, title: String(p.title || ''), text, imgFile });
        // 消化（準備済み = X側を消化。Bluesky側 posted_bsky_at とは別）
        await site.execute({ sql: `UPDATE x_post_decisions SET posted_at=datetime('now'), tweet_id='manual' WHERE id=?`, args: [d.id] });
        console.log(`  準備: [${genre}] ${pid} ${imgFile ? '(画像付き)' : '(画像なし)'}`);
    }

    // 一覧HTML生成（追記ではなく毎回 outbox 内の今回分を表示）
    const ACCOUNT_HINT = { new: '@shinsakushirase(005)', sale: '004', vr: '007', collab: '002', anon: '008', lady: '006' };
    const cards = items.map((it, i) => {
        const intent = 'https://x.com/intent/post?text=' + encodeURIComponent(it.text);
        return `
  <div class="card">
    <div class="meta"><b>${i + 1}.</b> [${esc(it.genre)}] ${esc(it.pid)} — ${esc(it.title)} <span class="acct">投稿先: ${esc(ACCOUNT_HINT[it.genre] || '')}</span></div>
    ${it.imgFile ? `<img src="./${esc(it.imgFile)}" draggable="true" title="この画像をXの投稿欄にドラッグできます" />` : '<div class="noimg">画像なし</div>'}
    <textarea readonly onclick="this.select()">${esc(it.text)}</textarea>
    <div class="btns">
      <a class="post" href="${intent}" target="_blank" rel="noopener">✕ Xで投稿（文入りで開く）</a>
      <button onclick="navigator.clipboard.writeText(this.closest('.card').querySelector('textarea').value);this.textContent='コピー済';">文をコピー</button>
      <a class="dl" href="./${esc(it.imgFile || '')}" download>画像を保存</a>
    </div>
  </div>`;
    }).join('\n');
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>X手動投稿 ${new Date().toLocaleString('ja-JP')}</title>
<style>body{font-family:sans-serif;max-width:680px;margin:16px auto;padding:0 12px;background:#f7f9fa}
.card{border:1px solid #e1e8ed;border-radius:14px;padding:14px;margin:14px 0;background:#fff}
.meta{font-size:12px;color:#666;margin-bottom:8px}
.acct{color:#1d9bf0;font-weight:bold;margin-left:6px}
img{max-width:240px;border-radius:10px;display:block;margin-bottom:8px;cursor:grab;border:1px solid #eee}
textarea{width:100%;height:96px;font-size:14px;padding:8px;box-sizing:border-box;border:1px solid #ddd;border-radius:8px}
.btns{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.post{padding:8px 16px;border-radius:999px;background:#000;color:#fff;font-weight:bold;text-decoration:none;font-size:14px}
button{padding:7px 14px;border:1px solid #ccc;border-radius:999px;background:#fff;color:#333;font-weight:bold;cursor:pointer;font-size:13px}
.dl{padding:7px 14px;border:1px solid #ccc;border-radius:999px;background:#fff;color:#333;text-decoration:none;font-weight:bold;font-size:13px}
.noimg{color:#999;margin-bottom:8px}
.how{background:#fff;border:1px solid #e1e8ed;border-radius:14px;padding:14px;font-size:14px;line-height:1.7}</style>
<h2>X 手動投稿（${items.length}件）</h2>
<div class="how"><b>かんたん手順</b><br>
① 各カードの <b>「✕ Xで投稿」</b> を押す（文が入った投稿画面が新しいタブで開きます。コピペ不要）<br>
② 画像も付けたい場合は、上の画像を投稿欄に<b>ドラッグ</b>（または「画像を保存」して添付）<br>
③ そのまま投稿。※リンクが入っているので画像を付けなくてもパッケージ画像のカードが自動表示されます<br>
<small>投稿先アカウントは各カードに表示。Xで該当アカウントに切り替えてから押してください。</small></div>
${cards}`;
    fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);
    console.log(`\n✅ ${items.length}件を準備 → ${path.join(OUT_DIR, 'index.html')} を開いて手動投稿`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
