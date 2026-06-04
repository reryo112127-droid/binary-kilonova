import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ALLOWED_HOSTS = [
    'cc3001.dmm.com',
    'pics.dmm.co.jp',
    'ec.dmm.com',
    'p.dmm.co.jp',
    'image.mgstage.com',
    'img.mgstage.com',
];

export async function GET(request: NextRequest) {
    const key = request.nextUrl.searchParams.get('key');
    if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
        return new NextResponse(null, { status: 401 });
    }

    const url = request.nextUrl.searchParams.get('url');
    if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 });

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return NextResponse.json({ error: 'invalid url' }, { status: 400 });
    }

    if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
        return NextResponse.json({ error: 'disallowed host' }, { status: 400 });
    }

    const referer = parsed.hostname.includes('mgstage')
        ? 'https://www.mgstage.com/'
        : 'https://www.dmm.co.jp/';

    try {
        const upstream = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': referer,
            },
            signal: AbortSignal.timeout(10_000),
        });

        if (!upstream.ok) {
            return NextResponse.json({ error: `upstream ${upstream.status}` }, { status: 502 });
        }

        const contentType = upstream.headers.get('content-type') || 'image/jpeg';

        return new NextResponse(upstream.body, {
            status: 200,
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=86400',
            },
        });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'unknown';
        return NextResponse.json({ error: msg }, { status: 502 });
    }
}
