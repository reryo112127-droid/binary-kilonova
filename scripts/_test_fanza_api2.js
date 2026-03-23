const DMM_API_ID = 'sXmYFJnNNfqnZ0WbB2Tc';
const DMM_AFFILIATE_ID = 'desireav-990';

async function search(kw) {
    const url = `https://api.dmm.com/affiliate/v3/ItemList?api_id=${DMM_API_ID}&affiliate_id=${DMM_AFFILIATE_ID}&site=FANZA&service=digital&floor=videoa&hits=1&keyword=${encodeURIComponent(kw)}&output=json`;
    console.log(`\n--- Searching: ${kw} ---`);
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.result && data.result.items && data.result.items.length > 0) {
            const item = data.result.items[0];
            console.log('Title:', item.title);
            console.log('Content ID:', item.content_id);
            console.log('Actresses:', item.iteminfo && item.iteminfo.actress ? item.iteminfo.actress.map(a => a.name) : 'None');
            console.log('Genres:', item.iteminfo && item.iteminfo.genre ? item.iteminfo.genre.map(g => g.name) : 'None');
        } else {
            console.log('Not found');
        }
    } catch (e) {
        console.error('Error:', e.message);
    }
}

async function main() {
    await search('ABW-153');
    await search('118abw00153');
    await search('PPT-116');
    await search('TRE-170');
}

main();
