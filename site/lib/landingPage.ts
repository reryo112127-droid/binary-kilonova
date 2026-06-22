// ============================================================
//  長尾ランディングページ(LP)共通レンダラ
//  /genre/[name]・/maker/[name]・/series/[name]・/cup/[letter] が共有する。
//  目的: 検索ボリュームのある語で固有 title/meta/H1 ＋ 実HTMLの作品カード(=索引可能)
//        ＋ JSON-LD(ItemList/BreadcrumbList) を持つページをサーバ生成する。
//  本文カードは内部 /api/products を1回叩いて取得(既存フィルタを丸ごと再利用)。
//  ページネーションはクライアントの無限スクロールが offset=30 から続ける。
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from './readHtml';
import { injectMobileLayout } from './injectLayout';
import { GET as productsGET } from '../app/api/products/route';

const BASE = process.env.NEXT_PUBLIC_SITE_URL || 'https://avrankings.com';
const SSR_COUNT = 30;

export interface LandingOptions {
    /** sitemap/内部リンクの種別 (genre|maker|series|cup) */
    type: string;
    /** URLスラッグ(生値。例: 巨乳 / エスワン) */
    slug: string;
    /** <title>(「| AVランキング」は付与される) */
    title: string;
    /** ページ見出し(H1) */
    h1: string;
    /** meta description */
    description: string;
    /** H1直下に出す説明文(索引テキスト) */
    intro: string;
    /** /api/products に渡すクエリ文字列(例: "genre=巨乳&sort=wish_count&excludeBest=1") */
    apiQuery: string;
    /** パンくず: ハブのパスと表示名(例: {path:'/genres', label:'ジャンル'}) */
    hub: { path: string; label: string };
    /** canonical 用パス(例: /genre/巨乳 ※未エンコードでOK、関数内でencode) */
    canonicalPath: string;
}

export function esc(s: unknown): string {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// MGS裏表紙→表紙 / 素人サムネ補正(products/route.ts の poster と同じ)
export function poster(url: string): string {
    if (!url) return '';
    if (url.includes('pb_e_')) return url.replace('pb_e_', 'pf_e_');
    if (url.includes('/digital/amateur/') && url.endsWith('jm.jpg')) return url.replace('jm.jpg', 'jp-001.jpg');
    return url;
}

export type Product = { product_id: string; title?: string; actresses?: string; main_image_url?: string };

// SSR用の作品カード(実 <a> リンク = クロール可能)
export function cardHtml(p: Product): string {
    const pid = String(p.product_id);
    const img = poster(String(p.main_image_url || ''));
    const act = p.actresses ? String(p.actresses).split(',')[0].trim() : '';
    const imgTag = img
        ? `<img class="h-full w-full object-cover object-right" src="${esc(img)}" alt="${esc(p.title)}" loading="lazy"/>`
        : `<div class="h-full w-full bg-slate-200 dark:bg-slate-700"></div>`;
    return `<a class="flex flex-col gap-1" href="/product/${encodeURIComponent(pid)}">`
        + `<div class="relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-slate-200 dark:bg-slate-700">${imgTag}`
        + `<button data-like-pid="${esc(pid)}" class="absolute bottom-1 right-1 w-6 h-6 flex items-center justify-center bg-black/30 backdrop-blur-sm rounded-full text-white" onclick="event.preventDefault();event.stopPropagation();toggleLike(this,this.dataset.likePid)"><span class="material-symbols-outlined text-[12px]">favorite</span></button>`
        + `</div>`
        + `<p class="line-clamp-2 text-[11px] font-bold leading-tight">${esc(p.title)}</p>`
        + (act ? `<p class="text-[10px] text-slate-400 truncate">${esc(act)}</p>` : '')
        + `</a>`;
}

// 作品配列を SSR カード列に
export function productCardsHtml(products: Product[]): string {
    return products.map(cardHtml).join('');
}

// #products-grid の中身を SSR カードに差し替える(対応する </div> を深さカウントで特定)
export function replaceGridInner(html: string, inner: string): string {
    const m = html.match(/<div[^>]*id="products-grid"[^>]*>/);
    if (!m || m.index === undefined) return html;
    const start = m.index + m[0].length;
    let depth = 1, i = start;
    while (i < html.length && depth > 0) {
        const nextOpen = html.indexOf('<div', i);
        const nextClose = html.indexOf('</div>', i);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) { depth++; i = nextOpen + 4; }
        else { depth--; i = nextClose + 6; }
    }
    const closeStart = i - 6;
    return html.slice(0, start) + inner + html.slice(closeStart);
}

