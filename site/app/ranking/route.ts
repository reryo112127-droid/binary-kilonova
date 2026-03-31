import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { injectMobileLayout, injectWebLayout } from '../../lib/injectLayout';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

// Design_Exportのタブバー（replaceHeaderで消えるため再注入）
// activeTab: 'products' | 'actresses'
function rankingTabBar(activeTab: 'products' | 'actresses'): string {
    const active = 'flex flex-col items-center justify-center border-b-2 border-primary text-primary pb-2 pt-1 flex-1 transition-all';
    const inactive = 'flex flex-col items-center justify-center border-b-2 border-transparent text-slate-500 dark:text-slate-400 pb-2 pt-1 flex-1 transition-all';
    return `<div class="sticky top-[49px] z-40 bg-background-light/95 dark:bg-background-dark/95 backdrop-blur-md px-4 border-b border-primary/10"><div class="flex justify-between"><a class="${activeTab === 'products' ? active : inactive}" href="/ranking"><p class="text-xs font-bold">作品</p></a><a class="${activeTab === 'actresses' ? active : inactive}" href="/ranking/actress"><p class="text-xs font-bold">出演者</p></a></div></div>`;
}

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    const htmlFile = isMobile
        ? path.join(process.cwd(), 'public', 'design', 'ranking.html')
        : path.join(process.cwd(), 'public', 'design', 'web', 'ranking.html');

    try {
        let html = fs.readFileSync(htmlFile, 'utf-8');
        html = isMobile ? injectMobileLayout(html, 'ranking', true) : injectWebLayout(html);
        if (isMobile) {
            // タブバーをMOBILE_HEADERの直後に再挿入
            html = html.replace('</header>', `</header>\n${rankingTabBar('products')}`);
            // tuneアイコン → カスタムランキング作成ページ
            html = html.replace('</body>', `<script>(function(){document.querySelectorAll('.material-symbols-outlined').forEach(function(el){if(el.textContent.trim()==='tune'){el.style.cursor='pointer';el.addEventListener('click',function(){location.href='/ranking/custom';});}});})();</script>\n</body>`);
        }
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
