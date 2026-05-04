// ============================================================
//  SSRデータ取得ユーティリティ
//  各ページのroute.tsからサーバーサイドでDBデータを取得し、
//  window.__SSR_*_DATA__ として注入するためのヘルパー関数
// ============================================================

import { getMgsClient, getFanzaClient } from './turso';
import { filterActresses } from './actressFilter';
import { readStaticCacheAsync as readStaticCache } from './staticCache';
import { getCached, setCached } from './apiCache';

const SSR_PAGE_TTL = 5 * 60 * 1000; // 5分

const HOME_MAKERS = [
    'S1','MOODYZ','アイデアポケット','E-BODY','OPPAI','Fitch','Madonna','痴女ヘブン',
    'kawaii','million','本中','ダスッ','Hunter','ワンズファクトリー','TAMEIKE',
    'プレミアム','SOD','FALENO','DAHLIA','プレステージ','Jackson','シロウトTV',
    'ナンパTV','ラグジュTV','DOC','ARA','KANBi','黒船','NTR.net','ドキュメンTV',
];
const BEST_EXCL = ['%BEST%','%ベスト%','%総集編%','%コレクション%','%Best%'];

type Row = Record<string, unknown>;

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

function addBestExcl(conds: string[], args: (string | number)[]) {
    BEST_EXCL.forEach(p => { conds.push('title NOT LIKE ?'); args.push(p); });
    conds.push('(duration_min IS NULL OR duration_min <= 200)');
}

function addMakersFanza(conds: string[], args: (string | number)[], makers: string[]) {
    if (!makers.length) return;
    const c = makers.map(() => '(label LIKE ? OR maker LIKE ?)').join(' OR ');
    conds.push(`(${c})`);
    makers.forEach(m => { args.push(`%${m}%`, `%${m}%`); });
}

/** ホーム用: FANZA予約作品（配信日降順） */
export async function ssrFetchFanzaPreOrders(limit: number): Promise<Row[]> {
    const cached = await readStaticCache<Row[]>('home_preorder_cache.json');
    if (cached && cached.length > 0) return cached.slice(0, limit);
    const client = getFanzaClient();
    if (!client) return [];
    const today = new Date().toISOString().slice(0, 10);
    const conds = ['sale_start_date > ?', "label NOT LIKE '%LadyHunter%'"];
    const args: (string | number)[] = [today];
    addBestExcl(conds, args);
    addMakersFanza(conds, args, HOME_MAKERS);
    try {
        const r = await client.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price
                  FROM products WHERE ${conds.join(' AND ')}
                  ORDER BY sale_start_date DESC LIMIT ${limit}`,
            args,
        });
        return r.rows.map(row => mapRow(row as Row, 'fanza'));
    } catch { return []; }
}

/** ホーム用: FANZA新作（当日→直近3日フォールバック） */
export async function ssrFetchFanzaNewProducts(limit: number): Promise<Row[]> {
    const cached = await readStaticCache<Row[]>('products_new_cache.json');
    if (cached && cached.length > 0) return cached.slice(0, limit);
    const client = getFanzaClient();
    if (!client) return [];
    const today = new Date().toISOString().slice(0, 10);
    const d3ago = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

    async function query(from: string, to: string): Promise<Row[]> {
        const conds = ['sale_start_date IS NOT NULL', 'sale_start_date >= ?', 'sale_start_date <= ?', "label NOT LIKE '%LadyHunter%'"];
        const args: (string | number)[] = [from, to];
        addBestExcl(conds, args);
        addMakersFanza(conds, args, HOME_MAKERS);
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
    const mgsClient = getMgsClient();
    const fanzaClient = getFanzaClient();
    const yearStart = new Date().getFullYear() + '-01-01';

    const [mgsRows, fanzaRows] = await Promise.all([
        mgsClient ? mgsClient.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date
                  FROM products
                  WHERE (duration_min IS NULL OR duration_min < 600)
                    AND title NOT LIKE '%BEST%' AND title NOT LIKE '%ベスト%'
                    AND title NOT LIKE '%総集編%' AND (duration_min IS NULL OR duration_min <= 200)
                    AND REPLACE(sale_start_date,'/','-') >= ?
                  ORDER BY wish_count DESC LIMIT ${limit * 2}`,
            args: [yearStart],
        }).then(r => r.rows).catch(() => []) : [],
        fanzaClient ? fanzaClient.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count,
                         genres, maker, sale_start_date, COALESCE(discount_pct,0) AS discount_pct
                  FROM products
                  WHERE sale_start_date >= ?
                    AND title NOT LIKE '%BEST%' AND title NOT LIKE '%ベスト%'
                    AND title NOT LIKE '%総集編%' AND (duration_min IS NULL OR duration_min <= 200)
                  ORDER BY COALESCE(review_count,0)*COALESCE(review_average,0) DESC, sale_start_date DESC
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
    const mgsClient = getMgsClient();
    const fanzaClient = getFanzaClient();
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
            const names = topEntries.map(([n]) => n);
            const placeholders = names.map(() => '?').join(',');
            const imgRes = await fanzaClient.execute({
                sql: `SELECT name, image_url FROM actress_profiles WHERE name IN (${placeholders}) AND image_url IS NOT NULL`,
                args: names,
            });
            for (const row of imgRes.rows) {
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

    const mgsClient = getMgsClient();
    const fanzaClient = getFanzaClient();
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

    const mgsClient = getMgsClient();
    const fanzaClient = getFanzaClient();
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
