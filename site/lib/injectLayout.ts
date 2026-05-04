// ============================================================
//  ページレイアウト注入ユーティリティ
//  全HTMLページのヘッダー/ナビをホーム画面デザインに統一する
// ============================================================

// ─── いいね・キャスト追加ユーティリティ（全ページ共通） ───────────
const LIKE_UTILS_SCRIPT = `<script id="like-utils">
(function(){
  window._likedSet=new Set(JSON.parse(localStorage.getItem('_liked')||'[]'));
  window._sid=function(){var s=localStorage.getItem('_sid');if(!s){s=Math.random().toString(36).slice(2)+Date.now().toString(36);localStorage.setItem('_sid',s);}return s;};
  window.toggleLike=function(btn,pid){
    var icon=btn.querySelector('.material-symbols-outlined');
    var liked=window._likedSet.has(pid);
    if(liked){
      window._likedSet.delete(pid);
      if(icon)icon.style.fontVariationSettings="'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24";
      btn.style.color='';
    }else{
      window._likedSet.add(pid);
      if(icon)icon.style.fontVariationSettings="'FILL' 1,'wght' 400,'GRAD' 0,'opsz' 24";
      btn.style.color='#ec5b13';
    }
    try{localStorage.setItem('_liked',JSON.stringify(Array.from(window._likedSet)));}catch(e){}
    fetch('/api/like/product/'+encodeURIComponent(pid),{method:'POST',headers:{'x-session-id':window._sid()}}).catch(function(){});
  };
  window.restoreLikes=function(){
    document.querySelectorAll('[data-like-pid]').forEach(function(btn){
      if(window._likedSet.has(btn.getAttribute('data-like-pid'))){
        var icon=btn.querySelector('.material-symbols-outlined');
        if(icon)icon.style.fontVariationSettings="'FILL' 1,'wght' 400,'GRAD' 0,'opsz' 24";
        btn.style.color='#ec5b13';
      }
    });
  };
})();
<\/script>`;

// ─── CSS（モバイル共通） ───────────────────────────────────────
const MOBILE_CSS = `<style id="layout-styles">
.active-icon{font-variation-settings:'FILL' 1,'wght' 400,'GRAD' 0,'opsz' 24}
.no-scrollbar::-webkit-scrollbar{display:none}
.no-scrollbar{-ms-overflow-style:none;scrollbar-width:none}
/* primary color override – Tailwindのconfigで未定義のページでも正しく表示 */
.bg-primary{background-color:#ec5b13!important}
.text-primary{color:#ec5b13!important}
.border-primary{border-color:#ec5b13!important}
.ring-primary{--tw-ring-color:#ec5b13!important}
.hover\:text-primary:hover{color:#ec5b13!important}
.hover\:bg-primary:hover{background-color:#ec5b13!important}
.hover\:border-primary:hover{border-color:#ec5b13!important}
.focus\:ring-primary:focus{--tw-ring-color:#ec5b13!important}
</style>`;

// ─── モバイル標準ヘッダー（home.htmlと同一デザイン） ───────────
const MOBILE_HEADER = `<header class="sticky top-0 z-50 flex items-center bg-white border-b border-gray-100 px-3 py-2" style="background:rgba(255,255,255,0.95);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)"><a href="/" class="shrink-0 mr-2"><div class="size-7 bg-primary rounded-lg flex items-center justify-center text-white"><span class="material-symbols-outlined text-[14px]">play_circle</span></div></a><form action="/search" method="get" id="site-search-form" style="flex:1;position:relative;display:flex;align-items:center;gap:6px"><div style="position:relative;flex:1"><input id="site-search-input" name="q" type="search" autocomplete="off" placeholder="女優・メーカーを検索..." style="width:100%;height:36px;background:#f3f4f6;border:none;border-radius:18px;padding:0 12px 0 32px;font-size:13px;outline:none;-webkit-appearance:none;color:#111"/><span class="material-symbols-outlined" style="position:absolute;left:9px;top:50%;transform:translateY(-50%);font-size:16px;color:#9ca3af;pointer-events:none">search</span></div></form><div id="site-search-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border-bottom:1px solid #e5e7eb;box-shadow:0 4px 12px rgba(0,0,0,0.1);z-index:100"><ul id="site-search-list" style="list-style:none;margin:0;padding:4px 0"></ul></div></header>`;

