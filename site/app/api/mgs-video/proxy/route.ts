import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * MGS mp4 をプロキシして CORS/Referer 制限を回避する
 * /api/mgs-video/proxy?mp4=<encoded-url>
 */
export async function GET(request: NextRequest) {
    const mp4 = request.nextUrl.searchParams.get('mp4');
    if (!mp4 || !mp4.startsWith('https://sample.mgstage.com/')) {
        return NextResponse.json({ error: 'invalid url' }, { status: 400 });
    }

    try {
        const rangeHeader = request.headers.get('range') || '';
        const headers: Record<string, string> = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.mgstage.com/',
            'Cookie': 'adc=1',
        };
        if (rangeHeader) headers['Range'] = rangeHeader;

        const upstream = await fetch(mp4, {
            headers,
            signal: AbortSignal.timeout(30_000),
        });

        const resHeaders: Record<string, string> = {
            'Content-Type': upstream.headers.get('Content-Type') || 'video/mp4',
            'Cache-Control': 'private, max-age=600',
            'Accept-Ranges': 'bytes',
        };
        const cl = upstream.headers.get('Content-Length');
        if (cl) resHeaders['Content-Length'] = cl;
        const cr = upstream.headers.get('Content-Range');
        if (cr) resHeaders['Content-Range'] = cr;

        return new NextResponse(upstream.body, {
            status: upstream.status,
            headers: resHeaders,
        });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'unknown';
        return NextResponse.json({ error: msg }, { status: 502 });
    }
}
