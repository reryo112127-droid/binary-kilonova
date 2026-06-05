/**
 * D1 アクセスアダプタ（旧 Turso/@libsql の置き換え）。
 *
 * Turso 完全廃止に伴い、Cloudflare D1 バインディング（DB_MGS / DB_FANZA / DB_SITE）を
 * getCloudflareContext 経由で取得し、旧 @libsql クライアントと互換の
 * `execute(sql | {sql,args}) => { rows }` インターフェースを提供する。
 *
 * これにより各 route/lib は `await getXxxClient()` を付けるだけで、
 * `db.execute({ sql, args })` の呼び出し本体を変更せず D1 に移行できる。
 *
 * Cloudflare Workers 環境（OpenNext）でのみ binding が存在する。
 * 取得できない場合（バインディング未設定・非 Workers 環境）は null を返し、
 * 呼び出し側の既存フォールバック（静的JSON 等）が働く。
 */
import { getCloudflareContext } from '@opennextjs/cloudflare';

// ─── D1 最小型定義（@cloudflare/workers-types に依存しない）─────────────
interface D1Meta {
    changes?: number;
    last_row_id?: number;
    rows_read?: number;
    rows_written?: number;
}
interface D1Result {
    results: Record<string, unknown>[];
    success: boolean;
    meta?: D1Meta;
}
interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    all(): Promise<D1Result>;
}
interface D1Database {
    prepare(query: string): D1PreparedStatement;
}

// ─── 旧 @libsql 互換のクライアント型 ──────────────────────────────────
export type ExecuteArg = string | { sql: string; args?: unknown[] };
export interface CompatResult {
    rows: Record<string, unknown>[];
    rowsAffected: number;
    lastInsertRowid: number | null;
}
export interface CompatClient {
    execute(stmt: ExecuteArg): Promise<CompatResult>;
}

function wrap(db: D1Database): CompatClient {
    return {
        async execute(stmt: ExecuteArg): Promise<CompatResult> {
            const sql = typeof stmt === 'string' ? stmt : stmt.sql;
            const args = typeof stmt === 'string' ? [] : (stmt.args ?? []);
            const prepared = db.prepare(sql);
            const bound = args.length > 0 ? prepared.bind(...args) : prepared;
            const res = await bound.all();
            return {
                rows: res.results ?? [],
                rowsAffected: res.meta?.changes ?? 0,
                lastInsertRowid: res.meta?.last_row_id ?? null,
            };
        },
    };
}

async function getBinding(name: string): Promise<D1Database | null> {
    try {
        const { env } = await getCloudflareContext({ async: true });
        const db = (env as unknown as Record<string, D1Database | undefined>)[name];
        return db ?? null;
    } catch {
        return null;
    }
}

// バインディングは Workers ランタイムが提供するためキャッシュ不要（取得は安価）。
export async function getMgsClient(): Promise<CompatClient | null> {
    const db = await getBinding('DB_MGS');
    return db ? wrap(db) : null;
}

// FANZA は無料D1(500MB/DB)に収めるため product_id ハッシュで複数シャードに分割している。
// 読み取りは全シャードに同じSELECTを投げて行をマージする（ランタイムは読み取り専用）。
// 注意: 行を返すSELECT用。COUNT等の集約クエリはシャードごとの部分結果になる（主に静的キャッシュ
//       フォールバックでのみ発生し、ロングテール検索の行取得には影響しない）。
export async function getFanzaClient(): Promise<CompatClient | null> {
    const names = ['DB_FANZA_0', 'DB_FANZA_1'];
    const dbs = (await Promise.all(names.map(getBinding))).filter((d): d is D1Database => !!d);
    if (dbs.length === 0) {
        // 後方互換: 単一バインディング DB_FANZA があればそれを使う
        const single = await getBinding('DB_FANZA');
        return single ? wrap(single) : null;
    }
    const clients = dbs.map(wrap);
    return {
        async execute(stmt: ExecuteArg): Promise<CompatResult> {
            const results = await Promise.all(clients.map(c => c.execute(stmt)));
            return {
                rows: results.flatMap(r => r.rows),
                rowsAffected: results.reduce((a, r) => a + r.rowsAffected, 0),
                lastInsertRowid: null,
            };
        },
    };
}

export async function getSiteClient(): Promise<CompatClient | null> {
    const db = await getBinding('DB_SITE');
    return db ? wrap(db) : null;
}
