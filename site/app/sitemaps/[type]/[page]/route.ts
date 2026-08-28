import { NextRequest, NextResponse } from 'next/server';
import { readStaticCacheAsync as readStaticCache } from '../../../../lib/staticCache';
import { loadGenres, loadMakers, loadSeries, CUPS } from '../../../../lib/lpData';
import { edgeLookup, edgeStore } from '../../../../lib/edgeCache';

// 子サイトマップ。/sitemaps/<type>/<page>.xml で 1ページ最大 CHUNK 件の <url> を返す。
// type = static | products | actresses。products/actresses は ASSETS の sitemap_cache.json を slice。

export const dynamic = 'force-dynamic';

const BASE = process.env.NEXT_PUBLIC_SITE_URL || 'https://avrankings.com';
const CHUNK = 10000; // app/sitemap.xml/route.ts の CHUNK と必ず同じ値にすること

// 静的(ハブ)ページ。ホーム/ランキング/一覧/検索など。
const STATIC_PATHS: { path: string; changefreq: string; priority: string }[] = [
    { path: '/', changefreq: 'daily', priority: '1.0' },
    { path: '/ranking', changefreq: 'daily', priority: '0.9' },
    { path: '/ranking/actress', changefreq: 'daily', priority: '0.9' },
    { path: '/ranking/2026', changefreq: 'weekly', priority: '0.8' },
    { path: '/new', changefreq: 'daily', priority: '0.8' },
    { path: '/pre-order', changefreq: 'daily', priority: '0.8' },
    { path: '/sale', changefreq: 'daily', priority: '0.8' },
    { path: '/search', changefreq: 'weekly', priority: '0.7' },
    { path: '/search/advanced', changefreq: 'monthly', priority: '0.5' },
    { path: '/video', changefreq: 'weekly', priority: '0.6' },
    { path: '/makers', changefreq: 'weekly', priority: '0.6' },
    { path: '/genres', changefreq: 'weekly', priority: '0.7' },
    { path: '/series', changefreq: 'weekly', priority: '0.6' },
    { path: '/cup', changefreq: 'weekly', priority: '0.6' },
];

type Url = { loc: string; changefreq: string; priority: string; lastmod?: string };

function buildUrlset(urls: Url[]): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n`
        + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
        + urls.map(u => `  <url><loc>${u.loc}</loc>`
            + (u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : '')
            + `<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n')
        + `\n</urlset>`;
}

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ type: string; page: string }> },
) {
    const { type, page: pageRaw } = await params;
    const page = parseInt(pageRaw, 10) || 0; // "0.xml" → 0

    // 重いXML生成(products/0.xml=5.3MB)をエッジキャッシュし、Googlebotの取得を Worker非生成で返す=負荷削減
    const edge = await edgeLookup(_req.url, `sm-${type}-${page}`);
    if (edge.hit) return edge.hit as NextResponse;

    let urls: Url[] = [];
    if (type === 'static') {
        urls = STATIC_PATHS.map(s => ({ loc: BASE + s.path, changefreq: s.changefreq, priority: s.priority }));
    } else if (type === 'landing') {
        // 長尾LP: ジャンル/メーカー/シリーズ/カップ(計~1000未満なので1チャンク)
        const [genres, makers, series] = await Promise.all([loadGenres(), loadMakers(), loadSeries()]);
        urls = [
            ...genres.map(g => ({ loc: `${BASE}/genre/${encodeURIComponent(g.name)}`, changefreq: 'weekly', priority: '0.7' })),
            ...makers.map(m => ({ loc: `${BASE}/maker/${encodeURIComponent(m.name)}`, changefreq: 'weekly', priority: '0.6' })),
            ...series.map(s => ({ loc: `${BASE}/series/${encodeURIComponent(s.name)}`, changefreq: 'weekly', priority: '0.5' })),
            ...CUPS.map(c => ({ loc: `${BASE}/cup/${c}`, changefreq: 'weekly', priority: '0.5' })),
        ].slice(page * CHUNK, (page + 1) * CHUNK);
    } else if (type === 'products' || type === 'actresses') {
        const cache = await readStaticCache<{ actresses?: string[]; products: string[] }>('sitemap_cache.json');
        if (type === 'products') {
            const all = cache?.products ?? [];
            const slice = all.slice(page * CHUNK, (page + 1) * CHUNK);
            // 発売日は別ファイル(sitemap_cache.products と同じ並び)。件数がずれていたら lastmod なしで出す。
            const lm = await readStaticCache<{ products: string[] }>('sitemap_lastmod.json');
            const dates = lm?.products?.length === all.length
                ? lm.products.slice(page * CHUNK, (page + 1) * CHUNK)
                : [];
            urls = slice.map((pid, i) => ({
                loc: `${BASE}/product/${encodeURIComponent(pid)}`,
                lastmod: dates[i] || undefined,
                changefreq: 'monthly',
                priority: '0.6',
            }));
        } else {
            // 女優名は別ファイル（商品ページのホットパスに2万件を載せないため）。
            // 旧デプロイとの互換で sitemap_cache.actresses にもフォールバックする。
            const ac = await readStaticCache<{ actresses: string[] }>('sitemap_actresses.json');
            const all = ac?.actresses ?? cache?.actresses ?? [];
            const slice = all.slice(page * CHUNK, (page + 1) * CHUNK);
            urls = slice.map(name => ({ loc: `${BASE}/actress/${encodeURIComponent(name)}`, changefreq: 'weekly', priority: '0.7' }));
        }
    } else {
        return new NextResponse('Not found', { status: 404 });
    }

    const resp = new NextResponse(buildUrlset(urls), {
        headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, s-maxage=86400, max-age=3600',
            'CDN-Cache-Control': 'public, s-maxage=86400',
        },
    });
    await edgeStore(edge, resp);
    return resp;
}
