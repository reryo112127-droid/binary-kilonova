import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../../lib/injectLayout';
import { injectHubSeo, replaceH1 } from '../../lib/pageMeta';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    const htmlFile = isMobile
        ? '/design/video.html'
        : '/design/web/home.html'; // PC版は未実装のためホームへ

    try {
        let html = await readHtml(request.url, htmlFile);
        // 動画ページは全画面プレーヤー設計のため標準ヘッダーを注入しない
        html = isMobile ? injectMobileLayout(html, 'video', { skipHeader: true, skipClean: true }) : injectWebLayout(html);
        // PC版はホームのHTMLを流用しているため、canonicalを明示しないと重複ページ扱いになる
        html = injectHubSeo(html, {
            title: 'AV サンプル動画',
            description: 'FANZA・MGSのAVサンプル動画をまとめて視聴。気になった作品はそのまま詳細ページで価格と収録内容をチェックできます。',
            path: '/video',
            breadcrumb: 'サンプル動画',
        });
        html = replaceH1(html, 'AV サンプル動画');
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
