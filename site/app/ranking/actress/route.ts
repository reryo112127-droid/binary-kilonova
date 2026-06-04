import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../../../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../../../lib/injectLayout';

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

    // 身体的特徴パラメータを読み取る
    const reqUrl = new URL(request.url);
    const filterHeight = reqUrl.searchParams.get('height') || '';
    const filterCup    = reqUrl.searchParams.get('cup')    || '';
    const filterAge    = reqUrl.searchParams.get('ageMin') || '';

    const htmlFile = isMobile
        ? '/design/ranking.html'
        : '/design/web/actress-ranking-2026.html';

    try {
        let html = await readHtml(request.url, htmlFile);
        html = isMobile ? injectMobileLayout(html, 'ranking', true) : injectWebLayout(html);
        if (isMobile) {
            // 身体的特徴フィルタのAPIクエリ文字列を組み立て（描画は ranking.html 本体が担当）
            const apiParams = new URLSearchParams({ limit: '30', fromDate: '2026-01-01', toDate: '2026-12-31' });
            if (filterHeight) apiParams.set('height', filterHeight);
            if (filterCup)    apiParams.set('cup', filterCup);
            if (filterAge)    apiParams.set('ageMin', filterAge);
            // 本体スクリプトが出演者ランキング取得に使うフィルタparamsをhead注入
            html = html.replace('</head>', `<script>window.__ACTRESS_API_PARAMS=${JSON.stringify(apiParams.toString())};</script></head>`);
            html = html.replace('</header>', `</header>\n${rankingTabBar('actresses')}`);

            // フィルタバッジのラベル生成
            const filterLabels: string[] = [];
            if (filterHeight) filterLabels.push(`身長${filterHeight.replace('-999', 'cm以上')}`);
            if (filterCup)    filterLabels.push(`${filterCup}カップ以上`);
            if (filterAge)    filterLabels.push(`${filterAge}歳以上`);
            const filterBadgeHtml = filterLabels.length
                ? `<div id="physical-filter-bar" style="display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px;background:#fff7ed;border-bottom:1px solid #fed7aa;">`
                  + filterLabels.map(l => `<span style="background:#f97316;color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;">${l}</span>`).join('')
                  + `<a href="/ranking/actress" style="margin-left:auto;font-size:11px;color:#9ca3af;text-decoration:none;">クリア</a></div>`
                : '';

            // 出演者セクションを表示・作品セクションを非表示にし、フィルタバッジ/tuneを設定
            // （ランキング描画は ranking.html 本体スクリプトが window.__ACTRESS_API_PARAMS を使って実施）
            html = html.replace('</body>', `<script>
(function(){
  var FILTER_BADGE = ${JSON.stringify(filterBadgeHtml)};
  var ws=document.getElementById('works-section'); if(ws)ws.classList.add('hidden');
  var as=document.getElementById('actress-section'); if(as)as.classList.remove('hidden');
  if(FILTER_BADGE){
    var tabBar=document.querySelector('[class*="sticky"][class*="top"]');
    if(tabBar&&tabBar.parentNode){var div=document.createElement('div');div.innerHTML=FILTER_BADGE;tabBar.parentNode.insertBefore(div.firstChild,tabBar.nextSibling);}
  }
  document.querySelectorAll('.material-symbols-outlined').forEach(function(el){
    if(el.textContent.trim()==='tune'){el.style.cursor='pointer';el.addEventListener('click',function(){location.href='/ranking/custom';});}
  });
})();
</script>\n</body>`);
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
