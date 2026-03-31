import { NextRequest, NextResponse } from 'next/server';
import { getFanzaClient } from '../../../../lib/turso';

export const dynamic = 'force-dynamic';

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ name: string }> }
) {
    const { name } = await params;
    const actressName = decodeURIComponent(name);
    const nameNoSpace = actressName.replace(/\s+/g, '');

    const db = getFanzaClient();
    if (!db) {
        return NextResponse.json({ name: actressName, error: 'db unavailable' }, { status: 503 });
    }

    // エイリアス解決: 入力名 → canonical_name
    const aliasRow = await db.execute({
        sql: `SELECT canonical_name FROM actress_aliases WHERE alias = ? OR alias = ?`,
        args: [actressName, nameNoSpace],
    }).then(r => r.rows[0]).catch(() => null);
    const canonicalName = (aliasRow?.canonical_name as string) ?? actressName;

    // プロフィール取得（canonical_name または入力名で検索）
    const row = await db.execute({
        sql: `SELECT * FROM actress_profiles WHERE name = ? OR name = ?`,
        args: [canonicalName, nameNoSpace],
    }).then(r => r.rows[0]).catch(() => null);

    const aliases: string[] = [];
    if (row?.aliases) {
        try {
            const parsed = JSON.parse(row.aliases as string);
            if (Array.isArray(parsed)) {
                parsed.forEach((a: string) => { if (a !== actressName) aliases.push(a); });
            }
        } catch { /* ignore */ }
    }
    if (canonicalName !== actressName) aliases.push(canonicalName);

    const profile = {
        name: actressName,
        canonical_name: canonicalName,
        aliases: [...new Set(aliases)],
        height:      row?.height      ?? null,
        bust:        row?.bust        ?? null,
        waist:       row?.waist       ?? null,
        hip:         row?.hip         ?? null,
        cup:         row?.cup         ?? null,
        birthday:    row?.birthday    ?? null,
        blood_type:  row?.blood_type  ?? null,
        hobby:       row?.hobby       ?? null,
        prefectures: row?.prefectures ?? null,
        image_url:   row?.image_url   ?? null,
        twitter:     row?.twitter     ?? null,
        instagram:   row?.instagram   ?? null,
        tiktok:      row?.tiktok      ?? null,
        sns_source:  row?.agency_source ?? (row?.avwiki_url ? 'avwiki' : null),
        agency_url:  row?.agency_url  ?? null,
        avwiki_url:  row?.avwiki_url  ?? null,
        retired:     row?.retired === 1,
        augmented:   row?.augmented === 1,
        has_fanza_profile:  !!(row?.fanza_id),
        has_avwiki_profile: !!(row?.avwiki_url),
        has_agency_profile: !!(row?.agency_url),
    };

    return NextResponse.json(profile);
}
