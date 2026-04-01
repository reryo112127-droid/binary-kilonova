import { NextRequest, NextResponse } from 'next/server';
import { getSiteClient, getFanzaClient } from '../../../../lib/turso';
import { initSiteSchema } from '../../../../lib/siteDb';

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

    const fanzaClient = getFanzaClient();
    const profileMap = new Map<string, string>();

    if (fanzaClient && names.length > 0) {
        try {
            const placeholders = names.map(() => '?').join(',');
            const imgRes = await fanzaClient.execute({
                sql: `SELECT name, image_url FROM actress_profiles WHERE name IN (${placeholders}) AND image_url IS NOT NULL`,
                args: names,
            });
            for (const row of imgRes.rows) {
                if (row.image_url) profileMap.set(String(row.name), String(row.image_url));
            }
        } catch { /* ignore */ }
    }

    const result = names.map(name => ({
        name,
        image_url: profileMap.get(name) || null,
    }));

    return NextResponse.json(result);
}
