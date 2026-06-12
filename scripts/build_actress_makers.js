/**
 * D1(FANZA両シャード+MGS)の全作品から「女優名 → 出演メーカー数」を構築して
 * data/actress_makers.json に保存する。女優ランキングで同名別人の混在汎用名
 * （ちな/いちか等＝多数メーカーにまたがる）を除外する判定に使う。
 * ローカルDBは出演者が古い(スクレイプはD1のみ更新)ため、D1から集計する。
 *   node scripts/build_actress_makers.js
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { d1 } = require('./lib/d1.js');

const OUT = path.join(__dirname, '..', 'data', 'actress_makers.json');

async function scan(client, label, nameMakers) {
    const PAGE = 8000;
    let total = 0;
    for (let off = 0; ; off += PAGE) {
        let r;
        for (let a = 0; a < 5; a++) {
            try { r = await client.execute({ sql: `SELECT actresses, maker FROM products WHERE actresses IS NOT NULL AND actresses <> '' AND maker IS NOT NULL AND maker <> '' LIMIT ? OFFSET ?`, args: [PAGE, off] }); break; }
            catch (e) { if (/429|CPU/.test(e.message) && a < 4) { await new Promise(x => setTimeout(x, 4000 * (a + 1))); continue; } throw e; }
        }
        for (const row of r.rows) {
            const mk = String(row.maker);
            for (const nm of String(row.actresses).split(/,|、/).map(s => s.trim()).filter(Boolean)) {
                let set = nameMakers.get(nm);
                if (!set) { set = new Set(); nameMakers.set(nm, set); }
                set.add(mk);
            }
        }
        total += r.rows.length;
        process.stdout.write(`  ${label}: ${total}\r`);
        if (r.rows.length < PAGE) break;
    }
    console.log(`\n  ${label} 完了: ${total}件`);
}

(async () => {
    const nameMakers = new Map();
    await scan(d1('fanza-0'), 'FANZA shard0', nameMakers);
    await scan(d1('fanza-1'), 'FANZA shard1', nameMakers);
    await scan(d1('mgs'), 'MGS', nameMakers);
    // name -> メーカー数（2社以上のみ保存してファイルを軽量化。1社は曖昧判定に不要）
    const out = {};
    for (const [nm, set] of nameMakers) if (set.size >= 2) out[nm] = set.size;
    fs.writeFileSync(OUT, JSON.stringify(out));
    console.log(`✅ ${Object.keys(out).length}名 → ${OUT}`);
    // サンプル
    for (const n of ['ちな', 'いちか', 'みちる', 'あいな', '涼森れむ', '鈴村あいり']) console.log('  ', n, ':', out[n] ?? '(1社以下)');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
