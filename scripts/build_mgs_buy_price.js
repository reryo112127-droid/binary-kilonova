/**
 * クロスプラットフォーム作品のMGS「ダウンロード買い切り」価格を詳細ページから収集する。
 * MGSの一覧/日次更新は最安(視聴/ストリーミング)価格しか持たないため、FANZAのdownload価格と
 * 条件が揃わない。比較表示用に、対象作品のダウンロード買い切り価格を別キャッシュへ収集する。
 * （日次phase3はD1のみ更新するので、このキャッシュは上書きされない。古い作品は日次対象外でもある）
 *
 *   node scripts/build_mgs_buy_price.js            # 全対象
 *   node scripts/build_mgs_buy_price.js --limit 50 # 動作確認
 *
 * 出力: data/mgs_buy_price.json + site/public/data/mgs_buy_price.json
 *   { "<mgsId>": { "list": <定価>, "current": <セール後> }, ... }
 */
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const Database = require('better-sqlite3');
const { fetchPage, politeWait } = require('../lib/fetcher');

const ROOT = path.join(__dirname, '..');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : 0; })();
const OUT = [path.join(ROOT, 'data', 'mgs_buy_price.json'), path.join(ROOT, 'site', 'public', 'data', 'mgs_buy_price.json')];

// 詳細ページHTMLから「ダウンロード」を含む最安オプション(=基本のダウンロード買い切り)の定価/セール価格を取る
function parseBuyPrice(html) {
    const $ = cheerio.load(html);
    const dls = [];
    $('.price-option').each((i, el) => {
        const title = $(el).find('.price-option-title').text().replace(/\s+/g, ' ').trim();
        if (!/ダウンロード/.test(title)) return; // 視聴(ストリーミング)のみは除外
        const list = parseInt($(el).find('.pre-sale-price').first().text().replace(/[^0-9]/g, '')) || null;
        const now = parseInt($(el).find('.now-price').first().text().replace(/[^0-9]/g, '')) || list;
        if (list) dls.push({ list, current: now });
    });
    if (!dls.length) return null;
    dls.sort((a, b) => a.list - b.list); // 最安のダウンロード(=基本SDダウンロード)
    return dls[0];
}

(async () => {
    const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'public', 'data', 'cross_platform.json'), 'utf-8'));
    const mgs = new Database(path.join(ROOT, 'data', 'mgs.db'), { readonly: true });
    const hasPrice = mgs.prepare('SELECT current_price FROM products WHERE product_id=? AND current_price>0');

    // MGS品番(大文字を含む)かつ価格が表示される作品のみ対象
    let targets = Object.keys(map).filter(k => /[A-Z]/.test(k) && hasPrice.get(k));
    if (LIMIT) targets = targets.slice(0, LIMIT);
    console.log('対象MGS作品:', targets.length, '件');

    // 既存キャッシュに追記(再開可能)
    const out = fs.existsSync(OUT[0]) ? JSON.parse(fs.readFileSync(OUT[0], 'utf-8')) : {};
    let done = 0, ok = 0, fail = 0;
    for (const id of targets) {
        if (out[id]) { done++; continue; } // 取得済みskip
        try {
            const html = await fetchPage(`https://www.mgstage.com/product/product_detail/${id}/`);
            const bp = parseBuyPrice(html);
            if (bp) { out[id] = bp; ok++; } else { fail++; }
        } catch (e) { fail++; }
        done++;
        if (done % 100 === 0) {
            for (const p of OUT) fs.writeFileSync(p, JSON.stringify(out));
            console.log(`  ${done}/${targets.length} (取得${ok} 失敗${fail})`);
        }
        await politeWait();
    }
    for (const p of OUT) fs.writeFileSync(p, JSON.stringify(out));
    console.log(`✅ 完了: 取得${ok} 失敗${fail} / キャッシュ計${Object.keys(out).length}件`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
