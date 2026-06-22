import { NextRequest, NextResponse } from 'next/server';
import { readStaticCacheAsync as readStaticCache } from '../../lib/staticCache';

// サイトマップ「インデックス」。子サイトマップ(/sitemaps/<type>/<page>.xml)を列挙する。
// 全作品~40万＋全出演女優~3.3万URLを、1ファイル5万URL/25MiBの上限内に収めるためチャンク分割する。
// 本文は ASSETS の sitemap_cache.json(IDのみ)から構築し、クロール時もD1を叩かない。

export const dynamic = 'force-dynamic';

const BASE = process.env.NEXT_PUBLIC_SITE_URL || 'https://avrankings.com';
const CHUNK = 45000; // 1子サイトマップあたりのURL数(<50,000)

export async function GET(_req: NextRequest) {
    const cache = await readStaticCache<{ actresses: string[]; products: string[] }>('sitemap_cache.json');
    const nProducts = cache?.products?.length ?? 0;
    const nActresses = cache?.actresses?.length ?? 0;
    const lastmod = new Date().toISOString();

    const children: string[] = [`${BASE}/sitemaps/static/0.xml`, `${BASE}/sitemaps/landing/0.xml`];
    for (let i = 0; i * CHUNK < nProducts; i++) children.push(`${BASE}/sitemaps/products/${i}.xml`);
    for (let i = 0; i * CHUNK < nActresses; i++) children.push(`${BASE}/sitemaps/actresses/${i}.xml`);

    const body = `<?xml version="1.0" encoding="UTF-8"?>\n`
        + `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
        + children.map(loc => `  <sitemap><loc>${loc}</loc><lastmod>${lastmod}</lastmod></sitemap>`).join('\n')
        + `\n</sitemapindex>`;

    return new NextResponse(body, {
        headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, s-maxage=86400, max-age=3600',
            'CDN-Cache-Control': 'public, s-maxage=86400',
        },
    });
}
