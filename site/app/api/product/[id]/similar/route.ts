import { NextRequest, NextResponse } from 'next/server';
import { getCached, setCached } from '../../../../../lib/apiCache';
import { readStaticCacheAsync as readStaticCache, cacheHeaders } from '../../../../../lib/staticCache';
import { r2GetProduct } from '../../../../../lib/productR2';
import { getMgsClient, getFanzaClient } from '../../../../../lib/turso';
import { filterActresses } from '../../../../../lib/actressFilter';

const SIMILAR_TTL = 6 * 60 * 60 * 1000; // 6時間
const BASE_TTL = 24 * 60 * 60 * 1000;   // 元作品メタは1日メモリ保持（D1読み取り削減）

export const dynamic = 'force-dynamic';

type ProductLite = Record<string, unknown>;

/**
 * 類似作品の起点となる作品のメタ（出演者/メーカー/ジャンル）を取得する。
 * R2 read-through は無効化済み（productR2.R2_ENABLED=false）で r2GetProduct は常に null を返すため、
 * D1 への軽量フォールバックが無いと類似作品が常に空になる。
 * Cloudflare無料枠を守るため、必要な3列だけ・1行だけ引き、メモリ+CF Cacheで再取得を抑える。
 */
async function fetchBaseMeta(id: string): Promise<ProductLite | null> {
    const memoKey = `similar_base_${id}`;
    const memo = getCached<ProductLite>(memoKey, BASE_TTL);
    if (memo) return memo;

    const r2 = await r2GetProduct(id);
    if (r2) { setCached(memoKey, r2); return r2; }

    const SQL = 'SELECT actresses, maker, genres FROM products WHERE product_id = ? LIMIT 1';
    const [mgsClient, fanzaClient] = await Promise.all([getMgsClient(), getFanzaClient()]);
    const [mgsRow, fanzaRow] = await Promise.all([
        mgsClient ? mgsClient.execute({ sql: SQL, args: [id] }).then(r => r.rows[0] ?? null).catch(() => null) : null,
        fanzaClient ? fanzaClient.execute({ sql: SQL, args: [id] }).then(r => r.rows[0] ?? null).catch(() => null) : null,
    ]);
    const row = mgsRow ?? fanzaRow;
    if (!row) return null;
    // 女優別キャッシュのキーはフィルタ済みの名前なので、ここでも同じ正規化を通す
    const base: ProductLite = {
        ...row,
        actresses: filterActresses(
            (row.actresses as string | null) || null,
            (row.genres as string | null) || null,
            (row.maker as string | null) || null,
        ),
    };
    setCached(memoKey, base);
    return base;
}

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

    const base = await fetchBaseMeta(id);
    if (!base) return NextResponse.json([], { headers: cacheHeaders(3600, 300) });

    const baseActresses = String(base.actresses ?? '').split(/,|、/).map(s => s.trim()).filter(Boolean);
    const baseMaker  = String(base.maker  ?? '').trim();
    const baseGenres = String(base.genres ?? '').split(',').map(s => s.trim()).filter(Boolean);

    // 候補: 出演女優の他作品を静的キャッシュ(女優別商品リスト)から収集。
    // extended は 19MB あるので top で全員賄えた場合は読み込まない（isolateのメモリ・CPU節約）。
    const top = await readStaticCache<Record<string, ProductLite[]>>('actress_top_products.json');
    const needsExt = baseActresses.some(a => !(top && top[a]));
    const ext = needsExt
        ? await readStaticCache<Record<string, ProductLite[]>>('actress_extended_products.json')
        : null;

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
