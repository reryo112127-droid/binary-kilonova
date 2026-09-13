/**
 * ハブページ(ホーム / 新作 / 予約 / セール)の SSR 用作品リスト。
 *
 * これらの一覧はクライアントJSが描いており、生のHTMLに作品への <a> が0〜1本しか無かった
 * （2026-09-13 実測: / 1本・/new 0本・/ranking 0本・/sale 1本）。サイトで最も評価の高い
 * ページから作品ページへの内部リンクが、クローラの初回取得では届いていなかった。
 * 供給源は ASSETS の静的キャッシュだけ（D1 は1行も読まない）。
 */
import { readStaticCacheAsync as readStaticCache } from './staticCache';
import { isBestOrCompilation } from './bestFilter';
import type { Product } from './landingPage';

type Row = Record<string, unknown>;

/** 'YYYY-MM-DD' に正規化（FANZA '-' / MGS '/'、時刻付き対応） */
function normDate(v: unknown): string {
    const m = String(v ?? '').match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

/** 日本時間の今日（配信日は JST で入っている） */
function todayJst(): string {
    return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

async function load(file: string): Promise<Row[]> {
    const rows = await readStaticCache<Row[]>(file).catch(() => null);
    return Array.isArray(rows) ? rows : [];
}

/** 新作（配信済み・BEST/総集編除外）。/new とホームの既定表示と同じ条件。 */
export async function ssrNewList(limit: number): Promise<Product[]> {
    const today = todayJst();
    return (await load('products_new_cache.json'))
        .filter(p => !isBestOrCompilation(p.title, p.duration_min) && normDate(p.sale_start_date) <= today)
        .slice(0, limit) as Product[];
}

/** 予約（未配信のみ） */
export async function ssrPreorderList(limit: number): Promise<Product[]> {
    const today = todayJst();
    return (await load('home_preorder_cache.json'))
        .filter(p => normDate(p.sale_start_date) > today)
        .slice(0, limit) as Product[];
}

/** セール中（割引1%以上・終了済みを除外・割引率の高い順） */
export async function ssrSaleList(limit: number): Promise<Product[]> {
    const today = todayJst();
    return (await load('sale_cache.json'))
        .filter(p => Number(p.discount_pct ?? 0) >= 1 && (!normDate(p.sale_end_date) || normDate(p.sale_end_date) >= today))
        .sort((a, b) => Number(b.discount_pct ?? 0) - Number(a.discount_pct ?? 0))
        .slice(0, limit) as Product[];
}
