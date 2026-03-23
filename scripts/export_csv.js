/**
 * CSVエクスポートユーティリティ
 * 
 * 使い方:
 *   node scripts/export_csv.js                        # 全件エクスポート
 *   node scripts/export_csv.js --exclude-long          # 600分以上を除外
 *   node scripts/export_csv.js --output my_export.csv  # 出力ファイル指定
 */
const fs = require('fs');
const path = require('path');
const db = require('../db/database');

async function main() {
    const args = process.argv.slice(2);
    const excludeLong = args.includes('--exclude-long');
    const outputIdx = args.indexOf('--output');
    const outputFile = outputIdx >= 0 ? args[outputIdx + 1] : path.join(__dirname, '..', 'data', 'mgs_export.csv');

    await db.init();

    const products = db.getAllProducts(excludeLong);
    console.log(`エクスポート対象: ${products.length.toLocaleString()}件`);
    if (excludeLong) {
        console.log('  ※ 600分以上の作品（BEST・総集編）を除外');
    }

    // CSV生成
    const headers = [
        'product_id', 'title', 'actresses', 'maker', 'label',
        'duration_min', 'main_image_url', 'sample_images_json',
        'sample_video_url', 'detail_scraped', 'scraped_at', 'updated_at'
    ];

    const csvLines = [headers.join(',')];

    for (const p of products) {
        const row = headers.map(h => {
            const val = p[h];
            if (val == null) return '';
            const str = String(val);
            // CSVエスケープ: ダブルクォート、カンマ、改行を含む場合
            if (str.includes('"') || str.includes(',') || str.includes('\n')) {
                return '"' + str.replace(/"/g, '""') + '"';
            }
            return str;
        });
        csvLines.push(row.join(','));
    }

    // ディレクトリ作成
    const dir = path.dirname(outputFile);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // BOM付きUTF-8で保存（Excelで文字化けしない）
    const bom = '\uFEFF';
    fs.writeFileSync(outputFile, bom + csvLines.join('\n'), 'utf-8');

    console.log(`✅ CSVファイルを保存しました: ${outputFile}`);
    console.log(`   ${csvLines.length - 1}件のレコード`);

    db.close();
}

main().catch((err) => {
    console.error('エラー:', err);
    process.exit(1);
});
