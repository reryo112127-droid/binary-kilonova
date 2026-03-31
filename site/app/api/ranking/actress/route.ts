import { NextRequest, NextResponse } from 'next/server';
import { getMgsClient, getFanzaClient, getSiteClient } from '../../../../lib/turso';
import { initSiteSchema } from '../../../../lib/siteDb';
import { filterActresses } from '../../../../lib/actressFilter';

const CANDIDATE_LIMIT = 500;

export const revalidate = 300; // 5分キャッシュ

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 200);
    const fromDate = searchParams.get('fromDate') || '';
    const toDate   = searchParams.get('toDate')   || '';

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

    // ─── Step 3: サイトDBから女優いいね取得 ──────────────────
    const topEntries = Array.from(actressMap.values())
        .sort((a, b) => b.wishScore - a.wishScore)
        .slice(0, limit * 2); // いいね取得用に多めに取る

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

    // ─── Step 4: スコア計算してソート ────────────────────────
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
            sample_image: e.sampleImage,
            sample_product_id: e.sampleProductId,
        };
    });

    scored.sort((a, b) => b.score - a.score);

    return NextResponse.json(scored.slice(0, limit));
}
