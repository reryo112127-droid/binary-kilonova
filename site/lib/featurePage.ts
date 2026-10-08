/**
 * 特集ページ（/features ハブと /feature/<slug>）。
 *
 * 中身は scripts/build_features.mjs がローカルDBから日次で焼く features.json（D1 は読まない）。
 * 見た目は長尾LPと同じ products.html の枠を使い、一覧は「順位・理由の一言・価格/評価」付きの行にする。
 * intro はビルドスクリプトが書いた信頼できる HTML（内部リンク入り）なのでそのまま出す。
 */
import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from './readHtml';
import { injectMobileLayout } from './injectLayout';
import { edgeLookup, edgeStore } from './edgeCache';
import { readStaticCacheAsync as readStaticCache } from './staticCache';
import { esc, poster, cardMetaHtml, replaceGridInner, type Product } from './landingPage';
import { setXFollow, xGenreOfFeature } from './xFollow';
import { filterActresses } from './actressFilter';

const BASE = process.env.NEXT_PUBLIC_SITE_URL || 'https://avrankings.com';

export type FeatureItem = Product & {
    maker?: string; sale_start_date?: string; source?: string; note?: string;
    duration_min?: number; pair_id?: string; fanza_price?: number; mgs_price?: number;
};
export type Feature = {
    slug: string; title: string; h1: string; description: string; intro: string; items: FeatureItem[];
};
type FeatureFile = { generatedAt: string; features: Feature[] };

export async function loadFeatures(): Promise<FeatureFile | null> {
    return readStaticCache<FeatureFile>('features.json').catch(() => null);
}

function head(title: string, desc: string, path: string, crumb: string, ld: object[] = []): string {
    const canonical = BASE + path;
    const t = `${title} | AVランキング`;
    const breadcrumb = {
        '@context': 'https://schema.org', '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'ホーム', item: BASE + '/' },
            { '@type': 'ListItem', position: 2, name: '特集', item: BASE + '/features' },
            ...(path === '/features' ? [] : [{ '@type': 'ListItem', position: 3, name: crumb, item: canonical }]),
        ],
    };
    return [
        `<title>${esc(t)}</title>`,
        `<meta name="description" content="${esc(desc.slice(0, 160))}"/>`,
        `<link rel="canonical" href="${esc(canonical)}"/>`,
        `<meta property="og:title" content="${esc(t)}"/>`,
        `<meta property="og:description" content="${esc(desc.slice(0, 160))}"/>`,
        `<meta property="og:url" content="${esc(canonical)}"/>`,
        `<meta property="og:type" content="article"/>`,
        ...[breadcrumb, ...ld].map(j => `<script type="application/ld+json">${JSON.stringify(j)}</script>`),
    ].join('\n');
}

function itemRow(p: FeatureItem, rank: number): string {
    const img = poster(String(p.main_image_url || ''));
    // 役名は出さない（実在女優だけ）
    p = { ...p, actresses: p.actresses ? (filterActresses(String(p.actresses), null, p.maker ?? null) ?? '') : '' };
    const pid = String(p.product_id);
    const medal = rank === 1 ? 'bg-amber-400 text-white' : rank === 2 ? 'bg-slate-400 text-white' : rank === 3 ? 'bg-orange-400 text-white' : 'bg-slate-100 text-slate-500 dark:bg-slate-800';
    return `<a class="flex gap-3 py-3 border-b border-slate-100 dark:border-slate-800" href="/product/${encodeURIComponent(pid)}">`
        + `<span class="shrink-0 w-7 h-7 rounded-full ${medal} text-xs font-black flex items-center justify-center">${rank}</span>`
        + `<div class="shrink-0 w-20 aspect-[3/4] overflow-hidden rounded-lg bg-slate-200 dark:bg-slate-700">`
        + (img ? `<img class="w-full h-full object-cover object-right" src="${esc(img)}" alt="${esc(p.title)}" loading="lazy"/>` : '')
        + `</div><div class="flex-1 min-w-0">`
        + `<p class="text-[13px] font-bold leading-snug line-clamp-2">${esc(p.title)}</p>`
        + (p.actresses ? `<p class="text-[11px] text-slate-500 truncate mt-0.5">${esc(p.actresses)}${p.maker ? ` ／ ${esc(p.maker)}` : ''}</p>` : (p.maker ? `<p class="text-[11px] text-slate-500 truncate mt-0.5">${esc(p.maker)}</p>` : ''))
        + (p.note ? `<p class="text-[11px] text-emerald-700 dark:text-emerald-400 font-bold mt-1 leading-snug">${esc(p.note)}</p>` : '')
        + cardMetaHtml(p)
        + `</div></a>`;
}

function otherFeatures(all: Feature[], current: string): string {
    const links = all.filter(f => f.slug !== current).map(f =>
        `<a href="/feature/${encodeURIComponent(f.slug)}" class="inline-flex rounded-full border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium hover:border-primary hover:text-primary transition-colors">${esc(f.title)}</a>`);
    return `<section class="px-4 pt-6 pb-4"><h2 class="text-sm font-bold mb-2">ほかの特集</h2><div class="flex flex-wrap gap-2">${links.join('')}</div></section>`;
}

/**
 * products.html 上部の絞り込み（新作/予約・FANZA/MGS・並び順・詳細検索）を外す。
 * 一覧ページ用の操作で、特集ページでは押しても何も起きない。<main> 直後の最初の <div> がそれ。
 */
