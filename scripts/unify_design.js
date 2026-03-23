const fs = require('fs');
const path = require('path');

const DESIGN_DIR = path.join(__dirname, '..', 'site', 'public', 'design');

const ACTIVE_TAB = {
    'home': 'home',
    'products': 'home',
    'product-detail': 'home',
    'review': 'home',
    'review-complete': 'home',
    'info-add-select': 'home',
    'cast-add': 'home',
    'cast-add-complete': 'home',
    'search-actress': 'search',
    'search-other': 'search',
    'advanced-search': 'search',
    'ranking': 'ranking',
    'custom-ranking': 'ranking',
    'custom-ranking-create': 'ranking',
    'video': 'video',
    'mypage': 'mypage',
    'sns-register': 'mypage',
    'sns-register-complete': 'mypage',
    'x-post-select': 'mypage',
    'rename-register': 'mypage',
    'rename-register-complete': 'mypage',
    'privacy': 'mypage',
    'terms': 'mypage',
};

const NO_NAV_PAGES = new Set(['age-verify', 'login', 'index']);

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
        return `<a class="${cls}" href="#"><span class="${iconCls}">${icon}</span><span class="${labelCls}">${label}</span></a>`;
    }).join('\n');

    return `<nav class="fixed bottom-0 left-0 right-0 z-50 bg-background-light/95 dark:bg-background-dark/95 backdrop-blur-lg border-t border-primary/10 px-4 pb-6 pt-3"><div class="flex items-center justify-between">\n${items}\n</div></nav>`;
}

const files = fs.readdirSync(DESIGN_DIR).filter(f => f.endsWith('.html'));
const updated = [];

for (const fname of files) {
    const name = fname.replace('.html', '');
    const fpath = path.join(DESIGN_DIR, fname);
    let html = fs.readFileSync(fpath, 'utf-8');
    const original = html;

    // 1) 戻るボタンアイコンを統一
    html = html.replace(/arrow_back_ios_new/g, 'arrow_back');
    html = html.replace(/arrow_back_ios/g, 'arrow_back');
    html = html.replace(/chevron_left/g, 'arrow_back');

    // 2) フィルターアイコンを統一
    html = html.replace(/filter_list/g, 'tune');

    // 3) ボトムナビを統一
    if (!NO_NAV_PAGES.has(name) && ACTIVE_TAB[name]) {
        const newNav = buildNav(ACTIVE_TAB[name]);
        html = html.replace(/<nav\b[\s\S]*?<\/nav>/g, newNav);
    }

    if (html !== original) {
        fs.writeFileSync(fpath, html, 'utf-8');
        updated.push(name);
    }
}

console.log(`更新完了: ${updated.length}ページ`);
updated.sort().forEach(n => console.log(`  ✅ ${n}`));
