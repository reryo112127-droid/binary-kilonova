import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { injectMobileLayout, injectWebLayout } from '../../../lib/injectLayout';
import { getSearchOptions, getContextualSearchOptions } from '../../../lib/searchOptions';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

const ADVANCED_SEARCH_SCRIPT = `<script>
(function(){
  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

  // ─── チップHTML生成 ───────────────────────────────────────
  function chipHtml(name, inputName, count){
    var countHtml = count ? ' <span class="text-gray-400 text-[10px]">'+count+'</span>' : '';
    return '<label class="cursor-pointer">'
      +'<input class="hidden chip-input" name="'+esc(inputName)+'" type="checkbox" value="'+esc(name)+'"/>'
      +'<span class="chip-label px-3 py-1.5 rounded-full border border-gray-200 text-xs inline-block transition-all bg-white select-none">'+esc(name)+countHtml+'</span>'
      +'</label>';
  }

  // ─── "すべて見る" ボトムシート ────────────────────────────
  function showAll(inputName, title, items){
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.45);display:flex;align-items:flex-end;';

    var sheet = document.createElement('div');
    sheet.style.cssText = 'width:100%;background:#fff;border-radius:1.25rem 1.25rem 0 0;max-height:80vh;display:flex;flex-direction:column;';

    // ヘッダー
    var hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:1rem 1.25rem;border-bottom:1px solid #f3f4f6;flex-shrink:0;';
    hdr.innerHTML = '<span style="font-weight:700;font-size:1rem;">'+esc(title)+'</span>'
      +'<button type="button" style="font-size:.875rem;color:#6b7280;">閉じる</button>';
    hdr.querySelector('button').onclick = function(){ overlay.remove(); };

    // 検索
    var searchWrap = document.createElement('div');
    searchWrap.style.cssText = 'padding:.75rem 1.25rem;border-bottom:1px solid #f3f4f6;flex-shrink:0;';
    searchWrap.innerHTML = '<input type="text" placeholder="絞り込み..." style="width:100%;padding:.5rem .75rem;border-radius:.75rem;border:none;background:#f3f4f6;font-size:.875rem;outline:none;">';

    // ボディ
    var body = document.createElement('div');
    body.style.cssText = 'overflow-y:auto;flex:1;padding:1rem 1.25rem;';
    var chipsWrap = document.createElement('div');
    chipsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:.5rem;';
    chipsWrap.innerHTML = items.map(function(item){ return chipHtml(item.name, inputName, item.count); }).join('');
    body.appendChild(chipsWrap);

    // 既存の選択を反映
    var existingVals = new Set(
      Array.from(document.querySelectorAll('input[name="'+inputName+'"]:checked')).map(function(el){ return el.value; })
    );
    chipsWrap.querySelectorAll('input[name="'+inputName+'"]').forEach(function(el){ if(existingVals.has(el.value)) el.checked = true; });

    // 絞り込み
    var filterInput = searchWrap.querySelector('input');
    filterInput.addEventListener('input', function(){
      var q = filterInput.value.trim().toLowerCase();
      chipsWrap.querySelectorAll('label').forEach(function(lbl){
        var inp = lbl.querySelector('input');
        lbl.style.display = (!q || inp.value.toLowerCase().includes(q)) ? '' : 'none';
      });
    });

    // フッター
    var footer = document.createElement('div');
    footer.style.cssText = 'padding:.75rem 1.25rem;border-top:1px solid #f3f4f6;flex-shrink:0;';
    var applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.style.cssText = 'width:100%;background:#f97316;color:#fff;font-weight:700;padding:.75rem;border-radius:.75rem;font-size:.875rem;border:none;';
    applyBtn.textContent = 'この選択を適用する';
    applyBtn.onclick = function(){
      // ボトムシートの選択をメインフォームに同期
      var sel = new Set(
        Array.from(chipsWrap.querySelectorAll('input:checked')).map(function(el){ return el.value; })
      );
      // メインフォームのチェックボックスを更新（存在するものは状態を同期、なければ追加）
      var existing = document.querySelectorAll('input[name="'+inputName+'"]');
      existing.forEach(function(el){ el.checked = sel.has(el.value); sel.delete(el.value); });
      // 残り（メインに存在しないもの）を hidden で追加
      sel.forEach(function(val){
        var inp = document.createElement('input');
        inp.type = 'hidden'; inp.name = inputName; inp.value = val;
        inp.setAttribute('data-dynamic','1');
        document.getElementById('search-form').appendChild(inp);
      });
      // 既存 dynamic hidden を削除してから再追加（重複防止）
      document.querySelectorAll('input[data-dynamic="1"][name="'+inputName+'"]').forEach(function(el){ el.remove(); });
      sel.forEach(function(val){
        var inp = document.createElement('input');
        inp.type = 'hidden'; inp.name = inputName; inp.value = val;
        inp.setAttribute('data-dynamic','1');
        document.getElementById('search-form').appendChild(inp);
      });
      // チップ表示を更新
      updateChipDisplay(inputName);
      overlay.remove();
    };
    footer.appendChild(applyBtn);

    overlay.appendChild(sheet);
    sheet.appendChild(hdr); sheet.appendChild(searchWrap); sheet.appendChild(body); sheet.appendChild(footer);
    overlay.addEventListener('click', function(e){ if(e.target===overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    setTimeout(function(){ filterInput.focus(); }, 100);
  }

  // チップの選択状態をラベルに反映
  function updateChipDisplay(inputName){
    document.querySelectorAll('input[name="'+inputName+'"]').forEach(function(inp){
      var lbl = inp.closest ? inp.closest('label') : null;
      if(!lbl) return;
      var span = lbl.querySelector('.chip-label');
      if(!span) return;
      if(inp.checked){
        span.style.backgroundColor='#f97316'; span.style.color='#fff'; span.style.borderColor='#f97316';
      } else {
        span.style.backgroundColor=''; span.style.color=''; span.style.borderColor='';
      }
    });
  }

  // ─── オートコンプリート ───────────────────────────────────
  function setupAutocomplete(input, items){
    if(!input) return;
    input.removeAttribute('list');
    var dropdown = document.createElement('div');
    dropdown.style.cssText = 'position:absolute;left:0;right:0;top:100%;margin-top:4px;background:#fff;border:1px solid #e5e7eb;border-radius:.75rem;box-shadow:0 4px 12px rgba(0,0,0,.1);z-index:50;display:none;overflow:hidden;';
    var wrap = input.parentElement;
    if(wrap) { wrap.style.position='relative'; wrap.appendChild(dropdown); }

    input.addEventListener('input', function(){
      var q = input.value.trim().toLowerCase();
      dropdown.style.display = 'none';
      if(!q) return;
      var matches = items.filter(function(name){ return name.toLowerCase().includes(q); }).slice(0,5);
      if(!matches.length) return;
      dropdown.innerHTML = matches.map(function(name){
        return '<div style="padding:.625rem 1rem;font-size:.875rem;cursor:pointer;border-bottom:1px solid #f9fafb;" data-v="'+esc(name)+'">'+esc(name)+'</div>';
      }).join('');
      dropdown.querySelectorAll('div').forEach(function(el){
        el.addEventListener('mousedown', function(e){ e.preventDefault(); input.value=el.getAttribute('data-v'); dropdown.style.display='none'; });
        el.addEventListener('touchstart', function(){ input.value=el.getAttribute('data-v'); dropdown.style.display='none'; },{passive:true});
        el.addEventListener('mouseover', function(){ el.style.backgroundColor='#fff7ed'; });
        el.addEventListener('mouseout', function(){ el.style.backgroundColor=''; });
      });
      dropdown.style.display = 'block';
    });
    document.addEventListener('click', function(e){ if(!wrap||!wrap.contains(e.target)) dropdown.style.display='none'; });
  }

  // ─── URLから引き継いだ検索条件 ───────────────────────────
  var prefill = new URLSearchParams(location.search);
  var prefillActress = prefill.get('actress') || '';
  var prefillMaker   = prefill.get('maker')   || '';
  var prefillLabel   = prefill.get('label')   || '';
  var prefillGenre   = prefill.get('genre')   || '';
  var prefillSource  = prefill.get('source')  || '';
  var prefillQ       = prefill.get('q')       || '';
  var prefillFrom    = prefill.get('fromDate')|| '';
  var prefillTo      = prefill.get('toDate')  || '';

  // プラットフォームを引き継ぎ
  if(prefillSource){
    var radios=document.querySelectorAll('input[name="platform"]');
    radios.forEach(function(r){ if(r.value===prefillSource) r.checked=true; });
    updateChipDisplay('platform');
  }

  // ─── メインデータ取得・描画 ──────────────────────────────
  (function(){
    if(window.__SSR_SEARCH_OPTIONS__) return Promise.resolve(window.__SSR_SEARCH_OPTIONS__);
    // SSRデータがない場合はクライアントから現在のパラメータ付きでフェッチ
    var op=new URLSearchParams();
    if(prefillActress) op.set('actress',prefillActress);
    if(prefillMaker)   op.set('maker',prefillMaker);
    if(prefillLabel)   op.set('label',prefillLabel);
    if(prefillGenre)   op.set('genre',prefillGenre);
    if(prefillQ)       op.set('q',prefillQ);
    if(prefillSource)  op.set('source',prefillSource);
    return fetch('/api/search/options?'+op.toString()).then(function(r){return r.json();});
  })().then(function(data){
    var makers = data.makers || [];
    var genres = data.genres || [];
    var actresses = data.actresses || [];

    // メーカーチップ差し替え
    var makerSec = document.querySelector('section[data-purpose="creator-section"]');
    if(makerSec){
      var chipsDiv = makerSec.querySelector('.flex.flex-wrap.gap-2');
      if(chipsDiv) chipsDiv.innerHTML = makers.slice(0,8).map(function(m){ return chipHtml(m.name,'maker',null); }).join('');
      var allBtn = makerSec.querySelector('button');
      if(allBtn){ allBtn.onclick = function(){ showAll('maker','メーカー',makers); }; }
      makerSec.addEventListener('change', function(){ updateChipDisplay('maker'); });
      var makerInput = makerSec.querySelector('input[type="text"]');
      setupAutocomplete(makerInput, makers.map(function(m){ return m.name; }));
      // 引き継ぎ: メーカー名をチップ選択 or テキスト入力にセット
      var targetMaker = prefillMaker || prefillLabel;
      if(targetMaker){
        var found = false;
        chipsDiv && chipsDiv.querySelectorAll('input[name="maker"]').forEach(function(inp){
          if(inp.value === targetMaker){ inp.checked=true; found=true; }
        });
        if(!found && makerInput) makerInput.value = targetMaker;
        updateChipDisplay('maker');
      }
      // 汎用クエリをメーカー欄に引き継ぎ（fallback）
      if(!targetMaker && prefillQ && makerInput) makerInput.value = prefillQ;
    }

    // ジャンルチップ差し替え
    var genreSec = document.querySelector('section[data-purpose="genre-section"]');
    if(genreSec){
      var gChipsDiv = genreSec.querySelector('.flex.flex-wrap.gap-2');
      if(gChipsDiv) gChipsDiv.innerHTML = genres.slice(0,8).map(function(g){ return chipHtml(g.name,'genre',null); }).join('');
      var gAllBtn = genreSec.querySelector('button');
      if(gAllBtn){ gAllBtn.onclick = function(){ showAll('genre','ジャンル',genres); }; }
      genreSec.addEventListener('change', function(){ updateChipDisplay('genre'); });
      // 引き継ぎ: ジャンル（カンマ区切り複数対応）
      if(prefillGenre){
        var prefillGenres = prefillGenre.split(',').map(function(s){return s.trim();}).filter(Boolean);
        var missingGenres = [];
        prefillGenres.forEach(function(gname){
          var found=false;
          gChipsDiv && gChipsDiv.querySelectorAll('input[name="genre"]').forEach(function(inp){
            if(inp.value===gname){ inp.checked=true; found=true; }
          });
          if(!found){ missingGenres.push(gname); }
        });
        // チップにない場合はDBから探してチップ追加
        missingGenres.forEach(function(gname){
          var match = genres.find(function(g){return g.name===gname;});
          if(match && gChipsDiv){
            var el=document.createElement('div'); el.innerHTML=chipHtml(gname,'genre',null);
            var newChip=el.firstChild; gChipsDiv.insertBefore(newChip,gChipsDiv.firstChild);
            newChip.querySelector('input').checked=true;
          }
        });
        updateChipDisplay('genre');
      }
    }

    // 出演者チップ追加 + すべて見るボタン挿入
    var actSec = document.querySelector('section[data-purpose="performer-section"]');
    if(actSec){
      var h2 = actSec.querySelector('h2');
      if(h2 && !actSec.querySelector('.act-header')){
        var hdrDiv = document.createElement('div');
        hdrDiv.className = 'act-header';
        hdrDiv.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;';
        h2.parentNode.insertBefore(hdrDiv, h2);
        h2.style.marginBottom='0';
        hdrDiv.appendChild(h2);
        var actAllBtn = document.createElement('button');
        actAllBtn.type='button'; actAllBtn.className='text-xs text-orange-600 font-medium';
        actAllBtn.textContent='すべて見る';
        actAllBtn.onclick = function(){ showAll('actress-chip','出演者',actresses); };
        hdrDiv.appendChild(actAllBtn);
      }
      var textInputWrap = actSec.querySelector('div.relative');
      if(textInputWrap && !actSec.querySelector('#actress-chips')){
        var aChips = document.createElement('div');
        aChips.id = 'actress-chips';
        aChips.style.cssText = 'display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem;';
        aChips.innerHTML = actresses.slice(0,8).map(function(a){ return chipHtml(a.name,'actress-chip',null); }).join('');
        actSec.insertBefore(aChips, textInputWrap);
        actSec.addEventListener('change', function(){ updateChipDisplay('actress-chip'); });
      }
      var actInput = actSec.querySelector('input[type="text"]');
      setupAutocomplete(actInput, actresses.map(function(a){ return a.name; }));
      // 引き継ぎ: 出演者
      if(prefillActress){
        var aChipsEl = document.getElementById('actress-chips');
        var found = false;
        aChipsEl && aChipsEl.querySelectorAll('input[name="actress-chip"]').forEach(function(inp){
          if(inp.value===prefillActress){ inp.checked=true; found=true; }
        });
        if(!found && actInput) actInput.value = prefillActress;
        updateChipDisplay('actress-chip');
      }
    }

    // 日付を引き継ぎ（カレンダー欄は詳細検索にないため年代セレクトはそのまま）
  }).catch(function(e){ console.error('search options error', e); });

  // ─── フォーム送信 ─────────────────────────────────────────
  var form = document.getElementById('search-form');
  var backBtn = document.querySelector('header button[aria-label="戻る"]');
  if(backBtn) backBtn.addEventListener('click', function(){ history.back(); });

  if(form){
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var p = new URLSearchParams();

      // プラットフォーム
      var platform = form.querySelector('input[name="platform"]:checked');
      if(platform && platform.value !== 'both') p.set('source', platform.value);

      // メーカー（チップ + テキスト）
      var makerVals = Array.from(form.querySelectorAll('input[name="maker"]:checked')).map(function(el){ return el.value; });
      var makerText = form.querySelector('section[data-purpose="creator-section"] input[type="text"]');
      if(makerText && makerText.value.trim()) makerVals.push(makerText.value.trim());
      if(makerVals.length) p.set('makers', makerVals.join(','));

      // 出演者（チップ + テキスト）
      var actVals = Array.from(form.querySelectorAll('input[name="actress-chip"]')).filter(function(el){ return el.checked || el.type==='hidden'; }).map(function(el){ return el.value; });
      var actText = form.querySelector('section[data-purpose="performer-section"] input[type="text"]');
      if(actText && actText.value.trim()) actVals.unshift(actText.value.trim());
      if(actVals.length === 1) p.set('actress', actVals[0]);
      else if(actVals.length > 1) p.set('actress', actVals[0]); // 複数は先頭を優先

      // ジャンル（複数 OR 対応）
      var genreVals = Array.from(form.querySelectorAll('input[name="genre"]')).filter(function(el){ return el.checked || el.type==='hidden'; }).map(function(el){ return el.value; });
      if(genreVals.length) p.set('genre', genreVals.join(','));

      // 身長
      var hSlider = document.getElementById('height-slider');
      if(hSlider){ var hv=parseInt(hSlider.value,10); if(hv>130) p.set('height', hv+'-999'); }

      // 年齢
      var aSlider = document.getElementById('age-slider');
      if(aSlider){ var av=parseInt(aSlider.value,10); if(av>18){ p.set('ageMin', String(av)); } }

      // カップ数
      var cSlider = document.getElementById('cup-slider');
      var cupNames = ['','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q'];
      if(cSlider){ var cv=parseInt(cSlider.value,10); if(cv>1){ var cupName=cupNames[cv]||''; if(cupName) p.set('cup', cupName); } }

      // 年代
      var era = document.getElementById('era-select');
      if(era && era.value && era.value !== 'all'){
        var ranges = {'2024':['2024-01-01','2024-12-31'],'2023':['2023-01-01','2023-12-31'],'2020s':['2020-01-01','2029-12-31'],'2010s':['2010-01-01','2019-12-31'],'2000s':[null,'2009-12-31']};
        var r = ranges[era.value];
        if(r){ if(r[0])p.set('fromDate',r[0]); if(r[1])p.set('toDate',r[1]); }
      }

      location.href = '/search?' + p.toString();
    });
  }
})();
</script>`;

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    const htmlFile = isMobile
        ? path.join(process.cwd(), 'public', 'design', 'advanced-search.html')
        : path.join(process.cwd(), 'public', 'design', 'web', 'advanced-search.html');

    try {
        let html = fs.readFileSync(htmlFile, 'utf-8');
        html = isMobile
            ? injectMobileLayout(html, 'search', { skipClean: true, skipHeader: true, skipBottomNav: true })
            : injectWebLayout(html);

        if (isMobile) {
            // URLパラメータがあればコンテキスト絞り込み、なければ全体オプション
            const reqUrl = new URL(request.url);
            const actress = reqUrl.searchParams.get('actress') || '';
            const maker   = reqUrl.searchParams.get('maker')   || '';
            const label   = reqUrl.searchParams.get('label')   || '';
            const genre   = reqUrl.searchParams.get('genre')   || '';
            const q       = reqUrl.searchParams.get('q')       || '';
            const source  = reqUrl.searchParams.get('source')  || '';

            const hasFilter = !!(actress || maker || label || genre || q);
            const ssrData = hasFilter
                ? await getContextualSearchOptions({ actress, maker, label, genre, q, source }).catch(() => null)
                : await getSearchOptions().catch(() => null);

            if (ssrData) {
                const ssrScript = `<script>window.__SSR_SEARCH_OPTIONS__=${JSON.stringify(ssrData)};</script>`;
                html = html.replace('</head>', ssrScript + '\n</head>');
            }
            html = html.replace('</body>', ADVANCED_SEARCH_SCRIPT + '\n</body>');
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
