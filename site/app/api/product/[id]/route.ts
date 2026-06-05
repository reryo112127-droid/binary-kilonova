import { NextRequest, NextResponse } from 'next/server';
import { filterActresses } from '../../../../lib/actressFilter';
import { getMgsClient, getFanzaClient } from '../../../../lib/turso';
import { getCached, setCached } from '../../../../lib/apiCache';
import { cacheHeaders } from '../../../../lib/staticCache';
import { r2GetProduct, r2PutProduct } from '../../../../lib/productR2';

const PRODUCT_TTL = 60 * 60 * 1000; // 1時間

export const dynamic = 'force-dynamic';

const MGS_AFF_ID = 'C45KQ3NS85OYDAQRUA5YQUD8RH';

const AMATEUR_MAKER_PATTERNS = ['シロウト', 'ナンパ', '素人', 'ドキュメン', 'アマTV', 'ガチなま', 'ハメ撮り'];

function detectAmateur(maker: string | null, genres: string | null): boolean {
    if (genres && genres.includes('素人')) return true;
    if (maker && AMATEUR_MAKER_PATTERNS.some(p => maker.includes(p))) return true;
    return false;
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
    const { id } = await params;

    const cfCache = typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null;
    let cfCacheKey: Request | null = null;
    if (cfCache) {
        cfCacheKey = new Request(request.url);
        const cfHit = await cfCache.match(cfCacheKey);
        if (cfHit) return cfHit as unknown as NextResponse;
    }

    const cacheKey = `product_${id}`;
    const cached = getCached<Record<string, unknown>>(cacheKey, PRODUCT_TTL);
    if (cached) return NextResponse.json(cached, { headers: cacheHeaders(86400, 3600) });

    // R2 read-through: 永続キャッシュにあればTursoを叩かず返す
    const r2data = await r2GetProduct(id);
    if (r2data) {
        setCached(cacheKey, r2data);
        if (cfCache && cfCacheKey) {
            await cfCache.put(cfCacheKey, new Response(JSON.stringify(r2data), {
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
            }));
        }
        return NextResponse.json(r2data, { headers: cacheHeaders(86400, 3600) });
    }

    let mgsProduct: Record<string, unknown> | null = null;
    let fanzaProduct: Record<string, unknown> | null = null;

    // MGS を検索
    const mgsClient = await getMgsClient();
    if (mgsClient) {
        try {
            const result = await mgsClient.execute({
                sql: 'SELECT * FROM products WHERE product_id = ?',
                args: [id],
            });
            if (result.rows.length > 0) {
                mgsProduct = { ...result.rows[0] } as Record<string, unknown>;
            }
        } catch (e) {
            console.error('MGS Turso error:', e);
        }
    }

    // FANZA を検索
    const fanzaClient = await getFanzaClient();
    if (fanzaClient) {
        try {
            const result = await fanzaClient.execute({
                sql: 'SELECT * FROM products WHERE product_id = ?',
                args: [id],
            });
            if (result.rows.length > 0) {
                fanzaProduct = { ...result.rows[0] } as Record<string, unknown>;
            }
        } catch (e) {
            console.error('FANZA Turso error:', e);
        }
    }

    if (!mgsProduct && !fanzaProduct) {
        return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    // プライマリソース: MGS優先（より詳細なメタデータを持つことが多い）
    const primary = mgsProduct ?? fanzaProduct!;
    const source = mgsProduct ? 'mgs' : 'fanza';

    const mgsAffiliateUrl = mgsProduct
        ? `https://www.mgstage.com/product/product_detail/${id}/?aff=${MGS_AFF_ID}`
        : null;
    const fanzaAffiliateUrl = fanzaProduct
        ? (fanzaProduct.affiliate_url as string | null) ?? null
        : null;

    // セール情報: FANZA優先、なければMGSから取得
    const fanzaSale = fanzaProduct as Record<string, unknown> | null;
    const mgsSale   = mgsProduct   as Record<string, unknown> | null;

    const discountPct = Number(fanzaSale?.discount_pct ?? mgsSale?.discount_pct ?? 0);
    const listPrice   = (fanzaSale?.list_price    ?? mgsSale?.list_price    ?? null) as number | null;
    const currentPrice= (fanzaSale?.current_price ?? mgsSale?.current_price ?? null) as number | null;
    const saleEndDate = (fanzaSale?.sale_end_date ?? mgsSale?.sale_end_date ?? null) as string | null;

    // duration_min=1はAPIのデータ不備（DMM APIがプレースホルダーとして1を返す）なのでnullに
    const durationMin = (() => {
        const d = Number(primary.duration_min);
        return (d && d > 1) ? d : null;
    })();

    // FANZAレビュー（数値のみ。テキストは取得しない）
    const reviewAverage = Number(fanzaProduct?.review_average ?? 0);
    const reviewCount   = Number(fanzaProduct?.review_count   ?? 0);

    const responseData = {
        ...primary,
        duration_min: durationMin,
        source,
        // 後方互換性のため affiliate_url はプライマリソースのURLを保持
        affiliate_url: mgsAffiliateUrl ?? fanzaAffiliateUrl,
        // 各プラットフォームのURL（nullなら未掲載）
        mgs_affiliate_url: mgsAffiliateUrl,
        fanza_affiliate_url: fanzaAffiliateUrl,
        // セール情報
        discount_pct: discountPct,
        list_price: listPrice,
        current_price: currentPrice,
        sale_end_date: saleEndDate,
        // FANZAレビュースコア
        review_average: reviewAverage || null,
        review_count: reviewCount || null,
        actresses: filterActresses(
            // MGS優先だが空の場合はFANZA側(AVWIKI補完済み)にフォールバック
            (mgsProduct?.actresses as string | null)
            || (fanzaProduct?.actresses as string | null)
            || null,
            (primary.genres as string | null) || null,
            (primary.maker as string | null) || null
        ),
        is_amateur: detectAmateur(
            (primary.maker as string | null) || null,
            (primary.genres as string | null) || null
        ),
        sample_images: (() => {
            try {
                return primary.sample_images_json ? JSON.parse(String(primary.sample_images_json)) : [];
            } catch {
                return [];
            }
        })(),
    };
    setCached(cacheKey, responseData);
    // R2に永続保存（次回以降はTuruso不要）
    await r2PutProduct(id, responseData);
    if (cfCache && cfCacheKey) {
        await cfCache.put(cfCacheKey, new Response(JSON.stringify(responseData), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
        }));
    }
    return NextResponse.json(responseData, { headers: cacheHeaders(86400, 3600) });
    } catch (err: unknown) {
        console.error('Product API error:', err);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