// ─── WEB標準ヘッダー（web/home.htmlと同一デザインベース） ───────
const WEB_HEADER = `<header class="sticky top-0 z-50 w-full bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800" data-layout="standard-web"><div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8"><div class="flex items-center justify-between h-14"><div class="flex items-center gap-6 shrink-0"><a href="/" class="flex items-center gap-2 shrink-0"><div class="size-7 bg-primary rounded-lg flex items-center justify-center text-white"><span class="material-symbols-outlined text-[14px]">play_circle</span></div><span class="font-bold text-base tracking-tight hidden sm:block text-slate-900 dark:text-white">AVランキング</span></a><nav class="hidden lg:flex items-center gap-5 text-xs font-medium"><a class="text-slate-500 dark:text-slate-400 hover:text-primary dark:hover:text-primary transition-colors" href="/new">新作</a><a class="text-slate-500 dark:text-slate-400 hover:text-primary dark:hover:text-primary transition-colors" href="/pre-order">予約</a><a class="text-slate-500 dark:text-slate-400 hover:text-primary dark:hover:text-primary transition-colors" href="/ranking">ランキング</a><a class="text-red-500 hover:text-red-600 transition-colors font-bold flex items-center gap-0.5" href="/sale"><span class="material-symbols-outlined text-[13px]">local_offer</span>セール</a><a class="text-slate-500 dark:text-slate-400 hover:text-primary dark:hover:text-primary transition-colors flex items-center gap-1" href="/info/add"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></svg>情報を追加</a><a class="text-slate-500 dark:text-slate-400 hover:text-primary dark:hover:text-primary transition-colors" href="/mypage">マイページ</a></nav></div><div class="flex items-center gap-3 flex-1 justify-end ml-4 max-w-sm"><div class="relative flex-1"><span class="absolute inset-y-0 left-0 pl-3 flex items-center text-slate-400"><svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></svg></span><input id="web-search-input" class="block w-full pl-9 pr-3 py-1.5 border border-slate-200 dark:border-slate-700 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-primary dark:bg-slate-800 dark:text-white dark:placeholder-slate-400 transition-all" placeholder="作品、出演者を検索..." type="text"/></div><button onclick="location.href='/search/advanced'" class="flex items-center gap-1 px-3 py-1.5 bg-primary text-white rounded-xl text-xs font-bold hover:opacity-90 transition-opacity shrink-0"><span class="material-symbols-outlined text-sm">tune</span><span class="hidden md:block">詳細検索</span></button></div></div></div></header>`;

// ─── モバイル標準ボトムナビ ──────────────────────────────────────
function mobileBottomNav(activePage = ''): string {
    function item(href: string, icon: string, label: string, page: string) {
        const active = activePage === page;
        return `<a class="flex flex-col items-center gap-1 ${active ? 'text-primary' : 'text-slate-400 dark:text-slate-500'} flex-1" href="${href}"><span class="material-symbols-outlined ${active ? 'active-icon ' : ''}text-[24px]">${icon}</span><span class="text-[10px] font-${active ? 'bold' : 'medium'}">${label}</span></a>`;
    }
    return `<nav class="fixed bottom-0 left-0 right-0 z-50 bg-background-light/95 dark:bg-background-dark/95 backdrop-blur-lg border-t border-primary/10 px-4 pb-6 pt-3"><div class="flex items-center justify-between">${item('/', 'home', 'ホーム', 'home')}${item('/search/advanced', 'search', '検索', 'search')}${item('/ranking', 'trophy', 'ランキング', 'ranking')}${item('/sale', 'local_offer', 'セール', 'sale')}${item('/mypage', 'person', 'マイページ', 'mypage')}</div></nav>`;
}

