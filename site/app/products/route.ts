import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../../lib/injectLayout';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

export const dynamic = 'force-dynamic';

const PRODUCTS_SCRIPT = `<script>
(function(){
  var params=new URLSearchParams(location.search);
  var type=params.get('type')||'new';
  var source=''; // '' | 'fanza' | 'mgs'
  var excludeBest=true;
  var showVr=false;
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
  var btnBest=document.getElementById('btn-best');
  var btnVr=document.getElementById('btn-vr');

  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function poster(url){
    if(!url)return '';
    if(url.includes('pb_e_'))return url.replace('pb_e_','pf_e_');
    if(url.includes('/digital/amateur/')&&url.endsWith('jm.jpg'))return url.replace('jm.jpg','jp-001.jpg');
    return url;
  }

  function updateSourceBtns(){
    if(!btnFanza||!btnMgs)return;
    var activeClass='bg-primary text-white border-primary';
    var inactiveClass='bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-transparent';
    btnFanza.className='flex h-9 shrink-0 items-center justify-center rounded-full border px-3 py-1 text-xs font-medium transition-all '+(source==='fanza'?activeClass:inactiveClass);
    btnMgs.className='flex h-9 shrink-0 items-center justify-center rounded-full border px-3 py-1 text-xs font-medium transition-all '+(source==='mgs'?activeClass:inactiveClass);
  }

  function updateBestBtn(){
    if(!btnBest)return;
    var icon=btnBest.querySelector('.material-symbols-outlined');
    if(icon){icon.textContent=excludeBest?'toggle_on':'toggle_off';icon.className='material-symbols-outlined text-[18px] '+(excludeBest?'text-primary':'text-slate-400');}
  }

  function updateVrBtn(){
    if(!btnVr)return;
    var icon=btnVr.querySelector('.material-symbols-outlined');
    if(icon){icon.textContent=showVr?'toggle_on':'toggle_off';icon.className='material-symbols-outlined text-[18px] '+(showVr?'text-primary':'text-slate-400');}
  }

  function renderSkeleton(){
    if(!grid)return;
    var h='';
    for(var i=0;i<9;i++){
      h+='<div class="flex flex-col gap-1.5">'
        +'<div class="relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-slate-200 dark:bg-slate-700 animate-pulse"></div>'
        +'<div class="h-3 bg-slate-200 dark:bg-slate-700 rounded animate-pulse w-full mt-1"></div>'
        +'<div class="h-3 bg-slate-200 dark:bg-slate-700 rounded animate-pulse w-2/3"></div>'
        +'</div>';
    }
    grid.innerHTML=h;
  }

  function renderCards(products,append){
    if(!grid)return;
    var h=products.map(function(p){
      var img=poster(p.main_image_url);
      var imgHtml=img
        ?'<img class="h-full w-full object-cover object-right" src="'+esc(img)+'" alt="'+esc(p.title)+'" loading="lazy"/>'
        :'<div class="h-full w-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center"><span class="material-symbols-outlined text-slate-400 text-3xl">movie</span></div>';
      var actHtml=p.actresses?'<p class="text-[10px] text-slate-400 truncate">'+esc(p.actresses.split(',')[0].trim())+'</p>':'';
      return '<div class="flex flex-col gap-1" style="cursor:pointer" onclick="location.href=\'/product/\'+encodeURIComponent(\''+esc(p.product_id)+'\')">'
        +'<div class="relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-slate-200 dark:bg-slate-700">'+imgHtml+'</div>'
        +'<p class="line-clamp-2 text-[11px] font-bold leading-tight">'+esc(p.title)+'</p>'
        +actHtml
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
    if(reset)renderSkeleton();
    var offset=page*LIMIT;
    var url='/api/products?sort='+getSortParam()+'&limit='+LIMIT+'&offset='+offset;
    if(source)url+='&source='+source;
    if(excludeBest)url+='&excludeBest=1';
    if(showVr)url+='&vr=1';
    fetch(url)
      .then(function(r){return r.json();})
      .then(function(data){
        var arr=Array.isArray(data)?data:(data.products||[]);
        if(arr.length<LIMIT)hasMore=false;
        renderCards(arr,!reset);
        page++;
        loading=false;
      })
      .catch(function(e){console.error('products load error',e);loading=false;});
  }

  // ヘッダーボタン
  var backBtn=document.getElementById('btn-back');
  var searchBtn=document.getElementById('btn-search-hdr');
  if(backBtn)backBtn.addEventListener('click',function(){history.back();});
  if(searchBtn)searchBtn.addEventListener('click',function(){location.href='/search';});

  // Initial
  updateSourceBtns();
  updateBestBtn();
  updateVrBtn();
  load(true);

  // Segment tab change
  document.querySelectorAll('input[name="content-type"]').forEach(function(r){
    r.addEventListener('change',function(){
      type=r.value==='pre-order'?'pre-order':'new';
      var url=new URL(location.href);
      url.searchParams.set('type',type);
      history.replaceState(null,'',url.toString());
      load(true);
    });
  });

  // Sort order change
  document.querySelectorAll('input[name="sort-order"]').forEach(function(r){
    r.addEventListener('change',function(){
      if(type!=='pre-order')load(true);
    });
  });

  // FANZA/MGS
  if(btnFanza)btnFanza.addEventListener('click',function(){source=source==='fanza'?'':'fanza';updateSourceBtns();load(true);});
  if(btnMgs)btnMgs.addEventListener('click',function(){source=source==='mgs'?'':'mgs';updateSourceBtns();load(true);});

  // BEST/総集編トグル
  if(btnBest)btnBest.addEventListener('click',function(){excludeBest=!excludeBest;updateBestBtn();load(true);});

  // VRトグル
  if(btnVr)btnVr.addEventListener('click',function(){showVr=!showVr;updateVrBtn();load(true);});

  // 無限スクロール
  window.addEventListener('scroll',function(){
    if(loading||!hasMore)return;
    if(window.scrollY+window.innerHeight>=document.documentElement.scrollHeight-600)load(false);
  },{passive:true});
})();
</script>`;

