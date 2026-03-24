/**
 * サジェストキャッシュ生成スクリプト
 *
 * - ローカル環境: mgs.db / fanza.db から抽出 → Turso + ファイルに保存
 * - CI環境(SQLiteなし): Turso DBから直接クエリ → Tursoに保存
 *
 * 実行: node scripts/build_suggest_cache.js
 */

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT   = path.join(DATA_DIR, 'suggest_cache.json');

// ---------- ローカルSQLite から抽出 ----------
function extractFromSqlite() {
    const Database = require('better-sqlite3');
    const MGS_DB   = path.join(DATA_DIR, 'mgs.db');
    const FANZA_DB = path.join(DATA_DIR, 'fanza.db');

    function fromDb(dbPath, label) {
        if (!fs.existsSync(dbPath)) {
            console.warn(`  [スキップ] ${label}: ファイルなし`);
            return { actresses: [], makers: [], labels: [], genres: [] };
        }
        const db = new Database(dbPath, { readonly: true });
        const actSet = new Set(), mkSet = new Set(), lbSet = new Set(), gnSet = new Set();

        db.prepare("SELECT DISTINCT maker FROM products WHERE maker IS NOT NULL AND maker != ''")
            .all().forEach(r => mkSet.add(r.maker.trim()));
        db.prepare("SELECT DISTINCT label FROM products WHERE label IS NOT NULL AND label != ''")
            .all().forEach(r => lbSet.add(r.label.trim()));

        db.prepare("SELECT actresses FROM products WHERE actresses IS NOT NULL AND actresses != ''")
            .all().forEach(({ actresses }) =>
                actresses.split(/[,\n]/).map(s => s.trim()).filter(Boolean).forEach(a => actSet.add(a)));

        db.prepare("SELECT genres FROM products WHERE genres IS NOT NULL AND genres != ''")
            .all().forEach(({ genres }) =>
                genres.split(/[,\n]/).map(s => s.trim()).filter(Boolean).forEach(g => gnSet.add(g)));

        db.close();
        console.log(`  ${label}: 女優 ${actSet.size.toLocaleString()} / メーカー ${mkSet.size} / レーベル ${lbSet.size} / ジャンル ${gnSet.size}`);
        return { actresses: [...actSet], makers: [...mkSet], labels: [...lbSet], genres: [...gnSet] };
    }

    const mgs   = fromDb(MGS_DB,   'MGS');
    const fanza = fromDb(FANZA_DB, 'FANZA');
    return {
        actresses: [...new Set([...mgs.actresses, ...fanza.actresses])].sort(),
        makers:    [...new Set([...mgs.makers,    ...fanza.makers])].sort(),
        labels:    [...new Set([...mgs.labels,    ...fanza.labels])].sort(),
        genres:    [...new Set([...mgs.genres,    ...fanza.genres])].sort(),
    };
}

// ---------- Turso から抽出（CI環境用） ----------
async function extractFromTurso(mgsDb, fanzaDb) {
    const split = rows => {
        const set = new Set();
        rows.forEach(r => {
            const val = Object.values(r)[0];
            if (val) String(val).split(/[,\n]/).map(s => s.trim()).filter(Boolean).forEach(v => set.add(v));
        });
        return [...set];
    };

    // 女優名は actress_profiles テーブルから（高速）
    const actRows  = await fanzaDb.execute("SELECT name FROM actress_profiles").then(r => r.rows);
    const actresses = actRows.map(r => r.name).filter(Boolean).sort();

    // メーカー・レーベル
    const [mgsMk, fanzaMk, mgsLb, fanzaLb] = await Promise.all([
        mgsDb.execute("SELECT DISTINCT maker FROM products WHERE maker IS NOT NULL AND maker != ''").then(r => r.rows),
        fanzaDb.execute("SELECT DISTINCT maker FROM products WHERE maker IS NOT NULL AND maker != ''").then(r => r.rows),
        mgsDb.execute("SELECT DISTINCT label FROM products WHERE label IS NOT NULL AND label != ''").then(r => r.rows),
        fanzaDb.execute("SELECT DISTINCT label FROM products WHERE label IS NOT NULL AND label != ''").then(r => r.rows),
    ]);
    const makers = [...new Set([...mgsMk, ...fanzaMk].map(r => Object.values(r)[0]).filter(Boolean))].sort();
    const labels = [...new Set([...mgsLb, ...fanzaLb].map(r => Object.values(r)[0]).filter(Boolean))].sort();

    // ジャンル: 既存キャッシュから取得（変化が少ないため）
    let genres = [];
    try {
        const cached = await fanzaDb.execute("SELECT data FROM suggest_cache WHERE key = 'main'").then(r => r.rows[0]);
        if (cached?.data) genres = JSON.parse(cached.data).genres ?? [];
    } catch {}
    if (genres.length === 0) {
        // フォールバック: Tursoからジャンルを取得（上限2000行）
        const [mgsGn, fanzaGn] = await Promise.all([
            mgsDb.execute("SELECT genres FROM products WHERE genres IS NOT NULL AND genres != '' LIMIT 2000").then(r => r.rows),
            fanzaDb.execute("SELECT genres FROM products WHERE genres IS NOT NULL AND genres != '' LIMIT 2000").then(r => r.rows),
        ]);
        genres = [...new Set(split(mgsGn).concat(split(fanzaGn)))].sort();
    }

    console.log(`  Turso: 女優 ${actresses.length.toLocaleString()} / メーカー ${makers.length} / レーベル ${labels.length} / ジャンル ${genres.length}`);
    return { actresses, makers, labels, genres };
}

