import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const LOGIN_HTML = `<!DOCTYPE html>
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
      window.location.href = '/admin?key=' + encodeURIComponent(key);
    });
  </script>
</body>
</html>`;

function buildAdminHtml(key: string): string {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>管理画面 | AVランキング</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet"/>
</head>
<body class="bg-gray-50 text-gray-900 antialiased">

  <!-- Header -->
  <header class="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-10">
    <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
      <h1 class="text-lg font-bold text-gray-800">管理画面</h1>
      <a href="/admin/x-post?key=${key}" class="inline-flex items-center gap-1 bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition">
        <span class="material-symbols-outlined text-base" style="font-variation-settings:'FILL' 1">mode_edit</span>
        X投稿選択
      </a>
    </div>
  </header>

  <!-- Main -->
  <main class="max-w-7xl mx-auto px-4 py-6">

    <!-- Tabs -->
    <div class="flex gap-2 mb-4">
      <button onclick="switchTab('cast')" id="tab-cast"
        class="tab-btn px-5 py-2 rounded-lg text-sm font-semibold border transition bg-blue-600 text-white border-blue-600">
        キャスト投稿
      </button>
      <button onclick="switchTab('sns')" id="tab-sns"
        class="tab-btn px-5 py-2 rounded-lg text-sm font-semibold border transition bg-white text-gray-600 border-gray-300 hover:bg-gray-50">
        SNS投稿
      </button>
      <button onclick="switchTab('rename')" id="tab-rename"
        class="tab-btn px-5 py-2 rounded-lg text-sm font-semibold border transition bg-white text-gray-600 border-gray-300 hover:bg-gray-50">
        改名投稿
      </button>
    </div>

    <!-- Status filter -->
    <div class="flex gap-2 mb-5">
      <button onclick="setStatus('pending')" id="status-pending"
        class="status-btn px-4 py-1.5 rounded-full text-xs font-semibold border transition bg-orange-100 text-orange-700 border-orange-300">
        未処理
      </button>
      <button onclick="setStatus('approved')" id="status-approved"
        class="status-btn px-4 py-1.5 rounded-full text-xs font-semibold border transition bg-white text-gray-600 border-gray-300 hover:bg-gray-50">
        承認済み
      </button>
      <button onclick="setStatus('rejected')" id="status-rejected"
        class="status-btn px-4 py-1.5 rounded-full text-xs font-semibold border transition bg-white text-gray-600 border-gray-300 hover:bg-gray-50">
        却下済み
      </button>
    </div>

    <!-- Loading -->
    <div id="loadingIndicator" class="text-center py-12 text-gray-400 hidden">
      <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      <p class="mt-2 text-sm">読み込み中...</p>
    </div>

    <!-- Error message -->
    <div id="errorMsg" class="hidden bg-red-50 text-red-700 border border-red-200 rounded-lg px-4 py-3 text-sm mb-4"></div>

    <!-- Tables -->
    <div id="panel-cast" class="tab-panel">
      <div id="table-cast"></div>
    </div>
    <div id="panel-sns" class="tab-panel hidden">
      <div id="table-sns"></div>
    </div>
    <div id="panel-rename" class="tab-panel hidden">
      <div id="table-rename"></div>
    </div>

  </main>

  <script>
    const ADMIN_KEY = '${key}';
    let currentTab = 'cast';
    let currentStatus = 'pending';
    const loadedTabs = new Set();

    function switchTab(tab) {
      currentTab = tab;
      loadedTabs.clear();

      // Update tab buttons
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('bg-blue-600', 'text-white', 'border-blue-600');
        btn.classList.add('bg-white', 'text-gray-600', 'border-gray-300');
      });
      const activeBtn = document.getElementById('tab-' + tab);
      activeBtn.classList.remove('bg-white', 'text-gray-600', 'border-gray-300');
      activeBtn.classList.add('bg-blue-600', 'text-white', 'border-blue-600');

      // Show/hide panels
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      document.getElementById('panel-' + tab).classList.remove('hidden');

      loadData();
    }

    function setStatus(status) {
      currentStatus = status;
      loadedTabs.clear();

      document.querySelectorAll('.status-btn').forEach(btn => {
        btn.classList.remove('bg-orange-100', 'text-orange-700', 'border-orange-300',
                             'bg-green-100', 'text-green-700', 'border-green-300',
                             'bg-red-100', 'text-red-700', 'border-red-300');
        btn.classList.add('bg-white', 'text-gray-600', 'border-gray-300');
      });

      const btn = document.getElementById('status-' + status);
      const colorMap = {
        pending:  ['bg-orange-100', 'text-orange-700', 'border-orange-300'],
        approved: ['bg-green-100',  'text-green-700',  'border-green-300'],
        rejected: ['bg-red-100',    'text-red-700',    'border-red-300'],
      };
      btn.classList.remove('bg-white', 'text-gray-600', 'border-gray-300');
      btn.classList.add(...colorMap[status]);

      loadData();
    }

    async function loadData() {
      const key = currentTab + '_' + currentStatus;
      if (loadedTabs.has(key)) return;

      const loading = document.getElementById('loadingIndicator');
      const errEl = document.getElementById('errorMsg');
      loading.classList.remove('hidden');
      errEl.classList.add('hidden');

      try {
        const res = await fetch('/api/admin/submissions?type=' + currentTab + '&status=' + currentStatus, {
          headers: { 'x-admin-key': ADMIN_KEY }
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const rows = await res.json();
        renderTable(currentTab, rows);
        loadedTabs.add(key);
      } catch (e) {
        errEl.textContent = 'データ読み込みエラー: ' + e.message;
        errEl.classList.remove('hidden');
      } finally {
        loading.classList.add('hidden');
      }
    }

    function renderTable(type, rows) {
      const container = document.getElementById('table-' + type);
      if (rows.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-400 py-12 text-sm">データがありません</p>';
        return;
      }

      let headers = '';
      let bodyRows = '';

      if (type === 'cast') {
        headers = '<th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">ID</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">作品ID</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">出演者</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">投稿日</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">ステータス</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">操作</th>';
        bodyRows = rows.map(r => \`<tr class="border-t border-gray-100 hover:bg-gray-50">
          <td class="px-4 py-3 text-sm text-gray-500">\${r.id}</td>
          <td class="px-4 py-3 text-sm font-mono text-blue-600">\${r.product_id || ''}</td>
          <td class="px-4 py-3 text-sm text-gray-800">\${r.actresses || ''}</td>
          <td class="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">\${(r.submitted_at || '').slice(0, 16)}</td>
          <td class="px-4 py-3">\${statusBadge(r.status)}</td>
          <td class="px-4 py-3">\${actionButtons(r.id, type, r.status)}</td>
        </tr>\`).join('');

      } else if (type === 'sns') {
        headers = '<th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">ID</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">出演者名</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">X</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Instagram</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">投稿日</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">ステータス</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">操作</th>';
        bodyRows = rows.map(r => \`<tr class="border-t border-gray-100 hover:bg-gray-50">
          <td class="px-4 py-3 text-sm text-gray-500">\${r.id}</td>
          <td class="px-4 py-3 text-sm text-gray-800">\${r.actress_name || ''}</td>
          <td class="px-4 py-3 text-sm text-sky-600">\${r.twitter_username ? '@' + r.twitter_username : '—'}</td>
          <td class="px-4 py-3 text-sm text-pink-600">\${r.instagram_username ? '@' + r.instagram_username : '—'}</td>
          <td class="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">\${(r.submitted_at || '').slice(0, 16)}</td>
          <td class="px-4 py-3">\${statusBadge(r.status)}</td>
          <td class="px-4 py-3">\${actionButtons(r.id, type, r.status)}</td>
        </tr>\`).join('');

      } else if (type === 'rename') {
        headers = '<th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">ID</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">旧名</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">新名</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">参照URL</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">投稿日</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">ステータス</th><th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">操作</th>';
        bodyRows = rows.map(r => \`<tr class="border-t border-gray-100 hover:bg-gray-50">
          <td class="px-4 py-3 text-sm text-gray-500">\${r.id}</td>
          <td class="px-4 py-3 text-sm text-gray-800">\${r.old_name || ''}</td>
          <td class="px-4 py-3 text-sm text-green-700 font-semibold">\${r.new_name || ''}</td>
          <td class="px-4 py-3 text-sm">\${r.reference_url ? \`<a href="\${r.reference_url}" target="_blank" class="text-blue-500 hover:underline text-xs">リンク</a>\` : '—'}</td>
          <td class="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">\${(r.submitted_at || '').slice(0, 16)}</td>
          <td class="px-4 py-3">\${statusBadge(r.status)}</td>
          <td class="px-4 py-3">\${actionButtons(r.id, type, r.status)}</td>
        </tr>\`).join('');
      }

      container.innerHTML = \`<div class="bg-white rounded-xl shadow overflow-hidden">
        <div class="overflow-x-auto">
          <table class="min-w-full">
            <thead class="bg-gray-50"><tr>\${headers}</tr></thead>
            <tbody>\${bodyRows}</tbody>
          </table>
        </div>
        <div class="px-4 py-2 text-xs text-gray-400 border-t border-gray-100">\${rows.length}件</div>
      </div>\`;
    }

    function statusBadge(status) {
      const map = {
        pending:  '<span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">未処理</span>',
        approved: '<span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">承認済</span>',
        rejected: '<span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">却下</span>',
      };
      return map[status] || status;
    }

    function actionButtons(id, type, status) {
      if (status !== 'pending') return '<span class="text-xs text-gray-400">処理済み</span>';
      return \`<div class="flex gap-2">
        <button onclick="doAction(\${id}, '\${type}', 'approve')"
          class="px-3 py-1 text-xs font-semibold bg-green-600 hover:bg-green-700 text-white rounded-lg transition">承認</button>
        <button onclick="doAction(\${id}, '\${type}', 'reject')"
          class="px-3 py-1 text-xs font-semibold bg-red-500 hover:bg-red-600 text-white rounded-lg transition">却下</button>
      </div>\`;
    }

    async function doAction(id, type, action) {
      const label = action === 'approve' ? '承認' : '却下';
      if (!confirm(id + ' を' + label + 'しますか？')) return;

      try {
        const res = await fetch('/api/admin/submissions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-key': ADMIN_KEY,
          },
          body: JSON.stringify({ id, type, action }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'エラー');
        loadedTabs.clear();
        loadData();
      } catch (e) {
        alert('エラー: ' + e.message);
      }
    }

    // Initial load
    loadData();
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
        return new NextResponse(LOGIN_HTML, { headers });
    }

    return new NextResponse(buildAdminHtml(key), { headers });
}
