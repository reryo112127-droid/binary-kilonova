import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { injectMobileLayout, injectWebLayout } from '../../lib/injectLayout';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    const htmlFile = isMobile
        ? path.join(process.cwd(), 'public', 'design', 'mypage.html')
        : path.join(process.cwd(), 'public', 'design', 'web', 'mypage.html');

    try {
        let html = fs.readFileSync(htmlFile, 'utf-8');
        html = isMobile ? injectMobileLayout(html, 'mypage') : injectWebLayout(html);
        if (!isMobile) {
            // WEB版: いいねした作品・女優・貢献データをAPIから読み込むスクリプトを注入
            const webMypageScript = `<script>
(function(){
  function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');}
  function sid(){var s=localStorage.getItem('_sid');if(!s){s=Math.random().toString(36).slice(2)+Date.now().toString(36);localStorage.setItem('_sid',s);}return s;}
  var SID=sid();

  // いいねした作品
  var likedGrid=document.getElementById('liked-works');
  if(likedGrid){
    fetch('/api/mypage/likes?sessionId='+encodeURIComponent(SID)).then(function(r){return r.json();}).then(function(items){
      if(!items||!items.length){likedGrid.innerHTML='<p class="text-sm text-slate-400 col-span-4 py-8 text-center">まだいいねした作品がありません</p>';return;}
      likedGrid.innerHTML='<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-6">'+items.slice(0,12).map(function(p){
        var img=p.main_image_url||'';var pid=encodeURIComponent(p.product_id||'');var t=esc((p.title||'').substring(0,40));
        var dt=p.sale_start_date?(String(p.sale_start_date).slice(0,4)+'年'):'';
        return '<div class="group cursor-pointer" onclick="location.href=\'/product/'+pid+'\'">'
          +'<div class="aspect-[3/4] rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-800 relative mb-3">'
          +(img?'<img class="w-full h-full object-cover object-left-top group-hover:scale-105 transition-transform duration-300" src="'+esc(img)+'" alt="'+t+'"/>':'<div class="w-full h-full bg-slate-200"></div>')
          +'</div><h3 class="text-sm font-semibold truncate group-hover:text-primary transition-colors">'+t+'</h3>'
          +(dt?'<p class="text-xs text-slate-500">'+dt+'リリース</p>':'')
          +'</div>';
      }).join('')+'</div>';
    }).catch(function(){});
  }

  // いいねした女優
  var actressTab=document.querySelector('[data-tab="liked-performers"]');
  var actressContent=document.getElementById('liked-performers');
  if(actressContent){
    fetch('/api/mypage/actress-likes?sessionId='+encodeURIComponent(SID)).then(function(r){return r.json();}).then(function(items){
      if(!items||!items.length){actressContent.innerHTML='<p class="text-sm text-slate-400 py-8 text-center">まだいいねした女優がいません</p>';return;}
      actressContent.innerHTML='<div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-4">'+items.map(function(a){
        var img=a.image_url||'';var an=encodeURIComponent(a.name||'');var name=esc(a.name||'');
        return '<div class="group cursor-pointer text-center" onclick="location.href=\'/actress/'+an+'\'">'
          +'<div class="w-full aspect-square rounded-full overflow-hidden bg-slate-100 dark:bg-slate-800 mb-2 mx-auto">'
          +(img?'<img class="w-full h-full object-cover group-hover:scale-105 transition-transform" src="'+esc(img)+'" alt="'+name+'"/>':'<span class="material-symbols-outlined text-slate-300 flex items-center justify-center w-full h-full text-4xl">account_circle</span>')
          +'</div><p class="text-xs font-semibold truncate group-hover:text-primary transition-colors">'+name+'</p></div>';
      }).join('')+'</div>';
    }).catch(function(){});
  }

  // 貢献タブ
  var contribTab=document.querySelector('[data-tab="recommended-works"]');
  if(contribTab){
    contribTab.textContent='貢献履歴';
    contribTab.setAttribute('data-tab','contrib');
    var contribContent=document.getElementById('recommended-works');
    if(contribContent){
      contribContent.id='contrib';
      contribContent.innerHTML='<p class="text-sm text-slate-400">読み込み中...</p>';
      contribTab.addEventListener('click',function(){
        fetch('/api/mypage/contributions',{headers:{'x-session-id':SID}}).then(function(r){return r.json();}).then(function(d){
          var count=d.count||0;
          var BADGES=[{min:100,label:'殿堂入り',emoji:'🏆'},{min:50,label:'プラチナ',emoji:'💎'},{min:20,label:'ゴールド',emoji:'🥇'},{min:5,label:'シルバー',emoji:'🥈'},{min:1,label:'ブロンズ',emoji:'🥉'}];
          var cur=BADGES.find(function(b){return count>=b.min;})||null;
          var html='<div class="p-6 bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 mb-6">'
            +'<div class="text-4xl mb-2">'+(cur?cur.emoji:'—')+'</div>'
            +'<div class="font-bold text-lg mb-1">'+(cur?cur.label:'まだバッジなし')+'</div>'
            +'<div class="text-slate-500 text-sm">累計貢献数: '+count+'件</div></div>';
          if(d.recent&&d.recent.length){
            html+='<div class="space-y-2">'+d.recent.map(function(r){
              var dt=new Date(r.created_at);var ds=isNaN(dt)?'':((dt.getMonth()+1)+'/'+dt.getDate());
              return '<a href="/product/'+encodeURIComponent(r.product_id)+'" class="flex items-center gap-3 p-3 rounded-xl bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 hover:border-primary/30 transition-all">'
                +'<span class="material-symbols-outlined text-primary text-sm">person_add</span>'
                +'<span class="flex-1 text-sm font-bold uppercase">'+r.product_id+'</span>'
                +(ds?'<span class="text-xs text-slate-400">'+ds+'</span>':'')+'</a>';
            }).join('')+'</div>';
          } else {
            html+='<p class="text-sm text-slate-400">まだ貢献がありません</p>';
          }
          contribContent.innerHTML=html;
        }).catch(function(){});
      },{once:true});
    }
  }
})();
</script>`;
            html = html.replace('</body>', webMypageScript + '\n</body>');
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
