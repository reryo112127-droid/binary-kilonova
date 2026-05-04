import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const GENRE_LABELS: Record<string, string> = {
    new:    '新作',
    sale:   'セール',
    anon:   '匿名',
    lady:   'レディ',
    vr:     'VR',
    collab: '共演作',
};

const GENRES = ['new', 'sale', 'anon', 'lady', 'vr', 'collab'];

function buildLoginHtml(): string {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>管理ログイン | AVランキング</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 min-h-screen flex items-center justify-center">
  <div class="bg-white rounded-xl shadow p-8 w-full max-w-sm">
    <h1 class="text-xl font-bold mb-6 text-center text-gray-800">管理画面ログイン</h1>
    <form id="loginForm" class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">管理キー</label>
        <input type="password" id="keyInput" class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="管理キーを入力"/>
      </div>
      <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 rounded-lg transition">ログイン</button>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', function(e) {
      e.preventDefault();
      const key = document.getElementById('keyInput').value;
      window.location.href = '/admin/x-post?key=' + encodeURIComponent(key);
    });
  </script>
</body>
</html>`;
}

const GENRE_CARD_CONFIG: Record<string, { sub: string; border: string; badge?: string; badgeClass?: string }> = {
    new:    { sub: 'New Works',     border: 'border-orange-500', badge: 'PICK UP', badgeClass: 'bg-orange-100 text-orange-600' },
    sale:   { sub: 'Sale',          border: 'border-red-500',    badge: 'SALE',    badgeClass: 'bg-red-500 text-white' },
    anon:   { sub: 'Anonymous',     border: 'border-slate-800' },
    lady:   { sub: 'Lady',          border: 'border-pink-400' },
    vr:     { sub: 'VR Experience', border: 'border-purple-500' },
    collab: { sub: 'Collab',        border: 'border-indigo-500' },
};

function buildXPostHtml(key: string): string {
    const genreCardsHtml = GENRES.map(genre => {
        const label = GENRE_LABELS[genre];
        const cfg = GENRE_CARD_CONFIG[genre] || { sub: '', border: 'border-slate-300' };
        const badgeHtml = cfg.badge
            ? `<span class="${cfg.badgeClass} text-[10px] font-bold px-2 py-0.5 rounded-full">${cfg.badge}</span>`
            : '';
        return `
      <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 flex flex-col">
        <div class="flex items-center justify-between mb-4 border-l-4 ${cfg.border} pl-3">
          <h2 class="text-lg font-bold">${label} <span class="text-xs font-normal text-slate-500 ml-1">${cfg.sub}</span></h2>
          ${badgeHtml}
        </div>
        <div id="panel-${genre}" class="flex-1 flex flex-col gap-3">
          <div class="text-center py-8"><div class="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-orange-500"></div></div>
        </div>
      </div>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>X投稿選択 | AVランキング</title>
  <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
  <link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/>
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet"/>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: { "primary": "#ec5b13" },
          fontFamily: { "display": ["Public Sans", "sans-serif"] }
        }
      }
    }
  </script>
  <style>
    .material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24; }
  </style>
