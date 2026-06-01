/**
 * FANZAのproductsテーブルにfloorカラムを追加し既存データをバックフィルする
 * floor: 'videoa'（企業作品）/ 'videoc'（素人）
 *
 * 使い方:
 *   node scripts/add_floor_column.js          # ローカルDB + Turso 両方
 *   node scripts/add_floor_column.js --local  # ローカルDBのみ
 *   node scripts/add_floor_column.js --turso  # Tursoのみ
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs   = require('fs');
const { createClient } = require('@libsql/client');

const DB_PATH = path.join(__dirname, '..', 'data', 'fanza.db');
const args = process.argv.slice(2);
const LOCAL_ONLY = args.includes('--local');
const TURSO_ONLY = args.includes('--turso');

// 素人判定パターン（メーカー名・レーベル名に含まれる場合はvideoc）
const VIDEOC_PATTERNS = [
    '素人', 'シロウト', 'ナンパ', 'ガチ素人', '白完素人',
    '投稿', 'S級素人', '俺の素人', '真実の口', 'えろ素人',
    'リアル素人', 'アマチュア',
];
const buildLikeConditions = () => {
    const conds = VIDEOC_PATTERNS.flatMap(p => [
        `maker LIKE '%${p}%'`,
        `label LIKE '%${p}%'`,
    ]);
    return conds.join(' OR ');
};

// ── ローカルDB ──────────────────────────────────────────────────
async function migrateLocal() {
    if (!fs.existsSync(DB_PATH)) { console.log('ローカルDB未検出。スキップ。'); return; }
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH);

    // カラム存在チェック
    const cols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
    if (!cols.includes('floor')) {
        db.prepare('ALTER TABLE products ADD COLUMN floor TEXT').run();
        console.log('[local] floor カラム追加完了');
    } else {
        console.log('[local] floor カラムは既に存在');
    }

    // バックフィル: 素人判定パターン → videoc
    const likeWhere = buildLikeConditions();
    const r1 = db.prepare(`UPDATE products SET floor = 'videoc' WHERE floor IS NULL AND (${likeWhere})`).run();
    console.log(`[local] videoc バックフィル: ${r1.changes}件`);

    // 残り → videoa
    const r2 = db.prepare(`UPDATE products SET floor = 'videoa' WHERE floor IS NULL`).run();
    console.log(`[local] videoa バックフィル: ${r2.changes}件`);

    // 結果確認
    const counts = db.prepare(`SELECT floor, COUNT(*) as n FROM products GROUP BY floor`).all();
    console.log('[local] 結果:', counts.map(r => `${r.floor}: ${r.n.toLocaleString()}件`).join(', '));

    db.close();
    console.log('[local] 完了');
}

// ── Turso ──────────────────────────────────────────────────────
async function migrateTurso() {
    const url   = process.env.TURSO_FANZA_URL;
    const token = process.env.TURSO_FANZA_TOKEN;
    if (!url || !token) { console.error('TURSO_FANZA_URL / TOKEN 未設定'); return; }

    const turso = createClient({ url, authToken: token });

    // カラム追加（既に存在するとエラーになるので無視）
    try {
        await turso.execute('ALTER TABLE products ADD COLUMN floor TEXT');
        console.log('[turso] floor カラム追加完了');
    } catch (e) {
        if (e.message.includes('duplicate column')) {
            console.log('[turso] floor カラムは既に存在');
        } else {
            console.error('[turso] ALTER TABLE エラー:', e.message);
            return;
        }
    }

    // FTS5トリガーを一時無効化（大量UPDATEでエラーになるため）
    try { await turso.execute('DROP TRIGGER IF EXISTS products_au'); } catch {}

    const likeWhere = buildLikeConditions();

    // videoc バックフィル（分割して実行）
    console.log('[turso] videoc バックフィル中...');
    let videocTotal = 0;
    let offset = 0;
    const BATCH = 500;
    while (true) {
        const result = await turso.execute({
            sql: `SELECT product_id FROM products WHERE floor IS NULL AND (${likeWhere}) LIMIT ${BATCH}`,
            args: [],
        });
        if (result.rows.length === 0) break;
        const ids = result.rows.map(r => String(r.product_id));
        const placeholders = ids.map(() => '?').join(',');
        await turso.execute({
            sql: `UPDATE products SET floor = 'videoc' WHERE product_id IN (${placeholders})`,
            args: ids,
        });
        videocTotal += ids.length;
        process.stdout.write(`  videoc: ${videocTotal}件\r`);
        if (ids.length < BATCH) break;
    }
    console.log(`\n[turso] videoc バックフィル: ${videocTotal}件`);

    // videoa バックフィル
    console.log('[turso] videoa バックフィル中...');
    let videoaTotal = 0;
    while (true) {
        const result = await turso.execute({
            sql: `SELECT product_id FROM products WHERE floor IS NULL LIMIT ${BATCH}`,
            args: [],
        });
        if (result.rows.length === 0) break;
        const ids = result.rows.map(r => String(r.product_id));
        const placeholders = ids.map(() => '?').join(',');
        await turso.execute({
            sql: `UPDATE products SET floor = 'videoa' WHERE product_id IN (${placeholders})`,
            args: ids,
        });
        videoaTotal += ids.length;
        process.stdout.write(`  videoa: ${videoaTotal}件\r`);
        if (ids.length < BATCH) break;
    }
    console.log(`\n[turso] videoa バックフィル: ${videoaTotal}件`);

    console.log('[turso] 完了');
}

// ── メイン ──────────────────────────────────────────────────────
(async () => {
    if (!TURSO_ONLY) await migrateLocal();
    if (!LOCAL_ONLY) await migrateTurso();
    console.log('\n全完了。');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
