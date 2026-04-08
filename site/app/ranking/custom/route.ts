import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { injectMobileLayout, injectWebLayout } from '../../../lib/injectLayout';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

const CUSTOM_RANKING_SCRIPT = `<script>
(function(){
  // 戻るボタン
  var backBtn=document.querySelector('header button[aria-label="戻る"]');
  if(backBtn)backBtn.addEventListener('click',function(){history.back();});

  // フォーム送信 → /search にリダイレクト
  var form=document.getElementById('search-form');
  if(form){
    form.addEventListener('submit',function(e){
      e.preventDefault();
      var p=new URLSearchParams();

      // プラットフォーム
      var platform=document.querySelector('input[name="platform"]:checked');
      if(platform&&platform.value!=='both')p.set('source',platform.value);

      // メーカー
      var makerChips=[...document.querySelectorAll('input[name="maker"]:checked')].map(function(i){return i.value;});
      var makerInput=document.querySelector('input[list="manufacturer-list"]');
      if(makerChips.length)p.set('maker',makerChips[0]);
      else if(makerInput&&makerInput.value.trim())p.set('maker',makerInput.value.trim());

      // 出演者
      var actInput=document.querySelector('section[data-purpose="performer-section"] input[type="text"]');
      if(actInput&&actInput.value.trim())p.set('actress',actInput.value.trim());

      // ジャンル
      var genreVals=[...document.querySelectorAll('input[name="genre"]:checked')].map(function(i){return i.value;});
      if(genreVals.includes('vr'))p.set('vr','1');
      var otherGenres=genreVals.filter(function(v){return v!=='vr'&&v!=='best';});
      if(otherGenres.length)p.set('genre',otherGenres.join(','));
      if(genreVals.includes('best'))p.set('excludeBest','0');

      // 身長スライダー
      var sliders=document.querySelectorAll('section[data-purpose="advanced-search-section"] input[type="range"]');
      if(sliders[0]){var hv=parseInt(sliders[0].value);if(hv>140)p.set('height',hv+'-999');}
      if(sliders[1]){var av=parseInt(sliders[1].value);if(av>18)p.set('ageMin',String(av));}

      // カップ
      var cupSlider=document.getElementById('cup-slider');
      var cups=['','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q'];
      if(cupSlider){var cv=parseInt(cupSlider.value);if(cv>1&&cups[cv])p.set('cup',cups[cv]);}

      // 年代
      var era=document.getElementById('era-select');
      if(era&&era.value&&era.value!=='all'){
        var eraMap={'2024':{from:'2024-01-01',to:'2024-12-31'},'2023':{from:'2023-01-01',to:'2023-12-31'},'2020s':{from:'2020-01-01',to:'2029-12-31'},'2010s':{from:'2010-01-01',to:'2019-12-31'},'2000s':{from:'2000-01-01',to:'2009-12-31'}};
        var em=eraMap[era.value];
        if(em){p.set('fromDate',em.from);p.set('toDate',em.to);}
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

    const htmlFile = isMobile
        ? path.join(process.cwd(), 'public', 'design', 'custom-ranking-create.html')
        : path.join(process.cwd(), 'public', 'design', 'web', 'custom-ranking-create.html');

    try {
        let html = fs.readFileSync(htmlFile, 'utf-8');
        if (isMobile) {
            // skipHeader: Stitch独自ヘッダー（戻るボタン+タイトル）をそのまま使う
            html = injectMobileLayout(html, '', { skipHeader: true });
            html = html.replace('</body>', CUSTOM_RANKING_SCRIPT + '\n</body>');
        } else {
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