const CUSTOM_RANKING_SCRIPT = `<script>
(function(){
  // 戻るボタン
  document.querySelector('header button[aria-label="戻る"]')?.addEventListener('click',function(){history.back();});

  // フォーム送信 → /search にリダイレクト
  var form=document.getElementById('search-form');
  if(form){
    form.addEventListener('submit',function(e){
      e.preventDefault();
      var p=new URLSearchParams();

      // プラットフォーム
      var platform=document.querySelector('input[name="platform"]:checked');
      if(platform&&platform.value!=='both')p.set('source',platform.value);

      // メーカー（チェックボックス）
      var makerInput=document.querySelector('input[list="manufacturer-list"]');
      var makerChips=[...document.querySelectorAll('input[name="maker"]:checked')].map(function(i){return i.value;});
      if(makerChips.length)p.set('maker',makerChips[0]);
      else if(makerInput&&makerInput.value.trim())p.set('maker',makerInput.value.trim());

      // 出演者
      var actInput=document.querySelector('section[data-purpose="performer-section"] input[type="text"]');
      if(actInput&&actInput.value.trim())p.set('actress',actInput.value.trim());

      // ジャンル（VRは特別扱い）
      var genreVals=[...document.querySelectorAll('input[name="genre"]:checked')].map(function(i){return i.value;});
      var vrChecked=genreVals.includes('vr');
      var otherGenres=genreVals.filter(function(v){return v!=='vr';});
      if(vrChecked)p.set('vr','1');
      if(otherGenres.length)p.set('genre',otherGenres.join(','));

      // 身長
      var hSlider=document.querySelector('section[data-purpose="advanced-search-section"] input[type="range"]:first-of-type');
      if(hSlider){var hv=parseInt(hSlider.value);if(hv>140)p.set('height',hv+'-999');}

      // 年齢
      var aSlider=document.querySelectorAll('section[data-purpose="advanced-search-section"] input[type="range"]')[1];
      if(aSlider){var av=parseInt(aSlider.value);if(av>18)p.set('ageMin',String(av));}

      // カップ
      var cupSlider=document.getElementById('cup-slider');
      var cups=['','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q'];
      if(cupSlider){var cv=parseInt(cupSlider.value);if(cv>1&&cups[cv])p.set('cup',cups[cv]);}

      // 年代
      var era=document.getElementById('era-select');
      if(era&&era.value&&era.value!=='all'){
        var eraMap={
          '2024':{from:'2024-01-01',to:'2024-12-31'},
          '2023':{from:'2023-01-01',to:'2023-12-31'},
          '2020s':{from:'2020-01-01',to:'2029-12-31'},
          '2010s':{from:'2010-01-01',to:'2019-12-31'},
          '2000s':{from:'2000-01-01',to:'2009-12-31'}
        };
        var e=eraMap[era.value];
        if(e){p.set('fromDate',e.from);p.set('toDate',e.to);}
      }

      p.set('sort','wish_count');
      location.href='/search?'+p.toString();
    });
  }
})();
</script>`;

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);
    const params = new URL(request.url).searchParams;
    const type = params.get('type') || 'new';

    const htmlFile = isMobile
        ? '/design/products.html'
        : `/design/web/${type === 'pre-order' ? 'pre-order.html' : 'new-products.html'}`;

    try {
        let html = await readHtml(request.url, htmlFile);

        if (isMobile) {
            // ヘッダーボタンにIDを付与
            html = html.replace(
                '<button class="flex items-center justify-center p-1 text-slate-600 dark:text-slate-400">\n<span class="material-symbols-outlined">arrow_back_ios</span>',
                '<button id="btn-back" class="flex items-center justify-center p-1 text-slate-600 dark:text-slate-400">\n<span class="material-symbols-outlined">arrow_back_ios</span>'
            );
            html = html.replace(
                '<button class="flex items-center justify-center p-1 text-slate-600 dark:text-slate-400">\n<span class="material-symbols-outlined">search</span>',
                '<button id="btn-search-hdr" class="flex items-center justify-center p-1 text-slate-600 dark:text-slate-400">\n<span class="material-symbols-outlined">search</span>'
            );
            // BEST/総集編・VRボタンにIDを付与
            html = html.replace(
                '<span class="text-xs font-medium">BEST/総集編</span>',
                '<span id="btn-best" class="flex h-9 shrink-0 items-center justify-center gap-1 rounded-full border border-slate-200 dark:border-slate-700 px-3 py-1"><span class="text-xs font-medium">BEST/総集編</span>'
            );
            // 簡易的なID付与: ボタン全体を置換
            html = html.replace(
                /<button class="flex h-9 shrink-0 items-center justify-center gap-1 rounded-full border border-slate-200 dark:border-slate-700 px-3 py-1">\s*<span class="text-xs font-medium">BEST\/総集編<\/span>/,
                '<button id="btn-best" class="flex h-9 shrink-0 items-center justify-center gap-1 rounded-full border border-slate-200 dark:border-slate-700 px-3 py-1"><span class="text-xs font-medium">BEST/総集編</span>'
            );
            html = html.replace(
                /<button class="flex h-9 shrink-0 items-center justify-center gap-1 rounded-full border border-slate-200 dark:border-slate-700 px-3 py-1">\s*<span class="text-xs font-medium">VR作品<\/span>/,
                '<button id="btn-vr" class="flex h-9 shrink-0 items-center justify-center gap-1 rounded-full border border-slate-200 dark:border-slate-700 px-3 py-1"><span class="text-xs font-medium">VR作品</span>'
            );
            // products-grid ID付与
            html = html.replace(
                'class="grid grid-cols-3 gap-x-2 gap-y-4 px-4 pb-24"',
                'id="products-grid" class="grid grid-cols-3 gap-x-2 gap-y-4 px-4 pb-24"',
            );
            html = injectMobileLayout(html, '');
            html = html.replace('</body>', PRODUCTS_SCRIPT + '\n</body>');
        } else {
            html = injectWebLayout(html);
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
