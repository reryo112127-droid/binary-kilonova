const url = require('url');

const DMM_API_ID = 'sXmYFJnNNfqnZ0WbB2Tc';
const DMM_AFFILIATE_ID = 'desireav-990';

async function search(kw) {
    const u = `https://api.dmm.com/affiliate/v3/ItemList?api_id=${DMM_API_ID}&affiliate_id=${DMM_AFFILIATE_ID}&site=FANZA&service=digital&floor=videoa&hits=1&keyword=${encodeURIComponent(kw)}&output=json`;
    console.log(`\n=== Keyword: ${kw} ===`);
    try {
        const res = await fetch(u);
        const data = await res.json();
        if(data.result && data.result.items && data.result.items.length) {
            const item = data.result.items[0];
            console.log('Title:', item.title);
            console.log('ContentID:', item.content_id);
            console.log('Actresses:', item.iteminfo.actress ? item.iteminfo.actress.map(a=>`${a.name}(${a.id})`).join(', ') : 'none');
            console.log('Genres:', item.iteminfo.genre ? item.iteminfo.genre.map(g=>`${g.name}(${g.id})`).join(', ') : 'none');
        } else {
            console.log('Not found');
        }
    } catch (e) {
        console.error('Error:', e.message);
    }
}

async function searchByCid(cid) {
    const u = `https://api.dmm.com/affiliate/v3/ItemList?api_id=${DMM_API_ID}&affiliate_id=${DMM_AFFILIATE_ID}&site=FANZA&service=digital&floor=videoa&hits=1&cid=${encodeURIComponent(cid)}&output=json`;
    console.log(`\n=== CID: ${cid} ===`);
    try {
        const res = await fetch(u);
        const data = await res.json();
        if(data.result && data.result.items && data.result.items.length) {
            const item = data.result.items[0];
            console.log('Title:', item.title);
            console.log('Actresses:', item.iteminfo.actress ? item.iteminfo.actress.map(a=>`${a.name}(${a.id})`).join(', ') : 'none');
            console.log('Genres:', item.iteminfo.genre ? item.iteminfo.genre.map(g=>`${g.name}(${g.id})`).join(', ') : 'none');
        } else {
            console.log('Not found');
        }
    } catch (e) {
        console.error('Error:', e.message);
    }
}

async function main() {
    await searchByCid('530orecz00448'); // 230ORECZ-448 is probably 530orecz00448 or 53orecz448 etc.
    await search('ORECZ-448'); // partial
    await search('雪代さんと秋元さん');
    await search('083PPP-3353');
    await search('83ppp03353');
    await search('還暦超えの熟女が在籍する中●し天国の六十路デリヘル(4)');
}

main();
