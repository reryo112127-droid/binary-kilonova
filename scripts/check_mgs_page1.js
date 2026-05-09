/**
 * MGS検索page1の実際の内容とTurso DBを突き合わせる診断スクリプト
 * 使い方: node scripts/check_mgs_page1.js
 */
const { createClient } = require('@libsql/client');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', 'site', '.env.local') });

const { fetchPage } = require('../lib/fetcher');
const { parseSearchPage } = require('../lib/parser');

async function main() {
    const url   = process.env.TURSO_MGS_URL;
    const token = process.env.TURSO_MGS_TOKEN;
    if (!url || !token) { console.error('TURSO_MGS_URL/TOKEN 未設定'); process.exit(1); }

    const db = createClient({ url, authToken: token });

    // Tursoから既知ID取得（CI環境と同じロジック）
    console.log('Tursoから既知ID取得中...');
    const r = await db.execute(
        'SELECT product_id FROM products ORDER BY scraped_at DESC LIMIT 3000'
    );
    const knownIds = new Set(r.rows.map(row => String(row[0])));
    console.log(`既知ID: ${knownIds.size}件\n`);

    // MGS search page 1を取得
    const searchUrl = 'https://www.mgstage.com/search/cSearch.php?search_word=&sort=new&list_cnt=30&page=1';
    console.log(`取得中: ${searchUrl}`);
    const html = await fetchPage(searchUrl);
    const { products, totalCount } = parseSearchPage(html);
    console.log(`総件数: ${totalCount.toLocaleString()}タイトル`);
    console.log(`ページ1取得件数: ${products.length}件\n`);

    if (products.length === 0) {
        console.log('❌ ページ1で商品が取得できませんでした（HTMLパース失敗 or ブロック）');
        // HTMLの先頭500文字を表示してデバッグ
        console.log('\nHTML先頭500文字:');
        console.log(html.slice(0, 500));
        db.close();
        return;
    }

    // 各作品がknownかどうかチェック
    console.log('--- page 1 の作品一覧 ---');
    let newCount = 0;
    let knownCount = 0;
    for (const p of products) {
        const isKnown = knownIds.has(String(p.product_id));
        if (!isKnown) newCount++;
        else knownCount++;
        const status = isKnown ? '既知' : '★新作';
        console.log(`  [${status}] ${p.product_id}  ${String(p.title || '').slice(0, 35)}`);
    }
    console.log(`\n新作: ${newCount}件 / 既知: ${knownCount}件`);

    if (newCount > 0) {
        console.log('\n⚠️  新作が検出されているのにTursoに追加されていない → スクレイパーのバグ');
    } else {
        console.log('\nℹ️  page 1 の全作品が既知 → KNOWN_THRESHOLD で早期終了は正常動作');
    }

    // page 2も確認
    console.log('\npage 2 を確認中...');
    const searchUrl2 = 'https://www.mgstage.com/search/cSearch.php?search_word=&sort=new&list_cnt=30&page=2';
    const html2 = await fetchPage(searchUrl2);
    const { products: products2 } = parseSearchPage(html2);
    let newCount2 = 0;
    for (const p of products2) {
        const isKnown = knownIds.has(String(p.product_id));
        if (!isKnown) {
            newCount2++;
            console.log(`  [★新作] ${p.product_id}  ${String(p.title || '').slice(0, 35)}`);
        }
    }
    if (newCount2 === 0) console.log('  page 2 も全て既知');
    console.log(`page 2: 新作 ${newCount2}件 / 既知 ${products2.length - newCount2}件`);

    db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