// Workersは自分の公開URLへの自己fetchが失敗するため、/api/products の GET を同一プロセスで直接呼ぶ
// (D1バインディングを共有)。offset対応でページネーション/女優ページからも再利用する。
export async function fetchProducts(req: NextRequest, apiQuery: string, count = SSR_COUNT, offset = 0): Promise<Product[]> {
    try {
        const url = new URL(`/api/products?${apiQuery}&limit=${count}&offset=${offset}`, req.url);
        const res = await productsGET(new NextRequest(url));
        if (!res.ok) return [];
        const data = await res.json();
        const arr = Array.isArray(data) ? data : (data.products || []);
        return Array.isArray(arr) ? arr as Product[] : [];
    } catch { return []; }
}

// クライアント無限スクロール(SSR済みの続き startOffset から続ける)
function paginatorScript(apiQuery: string, startOffset: number): string {
    return `<script id="lp-paginate">(function(){
  var Q=${JSON.stringify(apiQuery)};var grid=document.getElementById('products-grid');
  if(!grid)return;
  // SSRカードが入っていれば続き(startOffset)から、空(=SSR失敗)なら先頭から取得
  var hasSSR=grid.querySelector('a[href^="/product/"]')!=null;
  var offset=hasSSR?${startOffset}:0,loading=false,hasMore=true,LIMIT=30;
  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function poster(u){if(!u)return'';if(u.indexOf('pb_e_')>-1)return u.replace('pb_e_','pf_e_');if(u.indexOf('/digital/amateur/')>-1&&/jm\\.jpg$/.test(u))return u.replace('jm.jpg','jp-001.jpg');return u;}
  function card(p){var pid=String(p.product_id);var img=poster(p.main_image_url);var act=p.actresses?String(p.actresses).split(',')[0].trim():'';
    var im=img?'<img class="h-full w-full object-cover object-right" src="'+esc(img)+'" alt="'+esc(p.title)+'" loading="lazy"/>':'<div class="h-full w-full bg-slate-200 dark:bg-slate-700"></div>';
    return '<a class="flex flex-col gap-1" href="/product/'+encodeURIComponent(pid)+'"><div class="relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-slate-200 dark:bg-slate-700">'+im
      +'<button data-like-pid="'+esc(pid)+'" class="absolute bottom-1 right-1 w-6 h-6 flex items-center justify-center bg-black/30 backdrop-blur-sm rounded-full text-white" onclick="event.preventDefault();event.stopPropagation();toggleLike(this,this.dataset.likePid)"><span class="material-symbols-outlined text-[12px]">favorite</span></button></div>'
      +'<p class="line-clamp-2 text-[11px] font-bold leading-tight">'+esc(p.title)+'</p>'+(act?'<p class="text-[10px] text-slate-400 truncate">'+esc(act)+'</p>':'')+'</a>';}
  function load(){if(loading||!hasMore)return;loading=true;
    fetch('/api/products?'+Q+'&limit='+LIMIT+'&offset='+offset).then(function(r){return r.json();}).then(function(d){
      var a=Array.isArray(d)?d:(d.products||[]);if(a.length<LIMIT)hasMore=false;
      grid.insertAdjacentHTML('beforeend',a.map(card).join(''));offset+=a.length;
      if(window.restoreLikes)window.restoreLikes();loading=false;
    }).catch(function(){loading=false;});}
  if(window.restoreLikes)window.restoreLikes();
  if(!hasSSR)load(); // SSRが空なら即座に先頭ページを取得して表示
  window.addEventListener('scroll',function(){if(loading||!hasMore)return;if(window.scrollY+window.innerHeight>=document.documentElement.scrollHeight-600)load();},{passive:true});
})();<\/script>`;
}

type Faq = { q: string; a: string };
type PageNav = { canonical: string; prevUrl: string; nextUrl: string; noindex: boolean };

// カタログ機能に即した汎用FAQ(露骨でない・薄いページ対策＋固有テキスト)
function faqFor(opts: LandingOptions): Faq[] {
    const n = opts.h1;
    return [
        { q: `${n}はどんな順番で表示されますか？`, a: `${n}の作品をお気に入り数・レビュー評価に基づく人気順で一覧表示しています。上位の作品から探せます。` },
        { q: `${n}の新作はありますか？`, a: `はい。新着・配信日順での並び替えに対応し、データは日次で更新しています。` },
        { q: `サンプル動画や最安値は確認できますか？`, a: `多くの作品でサンプル動画・サンプル画像を掲載し、MGS・FANZAの価格を比較して安い方を表示します。` },
    ];
}

