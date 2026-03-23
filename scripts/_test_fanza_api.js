const fs = require('fs');

const DMM_API_ID = 'sXmYFJnNNfqnZ0WbB2Tc';
const DMM_AFFILIATE_ID = 'desireav-990';

async function fetchFanzaProduct(cid) {
    const url = `https://api.dmm.com/affiliate/v3/ItemList?api_id=${DMM_API_ID}&affiliate_id=${DMM_AFFILIATE_ID}&site=FANZA&service=digital&floor=videoa&hits=1&cid=${cid}&output=json`;
    console.log('Querying:', url);
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.result && data.result.items && data.result.items.length > 0) {
            console.log(JSON.stringify(data.result.items[0], null, 2));
        } else {
            console.log('Product not found in FANZA:', cid);
        }
    } catch (e) {
        console.error('API Error:', e.message);
    }
}

// プレステージ等の品番をFANZAのcid形式に変換（例: ABW-153 -> 118abw00153）
// FANZAのcidはだいたい (メーカーコード)(英字)(数字5桁) 的なルールだけど、品番そのまま(小文字・ハイフンなし)でヒットすることも多い
function toFanzaCid(pid) {
    return pid.toLowerCase().replace('-', '00'); // 雑な変換。正確なプレステージの法則は 118abw00153 など。
}

async function main() {
    // 適当なプレステージの素人作品っぽい品番（例として先ほどマッチした涼森れむの ABW-153 などを試す）
    // プレステージの ABW-153 はFANZAでは 118abw00153
    await fetchFanzaProduct('118abw00153');
    
    // もう一つ、適当なキーワード検索も試す (涼森れむ の品番を取得してみる)
    const keywordUrl = `https://api.dmm.com/affiliate/v3/ItemList?api_id=${DMM_API_ID}&affiliate_id=${DMM_AFFILIATE_ID}&site=FANZA&service=digital&floor=videoa&hits=1&keyword=${encodeURIComponent('涼森れむ')}&output=json`;
    console.log('\nQuerying Keyword:', keywordUrl);
    try {
        const res = await fetch(keywordUrl);
        const data = await res.json();
        if (data.result && data.result.items && data.result.items.length > 0) {
            console.log('Sample Item from Keyword Search:');
            console.log(JSON.stringify(data.result.items[0].iteminfo, null, 2));
        }
    } catch (e) {
        console.error('API Error:', e.message);
    }
}

main();
