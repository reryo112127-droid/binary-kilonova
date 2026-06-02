import { NextRequest, NextResponse } from 'next/server';
import { postNextForGenre, getQueueStatus, GENRE_ACCOUNT_MAP } from '../../../../../lib/xPost';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function checkAdmin(req: NextRequest): boolean {
    return req.headers.get('x-admin-key') === process.env.ADMIN_KEY;
}

// GET: キュー状況を返す
export async function GET(request: NextRequest) {
    if (!checkAdmin(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const status = await getQueueStatus();
    return NextResponse.json(status);
}

// POST: 指定ジャンル（または全ジャンル）に1件投稿
export async function POST(request: NextRequest) {
    if (!checkAdmin(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const genre: string | undefined = body?.genre;

    if (genre) {
        const result = await postNextForGenre(genre);
        return NextResponse.json(result);
    }

    // 全ジャンル一括
    const results: Record<string, unknown> = {};
    for (const g of Object.keys(GENRE_ACCOUNT_MAP)) {
        results[g] = await postNextForGenre(g);
    }
    return NextResponse.json(results);
}
