/**
 * 30分未満の作品をMGS・FANZAのTurso DBから削除するワンタイムスクリプト
 *
 * 実行:
 *   node scripts/delete_short_products.js          -- 件数確認のみ（dry run）
 *   node scripts/delete_short_products.js --delete  -- 実際に削除
 */
const { createClient } = require('@libsql/client');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', 'site', '.env.local') });

const DRY_RUN = !process.argv.includes('--delete');
const MIN_DURATION = 30;

async function processDb(label, url, token) {
    if (!url || !token) {
        console.error(`[${label}] 環境変数未設定 — スキップ`);
        return;
    }

    const db = createClient({ url, authToken: token });

    // 件数確認
    const countRes = await db.execute({
        sql: `SELECT COUNT(*) as cnt FROM products WHERE duration_min IS NOT NULL AND duration_min < ?`,
        args: [MIN_DURATION],
    });
    const count = Number(countRes.rows[0].cnt);
    console.log(`[${label}] duration_min < ${MIN_DURATION}分: ${count.toLocaleString()}件`);

    if (count === 0) {
        console.log(`[${label}] 削除対象なし`);
        db.close();
        return;
    }

    // サンプル表示
    const sampleRes = await db.execute({
        sql: `SELECT product_id, title, duration_min FROM products WHERE duration_min IS NOT NULL AND duration_min < ? ORDER BY duration_min LIMIT 10`,
        args: [MIN_DURATION],
    });
    console.log(`[${label}] サンプル（先頭10件）:`);
    for (const r of sampleRes.rows) {
        console.log(`  ${r.product_id}  ${r.duration_min}分  ${String(r.title).slice(0, 40)}`);
    }

    if (DRY_RUN) {
        console.log(`[${label}] DRY RUN — 実際に削除するには --delete オプションを付けて実行してください\n`);
        db.close();
        return;
    }

    // 削除
    console.log(`[${label}] 削除中...`);
    const deleteRes = await db.execute({
        sql: `DELETE FROM products WHERE duration_min IS NOT NULL AND duration_min < ?`,
        args: [MIN_DURATION],
    });
    console.log(`[${label}] ✅ ${deleteRes.rowsAffected}件 削除完了`);

    // FTS5再構築
    try {
        await db.execute("INSERT INTO products_fts(products_fts) VALUES('rebuild')");
        console.log(`[${label}] FTS5再構築完了`);
    } catch (e) {
        console.warn(`[${label}] FTS5再構築スキップ: ${e.message}`);
    }

    db.close();
}

(async () => {
    if (DRY_RUN) console.log('=== DRY RUN（確認のみ）=== --delete を付けると実際に削除します\n');
    else         console.log('=== 削除実行 ===\n');

    await processDb('MGS',   process.env.TURSO_MGS_URL,   process.env.TURSO_MGS_TOKEN);
    await processDb('FANZA', process.env.TURSO_FANZA_URL, process.env.TURSO_FANZA_TOKEN);

    console.log('\n完了');
})();
