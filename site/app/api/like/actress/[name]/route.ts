import { NextRequest, NextResponse } from 'next/server';
import { getSiteClient } from '../../../../../lib/turso';
import { initSiteSchema, hasActressLike } from '../../../../../lib/siteDb';

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ name: string }> }
) {
    const { name } = await params;
    const actressName = decodeURIComponent(name);
    const sessionId = req.headers.get('x-session-id') || '';
    const db = getSiteClient();

    if (!db) return NextResponse.json({ count: 0, liked: false });

    await initSiteSchema();
    const [countRes, liked] = await Promise.all([
        db.execute({ sql: 'SELECT COUNT(*) as cnt FROM actress_likes WHERE actress_name = ?', args: [actressName] }),
        sessionId ? hasActressLike(actressName, sessionId) : Promise.resolve(false),
    ]);

    return NextResponse.json({
        count: Number(countRes.rows[0]?.cnt ?? 0),
        liked,
    });
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ name: string }> }
) {
    const { name } = await params;
    const actressName = decodeURIComponent(name);
    const sessionId = req.headers.get('x-session-id') || '';
    if (!sessionId) return NextResponse.json({ error: 'session required' }, { status: 400 });

    const db = getSiteClient();
    if (!db) return NextResponse.json({ error: 'DB unavailable' }, { status: 503 });

    await initSiteSchema();
    const already = await hasActressLike(actressName, sessionId);

    if (already) {
        await db.execute({
            sql: 'DELETE FROM actress_likes WHERE actress_name = ? AND session_id = ?',
            args: [actressName, sessionId],
        });
    } else {
        await db.execute({
            sql: 'INSERT OR IGNORE INTO actress_likes(actress_name, session_id) VALUES(?,?)',
            args: [actressName, sessionId],
        });
    }

    const countRes = await db.execute({
        sql: 'SELECT COUNT(*) as cnt FROM actress_likes WHERE actress_name = ?',
        args: [actressName],
    });

    return NextResponse.json({
        count: Number(countRes.rows[0]?.cnt ?? 0),
        liked: !already,
    });
}
