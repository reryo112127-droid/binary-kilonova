import { NextRequest, NextResponse } from 'next/server';
import { getMgsClient, getFanzaClient } from '../../../lib/turso';
import { readStaticCacheAsync as readStaticCache, cacheHeaders } from '../../../lib/staticCache';

export const dynamic = 'force-dynamic';

function poster(url: string | null): string {
    if (!url) return '';
    if (url.includes('pb_e_')) return url.replace('pb_e_', 'pf_e_');
    if (url.includes('/digital/amateur/') && url.endsWith('jm.jpg')) return url.replace('jm.jpg', 'jp-001.jpg');
    return url;
}

export async function GET(_request: NextRequest) {
    // 静的キャッシュ優先
    const cached = await readStaticCache<unknown[]>('makers_cache.json');
    if (cached && cached.length > 0) {
        return NextResponse.json(cached, {
            headers: { 'Content-Type': 'application/json', ...cacheHeaders(3600, 600) },
        });
    }

    // Tursoフォールバック
    const mgsClient = await getMgsClient();
    const fanzaClient = await getFanzaClient();

    const [mgsRows, fanzaRows] = await Promise.all([
        mgsClient ? mgsClient.execute({
            sql: `SELECT maker, COUNT(*) as cnt, MAX(main_image_url) as sample_image
                  FROM products
                  WHERE maker IS NOT NULL AND LENGTH(TRIM(maker)) > 1
                    AND (duration_min IS NULL OR duration_min < 600)
                  GROUP BY maker HAVING cnt >= 3
                  ORDER BY cnt DESC LIMIT 300`,
            args: [],
        }).then(r => r.rows).catch(() => []) : [],
        fanzaClient ? fanzaClient.execute({
            sql: `SELECT maker, COUNT(*) as cnt, MAX(main_image_url) as sample_image
                  FROM products
                  WHERE maker IS NOT NULL AND LENGTH(TRIM(maker)) > 1
                  GROUP BY maker HAVING cnt >= 3
                  ORDER BY cnt DESC LIMIT 300`,
            args: [],
        }).then(r => r.rows).catch(() => []) : [],
    ]);

    // 両DBをマージ（同名メーカーは件数合算）
    const map = new Map<string, { name: string; count: number; sample_image: string; sources: string[] }>();

    for (const row of mgsRows) {
        const name = String(row.maker ?? '').trim();
        if (!name) continue;
        const existing = map.get(name);
        if (existing) { existing.count += Number(row.cnt ?? 0); }
        else map.set(name, { name, count: Number(row.cnt ?? 0), sample_image: poster(String(row.sample_image ?? '')), sources: ['mgs'] });
    }
    for (const row of fanzaRows) {
        const name = String(row.maker ?? '').trim();
        if (!name) continue;
        const existing = map.get(name);
        if (existing) { existing.count += Number(row.cnt ?? 0); existing.sources.push('fanza'); }
        else map.set(name, { name, count: Number(row.cnt ?? 0), sample_image: poster(String(row.sample_image ?? '')), sources: ['fanza'] });
    }

    const result = Array.from(map.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 300);

    return NextResponse.json(result, {
        headers: { 'Content-Type': 'application/json', ...cacheHeaders(1800, 300) },
    });
}
