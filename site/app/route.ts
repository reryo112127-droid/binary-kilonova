import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../lib/injectLayout';
import {
    ssrFetchFanzaPreOrders,
    ssrFetchFanzaNewProducts,
    ssrFetchRanking,
    injectSsrScript,
} from '../lib/ssrFetch';
import { edgeLookup, edgeStore } from '../lib/edgeCache';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    // エッジキャッシュ優先(s-maxage窓内は Worker非起動=D1読み取りも発生しない)
    const edge = await edgeLookup(request.url, isMobile ? 'm' : 'w');
    if (edge.hit) return edge.hit;

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

        const resp = new NextResponse(html, {
            // Cache API に保存。s-maxage(30分)窓内のアクセスは Worker非起動で返り、D1優先化した予約取得の
            // D1読み取りも窓ごとに1回へ激減。予約/新作/ランキングは日次更新なので30分鮮度で十分。bfcacheは max-age=60 で維持。
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, s-maxage=1800, max-age=60',
                'CDN-Cache-Control': 'public, s-maxage=1800',
            },
        });
        await edgeStore(edge, resp);
        return resp;
    } catch {
        return new NextResponse('Not found', { status: 404 });
    }
}
