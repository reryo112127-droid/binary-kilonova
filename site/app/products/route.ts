import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { injectMobileLayout, injectWebLayout } from '../../lib/injectLayout';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

export const dynamic = 'force-dynamic';

const PRODUCTS_SCRIPT = `<script>
(function(){
  var params=new URLSearchParams(location.search);
  var type=params.get('type')||'new';
  var source=''; // '' | 'fanza' | 'mgs'
  var page=0;
  var loading=false;
  var hasMore=true;
  var LIMIT=30;

  // Pre-select segment tab based on ?type=
  document.querySelectorAll('input[name="content-type"]').forEach(function(r){
    r.checked=(type==='pre-order'&&r.value==='pre-order')||(type!=='pre-order'&&r.value==='new-releases');
  });

  var grid=document.getElementById('products-grid');
  var btnFanza=document.getElementById('btn-fanza');
  var btnMgs=document.getElementById('btn-mgs');

  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

  function updateSourceBtns(){
    if(!btnFanza||!btnMgs)return;
    var activeClass='bg-primary text-white border-primary';
    var inactiveClass='bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-transparent';
    btnFanza.className='flex h-9 shrink-0 items-center justify-center rounded-full border px-3 py-1 text-xs font-medium transition-all '+(source==='fanza'?activeClass:inactiveClass);
    btnMgs.className='flex h-9 shrink-0 items-center justify-center rounded-full border px-3 py-1 text-xs font-medium transition-all '+(source==='mgs'?activeClass:inactiveClass);
  }

  function renderSkeleton(){
    if(!grid)return;
    var h='';
    for(var i=0;i<9;i++){
      h+='<div class="flex flex-col gap-1.5">'
        +'<div class="relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-slate-200 animate-pulse"></div>'
        +'<div class="h-3 bg-slate-200 rounded animate-pulse w-full mt-1"></div>'
        +'<div class="h-3 bg-slate-200 rounded animate-pulse w-2/3"></div>'
        +'</div>';
    }
    grid.innerHTML=h;
  }

  function poster(url){if(!url)return '';if(url.includes('pb_e_'))return url.replace('pb_e_','pf_e_');return url;}
  function renderCards(products,append){
    if(!grid)return;
    var h=products.map(function(p){
      var imgHtml=p.main_image_url
        ?'<img class="h-full w-full object-cover object-right" src="'+esc(poster(p.main_image_url))+'" alt="'+esc(p.title)+'" loading="lazy"/>'
        :'<div class="h-full w-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center"><span class="material-symbols-outlined text-slate-400 text-3xl">movie</span></div>';
      return '<div class="flex flex-col gap-1.5" style="cursor:pointer" onclick="location.href=\'/product/\'+encodeURIComponent(\''+esc(p.product_id)+'\')">'
        +'<div class="relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-slate-200">'+imgHtml+'</div>'
        +'<p class="line-clamp-2 text-[11px] font-bold leading-tight">'+esc(p.title)+'</p>'
        +'</div>';
    }).join('');
    if(append)grid.insertAdjacentHTML('beforeend',h);
    else grid.innerHTML=h||'<p class="col-span-3 text-center text-xs text-slate-400 py-8">作品が見つかりませんでした</p>';
  }

  function getSortParam(){
    if(type==='pre-order')return'pre-order';
    var r=document.querySelector('input[name="sort-order"]:checked');
    return(r&&r.value==='popular')?'wish_count':'new';
  }

  function load(reset){
    if(loading)return;
    if(reset){page=0;hasMore=true;}
    if(!hasMore)return;
    loading=true;
    var offset=page*LIMIT;
    var url='/api/products?sort='+getSortParam()+'&limit='+LIMIT+'&offset='+offset;
    if(source)url+='&source='+source;
    fetch(url)
      .then(function(r){return r.json();})
      .then(function(data){
        if(!Array.isArray(data))data=[];
        if(data.length<LIMIT)hasMore=false;
        renderCards(data,!reset);
        page++;
        loading=false;
      })
      .catch(function(e){console.error('products load error',e);loading=false;});
  }

  // Initial load
  updateSourceBtns();
  renderSkeleton();
  load(true);

  // Segment tab change
  document.querySelectorAll('input[name="content-type"]').forEach(function(r){
    r.addEventListener('change',function(){
      type=r.value==='pre-order'?'pre-order':'new';
      var url=new URL(location.href);
      url.searchParams.set('type',type);
      history.replaceState(null,'',url.toString());
      renderSkeleton();
      load(true);
    });
  });

  // Sort order change
  document.querySelectorAll('input[name="sort-order"]').forEach(function(r){
    r.addEventListener('change',function(){
      if(type!=='pre-order'){renderSkeleton();load(true);}
    });
  });

  // FANZA/MGS source filter
  if(btnFanza){
    btnFanza.addEventListener('click',function(){
      source=source==='fanza'?'':'fanza';
      updateSourceBtns();
      renderSkeleton();
      load(true);
    });
  }
  if(btnMgs){
    btnMgs.addEventListener('click',function(){
      source=source==='mgs'?'':'mgs';
      updateSourceBtns();
      renderSkeleton();
      load(true);
    });
  }

  // Infinite scroll
  window.addEventListener('scroll',function(){
    if(loading||!hasMore)return;
    if(window.scrollY+window.innerHeight>=document.documentElement.scrollHeight-500){
      load(false);
    }
  },{passive:true});
})();
</script>`;

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);
    const params = new URL(request.url).searchParams;
    const type = params.get('type') || 'new';

    // PC版: web/new-products.html または web/pre-order.html
    // スマホ版: products.html（共通）
    const htmlFile = isMobile
        ? path.join(process.cwd(), 'public', 'design', 'products.html')
        : path.join(process.cwd(), 'public', 'design', 'web', type === 'pre-order' ? 'pre-order.html' : 'new-products.html');

    try {
        let html = fs.readFileSync(htmlFile, 'utf-8');

        if (isMobile) {
            // Add id to products grid for JS targeting
            html = html.replace(
                'class="grid grid-cols-3 gap-x-2 gap-y-4 px-4 pb-24"',
                'id="products-grid" class="grid grid-cols-3 gap-x-2 gap-y-4 px-4 pb-24"',
            );
            html = injectMobileLayout(html, '');
            html = html.replace('</body>', PRODUCTS_SCRIPT + '\n</body>');
        } else {
            // PC版HTMLは独自スクリプト付きなのでレイアウト注入のみ
            html = injectWebLayout(html);
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
