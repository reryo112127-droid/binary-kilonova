/**
 * 全メーカー一覧収集スクリプト
 * 50音別ページを巡回して全メーカー名と検索パラメータを収集
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { fetchPage, politeWait } = require('../lib/fetcher');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MAKERS_PATH = path.join(DATA_DIR, 'makers_all.json');

// 50音別ページID
const PAGE_IDS = ['osusume', 'a', 'ka', 'sa', 'ta', 'na', 'ha', 'ma', 'ya', 'ra', 'wa'];

async function main() {
    console.log('========================================');
    console.log('  MGS動画 全メーカー一覧収集');
    console.log('========================================\n');

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    const allMakers = new Map(); // name -> search_param (重複排除)

    for (const id of PAGE_IDS) {
        const url = `https://www.mgstage.com/ppv/makers.php?id=${id}`;
        console.log(`[${id}] ${url}`);

        const html = await fetchPage(url);
        const $ = cheerio.load(html);

        // メーカーリンクを抽出: maker[]= または label[]= パラメータを含むリンク
        $('a[href*="cSearch.php"]').each((_, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text().trim().replace(/^【[^】]+】/, '').replace(/^\[独占\]/, '').trim();

            // maker[] パラメータを抽出
            const makerMatch = href.match(/maker\[\]=([^&]+)/);
            const labelMatch = href.match(/label\[\]=([^&]+)/);

            if (makerMatch) {
                const param = decodeURIComponent(makerMatch[1]);
                const name = param.replace(/_0$/, '');
                if (name && !allMakers.has(name)) {
                    allMakers.set(name, { name, type: 'maker', search_param: `maker[]=${makerMatch[1]}` });
                }
            } else if (labelMatch) {
                const param = decodeURIComponent(labelMatch[1]);
                const name = param.replace(/_0$/, '');
                if (name && !allMakers.has(name)) {
                    allMakers.set(name, { name, type: 'label', search_param: `label[]=${labelMatch[1]}` });
                }
            }
        });

        console.log(`  → 累計: ${allMakers.size} メーカー/レーベル`);
        await politeWait();
    }

    // JSON保存
    const makerList = Array.from(allMakers.values());
    fs.writeFileSync(MAKERS_PATH, JSON.stringify(makerList, null, 2), 'utf-8');

    console.log(`\n✅ 合計 ${makerList.length} メーカー/レーベルを保存`);
    console.log(`   メーカー: ${makerList.filter(m => m.type === 'maker').length}`);
    console.log(`   レーベル: ${makerList.filter(m => m.type === 'label').length}`);
    console.log(`   保存先: ${MAKERS_PATH}`);
}

main().catch(err => {
    console.error('エラー:', err);
    process.exit(1);
});
