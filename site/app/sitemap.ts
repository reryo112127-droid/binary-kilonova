import { MetadataRoute } from 'next';
import fs from 'fs';
import path from 'path';
import { getMgsClient, getFanzaClient } from '../lib/turso';

const BASE_URL = 'https://lunar-zodiac.vercel.app';
const DATA_DIR = path.join(process.cwd(), '..', 'data');

function loadJson(filename: string) {
    const p = path.join(DATA_DIR, filename);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    // Static pages
    const staticPages: MetadataRoute.Sitemap = [
        { url: BASE_URL, changeFrequency: 'daily', priority: 1.0 },
        { url: `${BASE_URL}/search`, changeFrequency: 'weekly', priority: 0.8 },
        { url: `${BASE_URL}/ranking`, changeFrequency: 'daily', priority: 0.9 },
        { url: `${BASE_URL}/video`, changeFrequency: 'weekly', priority: 0.7 },
    ];

    // Actress pages from known lists
    const actressNames: string[] = [];
    const fanzaProfiles: Record<string, any> = loadJson('actress_profiles.json') ?? {};
    const avwikiProfiles: Record<string, any> = loadJson('avwiki_profiles.json') ?? {};

    const allNames = new Set([
        ...Object.keys(fanzaProfiles).filter(n => !fanzaProfiles[n]?.not_found),
        ...Object.keys(avwikiProfiles).filter(n => !avwikiProfiles[n]?.not_found && !avwikiProfiles[n]?.error),
    ]);
    allNames.forEach(n => actressNames.push(n));

    const actressPages: MetadataRoute.Sitemap = actressNames.slice(0, 2000).map(name => ({
        url: `${BASE_URL}/actress/${encodeURIComponent(name)}`,
        changeFrequency: 'weekly' as const,
        priority: 0.7,
    }));

    // Top products by wish_count from DB
    let productPages: MetadataRoute.Sitemap = [];
    try {
        const mgsClient = getMgsClient();
        if (mgsClient) {
            const result = await mgsClient.execute(
                'SELECT product_id FROM products ORDER BY wish_count DESC LIMIT 500'
            );
            productPages = result.rows.map((row: any) => ({
                url: `${BASE_URL}/product/${encodeURIComponent(row.product_id as string)}`,
                changeFrequency: 'monthly' as const,
                priority: 0.6,
            }));
        }
        const fanzaClient = getFanzaClient();
        if (fanzaClient) {
            const result = await fanzaClient.execute(
                'SELECT product_id FROM products ORDER BY wish_count DESC LIMIT 500'
            );
            const fanzaProductPages: MetadataRoute.Sitemap = result.rows.map((row: any) => ({
                url: `${BASE_URL}/product/${encodeURIComponent(row.product_id as string)}`,
                changeFrequency: 'monthly' as const,
                priority: 0.6,
            }));
            productPages = [...productPages, ...fanzaProductPages];
        }
    } catch { /* DB not available at build time */ }

    return [...staticPages, ...actressPages, ...productPages];
}
