import { NextRequest, NextResponse } from 'next/server';
import { r2DeleteProduct } from '../../../../lib/productR2';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// 指定された product_id のR2キャッシュを削除（価格鮮度確保用）。
// 日次バッチがセール商品IDを渡して呼び出す。次アクセスでTursoから最新価格を再取得する。
export async function POST(request: NextRequest) {
    if (request.headers.get('x-admin-key') !== process.env.ADMIN_KEY) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const ids: string[] = Array.isArray(body?.ids) ? body.ids.map(String) : [];
    if (ids.length === 0) return NextResponse.json({ ok: true, deleted: 0 });

    let deleted = 0;
    // 同時実行数を制限して順次削除
    const BATCH = 50;
    for (let i = 0; i < ids.length; i += BATCH) {
        const chunk = ids.slice(i, i + BATCH);
        await Promise.all(chunk.map(async (id) => {
            await r2DeleteProduct(id);
            deleted++;
        }));
    }

    return NextResponse.json({ ok: true, deleted });
}
