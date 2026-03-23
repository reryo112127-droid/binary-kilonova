import { NextRequest, NextResponse } from 'next/server';
import { getSiteClient } from '../../../../lib/turso';
import { initSiteSchema } from '../../../../lib/siteDb';

// アフィリエイトリンク経由での購入イベントを記録する
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    let body: { platform?: string } = {};
    try { body = await req.json(); } catch { /* platform は optional */ }
    const platform = body.platform || 'unknown';

    const db = getSiteClient();
    if (!db) return NextResponse.json({ ok: true }); // サイレントフォールバック

    await initSiteSchema();
    await db.execute({
        sql: 'INSERT INTO purchase_events(product_id, platform) VALUES(?,?)',
        args: [id, platform],
    });

    return NextResponse.json({ ok: true });
}
