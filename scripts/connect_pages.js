const fs = require('fs');
const path = require('path');

const DESIGN_DIR = path.join(__dirname, '..', 'site', 'public', 'design');

// ボトムナビのタブ → URL マッピング
const NAV_LINKS = {
    'home':    'home.html',
    'search':  'search-actress.html',
    'ranking': 'ranking.html',
    'video':   'video.html',
    'mypage':  'mypage.html',
};

const ACTIVE_TAB = {
    'home': 'home', 'products': 'home', 'product-detail': 'home',
    'review': 'home', 'review-complete': 'home',
    'info-add-select': 'home', 'cast-add': 'home', 'cast-add-complete': 'home',
    'search-actress': 'search', 'search-other': 'search', 'advanced-search': 'search',
    'ranking': 'ranking', 'custom-ranking': 'ranking', 'custom-ranking-create': 'ranking',
    'video': 'video',
    'mypage': 'mypage', 'sns-register': 'mypage', 'sns-register-complete': 'mypage',
    'x-post-select': 'mypage', 'rename-register': 'mypage', 'rename-register-complete': 'mypage',
    'privacy': 'mypage', 'terms': 'mypage',
};

const TABS = [
    { key: 'home',    icon: 'home',        label: 'ホーム' },
    { key: 'search',  icon: 'search',      label: '検索' },
    { key: 'ranking', icon: 'trophy',      label: 'ランキング' },
    { key: 'video',   icon: 'play_circle', label: '動画' },
    { key: 'mypage',  icon: 'person',      label: 'マイページ' },
];

function buildNav(active) {
    const items = TABS.map(({ key, icon, label }) => {
        const isActive = key === active;
        const cls = isActive
            ? 'flex flex-col items-center gap-1 text-primary flex-1'
            : 'flex flex-col items-center gap-1 text-slate-400 dark:text-slate-500 flex-1';
        const iconCls = isActive
            ? 'material-symbols-outlined active-icon text-[24px]'
            : 'material-symbols-outlined text-[24px]';
        const labelCls = isActive ? 'text-[10px] font-bold' : 'text-[10px] font-medium';
        const href = NAV_LINKS[key];
        return `<a class="${cls}" href="${href}"><span class="${iconCls}">${icon}</span><span class="${labelCls}">${label}</span></a>`;
    }).join('\n');
    return `<nav class="fixed bottom-0 left-0 right-0 z-50 bg-background-light/95 dark:bg-background-dark/95 backdrop-blur-lg border-t border-primary/10 px-4 pb-6 pt-3"><div class="flex items-center justify-between">\n${items}\n</div></nav>`;
}

// ページ固有のリンク置換ルール
const PAGE_RULES = {
    // 年齢確認: はい→home.html, いいえ→about:blank
    'age-verify': html => html
        .replace(
            /(<button[^>]*>)\s*\n?\s*(はい、18歳以上です)/,
            '<a href="home.html" class="w-full flex items-center justify-center h-14 bg-primary text-white rounded-xl text-lg font-bold shadow-lg shadow-primary/20 hover:opacity-90 active:scale-[0.98] transition-all">$2</a>'
        )
        .replace(
            /(<button[^>]*>)\s*\n?\s*(いいえ、18歳未満です)/,
            '<a href="about:blank" class="w-full flex items-center justify-center h-14 bg-primary/10 text-primary border-2 border-primary rounded-xl text-lg font-bold hover:bg-primary/20 active:scale-[0.98] transition-all">$2</a>'
        ),

    // ログイン: 完了後→home.html
    'login': html => html,

    // SNS登録完了→home.html
    'sns-register-complete': html => html,
};

// 全ページ共通の置換
function applyCommonRules(html, name) {
    // 1) ボトムナビを正しいhrefで再生成
    if (ACTIVE_TAB[name]) {
        html = html.replace(/<nav\b[\s\S]*?<\/nav>/g, buildNav(ACTIVE_TAB[name]));
    }

    // 2) 戻るボタン → history.back()
    html = html.replace(
        /(<button[^>]*aria-label="戻る"[^>]*>)/g,
        '<button onclick="history.back()" $1'.replace('<button onclick="history.back()" <button', '<button onclick="history.back()"')
    );
    // aria-labelなしの戻るボタン(arrow_backアイコン含む)
    html = html.replace(
        /(<button(?![^>]*onclick)[^>]*>)\s*(<span[^>]*>arrow_back<\/span>)\s*(<\/button>)/g,
        '<button onclick="history.back()">$2$3'
    );

    // 3) 利用規約リンク
    html = html.replace(
        /href="#"([^>]*)>利用規約</g,
        'href="terms.html"$1>利用規約<'
    );
    // 4) プライバシーポリシーリンク
    html = html.replace(
        /href="#"([^>]*)>プライバシーポリシー</g,
        'href="privacy.html"$1>プライバシーポリシー<'
    );

    // 5) ヘッダーの新規登録ボタン
    html = html.replace(
        /(<button[^>]*>)\s*新規登録\s*(<\/button>)/g,
        '<a href="login.html" class="px-1.5 py-1 text-[9px] font-bold text-primary border border-primary/20 rounded-md whitespace-nowrap">新規登録</a>'
    );
    // 6) ヘッダーのログインボタン
    html = html.replace(
        /(<button[^>]*>)\s*ログイン\s*(<\/button>)/g,
        '<a href="login.html" class="px-1.5 py-1 text-[9px] font-bold bg-primary text-white rounded-md whitespace-nowrap">ログイン</a>'
    );

    // 7) 作品カード → product-detail.html
    // サムネイル画像のリンク
    html = html.replace(
        /(<a\s+class="[^"]*aspect-\[2\/3\][^"]*"\s+)href="#"/g,
        '$1href="product-detail.html"'
    );
    // 作品タイトルリンク
    html = html.replace(
        /(<a\s+class="[^"]*line-clamp[^"]*"\s+)href="#"/g,
        '$1href="product-detail.html"'
    );
    html = html.replace(
        /(<a\s+class="[^"]*font-semibold[^"]*text-xs[^"]*"\s+)href="#"/g,
        '$1href="product-detail.html"'
    );

    // 8) 検索→検索ページ
    html = html.replace(
        /(<a\s+class="[^"]*"\s+)href="#"([^>]*)>\s*(<span[^>]*>search<\/span>)\s*(<span[^>]*>検索<\/span>)/g,
        '$1href="search-actress.html"$2>$3$4'
    );

    // 9) カスタムランキング
    html = html.replace(
        /href="#"([^>]*)>カスタムランキング/g,
        'href="custom-ranking.html"$1>カスタムランキング'
    );

    return html;
}

const NO_NAV_PAGES = new Set(['age-verify', 'login', 'index']);
const updated = [];

for (const fname of fs.readdirSync(DESIGN_DIR).filter(f => f.endsWith('.html'))) {
    const name = fname.replace('.html', '');
    const fpath = path.join(DESIGN_DIR, fname);
    let html = fs.readFileSync(fpath, 'utf-8');
    const original = html;

    html = applyCommonRules(html, name);

    if (PAGE_RULES[name]) {
        html = PAGE_RULES[name](html);
    }

    if (html !== original) {
        fs.writeFileSync(fpath, html, 'utf-8');
        updated.push(name);
    }
}

console.log(`リンク接続完了: ${updated.length}ページ`);
updated.sort().forEach(n => console.log(`  ✅ ${n}`));
