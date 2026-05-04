import { NextRequest, NextResponse } from 'next/server';
import { getSiteClient } from '../../../../lib/turso';
import { initSiteSchema } from '../../../../lib/siteDb';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
    const body = await request.json().catch(() => null);
    if (!body?.actress_name) {
        return NextResponse.json({ error: 'actress_name は必須です' }, { status: 400 });
    }

    const actressName = String(body.actress_name).trim();
    const twitterUsername = body.twitter_username ? String(body.twitter_username).trim() : null;
    const instagramUsername = body.instagram_username ? String(body.instagram_username).trim() : null;

    if (!twitterUsername && !instagramUsername) {
        return NextResponse.json(
            { error: 'twitter_username か instagram_username のどちらかは必須です' },
            { status: 400 }
        );
    }

    const sessionId = request.headers.get('x-session-id') || '';

    const db = getSiteClient();
    if (!db) {
        return NextResponse.json({ error: 'DB接続エラー' }, { status: 503 });
    }

    await initSiteSchema();

    await db.execute({
        sql: `INSERT INTO sns_submissions (actress_name, twitter_username, instagram_username, session_id)
              VALUES (?, ?, ?, ?)`,
        args: [actressName, twitterUsername, instagramUsername, sessionId],
    });

    return NextResponse.json({ ok: true });
}
