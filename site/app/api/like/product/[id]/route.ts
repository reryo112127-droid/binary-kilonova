import { NextRequest, NextResponse } from 'next/server';
import { getSiteClient } from '../../../../../lib/turso';
import { initSiteSchema, hasProductLike } from '../../../../../lib/siteDb';

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const sessionId = req.headers.get('x-session-id') || '';
    const db = getSiteClient();

    if (!db) return NextResponse.json({ count: 0, liked: false });

    await initSiteSchema();
    const [countRes, liked] = await Promise.all([
        db.execute({ sql: 'SELECT COUNT(*) as cnt FROM product_likes WHERE product_id = ?', args: [id] }),
        sessionId ? hasProductLike(id, sessionId) : Promise.resolve(false),
    ]);

    return NextResponse.json({
        count: Number(countRes.rows[0]?.cnt ?? 0),
        liked,
    });
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const sessionId = req.headers.get('x-session-id') || '';
    if (!sessionId) return NextResponse.json({ error: 'session required' }, { status: 400 });

    const db = getSiteClient();
    if (!db) return NextResponse.json({ error: 'DB unavailable' }, { status: 503 });

    await initSiteSchema();
    const already = await hasProductLike(id, sessionId);

    if (already) {
        // トグル：いいね取り消し
        await db.execute({
            sql: 'DELETE FROM product_likes WHERE product_id = ? AND session_id = ?',
            args: [id, sessionId],
        });
    } else {
        // いいね追加
        await db.execute({
            sql: 'INSERT OR IGNORE INTO product_likes(product_id, session_id) VALUES(?,?)',
            args: [id, sessionId],
        });
    }

    const countRes = await db.execute({
        sql: 'SELECT COUNT(*) as cnt FROM product_likes WHERE product_id = ?',
        args: [id],
    });

    return NextResponse.json({
        count: Number(countRes.rows[0]?.cnt ?? 0),
        liked: !already,
    });
}
