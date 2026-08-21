/**
 * シャード fan-out のグローバル ORDER BY / LIMIT 再現。
 *
 * FANZA D1 は無料枠(500MB/DB)に収めるため product_id ハッシュで2シャードに分割されており、
 * 読み取りは同じSELECTを全シャードへ投げて行をマージしている。各シャードは自分の中でだけ
 * ORDER BY / LIMIT を適用するため、単純に連結すると
 *   ・並びが「シャード0の上位N件 → シャード1の上位N件」になり日付順/割引順が崩れる
 *   ・行数が LIMIT の shard 数倍になる
 * という2つの破綻が起きる。ここでマージ後に JS で再ソートして LIMIT まで切り詰める。
 *
 * Cloudflare依存が無い純粋関数なので単体で検証できる（lib/turso.ts から使用）。
 */

export type Row = Record<string, unknown>;
type ValueGetter = (row: Row) => unknown;

/** SQL末尾の ORDER BY 句と LIMIT 数値を取り出す（サブクエリを避けるため末尾の出現のみ対象）。 */
export function parseOrderTail(sql: string): { orderExprs: string[]; limit: number | null } | null {
    // LIMIT ?（バインド変数）も許容する。この場合は件数不明なので truncate しない。
    const m = /\border\s+by\s+([\s\S]+?)(?:\s+limit\s+(\d+|\?)(?:\s+offset\s+(?:\d+|\?))?)?\s*;?\s*$/i.exec(sql);
    if (!m) return null;
    // カンマ分割は括弧の外だけ（COALESCE(x,0) のような関数引数で切らない）
    const exprs: string[] = [];
    let depth = 0, cur = '';
    for (const ch of m[1]) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { exprs.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) exprs.push(cur);
    return {
        orderExprs: exprs.map(e => e.trim()).filter(Boolean),
        limit: m[2] && m[2] !== '?' ? parseInt(m[2], 10) : null,
    };
}

/** ORDER BY の式を、SELECT結果の列から値を取り出す関数へ解決する。解決できなければ null。 */
export function resolveOrderExpr(expr: string, sample: Row): { get: ValueGetter; desc: boolean } | null {
    let e = expr.trim();
    let desc = false;
    const dir = /\s+(asc|desc)$/i.exec(e);
    if (dir) { desc = dir[1].toLowerCase() === 'desc'; e = e.slice(0, dir.index).trim(); }

    if (/^random\(\)$/i.test(e)) return { get: () => Math.random(), desc };

    // 素の列名 / SELECT のエイリアス
    if (Object.prototype.hasOwnProperty.call(sample, e)) return { get: r => r[e], desc };

    // SUBSTR(col,1,10) — FANZAのタイムスタンプから日付部分を取る用法
    let f = /^substr\(\s*(\w+)\s*,\s*1\s*,\s*(\d+)\s*\)$/i.exec(e);
    if (f && Object.prototype.hasOwnProperty.call(sample, f[1])) {
        const col = f[1], n = parseInt(f[2], 10);
        return { get: r => String(r[col] ?? '').slice(0, n), desc };
    }
    // REPLACE(col,'/','-') — MGS形式の日付正規化（FANZA側では通常出ないが対称性のため）
    f = /^replace\(\s*(\w+)\s*,\s*'\/'\s*,\s*'-'\s*\)$/i.exec(e);
    if (f && Object.prototype.hasOwnProperty.call(sample, f[1])) {
        const col = f[1];
        return { get: r => String(r[col] ?? '').replace(/\//g, '-'), desc };
    }
    // COALESCE(col, 0)
    f = /^coalesce\(\s*(\w+)\s*,\s*([^)]*)\)$/i.exec(e);
    if (f && Object.prototype.hasOwnProperty.call(sample, f[1])) {
        const col = f[1], fallback = f[2].trim().replace(/^'|'$/g, '');
        return { get: r => r[col] ?? fallback, desc };
    }
    return null;
}

export function compareValues(a: unknown, b: unknown): number {
    const aNull = a === null || a === undefined;
    const bNull = b === null || b === undefined;
    if (aNull || bNull) return aNull && bNull ? 0 : aNull ? -1 : 1; // SQLite同様 NULL は最小
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const na = Number(a), nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '') return na - nb;
    return String(a).localeCompare(String(b));
}

/**
 * シャードごとの結果をグローバルな ORDER BY / LIMIT に合わせて並べ直す。
 * ORDER BY が無い / 式を解決できない場合は元の連結順のまま返す（従来動作＝悪化しない）。
 * OFFSET はシャード側で既に消費済みのため再適用しない（深いページングは元々近似）。
 */
export function mergeShardRows(sql: string, rows: Row[]): Row[] {
    if (rows.length === 0) return rows;
    // GROUP BY はシャードごとの「部分集計」が返る（同じmakerが各シャードから1行ずつ等）。
    // 呼び出し側が名前をキーに count を足し合わせて完成させる契約なので、ここで LIMIT まで
    // 切り詰めると集計対象が落ちる。並べ替えも意味を持たないため素通しする。
    if (/\bgroup\s+by\b/i.test(sql)) return rows;
    const tail = parseOrderTail(sql);
    if (!tail || tail.orderExprs.length === 0) return rows;
    const terms = tail.orderExprs.map(e => resolveOrderExpr(e, rows[0]));
    if (terms.some(t => t === null)) return rows;
    const resolved = terms as { get: ValueGetter; desc: boolean }[];
    const sorted = [...rows].sort((x, y) => {
        for (const t of resolved) {
            const c = compareValues(t.get(x), t.get(y));
            if (c !== 0) return t.desc ? -c : c;
        }
        return 0;
    });
    return tail.limit != null ? sorted.slice(0, tail.limit) : sorted;
}