function jsonLd(opts: LandingOptions, products: Product[], nav: PageNav, faq: Faq[]): string {
    const breadcrumb = {
        '@context': 'https://schema.org', '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'ホーム', item: BASE + '/' },
            { '@type': 'ListItem', position: 2, name: opts.hub.label, item: BASE + opts.hub.path },
            { '@type': 'ListItem', position: 3, name: opts.h1, item: BASE + opts.canonicalPath },
        ],
    };
    const itemList = {
        '@context': 'https://schema.org', '@type': 'ItemList', name: opts.title,
        itemListElement: products.slice(0, SSR_COUNT).map((p, i) => ({
            '@type': 'ListItem', position: i + 1, url: `${BASE}/product/${encodeURIComponent(String(p.product_id))}`,
        })),
    };
    const faqPage = {
        '@context': 'https://schema.org', '@type': 'FAQPage',
        mainEntity: faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    };
    const blocks: object[] = [breadcrumb];
    if (products.length) blocks.push(itemList);
    if (faq.length) blocks.push(faqPage);
    return blocks.map(b => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join('\n');
}

function seoHead(opts: LandingOptions, products: Product[], nav: PageNav, faq: Faq[]): string {
    const title = `${opts.title} | AVランキング`;
    const desc = opts.description.slice(0, 160);
    return `<title>${esc(title)}</title>\n`
        + `<meta name="description" content="${esc(desc)}"/>\n`
        + (nav.noindex ? `<meta name="robots" content="noindex,follow"/>\n` : '')
        + `<link rel="canonical" href="${esc(nav.canonical)}"/>\n`
        + (nav.prevUrl ? `<link rel="prev" href="${esc(nav.prevUrl)}"/>\n` : '')
        + (nav.nextUrl ? `<link rel="next" href="${esc(nav.nextUrl)}"/>\n` : '')
        + `<meta property="og:title" content="${esc(title)}"/>\n`
        + `<meta property="og:description" content="${esc(desc)}"/>\n`
        + `<meta property="og:type" content="website"/>\n`
        + `<meta property="og:url" content="${esc(nav.canonical)}"/>\n`
        + jsonLd(opts, products, nav, faq);
}

// H1＋説明文ブロック(グリッド直前に差し込む索引テキスト)
function headingBlock(opts: LandingOptions): string {
    return `<section class="px-4 pt-3 pb-1">`
        + `<nav class="text-[11px] text-slate-400 mb-1"><a href="/" class="hover:text-primary">ホーム</a> › <a href="${esc(opts.hub.path)}" class="hover:text-primary">${esc(opts.hub.label)}</a> › <span>${esc(opts.h1)}</span></nav>`
        + `<h1 class="text-lg font-bold leading-tight">${esc(opts.h1)}</h1>`
        + `<p class="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">${esc(opts.intro)}</p>`
        + `</section>`;
}

// 可視ページネーション(クロール可能な実リンク。?page=N)
function pagePath(path: string, p: number): string { return p > 0 ? `${path}?page=${p}` : path; }
function paginationNav(opts: LandingOptions, page: number, hasNext: boolean): string {
    if (page === 0 && !hasNext) return '';
    const link = (href: string, label: string) =>
        `<a class="rounded-full border border-slate-200 dark:border-slate-700 px-4 py-1.5 text-xs font-medium hover:border-primary hover:text-primary" href="${esc(href)}">${label}</a>`;
    const prev = page > 0 ? link(pagePath(opts.canonicalPath, page - 1), '‹ 前へ') : '<span></span>';
    const next = hasNext ? link(pagePath(opts.canonicalPath, page + 1), '次へ ›') : '<span></span>';
    return `<nav class="flex items-center justify-between px-4 py-4">${prev}<span class="text-[11px] text-slate-400">ページ ${page + 1}</span>${next}</nav>`;
}

// 可視FAQ(索引テキスト。FAQPage構造化データと対応)
function faqVisible(faq: Faq[]): string {
    return `<section class="px-4 py-5 border-t border-slate-200 dark:border-slate-800">`
        + `<h2 class="text-sm font-bold mb-2 text-slate-700 dark:text-slate-300">よくある質問</h2>`
        + faq.map(f => `<div class="mb-2"><p class="text-xs font-bold text-slate-700 dark:text-slate-300">Q. ${esc(f.q)}</p><p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">${esc(f.a)}</p></div>`).join('')
        + `</section>`;
}

