import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../../../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../../../lib/injectLayout';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

const COMPLETE_SCRIPT = `<script>
(function(){
  // 戻るボタン → 前のページへ
  var backBtn = document.querySelector('header button');
  if (backBtn) backBtn.addEventListener('click', function(){ history.back(); });

  // 「作品ページに戻る」ボタン → 2ページ前（作品詳細）へ
  var btns = document.querySelectorAll('button');
  btns.forEach(function(btn){
    var t = btn.textContent.trim();
    if (t === '作品ページに戻る') {
      btn.addEventListener('click', function(){ history.go(-2); });
    }
    if (t === 'ホーム画面に戻る' || t === 'ホームに戻る') {
      btn.addEventListener('click', function(){ location.href = '/'; });
    }
  });
})();
</script>`;

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    const htmlFile = isMobile
        ? '/design/cast-add-complete.html'
        : '/design/web/cast-add-complete.html';

    try {
        let html = await readHtml(request.url, htmlFile);
        html = isMobile ? injectMobileLayout(html) : injectWebLayout(html);
        html = html.replace('</body>', COMPLETE_SCRIPT + '\n</body>');

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