// ---------- Turso に保存 ----------
async function saveToTurso(db, merged) {
    await db.batch([
        { sql: `CREATE TABLE IF NOT EXISTS suggest_cache (
                    key TEXT PRIMARY KEY,
                    data TEXT NOT NULL,
                    updated_at TEXT
                )`, args: [] },
        {
            sql: `INSERT OR REPLACE INTO suggest_cache (key, data, updated_at) VALUES ('main', ?, ?)`,
            args: [JSON.stringify(merged), new Date().toISOString()],
        },
    ], 'write');
    console.log('  Turso suggest_cache 更新完了');
}

// ---------- メイン ----------
async function main() {
    console.log('========================================');
    console.log('  サジェストキャッシュ生成');
    console.log('========================================\n');
    const start = Date.now();

    const tursoUrl   = process.env.TURSO_FANZA_URL;
    const tursoToken = process.env.TURSO_FANZA_TOKEN;
    const mgsUrl     = process.env.TURSO_MGS_URL;
    const mgsToken   = process.env.TURSO_MGS_TOKEN;

    const hasSqlite = fs.existsSync(path.join(DATA_DIR, 'fanza.db'));
    const hasTurso  = !!(tursoUrl && tursoToken && mgsUrl && mgsToken);

    let merged;

    if (hasSqlite) {
        console.log('[モード] ローカルSQLite\n');
        merged = extractFromSqlite();
    } else if (hasTurso) {
        console.log('[モード] Turso (CI環境)\n');
        const { createClient } = require('@libsql/client');
        const fanzaDb = createClient({ url: tursoUrl,  authToken: tursoToken });
        const mgsDb   = createClient({ url: mgsUrl,    authToken: mgsToken });
        merged = await extractFromTurso(mgsDb, fanzaDb);
        fanzaDb.close();
        mgsDb.close();
    } else {
        console.error('SQLite も Turso も利用できません。環境変数を確認してください。');
        process.exit(1);
    }

    merged.generated_at = new Date().toISOString();

    // ファイルに保存（ローカル環境用）
    fs.writeFileSync(OUTPUT, JSON.stringify(merged));
    const sizeKb = (fs.statSync(OUTPUT).size / 1024).toFixed(0);

    // Turso に保存（設定されている場合）
    if (hasTurso) {
        const { createClient } = require('@libsql/client');
        const fanzaDb = createClient({ url: tursoUrl, authToken: tursoToken });
        await saveToTurso(fanzaDb, merged);
        fanzaDb.close();
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log('\n  マージ後:');
    console.log(`    女優:    ${merged.actresses.length.toLocaleString()}`);
    console.log(`    メーカー: ${merged.makers.length.toLocaleString()}`);
    console.log(`    レーベル: ${merged.labels.length.toLocaleString()}`);
    console.log(`    ジャンル: ${merged.genres.length.toLocaleString()}`);
    console.log(`\n  ✅ 完了 (${sizeKb} KB, ${elapsed}秒)`);
    console.log('========================================\n');
}

main().catch(e => { console.error(e); process.exit(1); });
