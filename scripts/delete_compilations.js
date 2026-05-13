/**
 * Best版・総集編・オムニバス・リマスター版をDBから削除
 *
 * 対象: Turso FANZA DB / Turso MGS DB / ローカル fanza.db
 *
 * 実行:
 *   node scripts/delete_compilations.js           # 通常実行
 *   node scripts/delete_compilations.js --dry-run # 件数確認のみ
 */

const path = require('path');
const { createClient } = require('@libsql/client');
const Database = require('better-sqlite3');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DB_PATH = path.join(__dirname, '..', 'data', 'fanza.db');
const DRY_RUN = process.argv.includes('--dry-run');

const CONDITION = `(
    title LIKE '%BEST%'
    OR title LIKE '%ベスト%'
    OR title LIKE '%総集編%'
    OR title LIKE '%オムニバス%'
    OR title LIKE '%リマスター%'
)`;

const TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE ON products BEGIN
    INSERT INTO products_fts(products_fts, rowid, product_id, title, actresses, genres)
    VALUES('delete', old.rowid, old.product_id, old.title, old.actresses, old.genres);
    INSERT INTO products_fts(rowid, product_id, title, actresses, genres)
    VALUES (new.rowid, new.product_id, new.title, new.actresses, new.genres);
END`;

async function deleteTurso(label, url, token, hasFts) {
    const client = createClient({ url, authToken: token });

    const countRes = await client.execute(`SELECT COUNT(*) as n FROM products WHERE ${CONDITION}`);
    const count = Number(countRes.rows[0].n);
    const totalRes = await client.execute('SELECT COUNT(*) as n FROM products');
    const total = Number(totalRes.rows[0].n);
    console.log(`\n[${label}] 削除対象: ${count.toLocaleString()}件 / 全体: ${total.toLocaleString()}件`);

    if (DRY_RUN || count === 0) {
        client.close();
        return count;
    }

    // FTS5トリガーをDROP
    try { await client.execute('DROP TRIGGER IF EXISTS products_au'); } catch {}

    // FTS5から先に削除（products_fts はcontentテーブルなので手動削除が必要）
    if (hasFts) {
        try {
            const ids = (await client.execute(`SELECT product_id FROM products WHERE ${CONDITION}`)).rows.map(r => String(r.product_id));
            const CHUNK = 100;
            for (let i = 0; i < ids.length; i += CHUNK) {
                const chunk = ids.slice(i, i + CHUNK);
                const ph = chunk.map(() => '?').join(',');
                await client.execute({
                    sql: `INSERT INTO products_fts(products_fts, rowid, product_id, title, actresses, genres)
                          SELECT 'delete', rowid, product_id, title, actresses, genres
                          FROM products WHERE product_id IN (${ph})`,
                    args: chunk,
                });
                process.stdout.write(`  FTS5削除: ${Math.min(i + CHUNK, ids.length)}/${ids.length}\r`);
            }
            console.log('');
        } catch (e) {
            console.warn('  FTS5削除スキップ:', e.message);
        }
    }

    // products テーブルから削除（バッチ）
    let deleted = 0;
    while (true) {
        const res = await client.execute(`DELETE FROM products WHERE rowid IN (SELECT rowid FROM products WHERE ${CONDITION} LIMIT 500)`);
        deleted += res.rowsAffected || 0;
        process.stdout.write(`  削除中: ${deleted.toLocaleString()}件\r`);
        if ((res.rowsAffected || 0) < 500) break;
    }
    console.log(`\n  削除完了: ${deleted.toLocaleString()}件`);

    // FTS5 rebuild
    if (hasFts) {
        try {
            console.log('  FTS5 rebuild中...');
            await client.execute("INSERT INTO products_fts(products_fts) VALUES('rebuild')");
            console.log('  FTS5 rebuild完了');
        } catch (e) {
            console.warn('  FTS5 rebuild失敗:', e.message);
        }
    }

    // トリガー再CREATE
    try { await client.execute(TRIGGER_DDL); } catch {}

    client.close();
    return deleted;
}

function deleteLocal(label) {
    if (!fs.existsSync(DB_PATH)) {
        console.log(`\n[${label}] ローカルDB未存在 — スキップ`);
        return 0;
    }
    const db = new Database(DB_PATH);

    const count = db.prepare(`SELECT COUNT(*) as n FROM products WHERE ${CONDITION}`).get().n;
    const total = db.prepare('SELECT COUNT(*) as n FROM products').get().n;
    console.log(`\n[${label}] 削除対象: ${count.toLocaleString()}件 / 全体: ${total.toLocaleString()}件`);

    if (DRY_RUN || count === 0) {
        db.close();
        return count;
    }

    const res = db.prepare(`DELETE FROM products WHERE ${CONDITION}`).run();
    console.log(`  削除完了: ${res.changes.toLocaleString()}件`);

    // ローカルFTS5 rebuild（存在する場合）
    try {
        db.prepare("INSERT INTO products_fts(products_fts) VALUES('rebuild')").run();
        console.log('  ローカルFTS5 rebuild完了');
    } catch {}

    db.close();
    return res.changes;
}

async function main() {
    console.log('════════════════════════════════════════');
    console.log('  Best/総集編/オムニバス/リマスター 削除');
    console.log('════════════════════════════════════════');
    if (DRY_RUN) console.log('  [DRY RUN] 件数確認のみ');
    console.log('');
    console.log('  削除条件:');
    console.log('    title LIKE BEST / ベスト / 総集編 / オムニバス / リマスター');

    const results = {};

    results.fanza = await deleteTurso(
        'Turso FANZA',
        process.env.TURSO_FANZA_URL,
        process.env.TURSO_FANZA_TOKEN,
        true
    );
    results.mgs = await deleteTurso(
        'Turso MGS',
        process.env.TURSO_MGS_URL,
        process.env.TURSO_MGS_TOKEN,
        true
    );
    results.local = deleteLocal('ローカル fanza.db');

    console.log('\n════════════════════════════════════════');
    console.log(DRY_RUN ? '  [DRY RUN] 削除予定件数' : '  完了');
    console.log('════════════════════════════════════════');
    console.log(`  Turso FANZA: ${results.fanza.toLocaleString()}件`);
    console.log(`  Turso MGS:   ${results.mgs.toLocaleString()}件`);
    console.log(`  ローカルDB:  ${results.local.toLocaleString()}件`);
    console.log('');
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