/** LPをレンダリングして NextResponse を返す。slug不正(空結果)時は呼び出し側で404にしてもよい。 */
export async function renderLandingPage(req: NextRequest, opts: LandingOptions): Promise<NextResponse> {
    // モバイルファースト索引に合わせ、埋め込みローダの無いクリーンな products.html を全UAで使う。
    const page = Math.max(0, parseInt(new URL(req.url).searchParams.get('page') || '0', 10) || 0);
    const offset = page * SSR_COUNT;
    const products = await fetchProducts(req, opts.apiQuery, SSR_COUNT, offset);
    const hasNext = products.length === SSR_COUNT;
    const faq = faqFor(opts);
    const nav: PageNav = {
        canonical: BASE + pagePath(opts.canonicalPath, page),
        prevUrl: page > 0 ? BASE + pagePath(opts.canonicalPath, page - 1) : '',
        nextUrl: hasNext ? BASE + pagePath(opts.canonicalPath, page + 1) : '',
        noindex: products.length === 0, // 範囲外/空ページは索引させない
    };

    let html = await readHtml(req.url, '/design/products.html');
    html = injectMobileLayout(html, '', { skipHeader: true });

    // テンプレ上部バーの汎用H1「作品一覧」をdivへ降格(キーワードH1を唯一のH1にする)
    html = html.replace(/<h1([^>]*)>作品一覧<\/h1>/, (_m, attrs) => `<div${attrs}>${esc(opts.slug)}</div>`);
    html = html.replace('</head>', seoHead(opts, products, nav, faq) + '\n</head>');
    html = html.replace(/<div[^>]*id="products-grid"[^>]*>/, m => headingBlock(opts) + m);
    html = replaceGridInner(html, productCardsHtml(products));
    // グリッド後・フッター前に ページネーション＋FAQ を挿入(injectFooterで </body>直前にfooterが入っている)
    html = html.replace('<footer id="site-footer"', paginationNav(opts, page, hasNext) + faqVisible(faq) + '<footer id="site-footer"');
    // このページ専用のページャ(SSR済みの続きから無限スクロール)
    html = html.replace('</body>', paginatorScript(opts.apiQuery, offset + products.length) + '\n</body>');

    return new NextResponse(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, s-maxage=3600, max-age=120',
            'CDN-Cache-Control': 'public, s-maxage=3600',
        },
    });
}

// ─── ハブ(一覧)ページ: /genres・/series・/cup ───────────────────
export interface IndexOptions {
    title: string;
    h1: string;
    description: string;
    intro: string;
    canonicalPath: string;
    items: { href: string; label: string; count?: number }[];
}

function indexSeoHead(opts: IndexOptions): string {
    const canonical = BASE + opts.canonicalPath;
    const title = `${opts.title} | AVランキング`;
    const desc = opts.description.slice(0, 160);
    const breadcrumb = {
        '@context': 'https://schema.org', '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'ホーム', item: BASE + '/' },
            { '@type': 'ListItem', position: 2, name: opts.h1, item: canonical },
        ],
    };
    return `<title>${esc(title)}</title>\n`
        + `<meta name="description" content="${esc(desc)}"/>\n`
        + `<link rel="canonical" href="${esc(canonical)}"/>\n`
        + `<meta property="og:title" content="${esc(title)}"/>\n`
        + `<meta property="og:description" content="${esc(desc)}"/>\n`
        + `<meta property="og:url" content="${esc(canonical)}"/>\n`
        + `<script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>`;
}

export async function renderIndexPage(req: NextRequest, opts: IndexOptions): Promise<NextResponse> {
    let html = await readHtml(req.url, '/design/products.html');
    html = injectMobileLayout(html, '', { skipHeader: true });

    html = html.replace(/<h1([^>]*)>作品一覧<\/h1>/, (_m, attrs) => `<div${attrs}>${esc(opts.h1)}</div>`);
    html = html.replace('</head>', indexSeoHead(opts) + '\n</head>');
    const heading = `<section class="px-4 pt-3 pb-1">`
        + `<nav class="text-[11px] text-slate-400 mb-1"><a href="/" class="hover:text-primary">ホーム</a> › <span>${esc(opts.h1)}</span></nav>`
        + `<h1 class="text-lg font-bold leading-tight">${esc(opts.h1)}</h1>`
        + `<p class="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">${esc(opts.intro)}</p>`
        + `</section>`;
    html = html.replace(/<div[^>]*id="products-grid"[^>]*>/, m => heading + m);

    const chips = opts.items.map(it =>
        `<a href="${esc(it.href)}" class="inline-flex items-center gap-1 rounded-full border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium hover:border-primary hover:text-primary transition-colors">`
        + `${esc(it.label)}${it.count != null ? `<span class="text-[10px] text-slate-400">${it.count.toLocaleString()}</span>` : ''}</a>`
    ).join('');
    html = replaceGridInner(html, `<div class="col-span-3 flex flex-wrap gap-2 px-4 pb-24">${chips}</div>`);

    return new NextResponse(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, s-maxage=21600, max-age=300',
            'CDN-Cache-Control': 'public, s-maxage=21600',
        },
    });
}
