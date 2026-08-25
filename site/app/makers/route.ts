import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../../lib/injectLayout';
import { injectHubSeo } from '../../lib/pageMeta';
import { edgeLookup, edgeStore } from '../../lib/edgeCache';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);
    const htmlFile = isMobile ? '/design/makers.html' : '/design/web/makers.html';

    const edge = await edgeLookup(request.url, isMobile ? 'm' : 'w');
    if (edge.hit) return edge.hit;

    try {
        let html = await readHtml(request.url, htmlFile);
        html = isMobile ? injectMobileLayout(html, 'makers', { skipHeader: true }) : injectWebLayout(html);
        html = injectHubSeo(html, {
            title: 'AVメーカー・レーベル一覧',
            description: 'エスワン・ムーディーズ・アイデアポケットなどFANZA・MGSの主要AVメーカー／レーベルを一覧化。メーカー別に作品をまとめて探せます。',
            path: '/makers',
            breadcrumb: 'メーカー一覧',
        });
        const resp = new NextResponse(html, {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                // メーカー一覧はほぼ不変。エッジ6時間で再クロールのWorker起動を抑える。
                'Cache-Control': 'public, s-maxage=21600, max-age=300',
                'CDN-Cache-Control': 'public, s-maxage=21600',
            },
        });
        await edgeStore(edge, resp);
        return resp;
    } catch {
        return new NextResponse('Not found', { status: 404 });
    }
}
