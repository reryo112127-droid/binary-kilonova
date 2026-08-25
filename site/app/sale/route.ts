import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../../lib/injectLayout';
import { injectHubSeo, replaceH1 } from '../../lib/pageMeta';
import { edgeLookup, edgeStore } from '../../lib/edgeCache';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    const htmlFile = isMobile
        ? '/design/sale.html'
        : '/design/web/sale.html';

    // 再クロール・リピート訪問を Worker 非起動で返す(UAでHTMLが変わるので m/w を鍵に含める)
    const edge = await edgeLookup(request.url, isMobile ? 'm' : 'w');
    if (edge.hit) return edge.hit;

    try {
        let html = await readHtml(request.url, htmlFile);
        html = isMobile ? injectMobileLayout(html, 'sale', { skipClean: true }) : injectWebLayout(html);
        html = injectHubSeo(html, {
            title: 'AV セール中の作品',
            description: 'FANZA・MGSで今セール中のAV作品をまとめて掲載。割引率と両プラットフォームの最安値を比べて、安く買えるタイミングを逃さずチェックできます。',
            path: '/sale',
            breadcrumb: 'セール',
        });
        // モバイル版 sale.html の H1 は中身が空だった
        html = replaceH1(html, 'セール中のAV作品');

        const resp = new NextResponse(html, {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                // セールは日次更新。エッジ30分で再クロール時のWorker起動を抑える。
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
