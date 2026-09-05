// ============================================================
//  D1 が使えないときの「縮退（degraded）応答」
//
//  D1 の無料枠切れ（[[d1Breaker]]）や障害で一覧クエリが 0 件になったとき、
//  ASSETS 配信の静的キャッシュJSONだけで**それらしい一覧を返す**ためのモジュール。
//  Workers Assets のリクエストは無料枠を消費しないので、これが無料の読み取りレプリカになる。
//
//  当然ながら完全な代替ではない:
//   - 母集団は静的キャッシュに載っている ~900件（新作300/人気400/セール60/ランキング200）だけ
//   - sample_video_url / series 等はキャッシュに無いので hasVideo・series 絞り込みは無視される
//  「空のサイト」よりはるかにマシ、という位置づけ。
// ============================================================

import { readStaticCacheAsync as readStaticCache } from './staticCache';
import { isBestOrCompilation } from './bestFilter';

type Row = Record<string, unknown>;

export type DegradedQuery = {
    sort?: string;
    q?: string;
    genre?: string;
    /** 名寄せ済みの別名グループ（グループ内OR・グループ間AND） */
    actressGroups?: string[][];
    maker?: string;
    exactMaker?: boolean;
    label?: string;
    source?: string;
    minDiscount?: number;
    excludeBest?: boolean;
    limit: number;
    offset?: number;
};

/** 日付を 'YYYY-MM-DD' に正規化（FANZA '-' / MGS '/'、時刻付き対応）*/
function normDate(v: unknown): string {
    const m = String(v ?? '').match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

/** セール終了済みを弾く（終了日不明は進行中扱い）*/
function notExpired(p: Row, today: string): boolean {
    const d = normDate(p.sale_end_date);
    return !d || d >= today;
}

// 静的キャッシュは日次バッチ製。母集団を広げるため複数ファイルを重ねて使う。
const POOL_FILES = [
    'home_preorder_cache.json',
    'products_new_cache.json',
    'products_popular_cache.json',
    'sale_cache.json',
    'ranking_2026_cache.json',
    'ranking_default_cache.json',
] as const;

/** 全キャッシュを product_id で重複排除して1つのプールにする */
async function loadPool(): Promise<Row[]> {
    const lists = await Promise.all(
        POOL_FILES.map(f => readStaticCache<Row[]>(f).catch(() => null)),
    );
    const seen = new Set<string>();
    const pool: Row[] = [];
    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const p of list) {
            const id = String(p?.product_id ?? '');
            if (!id || seen.has(id)) continue;
            seen.add(id);
            pool.push(p);
        }
    }
    return pool;
}

function textOf(p: Row): string {
    return [p.title, p.actresses, p.maker, p.genres, p.series_name].map(v => String(v ?? '')).join(' ').toLowerCase();
}

function matchesActressGroups(p: Row, groups: string[][]): boolean {
    const acts = String(p.actresses ?? '').split(/[,、]/).map(s => s.trim()).filter(Boolean);
    // グループ間AND（共演）・グループ内OR（別名）。D1側の絞り込みと同じ意味にする。
    return groups.every(g => acts.some(a => g.includes(a)));
}

function sortPool(rows: Row[], sort: string): Row[] {
    const byDateDesc = (a: Row, b: Row) => normDate(b.sale_start_date).localeCompare(normDate(a.sale_start_date));
    const popScore = (p: Row) =>
        Number(p.wish_count ?? 0) || Number(p.review_count ?? 0) * Number(p.review_average ?? 0);

    if (sort === 'discount') return rows.sort((a, b) => Number(b.discount_pct ?? 0) - Number(a.discount_pct ?? 0));
    if (sort === 'wish_count' || sort === 'popular') return rows.sort((a, b) => popScore(b) - popScore(a));
    if (sort === 'pre-order') return rows.sort((a, b) => normDate(a.sale_start_date).localeCompare(normDate(b.sale_start_date)));
    if (sort === 'random') {
        for (let i = rows.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rows[i], rows[j]] = [rows[j], rows[i]];
        }
        return rows;
    }
    return rows.sort(byDateDesc); // new / date_all / 既定
}

/**
 * 静的キャッシュだけで一覧を組み立てる。該当が無ければ空配列（呼び出し側は通常の空応答を返す）。
 */
export async function degradedProducts(qy: DegradedQuery): Promise<Row[]> {
    const pool = await loadPool();
    if (pool.length === 0) return [];

    const today = new Date().toISOString().slice(0, 10);
    const sort = qy.sort || 'new';
    const q = (qy.q || '').trim().toLowerCase();
    const genre = (qy.genre || '').trim();
    const maker = (qy.maker || '').trim();
    const label = (qy.label || '').trim();
    const minDiscount = qy.minDiscount ?? 0;

    let rows = pool.filter(p => {
        if (qy.source && String(p.source ?? '') !== qy.source) return false;
        if (qy.excludeBest && isBestOrCompilation(p.title, p.duration_min)) return false;
        if (q && !textOf(p).includes(q)) return false;
        if (genre && !String(p.genres ?? '').includes(genre)) return false;
        if (maker) {
            const mk = String(p.maker ?? '');
            const lb = String(p.label ?? '');
            if (qy.exactMaker ? (mk !== maker && lb !== maker) : !(mk.includes(maker) || lb.includes(maker))) return false;
        }
        if (label && !String(p.label ?? '').includes(label)) return false;
        if (qy.actressGroups && qy.actressGroups.length > 0 && !matchesActressGroups(p, qy.actressGroups)) return false;
        if (minDiscount > 0 && Number(p.discount_pct ?? 0) < minDiscount) return false;
        if (sort === 'discount') {
            if (Number(p.discount_pct ?? 0) < 1) return false;
            if (!notExpired(p, today)) return false; // 終了済みセールを先頭に出さない
        }
        if (sort === 'pre-order' && normDate(p.sale_start_date) <= today) return false;
        return true;
    });

    rows = sortPool(rows, sort);
    const offset = qy.offset ?? 0;
    return rows.slice(offset, offset + qy.limit);
}
