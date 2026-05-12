import { NextRequest, NextResponse } from 'next/server';
import { getFanzaClient } from '../../../../lib/turso';
import { getCached, setCached } from '../../../../lib/apiCache';
import { cacheHeaders } from '../../../../lib/staticCache';

const ACTRESS_TTL = 30 * 60 * 1000; // 30分

export const dynamic = 'force-dynamic';

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ name: string }> }
) {
    const { name } = await params;
    const actressName = decodeURIComponent(name);
    const nameNoSpace = actressName.replace(/\s+/g, '');

    // in-memoryキャッシュ（アイソレート内）
    const cacheKey = `actress_${actressName}`;
    const cached = getCached<object>(cacheKey, ACTRESS_TTL);
    if (cached) return NextResponse.json(cached, { headers: cacheHeaders(1800, 300) });

    // Cloudflare Cache API（アイソレート間共有）
    const cfCache = typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null;
    let cfCacheKey: Request | null = null;
    if (cfCache) {
        const normUrl = new URL(req.url);
        cfCacheKey = new Request(normUrl.toString());
        const cfHit = await cfCache.match(cfCacheKey);
        if (cfHit) return cfHit as unknown as NextResponse;
    }

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

    setCached(cacheKey, profile);

    const res = NextResponse.json(profile, { headers: cacheHeaders(1800, 300) });
    if (cfCache && cfCacheKey) {
        await cfCache.put(cfCacheKey, new Response(JSON.stringify(profile), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' },
        }));
    }
    return res;
}
