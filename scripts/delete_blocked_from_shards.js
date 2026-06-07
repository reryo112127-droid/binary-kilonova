/**
 * blocked_makers.json のメーカー作品を FANZA D1 2シャードから削除する。
 * D1のCPU時間制限を避けるため、products_ad(FTS削除)トリガを一旦止め、product_idを小分けDELETE。
 * 残るFTS空エントリは products との結合で除外され無害。
 *   node scripts/delete_blocked_from_shards.js
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { d1 } = require('./lib/d1.js');
const { FANZA_SHARDS } = require('./lib/shard.cjs');

const blocked = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'blocked_makers.json'), 'utf-8')).makers || [];

const PRODUCTS_AD = `CREATE TRIGGER IF NOT EXISTS products_ad AFTER DELETE ON products BEGIN
    DELETE FROM products_fts WHERE product_id = old.product_id;
END`;

(async () => {
    for (let s = 0; s < FANZA_SHARDS; s++) {
        const db = d1(`fanza-${s}`);
        // 対象 product_id を収集。makerが多いとバインド上限(100)超のため80社ずつ分割。
        const ids = [];
        const PAGE = 5000;
        const MK = 80;
        for (let mi = 0; mi < blocked.length; mi += MK) {
            const mchunk = blocked.slice(mi, mi + MK);
            const mph = mchunk.map(() => '?').join(',');
            for (let off = 0; ; off += PAGE) {
                const r = await db.execute({ sql: `SELECT product_id FROM products WHERE maker IN (${mph}) LIMIT ? OFFSET ?`, args: [...mchunk, PAGE, off] });
                ids.push(...r.rows.map(x => String(x.product_id)));
                if (r.rows.length < PAGE) break;
            }
        }
        console.log(`[shard ${s}] 削除対象: ${ids.length.toLocaleString()} 件`);
        if (ids.length === 0) continue;

        // FTS削除トリガを止める（CPU/容量対策。空FTSは無害）
        await db.execute('DROP TRIGGER IF EXISTS products_ad');
        let done = 0;
        const CH = 90; // バインド上限(100)内
        try {
            for (let i = 0; i < ids.length; i += CH) {
                const chunk = ids.slice(i, i + CH);
                const ph = chunk.map(() => '?').join(',');
                await db.execute({ sql: `DELETE FROM products WHERE product_id IN (${ph})`, args: chunk });
                done += chunk.length;
                if (done % 1800 === 0) process.stdout.write(`  shard ${s}: ${done}/${ids.length}\r`);
            }
        } finally {
            await db.execute(PRODUCTS_AD);
        }
        console.log(`\n[shard ${s}] ✅ 削除完了: ${done.toLocaleString()} 件`);
    }
    console.log('\n全シャード削除完了。次: キャッシュ再生成 → デプロイ');
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
