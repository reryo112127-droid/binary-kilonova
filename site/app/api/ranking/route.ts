import { NextRequest, NextResponse } from 'next/server';
import { getMgsClient, getFanzaClient, getSiteClient } from '../../../lib/turso';
import { initSiteSchema } from '../../../lib/siteDb';
import { computeProductScore, PRODUCT_SCORE } from '../../../lib/scoring';
import { filterActresses } from '../../../lib/actressFilter';

const CANDIDATE_LIMIT = 300; // スコア計算用候補数

export const revalidate = 300; // 5分キャッシュ

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 200);
    const fromDate = searchParams.get('fromDate') || ''; // e.g. "2026-01-01"
    const toDate = searchParams.get('toDate') || '';     // e.g. "2026-12-31"
    const excludeBest = searchParams.get('excludeBest') === '1';

    const mgsClient = getMgsClient();
    const fanzaClient = getFanzaClient();
    const siteClient = getSiteClient();

    if (!mgsClient && !fanzaClient) {
        return NextResponse.json([], { status: 503 });
    }

    // ─── Step 1: 候補作品を取得 ─────────────────────────────
    // MGSはYYYY/MM/DD形式、FANZAはYYYY-MM-DD形式 → MGSはREPLACEで正規化
    const BEST_PATTERNS = ['%BEST%', '%ベスト%', '%総集編%', '%コレクション%', '%Best%', '%best%'];

    function buildMgsDateConds(): { conds: string[]; args: string[] } {
        const conds: string[] = ['(duration_min IS NULL OR duration_min < 600)'];
        const args: string[] = [];
        if (fromDate) { conds.push("REPLACE(sale_start_date, '/', '-') >= ?"); args.push(fromDate); }
        if (toDate)   { conds.push("REPLACE(sale_start_date, '/', '-') <= ?"); args.push(toDate); }
        if (excludeBest) {
            BEST_PATTERNS.forEach(p => { conds.push('title NOT LIKE ?'); args.push(p); });
            conds.push('(duration_min IS NULL OR duration_min <= 200)');
        }
        return { conds, args };
    }
    function buildFanzaDateConds(): { conds: string[]; args: string[] } {
        const conds: string[] = [];
        const args: string[] = [];
        if (fromDate) { conds.push('sale_start_date >= ?'); args.push(fromDate); }
        if (toDate)   { conds.push('sale_start_date <= ?'); args.push(toDate); }
        if (excludeBest) {
            BEST_PATTERNS.forEach(p => { conds.push('title NOT LIKE ?'); args.push(p); });
            conds.push('(duration_min IS NULL OR duration_min <= 200)');
        }
        return { conds, args };
    }

    const mgsConds = buildMgsDateConds();
    const fanzaConds = buildFanzaDateConds();

    const [mgsRows, fanzaRows] = await Promise.all([
        mgsClient
            ? mgsClient.execute({
                  sql: `SELECT product_id, title, actresses, main_image_url, wish_count,
                               genres, maker, sale_start_date
                        FROM products
                        WHERE ${mgsConds.conds.join(' AND ')}
                        ORDER BY wish_count DESC
                        LIMIT ${CANDIDATE_LIMIT}`,
                  args: mgsConds.args,
              }).then(r => r.rows).catch(() => [])
            : [],
        fanzaClient
            ? fanzaClient.execute({
                  sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count,
                               genres, maker, sale_start_date,
                               COALESCE(discount_pct, 0) AS discount_pct
                        FROM products
                        ${fanzaConds.conds.length ? 'WHERE ' + fanzaConds.conds.join(' AND ') : ''}
                        ORDER BY sale_start_date DESC
                        LIMIT ${CANDIDATE_LIMIT}`,
                  args: fanzaConds.args,
              }).then(r => r.rows).catch(() => [])
            : [],
    ]);

    // ─── Step 2: productIdリストを作成（重複排除） ───────────
    type ProductRow = {
        product_id: string;
        title: string;
        actresses: string | null;
        main_image_url: string;
        wish_count: number;
        discount_pct: number;
        genres: string | null;
        maker: string | null;
        sale_start_date: string | null;
        source: 'mgs' | 'fanza';
    };

    const productMap = new Map<string, ProductRow>();
    for (const row of mgsRows) {
        const r = row as Record<string, unknown>;
        const pid = String(r.product_id);
        if (!productMap.has(pid)) {
            productMap.set(pid, {
                product_id: pid,
                title: String(r.title ?? ''),
                actresses: filterActresses(
                    (r.actresses as string | null) || null,
                    (r.genres as string | null) || null,
                    (r.maker as string | null) || null
                ),
                main_image_url: String(r.main_image_url ?? ''),
                wish_count: Number(r.wish_count ?? 0),
                discount_pct: 0,
                genres: (r.genres as string | null) || null,
                maker: (r.maker as string | null) || null,
                sale_start_date: (r.sale_start_date as string | null) || null,
                source: 'mgs',
            });
        }
    }
    for (const row of fanzaRows) {
        const r = row as Record<string, unknown>;
        const pid = String(r.product_id);
        if (!productMap.has(pid)) {
            productMap.set(pid, {
                product_id: pid,
                title: String(r.title ?? ''),
                actresses: filterActresses(
                    (r.actresses as string | null) || null,
                    (r.genres as string | null) || null,
                    (r.maker as string | null) || null
                ),
                main_image_url: String(r.main_image_url ?? ''),
                wish_count: Number(r.wish_count ?? 0),
                discount_pct: Number(r.discount_pct ?? 0),
                genres: (r.genres as string | null) || null,
                maker: (r.maker as string | null) || null,
                sale_start_date: (r.sale_start_date as string | null) || null,
                source: 'fanza',
            });
        }
    }

    const products = Array.from(productMap.values());
    const productIds = products.map(p => p.product_id);

    // ─── Step 3: サイトDBから一括取得 ────────────────────────
    const siteDataMap = new Map<string, {
        siteLikes: number;
        reviewStarCounts: Partial<Record<number, number>>;
        purchaseCount: number;
    }>();

    if (siteClient && productIds.length > 0) {
        try {
            await initSiteSchema();
            const placeholders = productIds.map(() => '?').join(',');

            const [likesRes, reviewsRes, purchasesRes] = await Promise.all([
                siteClient.execute({
                    sql: `SELECT product_id, COUNT(*) as cnt FROM product_likes WHERE product_id IN (${placeholders}) GROUP BY product_id`,
                    args: productIds,
                }),
                siteClient.execute({
                    sql: `SELECT product_id, stars, COUNT(*) as cnt FROM product_reviews WHERE product_id IN (${placeholders}) GROUP BY product_id, stars`,
                    args: productIds,
                }),
                siteClient.execute({
                    sql: `SELECT product_id, COUNT(*) as cnt FROM purchase_events WHERE product_id IN (${placeholders}) GROUP BY product_id`,
                    args: productIds,
                }),
            ]);

            for (const row of likesRes.rows) {
                const pid = String(row.product_id);
                if (!siteDataMap.has(pid)) siteDataMap.set(pid, { siteLikes: 0, reviewStarCounts: {}, purchaseCount: 0 });
                siteDataMap.get(pid)!.siteLikes = Number(row.cnt ?? 0);
            }
            for (const row of reviewsRes.rows) {
                const pid = String(row.product_id);
                if (!siteDataMap.has(pid)) siteDataMap.set(pid, { siteLikes: 0, reviewStarCounts: {}, purchaseCount: 0 });
                const stars = Number(row.stars);
                siteDataMap.get(pid)!.reviewStarCounts[stars] = Number(row.cnt ?? 0);
            }
            for (const row of purchasesRes.rows) {
                const pid = String(row.product_id);
                if (!siteDataMap.has(pid)) siteDataMap.set(pid, { siteLikes: 0, reviewStarCounts: {}, purchaseCount: 0 });
                siteDataMap.get(pid)!.purchaseCount = Number(row.cnt ?? 0);
            }
        } catch (err) {
            console.error('Site DB ranking query error:', err);
        }
    }

    // ─── Step 4: スコア計算 + MGS/FANZAを分離してインターリーブ ──
    const now = Date.now();
    const scoredAll = products.map(p => {
        const siteData = siteDataMap.get(p.product_id) ?? { siteLikes: 0, reviewStarCounts: {}, purchaseCount: 0 };
        const score = computeProductScore(p.wish_count, siteData);
        // FANZA用: 配信日ベースの近日スコア（サイトデータ付きで評価）
        let fanzaRecency = 0;
        if (p.source === 'fanza' && p.sale_start_date) {
            const daysSince = (now - new Date(p.sale_start_date).getTime()) / 86400000;
            if (daysSince >= 0) fanzaRecency = Math.max(0, 100000 - daysSince * 100);
        }
        return { ...p, score, fanzaRecency, siteLikes: siteData.siteLikes };
    });

    // MGS: スコア降順 / FANZA: 近日配信日 + サイトデータ降順
    const mgsPool = scoredAll.filter(p => p.source === 'mgs').sort((a, b) => b.score - a.score);
    const fanzaPool = scoredAll.filter(p => p.source === 'fanza').sort((a, b) => (b.score + b.fanzaRecency) - (a.score + a.fanzaRecency));

    // 2:1 比でインターリーブ (MGS 2本, FANZA 1本)
    const result: typeof scoredAll = [];
    let mi = 0, fi = 0;
    while (result.length < limit && (mi < mgsPool.length || fi < fanzaPool.length)) {
        // 2 MGS
        for (let k = 0; k < 2 && mi < mgsPool.length && result.length < limit; k++) {
            result.push(mgsPool[mi++]);
        }
        // 1 FANZA
        if (fi < fanzaPool.length && result.length < limit) {
            result.push(fanzaPool[fi++]);
        }
    }

    return NextResponse.json(result.slice(0, limit));
}
