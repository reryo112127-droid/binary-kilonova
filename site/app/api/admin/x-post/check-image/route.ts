import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function checkAdmin(req: NextRequest): boolean {
    return req.headers.get('x-admin-key') === process.env.ADMIN_KEY;
}

export async function POST(request: NextRequest) {
    if (!checkAdmin(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => null);
    const url: string = body?.url || '';
    if (!url) return NextResponse.json({ safe: true });

    // pb_e_ → pf_e_ (フルサイズパッケージ画像)
    const imageUrl = url.includes('pb_e_') ? url.replace('pb_e_', 'pf_e_') : url;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ safe: true });

    try {
        // 画像を取得してbase64変換
        const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) });
        if (!imgRes.ok) return NextResponse.json({ safe: true });

        const imgBuf  = await imgRes.arrayBuffer();
        const base64  = Buffer.from(imgBuf).toString('base64');
        const mime    = (imgRes.headers.get('content-type') || 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

        const client = new Anthropic({ apiKey });
        const msg = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 10,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
                    { type: 'text',  text: 'この画像に性器・陰毛・乳首など露骨な裸体が写っていますか？「yes」か「no」のみ答えてください。' },
                ],
            }],
        });

        const answer = msg.content[0]?.type === 'text' ? msg.content[0].text.trim().toLowerCase() : 'no';
        const safe   = !answer.startsWith('yes');

        return NextResponse.json({ safe, answer });

    } catch {
        // チェック失敗時は安全側（表示する）に倒す
        return NextResponse.json({ safe: true });
    }
}
