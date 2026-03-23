import { NextRequest, NextResponse } from 'next/server';
import { filterActresses } from '../../../../lib/actressFilter';
import { getMgsClient, getFanzaClient } from '../../../../lib/turso';

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
    const { id } = await params;

    let mgsProduct: Record<string, unknown> | null = null;
    let fanzaProduct: Record<string, unknown> | null = null;

    // MGS を検索
    const mgsClient = getMgsClient();
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
    const fanzaClient = getFanzaClient();
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

    // セール情報: FANZAにのみ discount_pct がある
    const discountPct = fanzaProduct
        ? Number((fanzaProduct as Record<string, unknown>).discount_pct ?? 0)
        : 0;
    const listPrice = fanzaProduct
        ? ((fanzaProduct as Record<string, unknown>).list_price as number | null) ?? null
        : null;
    const currentPrice = fanzaProduct
        ? ((fanzaProduct as Record<string, unknown>).current_price as number | null) ?? null
        : null;

    return NextResponse.json({
        ...primary,
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
        actresses: filterActresses(
            (primary.actresses as string | null) || null,
            (primary.genres as string | null) || null,
            (primary.maker as string | null) || null
        ),
        is_amateur: detectAmateur(
            (primary.maker as string | null) || null,
            (primary.genres as string | null) || null
        ),
        sample_images: primary.sample_images_json
            ? JSON.parse(String(primary.sample_images_json))
            : [],
    });
}
