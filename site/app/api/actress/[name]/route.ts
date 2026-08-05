import { NextRequest, NextResponse } from 'next/server';
import { getFanzaClient } from '../../../../lib/turso';
import { getCached, setCached } from '../../../../lib/apiCache';
import { readStaticCacheAsync as readStaticCache, cacheHeaders } from '../../../../lib/staticCache';
import { actressShardFile } from '../../../../lib/actressShard';

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

type ShardMap = Record<string, ActressDisplayEntry>;

/**
 * 女優エントリをシャードから引く。見つからなければ別名インデックスで正規名へ解決して再試行。
 * シャードが未生成/未デプロイの環境では旧来の一枚岩JSONへフォールバックする
 * （scripts/build_actress_display_shards.mjs の出力より前のデプロイでも壊れないように）。
 */
async function lookupActress(
    actressName: string,
    nameNoSpace: string,
): Promise<{ row: ActressDisplayEntry | null; canonicalName: string } | null> {
    const readShard = (name: string) => readStaticCache<ShardMap>(actressShardFile(name));

    // 直接一致（スペース除去の別表記は別シャードになるので、外れたときだけ2枚目を引く）
    const primary = await readShard(actressName);
    let shardsExist = primary !== null;
    let row = primary?.[actressName] ?? null;

    if (!row && nameNoSpace !== actressName) {
        const secondary = await readShard(nameNoSpace);
        shardsExist = shardsExist || secondary !== null;
        row = secondary?.[nameNoSpace] ?? null;
    }
    if (row) return { row, canonicalName: actressName };

    // 別名 → 正規名（旧実装は6万件を線形走査していた箇所）
    const aliasIndex = await readStaticCache<Record<string, string>>('actress_display_alias_index.json');
    if (aliasIndex) {
        shardsExist = true;
        const canonicalName = aliasIndex[actressName] ?? aliasIndex[nameNoSpace];
        if (canonicalName) {
            const resolved = (await readShard(canonicalName))?.[canonicalName] ?? null;
            if (resolved) return { row: resolved, canonicalName };
        }
    }
    // シャードは引けている＝データはあるが該当女優が居ないだけ（プロフィール無しで返す）
    if (shardsExist) return { row: null, canonicalName: actressName };

    // フォールバック: 一枚岩キャッシュ（シャード未デプロイ時のみ）
    const displayCache = await readStaticCache<ShardMap>('actress_display_cache.json');
    if (!displayCache) return null;
    const direct = displayCache[actressName] ?? displayCache[nameNoSpace] ?? null;
    if (direct) return { row: direct, canonicalName: actressName };
    for (const [canonical, entry] of Object.entries(displayCache)) {
        if (entry.aliases && entry.aliases.includes(actressName)) {
            return { row: displayCache[canonical] ?? null, canonicalName: canonical };
        }
    }
    return { row: null, canonicalName: actressName };
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
    // 旧実装は 24MB の actress_display_cache.json を丸ごと読み、isolate(メモリ128MB)に
    // 常駐させていた。名前ハッシュで64分割したシャード(各0.4MB以下)＋別名逆引きインデックス
    // (0.13MB)だけを引くことで、1リクエストあたりの読み込みを1/50以下にする。
    const lookup = await lookupActress(actressName, nameNoSpace);
    if (lookup) {
        const { row, canonicalName } = lookup;
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

    // ── 静的JSONがない場合のTursoフォールバック ──────────────────────
    const db = await getFanzaClient();
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
