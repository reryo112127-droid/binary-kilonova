// ============================================================
//  ページレイアウト注入ユーティリティ
//  全HTMLページのヘッダー/ナビをホーム画面デザインに統一する
// ============================================================

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
const MOBILE_HEADER = `<header class="sticky top-0 z-50 flex items-center justify-between bg-background-light/80 dark:bg-background-dark/80 backdrop-blur-md px-2 py-2 border-b border-primary/10"><div class="flex items-center gap-1.5 w-full"><div class="flex items-center gap-1 shrink-0"><a href="/" class="flex items-center gap-1"><div class="size-6 bg-primary rounded-lg flex items-center justify-center text-white"><span class="material-symbols-outlined text-[12px]">play_circle</span></div><span class="text-[10px] font-bold tracking-tight text-primary hidden min-[360px]:block">AVランキング</span></a></div><div class="relative flex-1 group min-w-0 mx-1"><div class="relative"><input id="site-search-input" class="w-full h-7 bg-slate-100 dark:bg-slate-800 border-none rounded-full py-1 pl-7 pr-2 text-[10px] focus:ring-1 focus:ring-primary/50 transition-all outline-none text-slate-900 dark:text-white" placeholder="検索" type="text"/><span class="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-[14px] text-slate-400">search</span></div><div class="hidden absolute top-full left-0 right-0 mt-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden z-50" id="site-search-dropdown"><ul class="py-1" id="site-search-list"></ul></div></div><div class="flex items-center gap-1 shrink-0"><button onclick="location.href='/info/add'" class="flex items-center justify-center p-0.5 text-slate-600 dark:text-slate-400" title="情報を追加"><span class="material-symbols-outlined text-[18px]">add_circle</span></button><a href="/signup" class="px-1.5 py-1 text-[9px] font-bold text-primary border border-primary/20 rounded-md whitespace-nowrap">新規登録</a><a href="/login" class="px-1.5 py-1 text-[9px] font-bold bg-primary text-white rounded-md whitespace-nowrap">ログイン</a></div></div></header>`;

// ─── WEB標準ヘッダー（web/home.htmlと同一デザインベース） ───────
const WEB_HEADER = `<header class="sticky top-0 z-50 w-full bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800" data-layout="standard-web"><div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8"><div class="flex items-center justify-between h-14"><div class="flex items-center gap-6 shrink-0"><a href="/" class="flex items-center gap-2 shrink-0"><div class="size-7 bg-primary rounded-lg flex items-center justify-center text-white"><span class="material-symbols-outlined text-[14px]">play_circle</span></div><span class="font-bold text-base tracking-tight hidden sm:block text-slate-900 dark:text-white">AVランキング</span></a><nav class="hidden lg:flex items-center gap-5 text-xs font-medium"><a class="text-slate-500 dark:text-slate-400 hover:text-primary dark:hover:text-primary transition-colors" href="/new">新作</a><a class="text-slate-500 dark:text-slate-400 hover:text-primary dark:hover:text-primary transition-colors" href="/pre-order">予約</a><a class="text-slate-500 dark:text-slate-400 hover:text-primary dark:hover:text-primary transition-colors" href="/ranking">ランキング</a><a class="text-slate-500 dark:text-slate-400 hover:text-primary dark:hover:text-primary transition-colors flex items-center gap-1" href="/info/add"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></svg>情報を追加</a><a class="text-slate-500 dark:text-slate-400 hover:text-primary dark:hover:text-primary transition-colors" href="/mypage">マイページ</a></nav></div><div class="flex items-center gap-3 flex-1 justify-end ml-4 max-w-sm"><div class="relative flex-1"><span class="absolute inset-y-0 left-0 pl-3 flex items-center text-slate-400"><svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></svg></span><input id="web-search-input" class="block w-full pl-9 pr-3 py-1.5 border border-slate-200 dark:border-slate-700 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-primary dark:bg-slate-800 dark:text-white dark:placeholder-slate-400 transition-all" placeholder="作品、出演者を検索..." type="text"/></div><button onclick="location.href='/search/advanced'" class="flex items-center gap-1 px-3 py-1.5 bg-primary text-white rounded-xl text-xs font-bold hover:opacity-90 transition-opacity shrink-0"><span class="material-symbols-outlined text-sm">tune</span><span class="hidden md:block">詳細検索</span></button><div class="flex items-center gap-2 shrink-0"><a href="/login" class="text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-primary">ログイン</a><a href="/signup" class="bg-primary text-white px-3 py-1.5 rounded-xl text-xs font-bold hover:opacity-90 transition-opacity">新規登録</a></div></div></div></div></header>`;

