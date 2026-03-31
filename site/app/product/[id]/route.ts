import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
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

function injectSEOMeta(html: string, product: Record<string, unknown> | null, id: string): string {
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

    // JSON-LD (VideoObject)
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

    const metaBlock = [
        `<title>${escHtml(seoTitle)}</title>`,
        `<meta name="description" content="${escHtml(desc)}"/>`,
        `<meta property="og:title" content="${escHtml(seoTitle)}"/>`,
        `<meta property="og:description" content="${escHtml(desc)}"/>`,
        `<meta property="og:type" content="video.other"/>`,
        imgUrl ? `<meta property="og:image" content="${escHtml(imgUrl)}"/>` : '',
        `<meta name="twitter:card" content="summary_large_image"/>`,
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
        ? path.join(process.cwd(), 'public', 'design', 'product-detail.html')
        : path.join(process.cwd(), 'public', 'design', 'web', 'product-detail.html');

    try {
        let html = fs.readFileSync(htmlFile, 'utf-8');

        // DB取得 → SEOメタ注入（並列でHTML読込と実行）
        const product = await fetchProduct(id);
        html = injectSEOMeta(html, product, id);

        html = isMobile ? injectMobileLayout(html) : injectWebLayout(html);
        return new NextResponse(html, {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
            },
        });
    } catch {
        return new NextResponse('Not found', { status: 404 });
    }
}
