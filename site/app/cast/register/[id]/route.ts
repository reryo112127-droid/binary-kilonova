import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../../../../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../../../../lib/injectLayout';
import { getMgsClient, getFanzaClient } from '../../../../lib/turso';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

function escHtml(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 横長パッケージ画像URLを取得（sample_imagesの先頭 or main_image_urlのpf変換）
function wideImageUrl(mainUrl: string, sampleJson: string | null): string {
    // sample_images の最初の画像（横長）を優先
    if (sampleJson) {
        try {
            const samples: string[] = JSON.parse(sampleJson);
            if (samples.length > 0) return samples[0];
        } catch { /* ignore */ }
    }
    // FANZAのpb_e_ → pf_e_ で横長フロントパッケージ
    if (mainUrl.includes('pb_e_')) return mainUrl.replace('pb_e_', 'pf_e_');
    return mainUrl;
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id: productId } = await params;
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    // 作品情報をSSRで取得
    let productTitle = '';
    let productImage = '';

    try {
        const mgsClient = await getMgsClient();
        const fanzaClient = await getFanzaClient();

        const [mgsRow, fanzaRow] = await Promise.all([
            mgsClient?.execute({
                sql: 'SELECT title, main_image_url, sample_images_json FROM products WHERE product_id = ? LIMIT 1',
                args: [productId],
            }).then(r => r.rows[0] ?? null).catch(() => null),
            fanzaClient?.execute({
                sql: 'SELECT title, main_image_url, sample_images_json FROM products WHERE product_id = ? LIMIT 1',
                args: [productId],
            }).then(r => r.rows[0] ?? null).catch(() => null),
        ]);

        const row = mgsRow ?? fanzaRow;
        if (row) {
            productTitle = String(row.title ?? '');
            const mainUrl = String(row.main_image_url ?? '');
            const sampleJson = row.sample_images_json ? String(row.sample_images_json) : null;
            productImage = wideImageUrl(mainUrl, sampleJson);
        }
    } catch { /* 取得失敗時は空のまま */ }

    const htmlFile = isMobile
        ? '/design/cast-add.html'
        : '/design/web/cast-add.html';

    const PRODUCT_ID   = JSON.stringify(productId);
    const SUCCESS_URL  = JSON.stringify('/cast/complete');

    // ── モバイル用スクリプト ──────────────────────────────────
    const mobileScript = `<script>
(function(){
  var PRODUCT_ID = ${PRODUCT_ID};
  var SUCCESS_URL = ${SUCCESS_URL};

  var backBtn = document.querySelector('header button');
  if (backBtn) backBtn.addEventListener('click', function(){ history.back(); });

  var addBtn = document.querySelector('button.border-dashed');
  var inputsWrap = document.querySelector('div.space-y-3');
  if (addBtn && inputsWrap) {
    addBtn.addEventListener('click', function(){
      var div = document.createElement('div');
      div.className = 'relative';
      div.innerHTML = '<input class="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 focus:ring-2 focus:ring-primary focus:border-transparent transition-all outline-none" placeholder="例：山田 太郎" type="text"/>';
      inputsWrap.appendChild(div);
    });
  }

  var submitBtn = document.querySelector('button.bg-primary.text-white.font-bold.py-4');
  if (submitBtn) {
    submitBtn.addEventListener('click', function(){
      var inputs = document.querySelectorAll('div.space-y-3 input[type="text"]');
      var actresses = Array.from(inputs).map(function(el){ return el.value.trim(); }).filter(Boolean);
      if (actresses.length === 0) { alert('出演者名を1名以上入力してください'); return; }
      submitBtn.disabled = true;
      submitBtn.textContent = '送信中...';
      var sessionId = localStorage.getItem('session_id') || '';
      fetch('/api/cast/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
        body: JSON.stringify({ product_id: PRODUCT_ID, actresses: actresses }),
      })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data.ok || data.message) { location.href = SUCCESS_URL; }
        else { alert('送信エラー: ' + (data.error || '不明なエラー')); submitBtn.disabled = false; submitBtn.textContent = 'この内容で登録する'; }
      })
      .catch(function(){ alert('通信エラーが発生しました'); submitBtn.disabled = false; submitBtn.textContent = 'この内容で登録する'; });
    });
  }
})();
</script>`;

    // ── PC用スクリプト ────────────────────────────────────────
    const webScript = `<script>
(function(){
  var PRODUCT_ID = ${PRODUCT_ID};
  var SUCCESS_URL = ${SUCCESS_URL};

  // キャンセルボタン
  document.querySelectorAll('button[type="button"]').forEach(function(btn){
    if (btn.textContent.trim() === 'キャンセル') btn.addEventListener('click', function(){ history.back(); });
  });

  // 既存の×ボタン（入力行削除）
  var list = document.getElementById('performer-list');
  if (list) {
    list.querySelectorAll('button').forEach(function(btn){
      btn.addEventListener('click', function(){ btn.closest('.flex.items-center.gap-2').remove(); });
    });
  }

  // 入力欄追加ボタン
  var addBtn = document.querySelector('button.border-dashed, button[class*="border-dashed"]');
  if (addBtn && list) {
    addBtn.addEventListener('click', function(){
      var div = document.createElement('div');
      div.className = 'flex items-center gap-2';
      div.innerHTML = '<input class="form-input flex-1 rounded-xl border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 focus:border-primary focus:ring-primary h-12" placeholder="例：山田 花子" type="text"/>'
        + '<button class="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300" type="button"><span class="material-symbols-outlined">close</span></button>';
      list.appendChild(div);
      div.querySelector('button').addEventListener('click', function(){ div.remove(); });
    });
  }

  // フォーム送信
  var form = document.querySelector('form');
  if (form) {
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var inputs = list ? list.querySelectorAll('input[type="text"]') : [];
      var actresses = Array.from(inputs).map(function(el){ return el.value.trim(); }).filter(Boolean);
      if (actresses.length === 0) { alert('出演者名を1名以上入力してください'); return; }
      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span><span>送信中...</span>'; }
      var sessionId = localStorage.getItem('session_id') || '';
      fetch('/api/cast/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
        body: JSON.stringify({ product_id: PRODUCT_ID, actresses: actresses }),
      })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data.ok || data.message) { location.href = SUCCESS_URL; }
        else {
          alert('送信エラー: ' + (data.error || '不明なエラー'));
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<span class="material-symbols-outlined">send</span><span>情報を送信する</span>'; }
        }
      })
      .catch(function(){
        alert('通信エラーが発生しました');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<span class="material-symbols-outlined">send</span><span>情報を送信する</span>'; }
      });
    });
  }
})();
</script>`;

    try {
        let html = await readHtml(request.url, htmlFile);
        html = isMobile ? injectMobileLayout(html) : injectWebLayout(html);

        if (isMobile) {
            // ── モバイル: パッケージ画像置換 ──────────────────
            if (productImage) {
                html = html.replace(
                    /<div class="w-full h-full bg-center bg-no-repeat bg-cover"[\s\S]*?<\/div>/,
                    `<img id="pkg-img" src="${escHtml(productImage)}" alt="${escHtml(productTitle)}" class="w-full h-full object-cover object-center"/>`
                );
            } else {
                html = html.replace(
                    /<div class="w-full h-full bg-center bg-no-repeat bg-cover"[\s\S]*?<\/div>/,
                    `<div class="w-full h-full flex items-center justify-center bg-slate-200 dark:bg-slate-700"><span class="material-symbols-outlined text-slate-400 text-4xl">movie</span></div>`
                );
            }
            // モバイル: タイトル置換
            html = html.replace(
                /(<h1 class="text-2xl font-bold leading-tight">)[^<]*/,
                `$1${escHtml(productTitle || productId)}`
            );
            html = html.replace('</body>', mobileScript + '\n</body>');

        } else {
            // ── PC: パッケージ画像置換 ────────────────────────
            if (productImage) {
                html = html.replace(
                    /<div class="w-full md:w-48 bg-center bg-no-repeat[^"]*bg-cover[^"]*"[^>]*style='background-image:[^']*'><\/div>/,
                    `<img id="pkg-img" src="${escHtml(productImage)}" alt="${escHtml(productTitle)}" class="w-full md:w-48 aspect-video md:aspect-square rounded-lg shrink-0 object-cover object-center"/>`
                );
            } else {
                html = html.replace(
                    /<div class="w-full md:w-48 bg-center bg-no-repeat[^"]*bg-cover[^"]*"[^>]*style='background-image:[^']*'><\/div>/,
                    `<div class="w-full md:w-48 aspect-video md:aspect-square rounded-lg shrink-0 flex items-center justify-center bg-slate-200 dark:bg-slate-700"><span class="material-symbols-outlined text-slate-400 text-5xl">movie</span></div>`
                );
            }
            // PC: タイトル置換（Work Info Card 内の h3）
            html = html.replace(
                /(<h3 class="text-slate-900 dark:text-white text-2xl font-bold"[^>]*>)[^<]*/,
                `$1${escHtml(productTitle || productId)}`
            );
            html = html.replace('</body>', webScript + '\n</body>');
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
