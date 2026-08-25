/**
 * ハブページ(ランキング/新作/予約/セール/動画)の <head> にSEOメタを注入する。
 *
 * これらのページはサイトマップに載せているのに、デザインHTMLの <title> が空(ranking.html /
 * products.html)で description も canonical も無かった。長尾LPや作品ページと違って
 * 共通レンダラ(lib/landingPage.ts)を通らないため取り残されていた箇所。
 */
import { esc } from './landingPage';

const BASE = process.env.NEXT_PUBLIC_SITE_URL || 'https://avrankings.com';

export type HubMeta = {
    /** 「| AVランキング」は自動で付く */
    title: string;
    description: string;
    /** 例: '/ranking'（BASE は自動で付く） */
    path: string;
    /** パンくずの2階層目の表示名(省略時は title を使う) */
    breadcrumb?: string;
    /** 追加の構造化データ */
    ld?: object[];
};

export function hubHead(meta: HubMeta): string {
    const title = `${meta.title} | AVランキング`;
    const desc = meta.description.slice(0, 160);
    const canonical = BASE + meta.path;
    const breadcrumb = {
        '@context': 'https://schema.org', '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'ホーム', item: `${BASE}/` },
            { '@type': 'ListItem', position: 2, name: meta.breadcrumb || meta.title, item: canonical },
        ],
    };
    return [
        `<title>${esc(title)}</title>`,
        `<meta name="description" content="${esc(desc)}"/>`,
        `<link rel="canonical" href="${esc(canonical)}"/>`,
        `<meta property="og:title" content="${esc(title)}"/>`,
        `<meta property="og:description" content="${esc(desc)}"/>`,
        `<meta property="og:type" content="website"/>`,
        `<meta property="og:url" content="${esc(canonical)}"/>`,
        `<meta name="twitter:card" content="summary"/>`,
        ...[breadcrumb, ...(meta.ld ?? [])].map(j => `<script type="application/ld+json">${JSON.stringify(j)}</script>`),
    ].join('\n');
}

/** 既存の <title>（空タグを含む）を差し替え、無ければ </head> の直前に入れる。 */
export function injectHubSeo(html: string, meta: HubMeta): string {
    const head = hubHead(meta);
    if (/<title>[\s\S]*?<\/title>/.test(html)) return html.replace(/<title>[\s\S]*?<\/title>/, head);
    return html.replace('</head>', `${head}\n</head>`);
}

/**
 * 最初の <h1> の中身をキーワード入りの見出しへ差し替える。無ければ本文先頭に補う。
 *
 * デザインHTMLの H1 は「作品一覧」「人気ランキング」のような汎用語で、同じテンプレを使い回す
 * /new と /pre-order、/ranking と /ranking/actress が同じ見出しになっていた。さらに
 * /ranking・/ranking/actress・/sale・/video はレイアウト注入後に H1 が1つも残らない
 * （デザイン側の H1 がヘッダーごと差し替えられる）状態だった。
 */
export function replaceH1(html: string, text: string): string {
    if (/<h1[^>]*>[\s\S]*?<\/h1>/.test(html)) {
        return html.replace(/(<h1[^>]*>)([\s\S]*?)(<\/h1>)/, (_m, open, _inner, close) => `${open}${esc(text)}${close}`);
    }
    const h1 = `<h1 class="px-4 pt-3 text-base font-bold tracking-tight text-slate-800 dark:text-slate-100">${esc(text)}</h1>`;
    for (const re of [/<\/header>/, /<main[^>]*>/, /<body[^>]*>/]) {
        const m = html.match(re);
        if (m) return html.replace(re, (mm) => mm + h1);
    }
    return html;
}