function dropListControls(html: string): string {
    const m = html.match(/<main[^>]*>\s*(<div class="flex flex-col gap-3 py-3">)/);
    if (!m || m.index === undefined) return html;
    const start = m.index + m[0].length - m[1].length;
    let depth = 1, i = start + m[1].length;
    while (i < html.length && depth > 0) {
        const o = html.indexOf('<div', i), c = html.indexOf('</div>', i);
        if (c === -1) return html;
        if (o !== -1 && o < c) { depth++; i = o + 4; } else { depth--; i = c + 6; }
    }
    return html.slice(0, start) + html.slice(i);
}

async function frame(req: NextRequest, headHtml: string, title: string): Promise<string> {
    let html = dropListControls(await readHtml(req.url, '/design/products.html'));
    html = injectMobileLayout(html, '', { skipHeader: true });
    html = html.replace(/<h1([^>]*)>作品一覧<\/h1>/, (_m, attrs) => `<div${attrs}>${esc(title)}</div>`);
    return html.replace(/<title>[\s\S]*?<\/title>/, '').replace('</head>', headHtml + '\n</head>');
}

function respond(html: string, status = 200): NextResponse {
    return new NextResponse(html, {
        status,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, s-maxage=21600, max-age=300, stale-while-revalidate=86400',
            'CDN-Cache-Control': 'public, s-maxage=21600',
        },
    });
}

export async function renderFeature(req: NextRequest, slug: string): Promise<NextResponse> {
    const edge = await edgeLookup(req.url, 'feat');
    if (edge.hit) return edge.hit as NextResponse;
    const data = await loadFeatures();
    const f = data?.features.find(x => x.slug === slug);
    if (!data || !f) return new NextResponse('Not found', { status: 404 });

    const path = `/feature/${encodeURIComponent(slug)}`;
    const itemList = {
        '@context': 'https://schema.org', '@type': 'ItemList', name: f.h1,
        itemListElement: f.items.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${BASE}/product/${encodeURIComponent(String(p.product_id))}`, name: p.title })),
    };
    let html = await frame(req, head(f.title, f.description, path, f.title, [itemList]), f.title);
    const updated = data.generatedAt.slice(0, 10).replace(/-/g, '/');
    const heading = `<section class="px-4 pt-3 pb-2">`
        + `<nav class="text-[11px] text-slate-400 mb-1"><a href="/" class="hover:text-primary">ホーム</a> › <a href="/features" class="hover:text-primary">特集</a> › <span>${esc(f.title)}</span></nav>`
        + `<h1 class="text-lg font-bold leading-tight">${esc(f.h1)}</h1>`
        + `<p class="text-[11px] text-slate-400 mt-1">更新日：${updated}・${f.items.length}作品</p>`
        + `<p class="mt-2 text-[13px] text-slate-600 dark:text-slate-300 leading-relaxed">${f.intro}</p>`
        + `</section>`;
    html = html.replace(/<div[^>]*id="products-grid"[^>]*>/, m => heading + m);
    html = replaceGridInner(html, `<div class="col-span-3 px-4">${f.items.map((p, i) => itemRow(p, i + 1)).join('')}</div>`);
    html = html.replace('<footer id="site-footer"', otherFeatures(data.features, slug) + '<footer id="site-footer"');
    html = setXFollow(html, xGenreOfFeature(slug));
    const resp = respond(html);
    await edgeStore(edge, resp);
    return resp;
}

export async function renderFeatureHub(req: NextRequest): Promise<NextResponse> {
    const edge = await edgeLookup(req.url, 'feat');
    if (edge.hit) return edge.hit as NextResponse;
    const data = await loadFeatures();
    const features = data?.features ?? [];
    const title = 'AV作品の特集一覧';
    let html = await frame(req, head(title, 'セール中の高評価作品、FANZAとMGSの価格差、ジャンル別の新作人気ランキングなど、切り口別のAV作品特集の一覧です。毎日更新しています。', '/features', title), title);
    const heading = `<section class="px-4 pt-3 pb-2">`
        + `<nav class="text-[11px] text-slate-400 mb-1"><a href="/" class="hover:text-primary">ホーム</a> › <span>特集</span></nav>`
        + `<h1 class="text-lg font-bold leading-tight">${esc(title)}</h1>`
        + `<p class="mt-1 text-[13px] text-slate-600 dark:text-slate-300 leading-relaxed">セール・価格比較・ジャンル別の新作など、目的別に作品をまとめた特集です。どれも毎日のデータ更新にあわせて入れ替わります。</p>`
        + `</section>`;
    html = html.replace(/<div[^>]*id="products-grid"[^>]*>/, m => heading + m);
    const cards = features.map(f => {
        const img = poster(String(f.items[0]?.main_image_url || ''));
        return `<a href="/feature/${encodeURIComponent(f.slug)}" class="flex gap-3 py-3 border-b border-slate-100 dark:border-slate-800">`
            + `<div class="shrink-0 w-16 aspect-[3/4] overflow-hidden rounded-lg bg-slate-200">${img ? `<img class="w-full h-full object-cover object-right" src="${esc(img)}" alt="" loading="lazy"/>` : ''}</div>`
            + `<div class="flex-1 min-w-0"><p class="text-sm font-bold leading-snug">${esc(f.title)}</p>`
            + `<p class="text-[11px] text-slate-500 mt-1 line-clamp-2">${esc(f.description)}</p>`
            + `<p class="text-[11px] text-primary mt-1">${f.items.length}作品 ›</p></div></a>`;
    }).join('');
    html = replaceGridInner(html, `<div class="col-span-3 px-4 pb-24">${cards}</div>`);
    const resp = respond(html);
    await edgeStore(edge, resp);
    return resp;
}
