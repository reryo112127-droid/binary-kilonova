import { NextRequest, NextResponse } from 'next/server';
import { getMgsClient } from '../../../lib/turso';

export const dynamic = 'force-dynamic';

/**
 * MGS サンプル動画MP4 URLをDBから返す
 * URLはscripts/prefetch_mgs_mp4_urls.jsで事前取得済み
 */
export async function GET(request: NextRequest) {
    const url = request.nextUrl.searchParams.get('url');
    if (!url) {
        return NextResponse.json({ error: 'url required' }, { status: 400 });
    }

    // DBから直接mp4 URLを取得
    const client = getMgsClient();
    if (!client) {
        return NextResponse.json({ error: 'db unavailable' }, { status: 503 });
    }

    try {
        const result = await client.execute({
            sql: 'SELECT sample_mp4_url FROM products WHERE sample_video_url = ? LIMIT 1',
            args: [url],
        });

        const row = result.rows[0];
        const mp4 = row ? (row[0] as string | null) : null;

        if (!mp4) {
            return NextResponse.json({ error: 'no video' }, { status: 404 });
        }

        return NextResponse.json({ mp4 });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'unknown';
        return NextResponse.json({ error: msg }, { status: 502 });
    }
}
