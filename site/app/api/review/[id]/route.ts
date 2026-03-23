import { NextRequest, NextResponse } from 'next/server';
import { getSiteClient } from '../../../../lib/turso';
import { initSiteSchema, getProductReviews } from '../../../../lib/siteDb';

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const db = getSiteClient();
    if (!db) return NextResponse.json([]);

    const reviews = await getProductReviews(id);
    return NextResponse.json(reviews);
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const sessionId = req.headers.get('x-session-id') || '';
    if (!sessionId) return NextResponse.json({ error: 'session required' }, { status: 400 });

    let body: { stars?: number; title?: string; comment?: string };
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }); }

    const stars = Number(body.stars);
    if (!stars || stars < 1 || stars > 5) {
        return NextResponse.json({ error: 'stars must be 1-5' }, { status: 400 });
    }

    const db = getSiteClient();
    if (!db) return NextResponse.json({ error: 'DB unavailable' }, { status: 503 });

    await initSiteSchema();

    // 1セッション1レビュー（上書き可）
    await db.execute({
        sql: `INSERT INTO product_reviews(product_id, session_id, stars, title, comment)
              VALUES(?,?,?,?,?)
              ON CONFLICT(product_id, session_id)
              DO UPDATE SET stars=excluded.stars, title=excluded.title, comment=excluded.comment, created_at=datetime('now')`,
        args: [id, sessionId, stars, body.title || null, body.comment || null],
    });

    // 集計を返す
    const statsRes = await db.execute({
        sql: 'SELECT AVG(CAST(stars AS REAL)) as avg, COUNT(*) as cnt FROM product_reviews WHERE product_id = ?',
        args: [id],
    });
    const avg = Number(statsRes.rows[0]?.avg ?? 0);
    const cnt = Number(statsRes.rows[0]?.cnt ?? 0);

    return NextResponse.json({ ok: true, avg: Math.round(avg * 10) / 10, count: cnt });
}
