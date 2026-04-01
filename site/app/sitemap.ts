import { MetadataRoute } from 'next';
import { getMgsClient, getFanzaClient } from '../lib/turso';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://lunar-zodiac.vercel.app';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    // Static pages
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

    // Actress pages from DB (profile画像がある女優 = 実在確認済み)
    let actressPages: MetadataRoute.Sitemap = [];
    try {
        const fanzaClient = getFanzaClient();
        if (fanzaClient) {
            const result = await fanzaClient.execute(
                'SELECT name FROM actress_profiles WHERE image_url IS NOT NULL ORDER BY name LIMIT 5000'
            );
            actressPages = result.rows.map((row: Record<string, unknown>) => ({
                url: `${BASE_URL}/actress/${encodeURIComponent(String(row.name))}`,
                changeFrequency: 'weekly' as const,
                priority: 0.7,
            }));
        }
    } catch { /* DB not available at build time */ }

    // 商品ページ: MGS人気順 + FANZA新着順 で重複排除
    let productPages: MetadataRoute.Sitemap = [];
    try {
        const seen = new Set<string>();

        const mgsClient = getMgsClient();
        if (mgsClient) {
            // MGS: wish_count上位5000件（duration_min=1はデータ不備のため除外）
            const result = await mgsClient.execute(
                'SELECT product_id FROM products WHERE (duration_min IS NULL OR duration_min != 1) ORDER BY wish_count DESC LIMIT 5000'
            );
            for (const row of result.rows) {
                const pid = String(row.product_id);
                if (!seen.has(pid)) {
                    seen.add(pid);
                    productPages.push({
                        url: `${BASE_URL}/product/${encodeURIComponent(pid)}`,
                        changeFrequency: 'monthly',
                        priority: 0.65,
                    });
                }
            }
        }

        const fanzaClient = getFanzaClient();
        if (fanzaClient) {
            // FANZA: 最新5000件 — 品番検索流入が見込める新作を優先
            const result = await fanzaClient.execute(
                'SELECT product_id FROM products ORDER BY sale_start_date DESC LIMIT 5000'
            );
            for (const row of result.rows) {
                const pid = String(row.product_id);
                if (!seen.has(pid)) {
                    seen.add(pid);
                    productPages.push({
                        url: `${BASE_URL}/product/${encodeURIComponent(pid)}`,
                        changeFrequency: 'monthly',
                        priority: 0.6,
                    });
                }
            }
        }
    } catch { /* DB not available at build time */ }

    return [...staticPages, ...actressPages, ...productPages];
}
