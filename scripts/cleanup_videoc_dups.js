/**
 * MGS と重複する FANZA videoc 作品を削除する（一度きりのクリーンアップ）。
 * 判定は scripts/lib/dedup.cjs（品番一致 + タイトル一致）。data/videoc_dedup_index.json が必要。
 *
 *   node scripts/cleanup_videoc_dups.js            # dry-run（件数のみ・削除しない）
 *   node scripts/cleanup_videoc_dups.js --apply    # ローカル fanza.db と D1(avrankings-fanza) から削除
 *
 * D1 の products_ad トリガが products_fts も自動削除する。
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { isDuplicate } = require('./lib/dedup.cjs');

const APPLY = process.argv.includes('--apply');
const FANZA_DB = path.join(__dirname, '..', 'data', 'fanza.db');
const INDEX    = path.join(__dirname, '..', 'data', 'videoc_dedup_index.json');

(async () => {
    if (!fs.existsSync(INDEX)) { console.error('先に node scripts/build_dedup_index.js を実行してください'); process.exit(1); }
    const index = JSON.parse(fs.readFileSync(INDEX, 'utf-8'));
    const { d1 } = require('./lib/d1.js');
    const fanza = fanzaShards();

    // D1(本番)の videoc を正として重複を導出（ローカルの削除状態に依存しない）
    const videoc = [];
    const PAGE = 5000;
    for (let off = 0; ; off += PAGE) {
        const r = await fanza.execute({ sql: "SELECT product_id, title FROM products WHERE floor='videoc' LIMIT ? OFFSET ?", args: [PAGE, off] });
        videoc.push(...r.rows);
        if (r.rows.length < PAGE) break;
    }
    const dupPids = videoc.filter(r => isDuplicate(r.product_id, r.title, index)).map(r => r.product_id);
    console.log(`D1 videoc総数: ${videoc.length.toLocaleString()} / 重複削除対象: ${dupPids.length.toLocaleString()}`);

    if (!APPLY) {
        console.log('\n[dry-run] 削除していません。--apply で実行します。サンプル:');
        dupPids.slice(0, 5).forEach(p => console.log('  ' + p));
        return;
    }

    // 1) D1(avrankings-fanza) から削除
    //    FTS削除トリガ(products_ad)を一時停止してから削除する。
    //    理由: trigram FTS の DELETE はトゥームストーンでDB一時肥大→「max DB size」超過するため。
    //    products行だけ削除すれば領域は減る。残るFTSの空エントリは products との結合で除外され無害。
    //    （バインド変数上限100のため CHUNK=90）
    await fanza.execute('DROP TRIGGER IF EXISTS products_ad');
    const CHUNK = 90;
    let done = 0;
    try {
        for (let i = 0; i < dupPids.length; i += CHUNK) {
            const chunk = dupPids.slice(i, i + CHUNK);
            const ph = chunk.map(() => '?').join(',');
            await fanza.execute({ sql: `DELETE FROM products WHERE product_id IN (${ph})`, args: chunk });
            done += chunk.length;
            process.stdout.write(`  D1削除: ${done}/${dupPids.length}\r`);
        }
    } finally {
        // トリガ復元（今後の単発削除でFTSを同期）
        await fanza.execute(`CREATE TRIGGER IF NOT EXISTS products_ad AFTER DELETE ON products BEGIN
            DELETE FROM products_fts WHERE product_id = old.product_id;
        END`);
    }
    console.log(`\n✅ D1(avrankings-fanza) から ${done.toLocaleString()} 件削除（FTS空エントリは無害・後で再構築可）`);

    // 2) ローカル fanza.db からも削除（存在すれば。冪等）
    if (fs.existsSync(FANZA_DB)) {
        const Database = require('better-sqlite3');
        const ldb = new Database(FANZA_DB);
        const del = ldb.prepare('DELETE FROM products WHERE product_id = ?');
        let lc = 0;
        const tx = ldb.transaction(ids => { for (const id of ids) lc += del.run(id).changes; });
        tx(dupPids);
        ldb.close();
        console.log(`✅ ローカル fanza.db から ${lc.toLocaleString()} 件削除`);
    }
    console.log('\n次: node site/scripts/generate-static-cache-local.mjs → cd site && npm run deploy:cf');
})().catch(e => { console.error(e); process.exit(1); });
