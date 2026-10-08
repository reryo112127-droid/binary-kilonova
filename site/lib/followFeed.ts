/**
 * ホームの「フォロー中の女優の新作・予約」欄。
 *
 * フォローはブラウザ保存（lib/injectLayout.ts の window._followSet）。ここは空の枠とクライアントJSだけを
 * 生HTMLに入れ、JS が静的キャッシュ（/data/products_new_cache.json・/data/home_preorder_cache.json）を
 * 読んで絞り込む。D1 も Worker も使わないので、エッジキャッシュ済みのホームのままで動く。
 * フォローが0人なら枠は出さない。
 */
export function insertFollowFeed(html: string, isMobile: boolean): string {
    const idx = html.indexOf('id="home-new-list"');
    if (idx === -1) return html;
    const at = html.lastIndexOf('<section', idx);
    if (at === -1) return html;
    const section = isMobile
        ? `<section id="follow-feed" class="mt-8" style="display:none"><div class="flex items-center justify-between px-4 mb-3"><h2 class="text-lg font-bold">フォロー中の女優の新作・予約</h2></div><div id="follow-feed-list" class="flex gap-3 overflow-x-auto px-4 no-scrollbar"></div></section>\n`
        : `<section id="follow-feed" class="mb-10" style="display:none"><h2 class="text-lg font-bold tracking-tight mb-4">フォロー中の女優の新作・予約</h2><div id="follow-feed-list" class="flex overflow-x-auto space-x-4 no-scrollbar pb-2"></div></section>\n`;
    const script = `<script>(function(){
  var set=window._followSet; if(!set||!set.size)return;
  var names=Array.from(set);
  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function poster(u){if(!u)return '';if(u.indexOf('pb_e_')>=0)return u.replace('pb_e_','pf_e_');return u;}
  function who(p){var a=String(p.actresses||'');for(var i=0;i<names.length;i++){if(a.indexOf(names[i])>=0)return names[i];}return '';}
  function get(u){return fetch(u).then(function(r){return r.ok?r.json():[];}).catch(function(){return [];});}
  Promise.all([get('/data/home_preorder_cache.json'),get('/data/products_new_cache.json')]).then(function(r){
    var today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
    var d=function(p){return String(p.sale_start_date||'').replace(/\\//g,'-').slice(0,10);};
    var pre=(Array.isArray(r[0])?r[0]:[]).filter(function(p){return d(p)>today&&who(p);}).sort(function(a,b){return d(a)<d(b)?-1:1;});
    var nw=(Array.isArray(r[1])?r[1]:[]).filter(function(p){return d(p)<=today&&who(p);});
    var seen={},items=[];
    pre.concat(nw).forEach(function(p){if(!seen[p.product_id]&&items.length<20){seen[p.product_id]=1;items.push(p);}});
    var box=document.getElementById('follow-feed'),list=document.getElementById('follow-feed-list');
    if(!box||!list||!items.length)return;
    list.innerHTML=items.map(function(p){
      var isPre=d(p)>today;
      return '<a href="/product/'+encodeURIComponent(p.product_id)+'" class="shrink-0 block" style="width:${isMobile ? 120 : 150}px">'
        +'<div class="aspect-[3/4] rounded-xl overflow-hidden bg-slate-200 relative"><img class="w-full h-full object-cover object-right" src="'+esc(poster(p.main_image_url))+'" alt="" loading="lazy"/>'
        +'<span class="absolute top-1.5 left-1.5 '+(isPre?'bg-red-600':'bg-primary')+' text-white text-[9px] font-bold px-1.5 py-0.5 rounded">'+(isPre?d(p).slice(5).replace('-','/')+' 配信':'新作')+'</span></div>'
        +'<p class="text-[10px] text-primary font-bold mt-1 truncate">'+esc(who(p))+'</p>'
        +'<p class="text-[10px] font-bold leading-tight line-clamp-2">'+esc(p.title)+'</p>'
        +(window.cardMeta?window.cardMeta(p):'')+'</a>';
    }).join('');
    box.style.display='';
  });
})();</script>`;
    html = html.slice(0, at) + section + html.slice(at);
    return html.replace('</body>', () => script + '\n</body>');
}
