import { NextRequest, NextResponse } from 'next/server';
import { getSiteClient, getMgsClient, getFanzaClient } from '../../../../lib/turso';
import { initSiteSchema } from '../../../../lib/siteDb';
import { filterActresses } from '../../../../lib/actressFilter';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId') || '';
    if (!sessionId) return NextResponse.json([]);

    const siteDb = getSiteClient();
    if (!siteDb) return NextResponse.json([]);

    await initSiteSchema();

    const likesRes = await siteDb.execute({
        sql: 'SELECT product_id FROM product_likes WHERE session_id = ? ORDER BY id DESC LIMIT 60',
        args: [sessionId],
    });

    const productIds = likesRes.rows.map(r => String(r.product_id));
    if (productIds.length === 0) return NextResponse.json([]);

    const mgsClient = getMgsClient();
    const fanzaClient = getFanzaClient();

    const placeholders = productIds.map(() => '?').join(',');

    async function fetchFromDb(client: ReturnType<typeof getMgsClient>, isMgs: boolean) {
        if (!client) return [];
        try {
            const res = await client.execute({
                sql: `SELECT product_id, title, actresses, main_image_url,
                     ${isMgs ? 'wish_count' : '0 AS wish_count'}, genres, maker
                     FROM products WHERE product_id IN (${placeholders})`,
                args: productIds,
            });
            return res.rows.map(row => ({
                ...row,
                actresses: filterActresses(
                    (row.actresses as string | null) || null,
                    (row.genres as string | null) || null,
                    (row.maker as string | null) || null
                ),
                source: isMgs ? 'mgs' : 'fanza',
            }));
        } catch { return []; }
    }

    const [mgsResults, fanzaResults] = await Promise.all([
        fetchFromDb(mgsClient, true),
        fetchFromDb(fanzaClient, false),
    ]);

    const productMap = new Map<string, Record<string, unknown>>();
    [...mgsResults, ...fanzaResults].forEach(p => {
        const row = p as Record<string, unknown>;
        const id = String(row.product_id);
        if (!productMap.has(id)) productMap.set(id, row);
    });

    const ordered = productIds
        .map(id => productMap.get(id))
        .filter(Boolean) as Record<string, unknown>[];

    return NextResponse.json(ordered);
}
