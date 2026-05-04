import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../../../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../../../lib/injectLayout';
import { getMgsClient, getFanzaClient } from '../../../lib/turso';
import { filterActresses } from '../../../lib/actressFilter';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

function escHtml(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function fetchProduct(id: string): Promise<Record<string, unknown> | null> {
    // FANZA優先（素人系作品が多い）
    const fanzaClient = getFanzaClient();
    if (fanzaClient) {
        try {
            const r = await fanzaClient.execute({
                sql: 'SELECT product_id, title, actresses, maker, label, genres, main_image_url, sale_start_date FROM products WHERE product_id = ? LIMIT 1',
                args: [id],
            });
            if (r.rows.length > 0) return { ...r.rows[0] } as Record<string, unknown>;
        } catch { /* fallthrough */ }
    }
    const mgsClient = getMgsClient();
    if (mgsClient) {
        try {
            const r = await mgsClient.execute({
                sql: 'SELECT product_id, title, actresses, maker, label, genres, main_image_url, sale_start_date FROM products WHERE product_id = ? LIMIT 1',
                args: [id],
            });
            if (r.rows.length > 0) return { ...r.rows[0] } as Record<string, unknown>;
        } catch { /* fallthrough */ }
    }
    return null;
}

// OGP用: 女優プロフィール画像（非露骨）を取得
async function fetchActressImageUrl(actressName: string): Promise<string | null> {
    const fanzaClient = getFanzaClient();
    if (!fanzaClient || !actressName) return null;
    try {
        const r = await fanzaClient.execute({
            sql: 'SELECT image_url FROM actress_profiles WHERE name = ? AND image_url IS NOT NULL LIMIT 1',
            args: [actressName],
        });
        if (r.rows.length > 0) return String(r.rows[0].image_url || '');
    } catch { /* ignore */ }
    return null;
}

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://lunar-zodiac.vercel.app';

function injectSEOMeta(html: string, product: Record<string, unknown> | null, id: string, actressImageUrl: string | null): string {
    const displayId = id.toUpperCase();

    // 女優名フィルタ適用
    const actresses = product
        ? filterActresses(
            (product.actresses as string | null) || null,
            (product.genres as string | null) || null,
            (product.maker as string | null) || null,
          ) || ''
        : '';

    const title    = product ? String(product.title   || '') : '';
    const maker    = product ? String(product.maker   || '') : '';
    const imgUrl   = product ? String(product.main_image_url || '') : '';
    const saleDate = product ? String(product.sale_start_date || '') : '';

    // タイトル: 「出演者名 品番 | AVコンシェルジュ」が最も検索に強い形式
    const seoTitle = actresses
        ? `${actresses} ${displayId} | AVコンシェルジュ`
        : `${displayId}${title ? ' ' + title.slice(0, 40) : ''} | AVコンシェルジュ`;

    // Description: 130字以内
    const descParts = [title.slice(0, 80)];
    if (actresses) descParts.push(`出演: ${actresses}`);
    if (maker)     descParts.push(`制作: ${maker}`);
    if (saleDate)  descParts.push(`配信: ${saleDate}`);
    const desc = descParts.join(' | ').slice(0, 130);

    // OGP画像: 女優プロフィール写真（非露骨）を優先。なければ og:image を省略
    // ※ パッケージ画像（main_image_url）は露骨なため SNS シェア時に使用しない
    const ogImageUrl = actressImageUrl || '';

    // JSON-LD (VideoObject) にはパッケージ画像を使用（検索エンジン向け）
    const actorList = actresses
        ? actresses.split(',').map(a => ({ '@type': 'Person', name: a.trim() }))
        : undefined;
    const jsonLd: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'VideoObject',
        name: title || displayId,
        description: desc,
    };
    if (imgUrl)    jsonLd.thumbnailUrl = imgUrl;
    if (actorList) jsonLd.actor = actorList;
    if (maker)     jsonLd.productionCompany = { '@type': 'Organization', name: maker };

    const canonicalUrl = `${SITE_URL}/product/${encodeURIComponent(id)}`;
    const metaBlock = [
        `<title>${escHtml(seoTitle)}</title>`,
        `<meta name="description" content="${escHtml(desc)}"/>`,
        `<link rel="canonical" href="${canonicalUrl}"/>`,
        `<meta property="og:title" content="${escHtml(seoTitle)}"/>`,
        `<meta property="og:description" content="${escHtml(desc)}"/>`,
        `<meta property="og:type" content="video.other"/>`,
        `<meta property="og:url" content="${canonicalUrl}"/>`,
        ogImageUrl ? `<meta property="og:image" content="${escHtml(ogImageUrl)}"/>` : '',
        ogImageUrl
            ? `<meta name="twitter:card" content="summary_large_image"/>`
            : `<meta name="twitter:card" content="summary"/>`,
        `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
    ].filter(Boolean).join('\n');

    // 既存の<title>タグをメタブロック全体に差し替え
    return html.replace(/<title>[^<]*<\/title>/, metaBlock);
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    const htmlFile = isMobile
        ? '/design/product-detail.html'
        : '/design/web/product-detail.html';

    try {
        let html = await readHtml(request.url, htmlFile);

        // 作品データ取得
        const product = await fetchProduct(id);

        // OGP用: 女優プロフィール画像を並列取得（露骨なパッケージ画像の代替）
        let actressImageUrl: string | null = null;
        if (product?.actresses) {
            const filtered = filterActresses(
                String(product.actresses),
                String(product.genres || ''),
                String(product.maker || '')
            );
            const firstName = filtered?.split(',')[0]?.trim();
            if (firstName) {
                actressImageUrl = await fetchActressImageUrl(firstName);
            }
        }

        html = injectSEOMeta(html, product, id, actressImageUrl);

        html = isMobile ? injectMobileLayout(html) : injectWebLayout(html);
        return new NextResponse(html, {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'private, max-age=60',
            },
        });
    } catch {
        return new NextResponse('Not found', { status: 404 });
    }
}
