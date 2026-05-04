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
        const mgsClient = getMgsClient();
        const fanzaClient = getFanzaClient();

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

    try {
        let html = await readHtml(request.url, htmlFile);
        html = isMobile ? injectMobileLayout(html) : injectWebLayout(html);

        // パッケージ画像エリアをSSR差し替え（背景div → 実際の<img>、改行込みでマッチ）
        if (productImage) {
            html = html.replace(
                /<div class="w-full h-full bg-center bg-no-repeat bg-cover"[\s\S]*?<\/div>/,
                `<img id="pkg-img" src="${escHtml(productImage)}" alt="${escHtml(productTitle)}" class="w-full h-full object-cover object-center"/>`
            );
        } else {
            // 画像なしでも背景divを空imgに置き換え（作品ID表示のため）
            html = html.replace(
                /<div class="w-full h-full bg-center bg-no-repeat bg-cover"[\s\S]*?<\/div>/,
                `<div id="pkg-img-placeholder" class="w-full h-full flex items-center justify-center bg-slate-200 dark:bg-slate-700"><span class="material-symbols-outlined text-slate-400 text-4xl">movie</span></div>`
            );
        }

        // タイトルをSSR差し替え
        html = html.replace(
            /(<h1 class="text-2xl font-bold leading-tight">)[^<]*/,
            `$1${escHtml(productTitle || productId)}`
        );

        // フォーム送信・入力追加・戻るボタンのスクリプトを注入
        const PRODUCT_ID = JSON.stringify(productId);
        const PRODUCT_TITLE = JSON.stringify(productTitle);
        const SUCCESS_URL = JSON.stringify(`/cast/complete`);

        const script = `<script>
(function(){
  var PRODUCT_ID = ${PRODUCT_ID};
  var SUCCESS_URL = ${SUCCESS_URL};

  // 戻るボタン
  var backBtn = document.querySelector('header button');
  if (backBtn) backBtn.addEventListener('click', function(){ history.back(); });

  // 入力欄追加ボタン
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

  // 送信ボタン
  var submitBtn = document.querySelector('button.bg-primary.text-white.font-bold.py-4');
  if (submitBtn) {
    submitBtn.addEventListener('click', function(){
      var inputs = document.querySelectorAll('div.space-y-3 input[type="text"]');
      var actresses = Array.from(inputs).map(function(el){ return el.value.trim(); }).filter(Boolean);
      if (actresses.length === 0) {
        alert('出演者名を1名以上入力してください');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '送信中...';

      var sessionId = localStorage.getItem('session_id') || '';

      fetch('/api/cast/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': sessionId,
        },
        body: JSON.stringify({ product_id: PRODUCT_ID, actresses: actresses }),
      })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data.ok || data.message) {
          location.href = SUCCESS_URL;
        } else {
          alert('送信エラー: ' + (data.error || '不明なエラー'));
          submitBtn.disabled = false;
          submitBtn.textContent = 'この内容で登録する';
        }
      })
      .catch(function(e){
        alert('通信エラーが発生しました');
        submitBtn.disabled = false;
        submitBtn.textContent = 'この内容で登録する';
      });
    });
  }
})();
</script>`;

        html = html.replace('</body>', script + '\n</body>');

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
