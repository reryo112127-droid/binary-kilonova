// ============================================================
//  SSRデータ取得ユーティリティ
//  各ページのroute.tsからサーバーサイドでDBデータを取得し、
//  window.__SSR_*_DATA__ として注入するためのヘルパー関数
// ============================================================

import { getMgsClient, getFanzaClient, executeInChunks } from './turso';
import { filterActresses } from './actressFilter';
import { readStaticCacheAsync as readStaticCache } from './staticCache';
import { getCached, setCached } from './apiCache';
import { bestExclusionSql, COMPILATION_MAX_MIN } from './bestFilter';

const SSR_PAGE_TTL = 5 * 60 * 1000; // 5分


// ホーム画面予約作品の厳選メーカーリスト（generate-static-cache.mjs の HOME_MAKERS と同期）
const HOME_MAKERS = [
    'エスワン', 'ムーディーズ', 'アイデアポケット', 'OPPAI', 'E-BODY', 'Fitch',
    'マドンナ', '本中', 'ダスッ', 'kawaii', 'Hunter', 'ワンズファクトリー',
    'SODクリエイト', 'FALENO', 'TAMEIKE', 'million', 'プレミアム', 'DAHLIA',
];
// FANZA用メーカー条件（label列 OR maker列）
const FANZA_MAKER_COND = HOME_MAKERS.map(() => '(label LIKE ? OR maker LIKE ?)').join(' OR ');
const FANZA_MAKER_ARGS = HOME_MAKERS.flatMap(m => [`%${m}%`, `%${m}%`]);
// MGS用メーカー条件（maker列 OR label列）
const MGS_MAKER_COND = HOME_MAKERS.map(() => '(maker LIKE ? OR label LIKE ?)').join(' OR ');
const MGS_MAKER_ARGS = HOME_MAKERS.flatMap(m => [`%${m}%`, `%${m}%`]);

const PREORDER_TTL = 30 * 60 * 1000; // 予約のライブD1結果を30分メモリキャッシュ

type Row = Record<string, unknown>;

// sale_start_date を 'YYYY-MM-DD' に正規化（FANZA '-' / MGS '/'、時刻付きにも対応）。不正は ''。
function normDate(v: unknown): string {
    const m = String(v ?? '').match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}
// product_id で重複排除し、sale_start_date 降順に並べる
function dedupByDateDesc(rows: Row[]): Row[] {
    const seen = new Set<string>();
    const out: Row[] = [];
    for (const r of rows) { const id = String(r.product_id); if (id && !seen.has(id)) { seen.add(id); out.push(r); } }
    out.sort((a, b) => normDate(b.sale_start_date).localeCompare(normDate(a.sale_start_date)));
    return out;
}

function mapRow(row: Row, source: string): Row {
    const r = { ...row } as Row;
    r.actresses = filterActresses(
        (r.actresses as string | null) || null,
        (r.genres as string | null) || null,
        (r.maker as string | null) || null
    );
    r.source = source;
    return r;
}

// BEST/総集編の判定は lib/bestFilter.ts に集約（旧: ここだけ 200分超を一律除外していた）
function addBestExcl(conds: string[], args: (string | number)[]) {
    const b = bestExclusionSql();
    conds.push(...b.conds);
    args.push(...b.args);
}

