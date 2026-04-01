import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { injectMobileLayout, injectWebLayout } from '../../../lib/injectLayout';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://lunar-zodiac.vercel.app';

function escHtml(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ name: string }> }
) {
    const { name } = await params;
    const actressName = decodeURIComponent(name);
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    const htmlFile = isMobile
        ? path.join(process.cwd(), 'public', 'design', 'search-actress.html')
        : path.join(process.cwd(), 'public', 'design', 'web', 'search-actress.html');

    try {
        let html = fs.readFileSync(htmlFile, 'utf-8');
        html = isMobile ? injectMobileLayout(html, 'search') : injectWebLayout(html);

        // SEO meta: canonical + title + description + JSON-LD
        const canonicalUrl = `${SITE_URL}/actress/${encodeURIComponent(actressName)}`;
        const seoTitle = `${escHtml(actressName)} | AV女優 出演作品・プロフィール | AVコンシェルジュ`;
        const desc = `${escHtml(actressName)}の出演作品一覧・プロフィール・スリーサイズ。FANZA・MGS動画の最新作から人気作まで網羅。`;
        const jsonLd = JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Person',
            name: actressName,
            url: canonicalUrl,
        });
        const metaBlock = [
            `<title>${seoTitle}</title>`,
            `<meta name="description" content="${desc}"/>`,
            `<link rel="canonical" href="${canonicalUrl}"/>`,
            `<meta property="og:title" content="${seoTitle}"/>`,
            `<meta property="og:description" content="${desc}"/>`,
            `<meta property="og:url" content="${canonicalUrl}"/>`,
            `<meta property="og:type" content="profile"/>`,
            `<meta name="twitter:card" content="summary"/>`,
            `<script type="application/ld+json">${jsonLd}</script>`,
        ].join('\n');
        html = html.replace(/<title>[^<]*<\/title>/, metaBlock);

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
