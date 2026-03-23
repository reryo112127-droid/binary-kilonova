/**
 * パーサー単体テスト
 * 取得済みHTMLを使ってparseSearchPageの動作を検証
 */
const fs = require('fs');
const path = require('path');
const { parseSearchPage } = require('../lib/parser');

const HTML_PATH = path.join(__dirname, '..', 'search_page_node.html');

if (!fs.existsSync(HTML_PATH)) {
    console.error('テスト用HTMLファイルが見つかりません:', HTML_PATH);
    process.exit(1);
}

const html = fs.readFileSync(HTML_PATH, 'utf-8');
const { products, totalCount } = parseSearchPage(html);

console.log('=== パーサーテスト結果 ===\n');
console.log(`■ 総件数: ${totalCount.toLocaleString()}件`);
console.log(`■ 抽出された作品数: ${products.length}件\n`);

if (products.length === 0) {
    console.error('❌ 作品が1件も抽出できませんでした！');
    process.exit(1);
}

// 最初の3件の詳細を表示
console.log('--- 最初の3件 ---');
products.slice(0, 3).forEach((p, i) => {
    console.log(`\n[${i + 1}] ${p.product_id}`);
    console.log(`  タイトル: ${p.title ? p.title.slice(0, 60) + '...' : '(なし)'}`);
    console.log(`  出演者: ${p.actresses || '(なし)'}`);
    console.log(`  メイン画像: ${p.main_image_url ? '✅' : '❌'}`);
    console.log(`  サンプル画像: ${p.sample_images.length}枚`);
    console.log(`  サンプル動画: ${p.sample_video_url ? '✅' : '❌'}`);
});

// 集計
const withTitle = products.filter(p => p.title).length;
const withActress = products.filter(p => p.actresses).length;
const withMainImg = products.filter(p => p.main_image_url).length;
const withVideo = products.filter(p => p.sample_video_url).length;
const avgSampleImgs = (products.reduce((s, p) => s + p.sample_images.length, 0) / products.length).toFixed(1);

console.log('\n--- 集計 ---');
console.log(`  タイトルあり: ${withTitle}/${products.length}`);
console.log(`  出演者あり: ${withActress}/${products.length}`);
console.log(`  メイン画像あり: ${withMainImg}/${products.length}`);
console.log(`  サンプル動画あり: ${withVideo}/${products.length}`);
console.log(`  サンプル画像平均: ${avgSampleImgs}枚`);

if (withTitle === products.length && products.length >= 25) {
    console.log('\n✅ パーサーテスト合格！');
} else {
    console.log('\n⚠️  一部データが欠落しています。パーサーを確認してください。');
}
