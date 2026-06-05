/**
 * Cloudflare D1 REST クライアント（旧 @libsql createClient のドロップイン置き換え）。
 *
 * Workers 外（ローカル / GitHub Actions）の日次スクリプトから D1 にリモート書き込みするための薄いラッパ。
 * 旧 libsql クライアントと同じ `.execute()` / `.batch()` インターフェースを提供する。
 *
 * 必要な環境変数:
 *   CLOUDFLARE_ACCOUNT_ID  … Cloudflare アカウントID
 *   CLOUDFLARE_D1_TOKEN    … D1 編集権限を持つ API トークン
 *   D1_FANZA_ID / D1_MGS_ID / D1_SITE_ID … 各 D1 データベースの database_id
 *
 * 使い方:
 *   const { d1 } = require('./lib/d1');
 *   const db = d1('fanza');              // または createD1Client({ databaseId })
 *   const r = await db.execute({ sql: 'SELECT * FROM products WHERE product_id = ?', args: [id] });
 *   await db.batch(stmts, 'write');      // stmts: ({sql,args}|string)[]
 *
 * 注意:
 *   - D1 REST は「params付きマルチ文バッチ」を持たないため、batch() は各文へ args をインライン展開し
 *     1リクエストに集約して送る（レート制限回避）。SQLテンプレートに ? のリテラルが無い前提。
 *   - 初期の大量インポートはこのクライアントではなく `wrangler d1 import` を使うこと。
 */

const API = 'https://api.cloudflare.com/client/v4';

function env(name) {
    const v = process.env[name];
    if (!v) throw new Error(`環境変数 ${name} が未設定です`);
    return v;
}

function sqlVal(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'boolean') return v ? '1' : '0';
    return "'" + String(v).replace(/'/g, "''") + "'";
}

// {sql, args} → args をインライン展開した SQL 文字列（? を順に置換）
function inline(stmt) {
    if (typeof stmt === 'string') return stmt;
    const { sql, args } = stmt;
    if (!args || args.length === 0) return sql;
    let i = 0;
    return sql.replace(/\?/g, () => {
        if (i >= args.length) throw new Error('プレースホルダ数が args より多い');
        return sqlVal(args[i++]);
    });
}

// libsql の行は名前アクセスと位置アクセス(row[0])の両方が可能。
// D1 REST は名前キーのみのため、列順(Object.values)から数値インデックスを補う。
function withPositional(rows) {
    for (const r of rows) {
        const vals = Object.values(r);
        for (let i = 0; i < vals.length; i++) if (!(i in r)) r[i] = vals[i];
    }
    return rows;
}

// 旧 Turso(外部コンテンツFTS)向けの FTS5 管理文は D1 では不要・有害なため no-op 化する。
// D1 の products_fts 同期は site/migrations/0004_catalog_fts.sql の products_ai/au/ad トリガ
// （WHENガード付き）が自動で行うため、スクリプトが散発的に発行する以下は実行しない:
//   - DROP TRIGGER ... products_au      （D1 の正しいトリガを消してしまう）
//   - CREATE TRIGGER ... products_au    （外部コンテンツ用の誤ったトリガを作る）
//   - INSERT INTO products_fts(products_fts) VALUES('rebuild')  （standalone FTSでは不可）
function isLegacyFtsNoop(sql) {
    const s = sql.replace(/\s+/g, ' ').trim();
    return /drop\s+trigger\s+if\s+exists\s+products_au/i.test(s)
        || /create\s+trigger\s+[^]*\bproducts_au\b/i.test(s)
        || /insert\s+into\s+products_fts\s*\(\s*products_fts\s*\)\s*values\s*\(\s*'rebuild'\s*\)/i.test(s);
}

function createD1Client({ databaseId, accountId, apiToken } = {}) {
    const acc = accountId || env('CLOUDFLARE_ACCOUNT_ID');
    const token = apiToken || env('CLOUDFLARE_D1_TOKEN');
    const dbId = databaseId;
    if (!dbId) throw new Error('databaseId が必要です');
    const endpoint = `${API}/accounts/${acc}/d1/database/${dbId}/query`;

    async function post(body) {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) {
            const msg = (json.errors && json.errors.map(e => e.message).join('; ')) || res.statusText;
            throw new Error(`D1 REST エラー (${res.status}): ${msg}`);
        }
        return json.result || [];
    }

    return {
        // libsql 互換: execute(sql) / execute({sql, args}) → { rows, rowsAffected, lastInsertRowid }
        async execute(stmt) {
            const sql = typeof stmt === 'string' ? stmt : stmt.sql;
            const params = typeof stmt === 'string' ? [] : (stmt.args ?? []);
            // 旧 Turso 向け FTS5 管理文は D1 では no-op（トリガが自動同期）
            if (isLegacyFtsNoop(sql)) return { rows: [], rowsAffected: 0, lastInsertRowid: null };
            const result = await post(params.length ? { sql, params } : { sql });
            const first = result[0] || {};
            return {
                rows: withPositional(first.results || []),
                rowsAffected: first.meta?.changes ?? 0,
                lastInsertRowid: first.meta?.last_row_id ?? null,
            };
        },

        // libsql 互換: batch(statements, mode?) → 各文を1リクエストに集約して実行
        async batch(statements /* , _mode */) {
            const sql = statements.map(inline).join(';\n') + ';';
            const result = await post({ sql });
            return result.map(r => ({ rows: withPositional(r.results || []), rowsAffected: r.meta?.changes ?? 0 }));
        },

        // libsql 互換: close() は REST では不要なので no-op
        close() { /* no-op */ },
    };
}

// 名前付きショートカット（環境変数の database_id から生成）
function d1(which) {
    const map = { fanza: 'D1_FANZA_ID', mgs: 'D1_MGS_ID', site: 'D1_SITE_ID' };
    const key = map[which];
    if (!key) throw new Error(`未知の D1 名: ${which}`);
    return createD1Client({ databaseId: env(key) });
}

module.exports = { createD1Client, d1, sqlVal };
