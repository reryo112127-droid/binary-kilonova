import { NextRequest, NextResponse } from 'next/server';
import { getCached, setCached } from '../../../../../lib/apiCache';
import { readStaticCacheAsync as readStaticCache, cacheHeaders } from '../../../../../lib/staticCache';
import { r2GetProduct } from '../../../../../lib/productR2';

const SIMILAR_TTL = 6 * 60 * 60 * 1000; // 6時間

export const dynamic = 'force-dynamic';

type ProductLite = Record<string, unknown>;

// 対象作品の出演女優の他作品を静的キャッシュ(女優別商品リスト)から集めて類似作品とする。
// R2 + 静的JSON のみ使用しTursoクエリをゼロにするTurso非依存実装。
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;

    const cfCache = typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null;
    let cfCacheKey: Request | null = null;
    if (cfCache) {
        cfCacheKey = new Request(request.url);
        const cfHit = await cfCache.match(cfCacheKey);
        if (cfHit) return cfHit as unknown as NextResponse;
    }

    const cacheKey = `similar_${id}`;
    const cached = getCached<ProductLite[]>(cacheKey, SIMILAR_TTL);
    if (cached) return NextResponse.json(cached, { headers: cacheHeaders(21600, 3600) });

    // 対象作品を R2 から取得（Turso非依存）
    const base = await r2GetProduct(id);
    if (!base) return NextResponse.json([], { headers: cacheHeaders(3600, 300) });

    const baseActresses = String(base.actresses ?? '').split(/,|、/).map(s => s.trim()).filter(Boolean);
    const baseMaker  = String(base.maker  ?? '').trim();
    const baseGenres = String(base.genres ?? '').split(',').map(s => s.trim()).filter(Boolean);

    // 候補: 出演女優の他作品を静的キャッシュ(女優別商品リスト)から収集
    const [top, ext] = await Promise.all([
        readStaticCache<Record<string, ProductLite[]>>('actress_top_products.json'),
        readStaticCache<Record<string, ProductLite[]>>('actress_extended_products.json'),
    ]);

    const seen = new Set<string>([String(id)]);
    const scored: { p: ProductLite; score: number }[] = [];
    for (const act of baseActresses) {
        const arr = (top && top[act]) || (ext && ext[act]) || [];
        for (const p of arr) {
            const pid = String(p.product_id);
            if (seen.has(pid)) continue;
            seen.add(pid);
            let score = 3; // 同女優
            if (p.maker && String(p.maker) === baseMaker) score += 1; // メーカー一致
            score += String(p.genres ?? '').split(',').map(s => s.trim()).filter(g => baseGenres.includes(g)).length; // ジャンル一致
            scored.push({ p, score });
        }
    }
    scored.sort((a, b) => b.score - a.score);
    const result = scored.slice(0, 8).map(s => s.p);

    setCached(cacheKey, result);
    if (cfCache && cfCacheKey) {
        await cfCache.put(cfCacheKey, new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600' },
        }));
    }
    return NextResponse.json(result, { headers: cacheHeaders(21600, 3600) });
}
