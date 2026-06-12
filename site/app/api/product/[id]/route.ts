import { NextRequest, NextResponse } from 'next/server';
import { filterActresses } from '../../../../lib/actressFilter';
import { getMgsClient, getFanzaClient } from '../../../../lib/turso';
import { getCached, setCached } from '../../../../lib/apiCache';
import { cacheHeaders, readStaticCacheAsync } from '../../../../lib/staticCache';
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

type PlatPrice = { current: number | null; list: number | null; discount: number };

/**
 * 同一作品がMGSとFANZAの両方にある場合、相手プラットフォームの
 * アフィリエイトURL・現在価格を引いて応答に付与し、どちらが安いかを判定する。
 * cross_platform.json（品番コア対応表）で相手の品番を引き、相手DBを1行だけ参照する。
 */
async function enrichCrossPlatform(data: Record<string, unknown>, id: string): Promise<void> {
    const primarySource = (data.source as string) || (String(id).includes('-') ? 'mgs' : 'fanza');
    const pCur = (data.current_price ?? null) as number | null;
    const primaryPrice: PlatPrice | null = (pCur != null)
        ? { current: pCur, list: (data.list_price ?? null) as number | null, discount: Number(data.discount_pct ?? 0) }
        : null;

    // プライマリ側の価格は先に確定させる（相手側の取得が失敗しても片側価格は必ず表示する）。
    if (primarySource === 'mgs') { data.mgs_price = primaryPrice; data.fanza_price = null; }
    else { data.fanza_price = primaryPrice; data.mgs_price = null; }
    data.cheaper_platform = null;
    data.cheaper_saving = 0;

    try {
        const map = await readStaticCacheAsync<Record<string, string>>('cross_platform.json');
        const counterpartId = map?.[id] || null;
        if (!counterpartId) return;

        const counterSource = primarySource === 'mgs' ? 'fanza' : 'mgs';
        const client = counterSource === 'fanza' ? await getFanzaClient() : await getMgsClient();
        if (!client) return;
        // MGSのスリムD1には affiliate_url カラムが無い（URLは品番から構築する）ため、
        // SELECT対象をプラットフォームごとに分ける。
        const cols = counterSource === 'fanza'
            ? 'affiliate_url, current_price, list_price, discount_pct'
            : 'current_price, list_price, discount_pct';
        const r = await client.execute({
            sql: `SELECT ${cols} FROM products WHERE product_id = ? LIMIT 1`,
            args: [counterpartId],
        });
        const row = r.rows[0] as Record<string, unknown> | undefined;
        if (!row) return;

        const cpPrice: PlatPrice = {
            current: (row.current_price ?? null) as number | null,
            list: (row.list_price ?? null) as number | null,
            discount: Number(row.discount_pct ?? 0),
        };
        const cpAffiliate = counterSource === 'fanza'
            ? ((row.affiliate_url as string | null) ?? null)
            : `https://www.mgstage.com/product/product_detail/${counterpartId}/?aff=${MGS_AFF_ID}`;

        if (counterSource === 'fanza') {
            data.fanza_price = cpPrice;
            if (cpAffiliate) data.fanza_affiliate_url = cpAffiliate;
        } else {
            data.mgs_price = cpPrice;
            if (cpAffiliate) data.mgs_affiliate_url = cpAffiliate;
        }

        // 両方の現在価格が判明している場合のみ安い方を判定
        const mp = data.mgs_price as PlatPrice | null;
        const fp = data.fanza_price as PlatPrice | null;
        if (mp?.current != null && fp?.current != null && mp.current !== fp.current) {
            data.cheaper_platform = mp.current < fp.current ? 'mgs' : 'fanza';
            data.cheaper_saving = Math.abs(mp.current - fp.current);
        }
    } catch (e) {
        console.error('cross-platform enrich error:', e);
    }
}

/**
 * D1(MGS→FANZA)から出演者文字列を1件引く。R2に古い空データが残っている作品を
 * スクレイプ後にD1値で補完(セルフヒール)するために使う。出演者がある方を返す。
 */
async function fetchActressesFromD1(id: string): Promise<string | null> {
    try {
        const mgsClient = await getMgsClient();
        if (mgsClient) {
            const r = await mgsClient.execute({ sql: 'SELECT actresses FROM products WHERE product_id = ? LIMIT 1', args: [id] });
            const a = (r.rows[0]?.actresses as string | null) || '';
            if (a.trim()) return a;
        }
    } catch (e) { console.error('selfheal MGS error:', e); }
    try {
        const fanzaClient = await getFanzaClient();
        if (fanzaClient) {
            const r = await fanzaClient.execute({ sql: 'SELECT actresses FROM products WHERE product_id = ? LIMIT 1', args: [id] });
            const a = (r.rows[0]?.actresses as string | null) || '';
            if (a.trim()) return a;
        }
    } catch (e) { console.error('selfheal FANZA error:', e); }
    return null;
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
        // セルフヒール: R2の出演者が空なら、スクレイプ後にD1へ入った可能性があるため
        // 一度だけD1を引いて補完し、R2へ書き戻して恒久修復する（出演者があった場合のみ）。
        const rawActs = ((r2data.actresses as string | null) || '').trim();
        if (!rawActs) {
            const healed = await fetchActressesFromD1(id);
            if (healed && healed.trim()) {
                r2data.actresses = healed;
                try { await r2PutProduct(id, r2data); } catch { /* 書き戻し失敗は無視（次回再試行） */ }
            }
        }
        // R2キャッシュ生成時は filterActresses 未適用のため、配信時に役名/通称を除去する
        r2data.actresses = filterActresses(
            (r2data.actresses as string | null) || null,
            (r2data.genres as string | null) || null,
            (r2data.maker as string | null) || null
        );
        await enrichCrossPlatform(r2data, id);
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
    await enrichCrossPlatform(responseData, id);
    setCached(cacheKey, responseData);
    // R2に永続保存（次回以降はD1不要）。
    // ただし FANZA はスリムD1に sample_images を持たないため、空ギャラリーで上書きしないよう
    // 画像がある場合のみ保存する（FANZAの完全な詳細は populate_r2_local が別途R2に投入する）。
    const sampleImgs = responseData.sample_images;
    const hasImages = Array.isArray(sampleImgs) && sampleImgs.length > 0;
    if (responseData.source === 'mgs' || hasImages) {
        await r2PutProduct(id, responseData);
    }
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
