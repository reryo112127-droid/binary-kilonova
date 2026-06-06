import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../../lib/injectLayout';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

// 検索条件を /api/products の URL に変換
function buildPrefetchUrl(base: string, sp: URLSearchParams): string | null {
    const q       = sp.get('q')       || '';
    const actress = sp.get('actress') || '';
    const maker   = sp.get('maker')   || '';
    const genre   = sp.get('genre')   || '';
    const label   = sp.get('label')   || '';
    const series  = sp.get('series')  || '';

    if (!q && !actress && !maker && !genre && !label && !series) return null;

    const p = new URLSearchParams();
    p.set('limit', '41'); // モバイル20件+1 / Web40件+1 の多い方
    p.set('sort', 'new');
    p.set('excludeBest', '1');
    if (q)       p.set('q',       q);
    if (actress) p.set('actress', actress);
    if (maker)   p.set('maker',   maker);
    if (genre)   p.set('genre',   genre);
    if (label)   p.set('label',   label);
    if (series)  p.set('series',  series);

    const origin = new URL(base).origin;
    return `${origin}/api/products?${p.toString()}`;
}

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    const htmlFile = isMobile
        ? '/design/search.html'
        : '/design/web/search-other.html';

    const sp = new URL(request.url).searchParams;

    // HTMLとAPIデータを並列取得
    const prefetchUrl = buildPrefetchUrl(request.url, sp);
    const [htmlResult, prefetchResult] = await Promise.all([
        readHtml(request.url, htmlFile).catch(() => null),
        prefetchUrl
            ? fetch(prefetchUrl, { signal: AbortSignal.timeout(4000) })
                .then(r => r.ok ? r.json() : null)
                .catch(() => null)
            : Promise.resolve(null),
    ]);

    if (!htmlResult) return new NextResponse('Not found', { status: 404 });

    let html = htmlResult;

    // 初回データをインライン注入（クライアントのAPI呼び出しを省略）
    if (prefetchResult && Array.isArray(prefetchResult)) {
        const payload = JSON.stringify({
            d: prefetchResult,
            p: {
                q:       sp.get('q')       || '',
                actress: sp.get('actress') || '',
                maker:   sp.get('maker')   || '',
                genre:   sp.get('genre')   || '',
                label:   sp.get('label')   || '',
            },
        });
        html = html.replace('</head>', `<script>window.__SD__=${payload};</script></head>`);
    }

    html = isMobile ? injectMobileLayout(html, 'search') : injectWebLayout(html);
    return new NextResponse(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'private, no-store',
        },
    });
}
