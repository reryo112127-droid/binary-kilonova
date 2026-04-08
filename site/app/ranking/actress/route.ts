import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
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

    const htmlFile = isMobile
        ? path.join(process.cwd(), 'public', 'design', 'ranking.html')
        : path.join(process.cwd(), 'public', 'design', 'web', 'actress-ranking-2026.html');

    try {
        let html = fs.readFileSync(htmlFile, 'utf-8');
        html = isMobile ? injectMobileLayout(html, 'ranking', true) : injectWebLayout(html);
        if (isMobile) {
            // Stitchのプレースホルダー画像・テキストを削除（データ読み込み前に表示されないように）
            html = html.replace(/src="https:\/\/lh3\.googleusercontent\.com\/[^"]+"/g, 'src="" style="display:none"');
            html = html.replace(/(<p id="rank-1-title"[^>]*>)[^<]*(<\/p>)/, '$1$2');
            html = html.replace(/(<p id="rank-2-title"[^>]*>)[^<]*(<\/p>)/, '$1$2');
            html = html.replace(/(<p id="rank-3-title"[^>]*>)[^<]*(<\/p>)/, '$1$2');
            // ranking-grid の静的ダミーカードを削除
            html = html.replace(/(<div id="ranking-grid"[^>]*>)[\s\S]*?(<\/div>\s*<\/section>)/, '$1\n$2');
            // 作品ランキングスクリプトとの競合を防ぐフラグを head に注入
            html = html.replace('</head>', `<script>window.__ACTRESS_RANKING=true;</script></head>`);
            html = html.replace('</header>', `</header>\n${rankingTabBar('actresses')}`);
            html = html.replace('</body>', `<script>
(function(){
  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function aurl(n){return '/actress/'+encodeURIComponent(n);}
  document.querySelectorAll('.material-symbols-outlined').forEach(function(el){
    if(el.textContent.trim()==='tune'){el.style.cursor='pointer';el.addEventListener('click',function(){location.href='/ranking/custom';});}
  });
  fetch('/api/ranking/actress?limit=12&fromDate=2026-01-01&toDate=2026-12-31')
    .then(function(r){return r.json();})
    .then(function(data){
      if(!Array.isArray(data)||!data.length)return;
      function setCard(n,a){
        var img=document.getElementById('rank-'+n+'-img');
        var ttl=document.getElementById('rank-'+n+'-title');
        var card=document.getElementById('rank-'+n+'-card');
        if(!a)return;
        if(img){
          // コンテナを 3:4矩形 → 正円に変更
          var wrap=img.parentElement;
          if(wrap){
            wrap.style.borderRadius='50%';
            wrap.style.aspectRatio='1/1';
            img.style.objectPosition='center top';
          }
          if(a.image_url){
            img.src=a.image_url;img.alt=esc(a.name||'');
          } else {
            img.style.display='none';
            if(wrap){
              var d=document.createElement('div');
              d.style.cssText='width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#e2e8f0;';
              d.innerHTML='<span class="material-symbols-outlined" style="font-size:2.5rem;color:#94a3b8">account_circle</span>';
              wrap.appendChild(d);
            }
          }
        }
        if(ttl)ttl.textContent=a.name||'';
        if(card)card.onclick=function(){location.href=aurl(a.name);};
      }
      setCard(1,data[0]);setCard(2,data[1]);setCard(3,data[2]);
      var grid=document.getElementById('ranking-grid');
      if(grid&&data.length>3){
        grid.innerHTML=data.slice(3).map(function(a,i){
          var rank=i+4;
          var imgHtml=a.image_url
            ?'<img class="w-full h-full object-cover object-center" src="'+esc(a.image_url)+'" alt="'+esc(a.name||'')+'" style="object-position:center top"/>'
            :'<div class="w-full h-full flex items-center justify-center bg-slate-200 dark:bg-slate-800"><span class="material-symbols-outlined text-slate-400 text-3xl">account_circle</span></div>';
          return '<a href="'+aurl(a.name)+'" class="flex flex-col items-center p-1.5">'
            +'<div class="relative mb-1.5 w-full">'
            +'<div class="w-full aspect-square rounded-full overflow-hidden border-2 border-primary/20 shadow-sm">'+imgHtml+'</div>'
            +'<span class="absolute top-0 left-0 w-5 h-5 flex items-center justify-center bg-black/60 text-white text-[9px] rounded-full font-bold">'+rank+'</span>'
            +'</div>'
            +'<h3 class="font-bold text-[10px] text-center line-clamp-1 w-full">'+esc(a.name||'')+'</h3></a>';
        }).join('');
      }
    })
    .catch(function(e){console.error('actress ranking error',e);});
})();
</script>\n</body>`);
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