// ─── モバイル検索サジェストスクリプト ─────────────────────────
const MOBILE_SEARCH_SCRIPT = `<script>
(function(){
  var form=document.getElementById('site-search-form');
  var input=document.getElementById('site-search-input');
  var dropdown=document.getElementById('site-search-dropdown');
  var list=document.getElementById('site-search-list');
  if(!input||!dropdown||!list)return;
  function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');}
  var timer=null;
  function hideDrop(){dropdown.style.display='none';}
  function showDrop(){dropdown.style.display='block';}
  function render(q){
    if(!q){hideDrop();return;}
    fetch('/api/suggest?q='+encodeURIComponent(q)).then(function(r){return r.json();}).then(function(data){
      var acts=(data.actresses||[]).slice(0,4);
      var makes=(data.makers||[]).slice(0,2);
      var html=acts.map(function(a){
        return '<li style="padding:10px 16px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid #f9fafb" onclick="location.href=\'/actress/\'+encodeURIComponent(\''+esc(a)+'\')"><span class="material-symbols-outlined" style="font-size:16px;color:#ec5b13">person</span><span>'+esc(a)+'</span></li>';
      }).concat(makes.map(function(m){
        return '<li style="padding:10px 16px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid #f9fafb" onclick="location.href=\'/search?maker=\'+encodeURIComponent(\''+esc(m)+'\')"><span class="material-symbols-outlined" style="font-size:16px;color:#9ca3af">business</span><span>'+esc(m)+'</span></li>';
      })).join('');
      list.innerHTML=html;
      if(html)showDrop();else hideDrop();
    }).catch(function(){hideDrop();});
  }
  input.addEventListener('focus',function(){if(input.value.trim())render(input.value);});
  input.addEventListener('input',function(){clearTimeout(timer);timer=setTimeout(function(){render(input.value);},200);});
  if(form)form.addEventListener('submit',function(){hideDrop();});
  document.addEventListener('click',function(e){if(!input.contains(e.target)&&!dropdown.contains(e.target))hideDrop();});
  document.addEventListener('touchstart',function(e){if(!input.contains(e.target)&&!dropdown.contains(e.target))hideDrop();},{passive:true});
})();
</script>`;

// ─── WEB検索スクリプト ─────────────────────────────────────────
const WEB_SEARCH_SCRIPT = `<script>
(function(){
  var input=document.getElementById('web-search-input');
  if(!input)return;
  input.addEventListener('keydown',e=>{if(e.key==='Enter')location.href='/search?q='+encodeURIComponent(input.value);});
})();
</script>`;

// ─── HTML操作ヘルパー ──────────────────────────────────────────
function replaceHeader(html: string, newHeader: string): string {
    const startIdx = html.indexOf('<header');
    if (startIdx === -1) return html.replace(/<body[^>]*>/, m => m + newHeader);
    const endIdx = html.indexOf('</header>', startIdx);
    if (endIdx === -1) return html;
    return html.slice(0, startIdx) + newHeader + html.slice(endIdx + '</header>'.length);
}

function replaceOrAppendBottomNav(html: string, newNav: string): string {
    // fixedを含む最後の<nav>を探して置換
    let lastIdx = -1;
    let searchFrom = 0;
    while (true) {
        const idx = html.indexOf('<nav', searchFrom);
        if (idx === -1) break;
        const closeTag = html.indexOf('>', idx);
        if (closeTag === -1) break;
        const tag = html.slice(idx, closeTag + 1);
        if (tag.includes('fixed')) lastIdx = idx;
        searchFrom = idx + 1;
    }
    if (lastIdx === -1) {
        return html.replace('</body>', newNav + '\n</body>');
    }
    const navEnd = html.indexOf('</nav>', lastIdx) + '</nav>'.length;
    return html.slice(0, lastIdx) + newNav + html.slice(navEnd);
}

