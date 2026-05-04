import { NextRequest, NextResponse } from 'next/server';
import { getSiteClient, getMgsClient, getFanzaClient } from '../../../../lib/turso';
import { initSiteSchema } from '../../../../lib/siteDb';

export const dynamic = 'force-dynamic';

function checkAdmin(req: NextRequest): boolean {
    return req.headers.get('x-admin-key') === process.env.ADMIN_KEY;
}

export async function GET(request: NextRequest) {
    if (!checkAdmin(request)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || 'cast';
    const status = searchParams.get('status') || 'pending';

    try {
        if (type === 'cast') {
            const mgsClient = getMgsClient();
            if (!mgsClient) return NextResponse.json({ error: 'DB接続エラー' }, { status: 503 });

            const result = await mgsClient.execute({
                sql: `SELECT id, product_id, actresses, session_id, submitted_at, status
                      FROM cast_submissions
                      WHERE status = ?
                      ORDER BY submitted_at DESC
                      LIMIT 100`,
                args: [status],
            });
            return NextResponse.json(result.rows);

        } else if (type === 'sns') {
            const db = getSiteClient();
            if (!db) return NextResponse.json({ error: 'DB接続エラー' }, { status: 503 });
            await initSiteSchema();

            const result = await db.execute({
                sql: `SELECT id, actress_name, twitter_username, instagram_username, session_id, submitted_at, status
                      FROM sns_submissions
                      WHERE status = ?
                      ORDER BY submitted_at DESC
                      LIMIT 100`,
                args: [status],
            });
            return NextResponse.json(result.rows);

        } else if (type === 'rename') {
            const db = getSiteClient();
            if (!db) return NextResponse.json({ error: 'DB接続エラー' }, { status: 503 });
            await initSiteSchema();

            const result = await db.execute({
                sql: `SELECT id, old_name, new_name, reference_url, session_id, submitted_at, status
                      FROM rename_submissions
                      WHERE status = ?
                      ORDER BY submitted_at DESC
                      LIMIT 100`,
                args: [status],
            });
            return NextResponse.json(result.rows);

        } else {
            return NextResponse.json({ error: '不正なtypeです' }, { status: 400 });
        }
    } catch (err) {
        console.error('[admin/submissions GET]', err);
        return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    if (!checkAdmin(request)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    if (!body?.id || !body?.type || !body?.action) {
        return NextResponse.json({ error: 'id, type, action は必須です' }, { status: 400 });
    }

    const { id, type, action } = body;

    try {
        // ── CAST ──────────────────────────────────────────────────────────────
        if (type === 'cast') {
            const mgsClient = getMgsClient();
            if (!mgsClient) return NextResponse.json({ error: 'DB接続エラー' }, { status: 503 });

            if (action === 'approve') {
                // Get the submission
                const subRes = await mgsClient.execute({
                    sql: 'SELECT product_id, actresses FROM cast_submissions WHERE id = ?',
                    args: [id],
                });
                if (subRes.rows.length === 0) {
                    return NextResponse.json({ error: '投稿が見つかりません' }, { status: 404 });
                }
                const { product_id, actresses } = subRes.rows[0];

                // Approve in MGS DB
                await mgsClient.execute({
                    sql: `UPDATE cast_submissions SET status = 'approved' WHERE id = ?`,
                    args: [id],
                });

                // Update products in MGS DB (only if actresses is empty)
                await mgsClient.execute({
                    sql: `UPDATE products SET actresses = ? WHERE product_id = ? AND (actresses IS NULL OR actresses = '')`,
                    args: [actresses, product_id],
                });

                // Update products in FANZA DB (only if actresses is empty)
                const fanzaClient = getFanzaClient();
                if (fanzaClient) {
                    await fanzaClient.execute({
                        sql: `UPDATE products SET actresses = ? WHERE product_id = ? AND (actresses IS NULL OR actresses = '')`,
                        args: [actresses, product_id],
                    }).catch(() => {});
                }

                return NextResponse.json({ ok: true, message: 'cast approved' });

            } else if (action === 'reject') {
                await mgsClient.execute({
                    sql: `UPDATE cast_submissions SET status = 'rejected' WHERE id = ?`,
                    args: [id],
                });
                return NextResponse.json({ ok: true, message: 'cast rejected' });

            } else {
                return NextResponse.json({ error: '不正なactionです' }, { status: 400 });
            }

        // ── SNS ───────────────────────────────────────────────────────────────
        } else if (type === 'sns') {
            const db = getSiteClient();
            if (!db) return NextResponse.json({ error: 'DB接続エラー' }, { status: 503 });
            await initSiteSchema();

            if (action === 'approve') {
                // Get the submission
                const subRes = await db.execute({
                    sql: 'SELECT actress_name, twitter_username, instagram_username FROM sns_submissions WHERE id = ?',
                    args: [id],
                });
                if (subRes.rows.length === 0) {
                    return NextResponse.json({ error: '投稿が見つかりません' }, { status: 404 });
                }
                const { actress_name, twitter_username, instagram_username } = subRes.rows[0];

                // Approve in site DB
                await db.execute({
                    sql: `UPDATE sns_submissions SET status = 'approved' WHERE id = ?`,
                    args: [id],
                });

                // Update FANZA actress_profiles
                const fanzaClient = getFanzaClient();
                if (fanzaClient) {
                    await fanzaClient.execute({
                        sql: `UPDATE actress_profiles
                              SET twitter = COALESCE(?, twitter),
                                  instagram = COALESCE(?, instagram)
                              WHERE name = ?`,
                        args: [twitter_username || null, instagram_username || null, actress_name],
                    }).catch(() => {});
                }

                return NextResponse.json({ ok: true, message: 'sns approved' });

            } else if (action === 'reject') {
                await db.execute({
                    sql: `UPDATE sns_submissions SET status = 'rejected' WHERE id = ?`,
                    args: [id],
                });
                return NextResponse.json({ ok: true, message: 'sns rejected' });

            } else {
                return NextResponse.json({ error: '不正なactionです' }, { status: 400 });
            }

        // ── RENAME ────────────────────────────────────────────────────────────
        } else if (type === 'rename') {
            const db = getSiteClient();
            if (!db) return NextResponse.json({ error: 'DB接続エラー' }, { status: 503 });
            await initSiteSchema();

            if (action === 'approve') {
                // Get the submission
                const subRes = await db.execute({
                    sql: 'SELECT old_name, new_name FROM rename_submissions WHERE id = ?',
                    args: [id],
                });
                if (subRes.rows.length === 0) {
                    return NextResponse.json({ error: '投稿が見つかりません' }, { status: 404 });
                }
                const { old_name, new_name } = subRes.rows[0];

                // Approve in site DB
                await db.execute({
                    sql: `UPDATE rename_submissions SET status = 'approved' WHERE id = ?`,
                    args: [id],
                });

                // Update FANZA actress_profiles
                const fanzaClient = getFanzaClient();
                if (fanzaClient) {
                    await fanzaClient.execute({
                        sql: `UPDATE actress_profiles SET name = ? WHERE name = ?`,
                        args: [new_name, old_name],
                    }).catch(() => {});
                }

                return NextResponse.json({ ok: true, message: 'rename approved' });

            } else if (action === 'reject') {
                await db.execute({
                    sql: `UPDATE rename_submissions SET status = 'rejected' WHERE id = ?`,
                    args: [id],
                });
                return NextResponse.json({ ok: true, message: 'rename rejected' });

            } else {
                return NextResponse.json({ error: '不正なactionです' }, { status: 400 });
            }

        } else {
            return NextResponse.json({ error: '不正なtypeです' }, { status: 400 });
        }

    } catch (err) {
        console.error('[admin/submissions POST]', err);
        return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
    }
}
