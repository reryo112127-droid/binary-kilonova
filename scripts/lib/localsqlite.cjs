/**
 * ローカル SQLite(better-sqlite3) を 旧 @libsql の file: クライアント互換で開く薄いラッパ。
 * `openLocal(path).execute(sql | {sql,args})` が Promise<{rows}> を返す（読み取り専用）。
 *
 * Turso 廃止後、@libsql/client への依存を消すために generate-static-cache-local.mjs から利用する。
 */
const Database = require('better-sqlite3');

function openLocal(filePath) {
    const db = new Database(filePath, { readonly: true });
    return {
        // libsql 互換: execute(sql) / execute({sql, args}) → { rows }
        async execute(stmt) {
            const sql = typeof stmt === 'string' ? stmt : stmt.sql;
            const args = typeof stmt === 'string' ? [] : (stmt.args ?? []);
            const prepared = db.prepare(sql);
            // SELECT 等の結果あり文は all()、それ以外は run()
            const rows = prepared.reader ? prepared.all(...args) : (prepared.run(...args), []);
            return { rows, rowsAffected: 0, lastInsertRowid: null };
        },
        close() { db.close(); },
    };
}

module.exports = { openLocal };
