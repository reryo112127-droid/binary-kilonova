import { NextRequest, NextResponse } from 'next/server';
import { getSiteClient } from '../../../../lib/turso';
import { initSiteSchema } from '../../../../lib/siteDb';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
    const body = await request.json().catch(() => null);
    if (!body?.old_name || !body?.new_name) {
        return NextResponse.json({ error: 'old_name と new_name は必須です' }, { status: 400 });
    }

    const oldName = String(body.old_name).trim();
    const newName = String(body.new_name).trim();
    const referenceUrl = body.reference_url ? String(body.reference_url).trim() : null;
    const sessionId = body.session_id ? String(body.session_id).trim() : '';

    if (!oldName || !newName) {
        return NextResponse.json({ error: 'old_name と new_name は空にできません' }, { status: 400 });
    }

    const db = getSiteClient();
    if (!db) {
        return NextResponse.json({ error: 'DB接続エラー' }, { status: 503 });
    }

    await initSiteSchema();

    await db.execute({
        sql: `INSERT INTO rename_submissions (old_name, new_name, reference_url, session_id)
              VALUES (?, ?, ?, ?)`,
        args: [oldName, newName, referenceUrl, sessionId],
    });

    return NextResponse.json({ ok: true });
}
