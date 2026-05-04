import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../../../../lib/readHtml';
import { getMgsClient, getFanzaClient, getSiteClient } from '../../../../lib/turso';
import { initSiteSchema } from '../../../../lib/siteDb';
import { filterActresses } from '../../../../lib/actressFilter';
import { getCached, setCached } from '../../../../lib/apiCache';
import { readStaticCacheAsync as readStaticCache, cacheHeaders } from '../../../../lib/staticCache';

const CANDIDATE_LIMIT = 500;
const ACTRESS_RANKING_TTL = 30 * 60 * 1000; // 30分

export const revalidate = 300; // 5分キャッシュ

// actress_profiles.json から身体的特徴でフィルタした出演者名セットを返す
async function getPhysicalFilterSet(
    cup: string,
    heightRange: string,
    ageMin: number,
): Promise<Set<string> | null> {
    if (!cup && !heightRange && !ageMin) return null;

    const profiles = await readStaticCache<Record<string, { cup?: string; height?: number; birthday?: string }>>('actress_profiles.json');
    if (!profiles) return null;

    function calcAge(birthday: string): number {
        const d = new Date(birthday), t = new Date();
        let a = t.getFullYear() - d.getFullYear();
        if (t.getMonth() < d.getMonth() || (t.getMonth() === d.getMonth() && t.getDate() < d.getDate())) a--;
        return a;
    }

    const CUP_ORDER = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q'];

    const matched = new Set<string>();
    for (const [name, p] of Object.entries(profiles)) {
        let ok = true;
        if (cup) {
            if (!p.cup) { ok = false; }
            else {
                const minIdx = CUP_ORDER.indexOf(cup);
                const pIdx   = CUP_ORDER.indexOf(p.cup);
                if (minIdx < 0 || pIdx < minIdx) ok = false;
            }
        }
        if (ok && heightRange) {
            const [min, max] = heightRange.split('-').map(Number);
            if (!p.height || p.height < min || (max && p.height >= max)) ok = false;
        }
        if (ok && ageMin) {
            if (!p.birthday) { ok = false; }
            else if (calcAge(p.birthday) < ageMin) ok = false;
        }
        if (ok) matched.add(name);
    }
    return matched;
}

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const fromDate  = searchParams.get('fromDate')  || '';
    const toDate    = searchParams.get('toDate')    || '';
    const cup       = searchParams.get('cup')       || '';
    const heightRange = searchParams.get('height')  || '';
    const ageMin    = parseInt(searchParams.get('ageMin') || '0', 10);

    const hasPhysical = !!(cup || heightRange || ageMin);

    // 2026年デフォルトクエリ（身体的特徴フィルタなし時のみ静的JSONを使用）
    if (!hasPhysical && fromDate === '2026-01-01' && toDate === '2026-12-31') {
        const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 200);
        const cached = await readStaticCache<unknown[]>('actress_ranking_2026_cache.json');
        if (cached && cached.length > 0) return NextResponse.json(
            cached.slice(0, limit),
            { headers: { 'Content-Type': 'application/json', ...cacheHeaders(3600, 86400) } }
        );
    }

    const cacheKey = 'actress_ranking_' + Array.from(searchParams.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
    const hit = getCached<unknown[]>(cacheKey, ACTRESS_RANKING_TTL);
    if (hit) return NextResponse.json(hit, { headers: { 'Content-Type': 'application/json', ...cacheHeaders(300, 600) } });
    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 200);

    const mgsClient = getMgsClient();
    const fanzaClient = getFanzaClient();
    const siteClient = getSiteClient();

    if (!mgsClient && !fanzaClient) {
        return NextResponse.json([], { status: 503 });
    }

    // ─── Step 1: 候補作品を取得 ─────────────────────────────
    const mgsDateConds: string[] = ['(duration_min IS NULL OR duration_min < 600)'];
    const mgsDateArgs: string[] = [];
    if (fromDate) { mgsDateConds.push("REPLACE(sale_start_date, '/', '-') >= ?"); mgsDateArgs.push(fromDate); }
    if (toDate)   { mgsDateConds.push("REPLACE(sale_start_date, '/', '-') <= ?"); mgsDateArgs.push(toDate); }

    const fanzaDateConds: string[] = [];
    const fanzaDateArgs: string[] = [];
    if (fromDate) { fanzaDateConds.push('sale_start_date >= ?'); fanzaDateArgs.push(fromDate); }
    if (toDate)   { fanzaDateConds.push('sale_start_date <= ?'); fanzaDateArgs.push(toDate); }

    const [mgsRows, fanzaRows] = await Promise.all([
        mgsClient
            ? mgsClient.execute({
                  sql: `SELECT product_id, actresses, main_image_url, wish_count, genres, maker
                        FROM products
                        WHERE ${mgsDateConds.join(' AND ')}
                        ORDER BY wish_count DESC
                        LIMIT ${CANDIDATE_LIMIT}`,
                  args: mgsDateArgs,
              }).then(r => r.rows).catch(() => [])
            : [],
        fanzaClient
            ? fanzaClient.execute({
                  sql: `SELECT product_id, actresses, main_image_url,
                               0 AS wish_count, genres, maker
                        FROM products
                        ${fanzaDateConds.length ? 'WHERE ' + fanzaDateConds.join(' AND ') : ''}
                        ORDER BY sale_start_date DESC
                        LIMIT ${CANDIDATE_LIMIT}`,
                  args: fanzaDateArgs,
              }).then(r => r.rows).catch(() => [])
            : [],
    ]);

    // ─── Step 2: 女優ごとにスコア集計 ───────────────────────
    type ActressEntry = {
        name: string;
        wishScore: number;
        workCount: number;
        sampleImage: string;
        sampleProductId: string;
    };

    const actressMap = new Map<string, ActressEntry>();

    function processRows(rows: typeof mgsRows) {
        for (const row of rows) {
            const r = row as Record<string, unknown>;
            const actressesStr = filterActresses(
                (r.actresses as string | null) || null,
                (r.genres as string | null) || null,
                (r.maker as string | null) || null
            );
            if (!actressesStr) continue;

            const names = actressesStr.split(/,|、/).map(s => s.trim()).filter(Boolean);
            const wishCount = Number(r.wish_count ?? 0);
            const image = String(r.main_image_url ?? '');
            const productId = String(r.product_id ?? '');

            for (const name of names) {
                if (!name) continue;
                const existing = actressMap.get(name);
                if (existing) {
                    existing.wishScore += wishCount;
                    existing.workCount += 1;
                    // より高いwish_countの作品の画像を使用
                    if (wishCount > 0 && existing.wishScore - wishCount < wishCount) {
                        existing.sampleImage = image;
                        existing.sampleProductId = productId;
                    }
                } else {
                    actressMap.set(name, {
                        name,
                        wishScore: wishCount,
                        workCount: 1,
                        sampleImage: image,
                        sampleProductId: productId,
                    });
                }
            }
        }
    }

    processRows(mgsRows);
    processRows(fanzaRows);

    // ─── Step 2.5: 身体的特徴フィルタ ───────────────────────────
    const physicalFilterSet = await getPhysicalFilterSet(cup, heightRange, ageMin);

    // ─── Step 3: サイトDBから女優いいね取得 ──────────────────
    const allEntries = Array.from(actressMap.values())
        .sort((a, b) => b.wishScore - a.wishScore);

    const filteredEntries = physicalFilterSet
        ? allEntries.filter(e => physicalFilterSet.has(e.name))
        : allEntries;

    const topEntries = filteredEntries.slice(0, limit * 2); // いいね取得用に多めに取る

    const actressLikesMap = new Map<string, number>();

    if (siteClient && topEntries.length > 0) {
        try {
            await initSiteSchema();
            // 一括でいいね数取得
            const names = topEntries.map(e => e.name);
            const placeholders = names.map(() => '?').join(',');
            const likesRes = await siteClient.execute({
                sql: `SELECT actress_name, COUNT(*) as cnt FROM actress_likes WHERE actress_name IN (${placeholders}) GROUP BY actress_name`,
                args: names,
            });
            for (const row of likesRes.rows) {
                actressLikesMap.set(String(row.actress_name), Number(row.cnt ?? 0));
            }
        } catch (err) {
            console.error('Actress ranking site DB error:', err);
        }
    }

    // ─── Step 4: 女優プロフィール画像を取得（顔写真・非露骨）──
    const actressImageMap = new Map<string, string>();
    if (fanzaClient && topEntries.length > 0) {
        try {
            const names = topEntries.map(e => e.name);
            const placeholders = names.map(() => '?').join(',');
            const imgRes = await fanzaClient.execute({
                sql: `SELECT name, image_url FROM actress_profiles WHERE name IN (${placeholders}) AND image_url IS NOT NULL`,
                args: names,
            });
            for (const row of imgRes.rows) {
                if (row.image_url) actressImageMap.set(String(row.name), String(row.image_url));
            }
        } catch { /* ignore */ }
    }

    // ─── Step 5: スコア計算してソート ────────────────────────
    const LIKE_BONUS = 5000; // いいね1件 = wish_count 5000相当

    const scored = topEntries.map(e => {
        const likes = actressLikesMap.get(e.name) ?? 0;
        const score = e.wishScore + likes * LIKE_BONUS;
        return {
            name: e.name,
            score,
            wish_score: e.wishScore,
            work_count: e.workCount,
            actress_likes: likes,
            image_url: actressImageMap.get(e.name) || null, // プロフィール写真（非露骨）
            sample_image: e.sampleImage,
            sample_product_id: e.sampleProductId,
        };
    });

    scored.sort((a, b) => b.score - a.score);

    const finalScored = scored.slice(0, limit);
    setCached(cacheKey, finalScored);
    return NextResponse.json(finalScored, { headers: { 'Content-Type': 'application/json', ...cacheHeaders(120, 600) } });
}
