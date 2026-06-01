import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const SAMPLE_API = 'https://www.mgstage.com/sampleplayer/sampleRespons.php?pid=';

function extractUuid(url: string): string | null {
    const m = url.match(/sampleplayer\.html\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
}

function convertIsmToMp4(url: string): string {
    // .ism/request?... → .mp4
    const mp4 = url.replace(/\.ism\/request.*$/, '.mp4');
    // http://dl. → https://sample.
    return mp4.replace(/^http:\/\/dl\./, 'https://sample.');
}

export async function GET(request: NextRequest) {
    const url = request.nextUrl.searchParams.get('url');
    if (!url) {
        return NextResponse.json({ error: 'url required' }, { status: 400 });
    }

    // すでにMP4直URLの場合はそのまま返す（phase2_5適用済み旧作品）
    if (url.includes('sample.mgstage.com') && url.endsWith('.mp4')) {
        const proxyUrl = `/api/mgs-video/proxy?mp4=${encodeURIComponent(url)}`;
        return NextResponse.json({ mp4: proxyUrl });
    }

    // sampleplayer.html/{UUID} からUUIDを抽出してsampleRespons.phpに問い合わせ
    const uuid = extractUuid(url);
    if (!uuid) {
        return NextResponse.json({ error: 'invalid url' }, { status: 400 });
    }

    try {
        const res = await fetch(SAMPLE_API + uuid, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.mgstage.com/',
                'Cookie': 'adc=1',
            },
            signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
            return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502 });
        }

        const json = await res.json() as { url?: string; error?: string };
        if (!json.url) {
            return NextResponse.json({ error: 'no url in response' }, { status: 404 });
        }

        const mp4Direct = convertIsmToMp4(json.url);
        // プロキシ経由で返す（CORS/Referer制限を回避）
        const proxyUrl = `/api/mgs-video/proxy?mp4=${encodeURIComponent(mp4Direct)}`;
        return NextResponse.json({ mp4: proxyUrl });

    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'unknown';
        return NextResponse.json({ error: msg }, { status: 502 });
    }
}
