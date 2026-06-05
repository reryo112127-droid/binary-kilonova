import { NextRequest, NextResponse } from 'next/server';
import { r2PutProductRaw } from '../../../../lib/productR2';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ローカルDBで生成した商品詳細JSONをR2に一括投入する。
// Tursoブロック中でも新作の商品詳細をR2にキャッシュできるようにする(populate_r2_local.mjs から呼ぶ)。
// body: { items: [{ id: string, data: object }, ...] }
export async function POST(request: NextRequest) {
    if (request.headers.get('x-admin-key') !== process.env.ADMIN_KEY) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const items: { id: string; data: Record<string, unknown> }[] = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) return NextResponse.json({ ok: true, saved: 0 });

    let saved = 0;
    const BATCH = 25;
    for (let i = 0; i < items.length; i += BATCH) {
        const chunk = items.slice(i, i + BATCH);
        await Promise.all(chunk.map(async (it) => {
            if (it && it.id && it.data) {
                await r2PutProductRaw(String(it.id), it.data);
                saved++;
            }
        }));
    }

    return NextResponse.json({ ok: true, saved });
}
