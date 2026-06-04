import { NextRequest, NextResponse } from 'next/server';
import { getFanzaClient } from '../../../../lib/turso';
import { getCached, setCached } from '../../../../lib/apiCache';
import { readStaticCacheAsync as readStaticCache, cacheHeaders } from '../../../../lib/staticCache';

const ACTRESS_TTL = 24 * 60 * 60 * 1000; // 24時間

export const dynamic = 'force-dynamic';

type ActressDisplayEntry = {
    name: string; fanza_id: string | null; ruby: string | null;
    height: number | null; bust: number | null; waist: number | null; hip: number | null; cup: string | null;
    birthday: string | null; blood_type: string | null; hobby: string | null; prefectures: string | null;
    image_url: string | null; twitter: string | null; instagram: string | null; tiktok: string | null;
    aliases: string[]; avwiki_url: string | null; agency_url: string | null; agency_source: string | null;
    augmented: boolean; retired: boolean;
};

function buildProfile(actressName: string, canonicalName: string, row: ActressDisplayEntry | null) {
    const aliases: string[] = [];
    if (row?.aliases) {
        row.aliases.forEach((a: string) => { if (a !== actressName) aliases.push(a); });
    }
    if (canonicalName !== actressName) aliases.push(canonicalName);
    return {
        name:        actressName,
        canonical_name: canonicalName,
        aliases:     [...new Set(aliases)],
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
        retired:     row?.retired === true,
        augmented:   row?.augmented === true,
        has_fanza_profile:  !!(row?.fanza_id),
        has_avwiki_profile: !!(row?.avwiki_url),
        has_agency_profile: !!(row?.agency_url),
    };
}

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ name: string }> }
) {
    const { name } = await params;
    const actressName = decodeURIComponent(name);
    const nameNoSpace = actressName.replace(/\s+/g, '');

    const cacheKey = `actress_${actressName}`;
    const cached = getCached<object>(cacheKey, ACTRESS_TTL);
    if (cached) return NextResponse.json(cached, { headers: cacheHeaders(86400, 3600) });

    const cfCache = typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null;
    let cfCacheKey: Request | null = null;
    if (cfCache) {
        cfCacheKey = new Request(new URL(req.url).toString());
        const cfHit = await cfCache.match(cfCacheKey);
        if (cfHit) return cfHit as unknown as NextResponse;
    }

    // ── 静的JSONから取得（Tursoクエリを省略）────────────────────────
    const displayCache = await readStaticCache<Record<string, ActressDisplayEntry>>('actress_display_cache.json');
    if (displayCache) {
        // 直接一致 or スペース除去で一致
        const row = displayCache[actressName] ?? displayCache[nameNoSpace] ?? null;

        // エイリアス解決: aliases配列でどの名前を正規名に持つか逆引き
        let canonicalName = actressName;
        if (!row) {
            for (const [canonical, entry] of Object.entries(displayCache)) {
                if (entry.aliases && entry.aliases.includes(actressName)) {
                    canonicalName = canonical;
                    break;
                }
            }
        }
        const resolved = row ?? displayCache[canonicalName] ?? null;
        const profile = buildProfile(actressName, canonicalName, resolved);

        setCached(cacheKey, profile);
        const res = NextResponse.json(profile, { headers: cacheHeaders(86400, 3600) });
        if (cfCache && cfCacheKey) {
            await cfCache.put(cfCacheKey, new Response(JSON.stringify(profile), {
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
            }));
        }
        return res;
    }

    // ── 静的JSONがない場合のTursoフォールバック ──────────────────────
    const db = getFanzaClient();
    if (!db) return NextResponse.json({ name: actressName }, { status: 503 });

    const [aliasRow, profileRow] = await Promise.all([
        db.execute({ sql: `SELECT canonical_name FROM actress_aliases WHERE alias = ? OR alias = ?`, args: [actressName, nameNoSpace] })
          .then(r => r.rows[0]).catch(() => null),
        db.execute({ sql: `SELECT * FROM actress_profiles WHERE name = ? OR name = ?`, args: [actressName, nameNoSpace] })
          .then(r => r.rows[0]).catch(() => null),
    ]);
    const canonicalName = (aliasRow?.canonical_name as string) ?? actressName;
    const row = profileRow as ActressDisplayEntry | null;
    const profile = buildProfile(actressName, canonicalName, row);

    setCached(cacheKey, profile);
    const res = NextResponse.json(profile, { headers: cacheHeaders(86400, 3600) });
    if (cfCache && cfCacheKey) {
        await cfCache.put(cfCacheKey, new Response(JSON.stringify(profile), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
        }));
    }
    return res;
}
