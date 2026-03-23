/**
 * 全女優一覧収集スクリプト
 * 50音別ページを巡回して全女優名と検索パラメータを収集
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { fetchPage, politeWait } = require('../lib/fetcher');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ACTRESSES_PATH = path.join(DATA_DIR, 'actresses_all.json');

// 50音別ページ (おすすめ + kana=1..10)
const PAGE_IDS = ['', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const PAGE_NAMES = ['おすすめ', 'あ行', 'か行', 'さ行', 'た行', 'な行', 'は行', 'ま行', 'や行', 'ら行', 'わ行'];

async function main() {
    console.log('========================================');
    console.log('  MGS動画 全女優一覧収集');
    console.log('========================================\n');

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    const allActresses = new Map();

    for (let i = 0; i < PAGE_IDS.length; i++) {
        const id = PAGE_IDS[i];
        const name = PAGE_NAMES[i];
        const url = id
            ? `https://www.mgstage.com/list/actress_list.php?kana=${id}`
            : 'https://www.mgstage.com/list/actress_list.php';
        console.log(`[${name}] ${url}`);

        const html = await fetchPage(url);
        const $ = cheerio.load(html);

        // actor[] パラメータを含むリンクから女優名を抽出
        $('a[href*="actor[]="]').each((_, el) => {
            const href = $(el).attr('href') || '';
            const actorMatch = href.match(/actor\[\]=([^&]+)/);
            if (!actorMatch) return;

            const encodedParam = actorMatch[1];
            const decodedName = decodeURIComponent(encodedParam).replace(/_0$/, '');

            if (decodedName && !allActresses.has(decodedName)) {
                allActresses.set(decodedName, {
                    name: decodedName,
                    search_param: `actor[]=${encodedParam}`,
                });
            }
        });

        console.log(`  → 累計: ${allActresses.size} 女優`);
        await politeWait();
    }

    // JSON保存
    const actressList = Array.from(allActresses.values());
    fs.writeFileSync(ACTRESSES_PATH, JSON.stringify(actressList, null, 2), 'utf-8');

    console.log(`\n✅ 合計 ${actressList.length} 女優を保存`);
    console.log(`   保存先: ${ACTRESSES_PATH}`);
}

main().catch(err => {
    console.error('エラー:', err);
    process.exit(1);
});
