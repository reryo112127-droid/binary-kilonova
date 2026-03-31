import { NextRequest, NextResponse } from 'next/server';
import { getMyContributions } from '../../../../lib/siteDb';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const sessionId = request.headers.get('x-session-id') || '';
    if (!sessionId) return NextResponse.json({ count: 0, badge: null, recent: [] });

    const data = await getMyContributions(sessionId);
    return NextResponse.json(data);
}