</head>
<body class="bg-slate-50 font-display text-slate-900 antialiased">

  <!-- Header（変更なし） -->
  <header class="bg-gray-900 text-white sticky top-0 z-10 shadow-md">
    <div class="max-w-screen-xl mx-auto px-4 py-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <a href="/admin?key=${key}" class="text-gray-400 hover:text-white transition text-sm flex items-center gap-1">
          <span class="material-symbols-outlined text-base">arrow_back</span>
          管理画面
        </a>
        <span class="text-gray-600">/</span>
        <h1 class="font-bold text-base">X投稿選択</h1>
      </div>
      <button onclick="markAllDone()"
        class="bg-sky-500 hover:bg-sky-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition flex items-center gap-1">
        <span class="material-symbols-outlined text-base">check_circle</span>
        一括スキップ
      </button>
    </div>
  </header>

  <main class="max-w-[1400px] mx-auto px-4 py-8">
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      ${genreCardsHtml}
    </div>
  </main>

  <!-- Genre Move Modal -->
  <div id="genreMoveModal" class="fixed inset-0 bg-black/50 z-50 hidden flex items-center justify-center">
    <div class="bg-white rounded-2xl shadow-xl p-6 w-80">
      <h3 class="font-bold text-slate-800 mb-4">ジャンル移動</h3>
      <p class="text-sm text-slate-600 mb-4">移動先ジャンルを選択してください</p>
      <div id="genreMoveOptions" class="grid grid-cols-2 gap-2 mb-4"></div>
      <button onclick="closeGenreModal()" class="w-full py-2 text-sm text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50">キャンセル</button>
    </div>
  </div>

  <script>
    const ADMIN_KEY = '${key}';
    const GENRE_LABELS = ${JSON.stringify(GENRE_LABELS)};
    const GENRES = ${JSON.stringify(GENRES)};
    const currentProducts = {};
    let genreMoveContext = null;

    async function loadGenre(genre) {
      const panel = document.getElementById('panel-' + genre);
      panel.innerHTML = '<div class="text-center py-8"><div class="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-orange-500"></div></div>';

      try {
        const res = await fetch('/api/admin/x-post?genre=' + genre + '&limit=1', {
          headers: { 'x-admin-key': ADMIN_KEY }
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const products = await res.json();

        if (!products || products.length === 0) {
          currentProducts[genre] = null;
          panel.innerHTML = '<div class="text-center py-8 flex flex-col items-center gap-2 text-slate-400"><span class="material-symbols-outlined text-3xl text-green-500" style="font-variation-settings:\'FILL\' 1">check_circle</span><span class="text-sm">全て処理済み</span></div>';
          return;
        }

        const product = products[0];
        currentProducts[genre] = product;
        renderProduct(genre, product);
      } catch (e) {
        panel.innerHTML = '<div class="text-center text-red-400 text-sm py-8">' + e.message + '</div>';
      }
    }

    function renderProduct(genre, product) {
      const panel = document.getElementById('panel-' + genre);
      const sampleImgs = (product.sample_images || []).slice(0, 4);

      const sampleHtml = sampleImgs.length > 0
        ? '<div class="grid grid-cols-4 gap-2">' +
            sampleImgs.map(img =>
              '<div class="aspect-video rounded-md overflow-hidden border border-slate-100"><img src="' + img + '" class="w-full h-full object-cover" loading="lazy" onerror="this.style.display=\'none\'"/></div>'
            ).join('') +
          '</div>'
        : '<div class="text-xs text-slate-400 text-center py-1">サンプルなし</div>';

      const discountBadge = product.discount_pct > 0
        ? '<span class="absolute top-2 left-2 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">' + product.discount_pct + '%OFF</span>'
        : '';

      panel.innerHTML =
        '<div class="relative group aspect-[3/4] rounded-lg overflow-hidden border border-slate-100 cursor-pointer">' +
          '<img src="' + (product.main_image_url || '') + '" class="w-full h-full object-cover transition-transform group-hover:scale-105"/>' +
          discountBadge +
        '</div>' +
        sampleHtml +
        '<p class="text-xs text-slate-700 leading-snug line-clamp-2 font-medium">' + (product.title || '') + '</p>' +
        (product.actresses ? '<p class="text-[10px] text-slate-500 truncate">' + product.actresses + '</p>' : '') +
        '<div class="space-y-2 mt-auto pt-1">' +
          '<div class="grid grid-cols-2 gap-2">' +
            '<button onclick="approve(\'' + product.product_id + '\', \'' + genre + '\')" class="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 shadow-sm"><span class="material-symbols-outlined text-sm" style="font-variation-settings:\'FILL\' 1">auto_fix_high</span>パケ投稿</button>' +
            '<button onclick="approve(\'' + product.product_id + '\', \'' + genre + '\')" class="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-lg bg-primary/10 text-primary text-xs font-bold hover:bg-primary/20"><span class="material-symbols-outlined text-sm">image</span>サンプル投稿</button>' +
          '</div>' +
          '<div class="grid grid-cols-2 gap-2">' +
            '<button onclick="decide(\'' + product.product_id + '\', \'' + genre + '\', \'skip\')" class="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border border-slate-200 text-slate-600 text-[11px] font-medium hover:bg-slate-50"><span class="material-symbols-outlined text-sm">close</span>投稿しない</button>' +
            '<button onclick="decide(\'' + product.product_id + '\', \'' + genre + '\', \'best_exclude\')" class="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-amber-50 border border-amber-100 text-amber-700 text-[11px] font-bold hover:bg-amber-100"><span class="material-symbols-outlined text-sm">auto_awesome_motion</span>BEST除外</button>' +
          '</div>' +
          '<button onclick="genreMove(\'' + product.product_id + '\', \'' + genre + '\')" class="w-full flex items-center justify-between py-2 px-3 rounded-lg border border-red-100 text-red-600 text-[11px] font-medium hover:bg-red-50"><span class="flex items-center gap-1.5"><span class="material-symbols-outlined text-sm">category</span>ジャンル間違い</span><span class="material-symbols-outlined text-sm">expand_more</span></button>' +
        '</div>';
    }

    // 承認: x_post_decisions に decision='approve' で登録 → 自動投稿スクリプトがキューから拾う
    function approve(productId, genre) {
      decide(productId, genre, 'approve', genre);
    }

    async function decide(productId, genre, decision, newGenre) {
      try {
        const res = await fetch('/api/admin/x-post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
          body: JSON.stringify({ product_id: productId, decision, new_genre: newGenre || genre }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        await loadGenre(genre);
      } catch (e) {
        alert('エラー: ' + e.message);
      }
    }

    function genreMove(productId, genre) {
      genreMoveContext = { productId, genre };
      const options = document.getElementById('genreMoveOptions');
      options.innerHTML = GENRES.filter(g => g !== genre)
        .map(g => '<button onclick="confirmGenreMove(\'' + g + '\')" class="py-2 text-sm font-semibold bg-primary/10 text-primary border border-primary/20 rounded-xl hover:bg-primary/20 transition">' + GENRE_LABELS[g] + '</button>')
        .join('');
      document.getElementById('genreMoveModal').classList.remove('hidden');
    }

    function confirmGenreMove(targetGenre) {
      if (!genreMoveContext) return;
      const { productId, genre } = genreMoveContext;
      closeGenreModal();
      decide(productId, genre, 'approve', targetGenre);
    }

    function closeGenreModal() {
      document.getElementById('genreMoveModal').classList.add('hidden');
      genreMoveContext = null;
    }

    async function markAllDone() {
      if (!confirm('全ジャンルをスキップしますか？')) return;
      await Promise.all(GENRES.map(genre => {
        const product = currentProducts[genre];
        return product ? decide(product.product_id, genre, 'skip') : Promise.resolve();
      }));
    }

    GENRES.forEach(genre => loadGenre(genre));
  </script>
</body>
</html>`;
}

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key') || '';

    const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store',
    };

    if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
        return new NextResponse(buildLoginHtml(), { headers });
    }

    return new NextResponse(buildXPostHtml(key), { headers });
}