// ─── モバイル標準ボトムナビ ──────────────────────────────────────
function mobileBottomNav(activePage = ''): string {
    function item(href: string, icon: string, label: string, page: string) {
        const active = activePage === page;
        return `<a class="flex flex-col items-center gap-1 ${active ? 'text-primary' : 'text-slate-400 dark:text-slate-500'} flex-1" href="${href}"><span class="material-symbols-outlined ${active ? 'active-icon ' : ''}text-[24px]">${icon}</span><span class="text-[10px] font-${active ? 'bold' : 'medium'}">${label}</span></a>`;
    }
    return `<nav class="fixed bottom-0 left-0 right-0 z-50 bg-background-light/95 dark:bg-background-dark/95 backdrop-blur-lg border-t border-primary/10 px-4 pb-6 pt-3"><div class="flex items-center justify-between">${item('/', 'home', 'ホーム', 'home')}${item('/search', 'search', '検索', 'search')}${item('/ranking', 'trophy', 'ランキング', 'ranking')}${item('/search?sort=new', 'play_circle', '動画', 'video')}${item('/mypage', 'person', 'マイページ', 'mypage')}</div></nav>`;
}

// ─── モバイル検索サジェストスクリプト ─────────────────────────
const MOBILE_SEARCH_SCRIPT = `<script>
(function(){
  var input=document.getElementById('site-search-input');
  var dropdown=document.getElementById('site-search-dropdown');
  var list=document.getElementById('site-search-list');
  if(!input||!dropdown||!list)return;
  function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');}
  var cache=null;
  function getSuggest(){
    if(cache)return Promise.resolve(cache);
    return fetch('/api/suggest').then(r=>r.json()).then(d=>{cache=d;return d;}).catch(()=>({}));
  }
  function render(q){
    getSuggest().then(function(data){
      var acts=data.actresses||[];
      var prods=data.products||[];
      if(q){var ql=q.toLowerCase();acts=acts.filter(a=>a.name&&a.name.toLowerCase().includes(ql));prods=prods.filter(p=>p.title&&p.title.toLowerCase().includes(ql));}
      var html=acts.slice(0,3).map(a=>
        '<li class="px-3 py-1.5 text-[10px] hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer flex items-center gap-2" onclick="location.href=\'/actress/\'+encodeURIComponent(\''+esc(a.name)+'\')"><span class="material-symbols-outlined text-[14px] text-primary">person</span><span>'+esc(a.name)+'</span></li>'
      ).concat(prods.slice(0,5).map(p=>
        '<li class="px-3 py-1.5 text-[10px] hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer flex items-center gap-2" onclick="location.href=\'/product/\'+encodeURIComponent(\''+esc(p.product_id)+'\')"><span class="material-symbols-outlined text-[14px] text-slate-400">movie</span><span>'+esc((p.title||'').substring(0,28))+'</span></li>'
      )).join('');
      list.innerHTML=html||'<li class="px-3 py-2 text-[10px] text-slate-400">該当なし</li>';
      dropdown.classList.remove('hidden');
    });
  }
  input.addEventListener('focus',()=>render(input.value));
  input.addEventListener('input',()=>render(input.value));
  input.addEventListener('keydown',e=>{if(e.key==='Enter'){dropdown.classList.add('hidden');location.href='/search?q='+encodeURIComponent(input.value);}});
  document.addEventListener('click',e=>{if(!input.contains(e.target)&&!dropdown.contains(e.target))dropdown.classList.add('hidden');});
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

/**
 * モバイルHTML向けレイアウト注入
 * ヘッダーとボトムナビをホーム画面デザインに統一する
 */
export function injectMobileLayout(html: string, activePage = ''): string {
    html = html.replace('</head>', MOBILE_CSS + '\n</head>');
    html = replaceHeader(html, MOBILE_HEADER);
    html = replaceOrAppendBottomNav(html, mobileBottomNav(activePage));
    html = html.replace('</body>', MOBILE_SEARCH_SCRIPT + '\n' + STITCH_CLEAN_SCRIPT + '\n</body>');
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
    html = html.replace('</head>', WEB_CSS + '\n</head>');
    html = replaceHeader(html, WEB_HEADER);
    html = html.replace('</body>', WEB_SEARCH_SCRIPT + '\n' + STITCH_CLEAN_SCRIPT + '\n</body>');
    return html;
}
