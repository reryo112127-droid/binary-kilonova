/**
 * FANZAの「人気順(sort=rank=売上/人気)」を収集し、作品ごとの人気スコア(0..1)を出力する。
 * MGSは wish_count(お気に入り)で人気を測れるが、FANZAのお気に入り/売上数はAPIに無い。
 * 代わりにDMMの人気順(rank)の順位を人気指標として使い、レビューと併せてランキングを両PF公平にする。
 *   node scripts/build_fanza_popularity.js [--per 3000]
 * 出力: data/fanza_popularity.json + site/public/data/fanza_popularity.json
 *   { "<content_id>": <rankScore 0..1>, ... }  (1.0=最も人気 / 上位ほど高い)
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');
const OUT = [path.join(ROOT, 'data', 'fanza_popularity.json'), path.join(ROOT, 'site', 'public', 'data', 'fanza_popularity.json')];
const API_ID = process.env.DMM_API_ID, AFF_ID = process.env.DMM_AFFILIATE_ID;
const PER = (() => { const i = process.argv.indexOf('--per'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : 3000; })();
const FLOORS = ['videoa', 'videoc'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchFloor(floor, n, scores) {
    let captured = 0;
    for (let off = 1; off <= n; off += 100) {
        const p = new URLSearchParams({ api_id: API_ID, affiliate_id: AFF_ID, site: 'FANZA', service: 'digital', floor, output: 'json', hits: '100', sort: 'rank', offset: String(off) });
        let items = [];
        try {
            const r = await fetch('https://api.dmm.com/affiliate/v3/ItemList?' + p);
            const d = await r.json();
            items = d.result?.items || [];
        } catch (e) { console.warn(`  ${floor} offset=${off}: ${e.message}`); }
        if (!items.length) break;
        items.forEach((it, i) => {
            const pos = off + i;                 // 1-based 人気順位
            const score = Math.max(0, (n - pos + 1) / n); // 0..1 (上位ほど高い)
            const cid = it.content_id;
            // 同一作品が複数floorに出る場合は高い方を採用
            if (cid && (!(cid in scores) || score > scores[cid])) scores[cid] = Math.round(score * 1000) / 1000;
        });
        captured += items.length;
        await sleep(300);
    }
    console.log(`  ${floor}: ${captured}件`);
}

(async () => {
    if (!API_ID || !AFF_ID) throw new Error('DMM_API_ID / DMM_AFFILIATE_ID 未設定(.env)');
    const scores = {};
    for (const f of FLOORS) await fetchFloor(f, PER, scores);
    const json = JSON.stringify(scores);
    for (const p of OUT) fs.writeFileSync(p, json);
    console.log(`✅ FANZA人気スコア: ${Object.keys(scores).length}作品 (${(json.length / 1024).toFixed(0)}KB)`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
