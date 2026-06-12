/**
 * 全作品の main_image_url を「顔が出る正しいバリアント」に正規化する。
 *   MGS:    pb_e_(横長裏) → pf_e_(縦長表紙)
 *   FANZA素人: /digital/amateur/...jm.jpg → jp-001.jpg(実写1枚目)
 * ローカルDB(即時)とD1(チャンク・再開可能)の両方を更新。
 * D1の日次書込上限(10万/日)に達したら中断し、翌日の再実行で続きから完了する
 * （更新済み行は LIKE パターンに一致しなくなるため自動的にスキップされる）。
 *   node scripts/normalize_main_images.js
 */
const path = require('path');
const D = require('better-sqlite3');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { d1 } = require('./lib/d1.js');
const ROOT = path.join(__dirname, '..');

function localFix() {
    const mgs = new D(path.join(ROOT, 'data', 'mgs.db'));
    const m = mgs.prepare("UPDATE products SET main_image_url=REPLACE(main_image_url,'pb_e_','pf_e_') WHERE main_image_url LIKE '%pb_e_%'").run();
    mgs.close();
    console.log('ローカル mgs.db  pb_e_→pf_e_ :', m.changes, '件');
    const fz = new D(path.join(ROOT, 'data', 'fanza.db'));
    const f = fz.prepare("UPDATE products SET main_image_url=REPLACE(main_image_url,'jm.jpg','jp-001.jpg') WHERE main_image_url LIKE '%/digital/amateur/%jm.jpg'").run();
    fz.close();
    console.log('ローカル fanza.db jm→jp-001 :', f.changes, '件');
}

async function d1Normalize(client, label, likePat, fromStr, toStr) {
    const CHUNK = 10000;
    let total = 0;
    while (true) {
        let res;
        try {
            res = await client.execute({
                sql: `UPDATE products SET main_image_url=REPLACE(main_image_url,?,?) WHERE product_id IN (SELECT product_id FROM products WHERE main_image_url LIKE ? LIMIT ${CHUNK})`,
                args: [fromStr, toStr, likePat],
            });
        } catch (e) {
            if (/limit|exceeded|429|quota|too many|daily/i.test(e.message)) {
                console.log(`\n⏸ ${label}: 上限/エラーで中断（${total}件済）。翌日の再実行で続行。詳細: ${e.message}`);
                return false;
            }
            throw e;
        }
        const n = res.rowsAffected || 0;
        total += n;
        process.stdout.write(`  ${label}: ${total}件更新\r`);
        if (n === 0) break;
    }
    console.log(`\n✅ D1 ${label} 完了: ${total}件`);
    return true;
}

(async () => {
    console.log('=== Phase 1: ローカルDB（即時・無料） ===');
    localFix();

    console.log('=== Phase 2: D1（チャンク・再開可能） ===');
    const okMgs = await d1Normalize(d1('mgs'), 'MGS pb_e_→pf_e_', '%pb_e_%', 'pb_e_', 'pf_e_');
    let okFz = true;
    if (okMgs) {
        for (const sh of ['fanza-0', 'fanza-1']) {
            const ok = await d1Normalize(d1(sh), `FANZA素人 ${sh}`, '%/digital/amateur/%jm.jpg', 'jm.jpg', 'jp-001.jpg');
            if (!ok) { okFz = false; break; }
        }
    }
    console.log(okMgs && okFz ? '\n🎉 全件完了' : '\n⚠ 一部未完。明日 node scripts/normalize_main_images.js を再実行してください');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
