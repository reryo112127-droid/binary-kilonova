const fs = require('fs');
const initSqlJs = require('sql.js');

const DMM_API_ID = 'sXmYFJnNNfqnZ0WbB2Tc';
const DMM_AFFILIATE_ID = 'desireav-990';

// APIコール間のウェイト（DMM API制限対策）
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchFanzaByTitle(title) {
    // タイトルが長すぎると検索に引っかかりにくいため、最初の20文字程度を使ってみる（またはそのまま）
    // DMMのkeyword検索はAND検索になるため、長すぎるとノイズでヒットしないかもしれない
    const searchWord = title.length > 30 ? title.substring(0, 30) : title;
    
    const url = `https://api.dmm.com/affiliate/v3/ItemList?api_id=${DMM_API_ID}&affiliate_id=${DMM_AFFILIATE_ID}&site=FANZA&service=digital&floor=videoa&hits=1&keyword=${encodeURIComponent(searchWord)}&output=json`;
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        if(data.result && data.result.items && data.result.items.length) {
            const item = data.result.items[0];
            return item.iteminfo.actress ? item.iteminfo.actress.map(a => a.name) : null;
        }
    } catch (e) {
        // error
    }
    return null;
}

async function main() {
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync('data/mgs.db'));
    
    // パラダイステレビ、俺の素人の出演者不明作品を取得
    const queries = db.exec("SELECT product_id, title, maker FROM products WHERE (maker LIKE '%パラダイステレビ%' OR maker LIKE '%俺の素人%') AND (actresses IS NULL OR actresses = '') LIMIT 60;");
    
    let hitCount = 0;
    
    if(queries.length > 0) {
        const rows = queries[0].values;
        for (const [pid, title, maker] of rows) {
            const resultActresses = await fetchFanzaByTitle(title);
            if (resultActresses && resultActresses.length > 0) {
                console.log(`[HIT] ${pid} (${maker})`);
                console.log(`      Title: ${title.substring(0, 40)}...`);
                console.log(`      Found Actresses: ${resultActresses.join(', ')}\n`);
                hitCount++;
            } else {
                console.log(`[Miss] ${pid} (${maker}) - ${title.substring(0, 30)}...`);
            }
            await sleep(500); // 0.5s wait
        }
    }
    
    console.log(`\n================================`);
    console.log(` Tested: 20, Hits: ${hitCount}`);
    console.log(`================================`);
}

main().catch(console.error);