/** ホーム用: 予約作品（厳選メーカー・配信日降順） */
// D1優先: 毎日更新されるD1から「明日以降の予約」を引く（凍結しがちなローカルバッチ製キャッシュに依存しない）。
// FANZA+MGS をマージし配信日DESC。TTLで読み取りを抑制。D1が無い/0件のときだけ静的キャッシュ(>todayで絞る)へフォールバック。
export async function ssrFetchFanzaPreOrders(limit: number): Promise<Row[]> {
    const cacheKey = `ssr_home_preorder_${limit}`;
    const memo = getCached<Row[]>(cacheKey, PREORDER_TTL);
    if (memo) return memo;

    const today = new Date().toISOString().slice(0, 10);
    const [fanzaClient, mgsClient] = await Promise.all([getFanzaClient(), getMgsClient()]);

    if (fanzaClient || mgsClient) {
        const fanzaConds = ['sale_start_date > ?', "label NOT LIKE '%LadyHunter%'", `(${FANZA_MAKER_COND})`];
        const fanzaArgs: (string | number)[] = [today, ...FANZA_MAKER_ARGS];
        addBestExcl(fanzaConds, fanzaArgs);
        const mgsConds = ["REPLACE(sale_start_date,'/','-') > ?", `(${MGS_MAKER_COND})`];
        const mgsArgs: (string | number)[] = [today, ...MGS_MAKER_ARGS];
        addBestExcl(mgsConds, mgsArgs);

        const [fanzaRows, mgsRows] = await Promise.all([
            fanzaClient ? fanzaClient.execute({
                sql: `SELECT product_id, title, actresses, main_image_url, genres, maker, sale_start_date,
                             COALESCE(discount_pct,0) AS discount_pct, list_price, current_price
                      FROM products WHERE ${fanzaConds.join(' AND ')}
                      ORDER BY sale_start_date DESC LIMIT ${limit * 2}`,
                args: fanzaArgs,
            }).then(r => r.rows.map(row => mapRow(row as Row, 'fanza'))).catch(() => [] as Row[]) : [],
            mgsClient ? mgsClient.execute({
                sql: `SELECT product_id, title, actresses, main_image_url, genres, maker, sale_start_date,
                             0 AS discount_pct, NULL AS list_price, NULL AS current_price
                      FROM products WHERE ${mgsConds.join(' AND ')}
                      ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT ${limit * 2}`,
                args: mgsArgs,
            }).then(r => r.rows.map(row => mapRow(row as Row, 'mgs'))).catch(() => [] as Row[]) : [],
        ]);

        const merged = dedupByDateDesc([...fanzaRows, ...mgsRows]).slice(0, limit);
        if (merged.length > 0) { setCached(cacheKey, merged); return merged; }
    }

    // フォールバック: 静的キャッシュ（配信済み=過去を除外し、配信日DESCで返す）
    const cached = await readStaticCache<Row[]>('home_preorder_curated_cache.json');
    if (cached && cached.length > 0) {
        return cached.filter(p => normDate((p as Row).sale_start_date) > today)
            .sort((a, b) => normDate((b as Row).sale_start_date).localeCompare(normDate((a as Row).sale_start_date)))
            .slice(0, limit);
    }
    return [];
}

/** ホーム用: FANZA新作（当日→直近3日フォールバック） */
export async function ssrFetchFanzaNewProducts(limit: number): Promise<Row[]> {
    const cached = await readStaticCache<Row[]>('products_new_cache.json');
    if (cached && cached.length > 0) return cached.slice(0, limit);
    const client = await getFanzaClient();
    if (!client) return [];
    const today = new Date().toISOString().slice(0, 10);
    const d3ago = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

    async function query(from: string, to: string): Promise<Row[]> {
        const conds = ['sale_start_date IS NOT NULL', 'sale_start_date >= ?', 'sale_start_date <= ?', "label NOT LIKE '%LadyHunter%'"];
        const args: (string | number)[] = [from, to];
        addBestExcl(conds, args);
        try {
            const r = await client!.execute({
                sql: `SELECT product_id, title, actresses, main_image_url, genres, maker, sale_start_date,
                             COALESCE(discount_pct,0) AS discount_pct, list_price, current_price
                      FROM products WHERE ${conds.join(' AND ')}
                      ORDER BY sale_start_date DESC LIMIT ${limit}`,
                args,
            });
            return r.rows.map(row => mapRow(row as Row, 'fanza'));
        } catch { return []; }
    }

    const todayData = await query(today, today);
    if (todayData.length > 0) return todayData;
    return query(d3ago, today);
}

