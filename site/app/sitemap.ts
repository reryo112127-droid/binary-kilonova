import { MetadataRoute } from 'next';
import { readStaticCacheAsync as readStaticCache } from '../lib/staticCache';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://avrankings.com';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    const staticPages: MetadataRoute.Sitemap = [
        { url: BASE_URL,                            changeFrequency: 'daily',   priority: 1.0 },
        { url: `${BASE_URL}/ranking`,               changeFrequency: 'daily',   priority: 0.9 },
        { url: `${BASE_URL}/ranking/actress`,       changeFrequency: 'daily',   priority: 0.9 },
        { url: `${BASE_URL}/ranking/2026`,          changeFrequency: 'weekly',  priority: 0.8 },
        { url: `${BASE_URL}/new`,                   changeFrequency: 'daily',   priority: 0.8 },
        { url: `${BASE_URL}/pre-order`,             changeFrequency: 'daily',   priority: 0.8 },
        { url: `${BASE_URL}/search`,                changeFrequency: 'weekly',  priority: 0.7 },
        { url: `${BASE_URL}/search/advanced`,       changeFrequency: 'monthly', priority: 0.5 },
        { url: `${BASE_URL}/video`,                 changeFrequency: 'weekly',  priority: 0.6 },
    ];

    // サイトマップキャッシュをASSETSから読む（Turso直接クエリ廃止・15,000行削減）
    let actressPages: MetadataRoute.Sitemap = [];
    let productPages: MetadataRoute.Sitemap = [];
    try {
        const cache = await readStaticCache<{ actresses: string[]; products: string[] }>('sitemap_cache.json');
        if (cache) {
            actressPages = (cache.actresses ?? []).map(name => ({
                url: `${BASE_URL}/actress/${encodeURIComponent(name)}`,
                changeFrequency: 'weekly' as const,
                priority: 0.7,
            }));
            productPages = (cache.products ?? []).map((pid, i) => ({
                url: `${BASE_URL}/product/${encodeURIComponent(pid)}`,
                changeFrequency: 'monthly' as const,
                priority: i < 5000 ? 0.65 : 0.6,
            }));
        }
    } catch { /* キャッシュ未生成時はスタティックページのみ */ }

    return [...staticPages, ...actressPages, ...productPages];
}
