/**
 * HTMLパーサーモジュール
 * cheerioを使ったMGS動画ページのデータ抽出
 */
const cheerio = require('cheerio');

/**
 * 検索一覧ページから商品情報を抽出
 * @param {string} html - 検索結果ページのHTML
 * @returns {{ products: Array, totalCount: number }}
 */
function parseSearchPage(html) {
    const $ = cheerio.load(html);
    const products = [];

    // 総件数を抽出（例: "114698タイトル中"）
    const totalCount = parseTotalCount(html);

    // 各商品カードを解析
    $('li.product_list_item').each((_, el) => {
        const $el = $(el);

        // 品番: 詳細ページリンクから抽出
        const detailLink = $el.find('a[href*="/product/product_detail/"]').first().attr('href') || '';
        const productIdMatch = detailLink.match(/\/product\/product_detail\/([^/]+)\//);
        if (!productIdMatch) return;
        const product_id = productIdMatch[1];

        // タイトル
        const title = $el.find('a.title.lineclamp').text().trim().replace(/^[\s\S]*?(?=【|[^\s])/, '').trim();

        // 出演者
        const actresses = [];
        $el.find('a.actor_name').each((_, actorEl) => {
            const name = $(actorEl).text().trim();
            if (name) actresses.push(name);
        });

        // メイン画像URL (pb_e_ prefix)
        const mainImageLink = $el.find(`a[class*="sample_image_${product_id}"]`).first();
        const main_image_url = mainImageLink.attr('href') || '';

        // サンプル画像URL群 (cap_e_ prefix)
        const sample_images = [];
        $el.find(`a[class*="sample_image_${product_id}"]`).each((_, imgEl) => {
            const href = $(imgEl).attr('href') || '';
            if (href && href.includes('cap_e_')) {
                sample_images.push(href);
            }
        });

        // サンプル動画URL
        const sampleVideoLink = $el.find('a.button_sample').attr('href') || '';
        const sample_video_url = sampleVideoLink
            ? `https://www.mgstage.com${sampleVideoLink.startsWith('/') ? '' : '/'}${sampleVideoLink}`
            : '';

        // サムネイル画像URL (一覧表示用の画像)
        const thumbImg = $el.find('h5 a img').attr('src') || '';

        products.push({
            product_id,
            title: cleanTitle(title),
            actresses: actresses.join(', '),
            main_image_url: main_image_url || thumbImg,
            sample_images,
            sample_video_url: sample_video_url || null,
        });
    });

    return { products, totalCount };
}

/**
 * タイトルのクリーニング
 */
function cleanTitle(title) {
    // 独占配信タグのテキストを除去
    return title.replace(/^\s*/, '').trim();
}

/**
 * 総件数の抽出（例: "114698タイトル中"）
 * @param {string} html
 * @returns {number}
 */
function parseTotalCount(html) {
    const match = html.match(/(\d[\d,]*)タイトル中/);
    if (!match) return 0;
    return parseInt(match[1].replace(/,/g, ''), 10);
}

/**
 * 詳細ページから各種情報を抽出
 * @param {string} html - 詳細ページのHTML
 * @returns {{ title: string, maker: string, label: string, duration_min: number|null, wish_count: number|null, genres: string, sale_start_date: string }}
 */
function parseDetailPage(html) {
    const $ = cheerio.load(html);

    let title = '';
    let maker = '';
    let label = '';
    let duration_min = null;
    let wish_count = null;
    const genres = [];
    const actresses = [];
    let sale_start_date = '';

    // タイトル: h1.tag から取得
    title = $('h1.tag').text().trim();

    // 欲しいものリスト追加数: detail_wish_cnt の行
    $('table tr').each((_, row) => {
        const $row = $(row);
        const wishDiv = $row.find('.detail_wish_cnt');
        if (wishDiv.length) {
            const countTd = $row.find('td').last();
            const countText = countTd.text().trim().replace(/,/g, '');
            const n = parseInt(countText, 10);
            if (!isNaN(n)) wish_count = n;
        }
    });

    // テーブル行を探索
    $('table tr').each((_, row) => {
        const $row = $(row);
        const th = $row.find('th').text().trim();
        const td = $row.find('td');

        if (th.includes('出演')) {
            td.find('a').each((_, a) => {
                const name = $(a).text().trim();
                if (name) actresses.push(name);
            });
        } else if (th.includes('メーカー')) {
            maker = td.find('a').text().trim() || td.text().trim();
        } else if (th.includes('レーベル')) {
            label = td.find('a').text().trim() || td.text().trim();
        } else if (th.includes('収録時間')) {
            const timeText = td.text().trim();
            const minMatch = timeText.match(/(\d+)/);
            if (minMatch) {
                duration_min = parseInt(minMatch[1], 10);
            }
        } else if (th.includes('配信開始日')) {
            sale_start_date = td.text().trim();
        } else if (th.includes('ジャンル')) {
            td.find('a').each((_, a) => {
                const g = $(a).text().trim();
                if (g) genres.push(g);
            });
        }
    });

    return { title, actresses: actresses.join(', '), maker, label, duration_min, wish_count, genres: genres.join(', '), sale_start_date };
}

/**
 * サンプル動画の直接URLを取得（サンプルプレイヤーページから）
 * @param {string} html - サンプルプレイヤーページのHTML
 * @returns {string|null} mp4 URL
 */
function parseSampleVideoUrl(html) {
    // video.jsの設定からmp4 URLを探す
    const mp4Match = html.match(/(?:src|file|url)['":\s]+['"]?(https?:\/\/[^'"?\s]+\.mp4[^'"?\s]*)/i);
    if (mp4Match) return mp4Match[1];

    // source タグからmp4を探す
    const sourceMatch = html.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)/i);
    if (sourceMatch) return sourceMatch[1];

    return null;
}

module.exports = {
    parseSearchPage,
    parseDetailPage,
    parseTotalCount,
    parseSampleVideoUrl,
};