/** ランキング: MGS(wish_count) + FANZA(review) 2:1インターリーブ */
export async function ssrFetchRanking(limit: number): Promise<Row[]> {
    const cached = await readStaticCache<Row[]>('ranking_2026_cache.json');
    if (cached && cached.length > 0) return cached.slice(0, limit);
    const mgsClient = await getMgsClient();
    const fanzaClient = await getFanzaClient();
    const yearStart = new Date().getFullYear() + '-01-01';

    const [mgsRows, fanzaRows] = await Promise.all([
        mgsClient ? mgsClient.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date
                  FROM products
                  WHERE (duration_min IS NULL OR duration_min < 600)
                    AND title NOT LIKE '%BEST%' AND title NOT LIKE '%ベスト%'
                    AND title NOT LIKE '%総集編%' AND (duration_min IS NULL OR duration_min <= ${COMPILATION_MAX_MIN})
                    AND REPLACE(sale_start_date,'/','-') >= ?
                  ORDER BY wish_count DESC LIMIT ${limit * 2}`,
            args: [yearStart],
        }).then(r => r.rows).catch(() => []) : [],
        fanzaClient ? fanzaClient.execute({
            // review_score はエイリアスとして SELECT に出す（FANZAはシャード分割されており、
            // ORDER BY 式が結果列に無いとマージ時にグローバル順へ並べ直せないため）。
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count,
                         genres, maker, sale_start_date, COALESCE(discount_pct,0) AS discount_pct,
                         COALESCE(review_count,0)*COALESCE(review_average,0) AS review_score
                  FROM products
                  WHERE sale_start_date >= ?
                    AND title NOT LIKE '%BEST%' AND title NOT LIKE '%ベスト%'
                    AND title NOT LIKE '%総集編%' AND (duration_min IS NULL OR duration_min <= ${COMPILATION_MAX_MIN})
                  ORDER BY review_score DESC, sale_start_date DESC
                  LIMIT ${limit}`,
            args: [yearStart],
        }).then(r => r.rows).catch(() => []) : [],
    ]);

    const mgs = mgsRows.map(r => mapRow(r as Row, 'mgs'));
    const fanza = fanzaRows.map(r => mapRow(r as Row, 'fanza'));
    const result: Row[] = [];
    let mi = 0, fi = 0;
    while (result.length < limit && (mi < mgs.length || fi < fanza.length)) {
        for (let k = 0; k < 2 && mi < mgs.length && result.length < limit; k++) result.push(mgs[mi++]);
        if (fi < fanza.length && result.length < limit) result.push(fanza[fi++]);
    }
    return result.slice(0, limit);
}

/** 女優ランキング: wish_count集計 + プロフィール画像 */
export async function ssrFetchActressRanking(limit: number): Promise<Row[]> {
    const cached = await readStaticCache<Row[]>('actress_ranking_2026_cache.json');
    if (cached && cached.length > 0) return cached.slice(0, limit);
    const mgsClient = await getMgsClient();
    const fanzaClient = await getFanzaClient();
    const yearStart = new Date().getFullYear() + '-01-01';
    const CANDIDATE = 300;

    const [mgsRows, fanzaRows] = await Promise.all([
        mgsClient ? mgsClient.execute({
            sql: `SELECT actresses, main_image_url, wish_count, genres, maker
                  FROM products WHERE (duration_min IS NULL OR duration_min < 600)
                  AND REPLACE(sale_start_date,'/','-') >= ?
                  ORDER BY wish_count DESC LIMIT ${CANDIDATE}`,
            args: [yearStart],
        }).then(r => r.rows).catch(() => []) : [],
        fanzaClient ? fanzaClient.execute({
            sql: `SELECT actresses, main_image_url, 0 AS wish_count, genres, maker
                  FROM products WHERE sale_start_date >= ?
                  ORDER BY sale_start_date DESC LIMIT ${CANDIDATE}`,
            args: [yearStart],
        }).then(r => r.rows).catch(() => []) : [],
    ]);

    type Entry = { wishScore: number; workCount: number; sampleImage: string };
    const actressMap = new Map<string, Entry>();

    for (const row of [...mgsRows, ...fanzaRows]) {
        const r = row as Row;
        const actressesStr = filterActresses(
            (r.actresses as string | null) || null,
            (r.genres as string | null) || null,
            (r.maker as string | null) || null
        );
        if (!actressesStr) continue;
        const names = actressesStr.split(/,|、/).map(s => s.trim()).filter(Boolean);
        const wish = Number(r.wish_count ?? 0);
        const img = String(r.main_image_url ?? '');
        for (const name of names) {
            const e = actressMap.get(name);
            if (e) { e.wishScore += wish; e.workCount++; }
            else actressMap.set(name, { wishScore: wish, workCount: 1, sampleImage: img });
        }
    }

    const topEntries = Array.from(actressMap.entries())
        .sort((a, b) => b[1].wishScore - a[1].wishScore)
        .slice(0, limit * 2);

    // プロフィール画像を取得
    const actressImageMap = new Map<string, string>();
    if (fanzaClient && topEntries.length > 0) {
        try {
            // D1のバインド変数上限(100)のため分割実行
            const names = topEntries.map(([n]) => n);
            const imgRows = await executeInChunks(fanzaClient,
                ph => `SELECT name, image_url FROM actress_profiles WHERE name IN (${ph}) AND image_url IS NOT NULL`,
                names);
            for (const row of imgRows) {
                if (row.image_url) actressImageMap.set(String(row.name), String(row.image_url));
            }
        } catch { /* ignore */ }
    }

    return topEntries.slice(0, limit).map(([name, e]) => ({
        name,
        score: e.wishScore,
        work_count: e.workCount,
        image_url: actressImageMap.get(name) || null,
        sample_image: e.sampleImage,
    }));
}

