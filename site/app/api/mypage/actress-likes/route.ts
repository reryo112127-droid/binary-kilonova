import { NextRequest, NextResponse } from 'next/server';
import { getSiteClient } from '../../../../lib/turso';
import { initSiteSchema } from '../../../../lib/siteDb';
import { readStaticCacheAsync as readStaticCache } from '../../../../lib/staticCache';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId') || '';
    if (!sessionId) return NextResponse.json([]);

    const siteDb = getSiteClient();
    if (!siteDb) return NextResponse.json([]);

    await initSiteSchema();

    const likesRes = await siteDb.execute({
        sql: 'SELECT actress_name FROM actress_likes WHERE session_id = ? ORDER BY id DESC LIMIT 40',
        args: [sessionId],
    });

    const names = likesRes.rows.map(r => String(r.actress_name));
    if (names.length === 0) return NextResponse.json([]);

    // actress_profiles はASSETSの静的JSONから取得（Tursoクエリ廃止）
    const profileMap = new Map<string, string>();
    try {
        const profiles = await readStaticCache<Record<string, { image_url?: string }>>('actress_profiles.json');
        if (profiles) {
            for (const name of names) {
                const img = profiles[name]?.image_url;
                if (img) profileMap.set(name, img);
            }
        }
    } catch { /* ignore */ }

    const result = names.map(name => ({
        name,
        image_url: profileMap.get(name) || null,
    }));

    return NextResponse.json(result);
}
