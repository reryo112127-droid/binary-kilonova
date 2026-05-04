import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../lib/injectLayout';
import {
    ssrFetchFanzaPreOrders,
    ssrFetchFanzaNewProducts,
    ssrFetchRanking,
    injectSsrScript,
} from '../lib/ssrFetch';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    const htmlFile = isMobile
        ? '/design/home.html'
        : '/design/web/home.html';

    try {
        let html = await readHtml(request.url, htmlFile);
        html = isMobile ? injectMobileLayout(html, 'home') : injectWebLayout(html);

        // SSRデータ取得・注入（失敗してもクライアントfetchにフォールバック）
        try {
            const [preOrders, newProducts, ranking] = await Promise.all([
                ssrFetchFanzaPreOrders(12),
                ssrFetchFanzaNewProducts(12),
                ssrFetchRanking(10),
            ]);
            html = injectSsrScript(html, '__SSR_HOME_DATA__', { preOrders, newProducts, ranking });
        } catch (e) {
            console.error('SSR home data fetch failed:', e);
        }

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