// ─── 公開関数 ─────────────────────────────────────────────────

export interface MobileLayoutOptions {
    /** Design_Exportのプレースホルダー画像をそのまま表示する（STITCH_CLEAN_SCRIPTを無効化） */
    skipClean?: boolean;
    /** Design_Exportのヘッダーをそのまま使用する（MOBILE_HEADERで置換しない） */
    skipHeader?: boolean;
    /** ボトムナビを追加しない（スティッキーフッターボタンがある詳細ページ用） */
    skipBottomNav?: boolean;
}

/**
 * モバイルHTML向けレイアウト注入
 * ヘッダーとボトムナビをホーム画面デザインに統一する
 */
export function injectMobileLayout(html: string, activePage = '', skipCleanOrOpts: boolean | MobileLayoutOptions = false): string {
    const opts: MobileLayoutOptions = typeof skipCleanOrOpts === 'boolean'
        ? { skipClean: skipCleanOrOpts }
        : skipCleanOrOpts;
    html = html.replace('</head>', MOBILE_CSS + '\n' + LIKE_UTILS_SCRIPT + '\n</head>');
    if (!opts.skipHeader) html = replaceHeader(html, MOBILE_HEADER);
    if (!opts.skipBottomNav) html = replaceOrAppendBottomNav(html, mobileBottomNav(activePage));
    const scripts = opts.skipClean
        ? MOBILE_SEARCH_SCRIPT
        : MOBILE_SEARCH_SCRIPT + '\n' + STITCH_CLEAN_SCRIPT;
    html = html.replace('</body>', scripts + '\n</body>');
    return html;
}

// ─── Stitch モック画像クリーンアップスクリプト ──────────────
const STITCH_CLEAN_SCRIPT = `<script>(function(){
function cl(){
  document.querySelectorAll('img[src*="lh3.googleusercontent.com"]').forEach(function(img){
    var c=img.closest('article')||img.closest('.group')||img.parentElement;if(c)c.remove();
  });
  document.querySelectorAll('[style*="lh3.googleusercontent.com"]').forEach(function(el){
    var c=el.closest('article')||el.closest('.group')||el.parentElement;if(c)c.remove();
  });
}
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',cl):cl();
})();<\/script>`;

// ─── WEB CSS（primaryカラー補完） ───────────────────────────
const WEB_CSS = `<style id="web-layout-styles">
.bg-primary{background-color:#ec5b13!important}
.text-primary{color:#ec5b13!important}
.border-primary{border-color:#ec5b13!important}
.ring-primary{--tw-ring-color:#ec5b13!important}
.hover\\:text-primary:hover{color:#ec5b13!important}
.hover\\:bg-primary:hover{background-color:#ec5b13!important}
.hover\\:border-primary:hover{border-color:#ec5b13!important}
.focus\\:ring-primary:focus{--tw-ring-color:#ec5b13!important}
.bg-primary\\/10{background-color:rgba(236,91,19,0.1)!important}
.bg-primary\\/5{background-color:rgba(236,91,19,0.05)!important}
.text-primary\\/80{color:rgba(236,91,19,0.8)!important}
.border-primary\\/20{border-color:rgba(236,91,19,0.2)!important}
.border-primary\\/10{border-color:rgba(236,91,19,0.1)!important}
</style>`;

/**
 * WEB HTML向けレイアウト注入
 * ヘッダーをホーム画面デザインに統一する（ボトムナビなし）
 */
export function injectWebLayout(html: string): string {
    html = html.replace('</head>', WEB_CSS + '\n' + LIKE_UTILS_SCRIPT + '\n</head>');
    html = replaceHeader(html, WEB_HEADER);
    html = html.replace('</body>', WEB_SEARCH_SCRIPT + '\n' + STITCH_CLEAN_SCRIPT + '\n</body>');
    return html;
}
