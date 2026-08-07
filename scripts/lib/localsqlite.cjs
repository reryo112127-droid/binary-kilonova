/**
 * ローカル SQLite(better-sqlite3) を 旧 @libsql の file: クライアント互換で開く薄いラッパ。
 * `openLocal(path).execute(sql | {sql,args})` が Promise<{rows}> を返す。
 *
 * 既定は読み取り専用（キャッシュ生成用途で誤って書き換えないため）。
 * 書き込みが必要な場合のみ `openLocal(path, { readonly: false })` で開く。
 *
 * Turso 廃止後、@libsql/client への依存を消すために generate-static-cache-local.mjs から利用する。
 */
const Database = require('better-sqlite3');

function openLocal(filePath, { readonly = true } = {}) {
    const db = new Database(filePath, { readonly });
    return {
        // libsql 互換: execute(sql) / execute({sql, args}) → { rows, rowsAffected }
        async execute(stmt) {
            const sql = typeof stmt === 'string' ? stmt : stmt.sql;
            const args = typeof stmt === 'string' ? [] : (stmt.args ?? []);
            const prepared = db.prepare(sql);
            // SELECT 等の結果あり文は all()、それ以外は run()（DELETE等の件数は changes で返す）
            if (prepared.reader) return { rows: prepared.all(...args), rowsAffected: 0, lastInsertRowid: null };
            const info = prepared.run(...args);
            return { rows: [], rowsAffected: info.changes ?? 0, lastInsertRowid: info.lastInsertRowid ?? null };
        },
        close() { db.close(); },
    };
}

module.exports = { openLocal };
