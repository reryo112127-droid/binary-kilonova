import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * FANZA サンプル動画MP4 URLをDMMのhtml5_playerから取得する
 * sample_video_url (litevideo URL) から cid を抽出し、html5_playerを叩いてMP4 URLを返す
 */
export async function GET(request: NextRequest) {
    const url = request.nextUrl.searchParams.get('url');
    if (!url) {
        return NextResponse.json({ error: 'url required' }, { status: 400 });
    }

    // cid を litevideo URL から抽出
    // 例: https://www.dmm.co.jp/litevideo/-/part/=/cid=h_068mxgs225/size=720_480/...
    const cidMatch = url.match(/[?&/]cid=([^/&?]+)/);
    if (!cidMatch) {
        return NextResponse.json({ error: 'cid not found in url' }, { status: 400 });
    }
    const cid = cidMatch[1];

    // DMMのhtml5_playerページからMP4 URLを取得
    const playerUrl = `https://www.dmm.co.jp/service/digitalapi/-/html5_player/=/cid=${encodeURIComponent(cid)}/mtype=AhRVShI_/service=litevideo/mode=part/width=720/height=480/`;

    try {
        const res = await fetch(playerUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                'Referer': 'https://www.dmm.co.jp/',
            },
            signal: AbortSignal.timeout(8000),
        });

        if (!res.ok) {
            return NextResponse.json({ error: `dmm returned ${res.status}` }, { status: 502 });
        }

        const html = await res.text();

        // "src":"//cc3001.dmm.co.jp/pv/.../xxx_sm_s.mp4" を抽出
        const mp4Match = html.match(/"src":"(\/\/cc3001\.dmm\.co\.jp\/[^"]+\.mp4)"/);
        if (!mp4Match) {
            return NextResponse.json({ error: 'mp4 not found' }, { status: 404 });
        }

        const mp4 = 'https:' + mp4Match[1].replace(/\\\//g, '/');
        return NextResponse.json({ mp4 });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'unknown';
        return NextResponse.json({ error: msg }, { status: 502 });
    }
}