/** 新作ページ用: MGS + FANZA 直近30日 */
export async function ssrFetchNewProductsPage(limit: number): Promise<Row[]> {
    const cacheKey = `ssr_new_${limit}`;
    const cached = getCached<Row[]>(cacheKey, SSR_PAGE_TTL);
    if (cached) return cached;

    const mgsClient = await getMgsClient();
    const fanzaClient = await getFanzaClient();
    const today = new Date().toISOString().slice(0, 10);
    const d30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const [mgsRows, fanzaRows] = await Promise.all([
        mgsClient ? mgsClient.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         0 AS discount_pct, NULL AS list_price, NULL AS current_price
                  FROM products WHERE sale_start_date IS NOT NULL
                    AND REPLACE(sale_start_date,'/','-') <= ?
                    AND REPLACE(sale_start_date,'/','-') >= ?
                    AND (duration_min IS NULL OR duration_min < 600)
                  ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT ${limit}`,
            args: [today, d30],
        }).then(r => r.rows).catch(() => []) : [],
        fanzaClient ? fanzaClient.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price
                  FROM products WHERE sale_start_date IS NOT NULL
                    AND sale_start_date <= ? AND sale_start_date >= ?
                  ORDER BY sale_start_date DESC LIMIT ${limit}`,
            args: [today, d30],
        }).then(r => r.rows).catch(() => []) : [],
    ]);

    const combined: Row[] = [];
    const maxLen = Math.max(mgsRows.length, fanzaRows.length);
    for (let i = 0; i < maxLen; i++) {
        if (mgsRows[i]) combined.push(mapRow(mgsRows[i] as Row, 'mgs'));
        if (fanzaRows[i]) combined.push(mapRow(fanzaRows[i] as Row, 'fanza'));
    }
    const result = combined.slice(0, limit);
    setCached(cacheKey, result);
    return result;
}

/** 予約ページ用: MGS + FANZA 明日以降 */
export async function ssrFetchPreOrdersPage(limit: number): Promise<Row[]> {
    const cacheKey = `ssr_preorder_${limit}`;
    const cached = getCached<Row[]>(cacheKey, SSR_PAGE_TTL);
    if (cached) return cached;

    const mgsClient = await getMgsClient();
    const fanzaClient = await getFanzaClient();
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const [mgsRows, fanzaRows] = await Promise.all([
        mgsClient ? mgsClient.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         0 AS discount_pct, NULL AS list_price, NULL AS current_price
                  FROM products WHERE REPLACE(sale_start_date,'/','-') >= ?
                    AND (duration_min IS NULL OR duration_min < 600)
                  ORDER BY REPLACE(sale_start_date,'/','-') ASC LIMIT ${limit}`,
            args: [tomorrow],
        }).then(r => r.rows).catch(() => []) : [],
        fanzaClient ? fanzaClient.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price
                  FROM products WHERE sale_start_date >= ?
                  ORDER BY sale_start_date ASC LIMIT ${limit}`,
            args: [tomorrow],
        }).then(r => r.rows).catch(() => []) : [],
    ]);

    const combined: Row[] = [];
    const maxLen = Math.max(mgsRows.length, fanzaRows.length);
    for (let i = 0; i < maxLen; i++) {
        if (mgsRows[i]) combined.push(mapRow(mgsRows[i] as Row, 'mgs'));
        if (fanzaRows[i]) combined.push(mapRow(fanzaRows[i] as Row, 'fanza'));
    }
    const result = combined.slice(0, limit);
    setCached(cacheKey, result);
    return result;
}

/** SSRデータをHTMLのheadに安全に注入するヘルパー */
export function injectSsrScript(html: string, varName: string, data: unknown): string {
    const safeJson = JSON.stringify(data).replace(/<\//g, '<\\/');
    return html.replace('</head>', `<script>window.${varName}=${safeJson};</script>\n</head>`);
}
