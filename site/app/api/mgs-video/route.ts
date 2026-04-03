import { NextRequest, NextResponse } from 'next/server';

// Edge Runtimeで実行 → ユーザー最寄りのVercel PoP（日本ユーザーなら東京）から
// MGSにリクエストを送るため、米国サーバーのIPブロックを回避できる
export const runtime = 'edge';

/**
 * MGS サンプル動画URLを取得するプロキシ
 *
 * sample_video_url (例: https://www.mgstage.com/sampleplayer/sampleplayer.html/{UUID})
 * → sampleRespons.php?pid={UUID} で実際のストリーミングURLを取得
 * → .ism/request... を .mp4 に変換して返す
 */
export async function GET(request: NextRequest) {
    const url = request.nextUrl.searchParams.get('url');
    if (!url) {
        return NextResponse.json({ error: 'url required' }, { status: 400 });
    }

    // DB に直接 mp4 URL が格納されている場合はそのまま返す
    if (url.includes('.mp4')) {
        return NextResponse.json({ mp4: url });
    }

    // sampleplayer.html/{UUID} 形式の場合は sampleRespons.php 経由で取得
    const uuid = url.split('/').pop();
    if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) {
        return NextResponse.json({ error: 'invalid url' }, { status: 400 });
    }

    try {
        const res = await fetch(
            `https://www.mgstage.com/sampleplayer/sampleRespons.php?pid=${uuid}`,
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://www.mgstage.com/',
                    'Cookie': 'adc=1',
                },
                signal: AbortSignal.timeout(10_000),
            }
        );

        if (!res.ok) {
            return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502 });
        }

        const data = await res.json() as { url?: string };
        if (!data.url) {
            return NextResponse.json({ error: 'no video' }, { status: 404 });
        }

        // Smooth Streaming (.ism/request...) → MP4 に変換
        // sample.mgstage.com はReferer不要でアクセス可能なので直接URLを返す
        const mp4 = data.url.replace(/\.ism\/request.*$/, '.mp4');

        return NextResponse.json({ mp4 });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'unknown';
        return NextResponse.json({ error: msg }, { status: 502 });
    }
}
