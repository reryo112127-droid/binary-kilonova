import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../../lib/injectLayout';
import { ssrFetchRanking, ssrFetchActressRanking, injectSsrScript } from '../../lib/ssrFetch';
import { injectHubSeo, replaceH1 } from '../../lib/pageMeta';
import { edgeLookup, edgeStore } from '../../lib/edgeCache';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

function rankingTabBar(activeTab: 'products' | 'actresses'): string {
    const active = 'flex flex-col items-center justify-center border-b-2 border-primary text-primary pb-2 pt-1 flex-1 transition-all';
    const inactive = 'flex flex-col items-center justify-center border-b-2 border-transparent text-slate-500 dark:text-slate-400 pb-2 pt-1 flex-1 transition-all';
    return `<div class="sticky top-[49px] z-40 bg-background-light/95 dark:bg-background-dark/95 backdrop-blur-md px-4 border-b border-primary/10"><div class="flex justify-between"><a class="${activeTab === 'products' ? active : inactive}" href="/ranking"><p class="text-xs font-bold">作品</p></a><a class="${activeTab === 'actresses' ? active : inactive}" href="/ranking/actress"><p class="text-xs font-bold">出演者</p></a></div></div>`;
}

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    const htmlFile = isMobile
        ? '/design/ranking.html'
        : '/design/web/ranking.html';

    // 再クロール・リピート訪問を Worker 非起動で返す(UAでHTMLが変わるので m/w を鍵に含める)
    const edge = await edgeLookup(request.url, isMobile ? 'm' : 'w');
    if (edge.hit) return edge.hit;

    try {
        let html = await readHtml(request.url, htmlFile);
        html = isMobile ? injectMobileLayout(html, 'ranking', true) : injectWebLayout(html);
        // デザインHTMLの <title> は空だった(サイトマップ申告済みなのに無題扱い)
        html = injectHubSeo(html, {
            title: 'AV作品 人気ランキング',
            description: 'FANZA・MGSのAV作品を人気順にランキング。新作から定番まで、レビュー数・お気に入り数をもとにした総合ランキングを毎日更新しています。',
            path: '/ranking',
            breadcrumb: 'ランキング',
        });
        html = replaceH1(html, 'AV作品 人気ランキング');
        if (isMobile) {
            html = html.replace('</header>', `</header>\n${rankingTabBar('products')}`);
            html = html.replace('</body>', `<script>(function(){document.querySelectorAll('.material-symbols-outlined').forEach(function(el){if(el.textContent.trim()==='tune'){el.style.cursor='pointer';el.addEventListener('click',function(){location.href='/ranking/custom';});}});})();</script>\n</body>`);
        }

        // SSRデータ取得・注入
        try {
            if (isMobile) {
                const ranking = await ssrFetchRanking(30);
                html = injectSsrScript(html, '__SSR_RANKING_DATA__', ranking);
            } else {
                const [ranking, actressRanking] = await Promise.all([
                    ssrFetchRanking(30),
                    ssrFetchActressRanking(30),
                ]);
                html = injectSsrScript(html, '__SSR_RANKING_DATA__', ranking);
                html = injectSsrScript(html, '__SSR_ACTRESS_RANKING_DATA__', actressRanking);
            }
        } catch (e) {
            console.error('SSR ranking data fetch failed:', e);
        }

        const resp = new NextResponse(html, {
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
