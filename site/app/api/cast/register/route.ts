import { NextRequest, NextResponse } from 'next/server';
import { getMgsClient, getFanzaClient } from '../../../../lib/turso';
import { recordContribution, initSiteSchema } from '../../../../lib/siteDb';

export async function POST(request: NextRequest) {
    const body = await request.json().catch(() => null);
    if (!body?.product_id || !body?.actresses?.length) {
        return NextResponse.json({ error: 'product_id と actresses は必須です' }, { status: 400 });
    }

    const productId = String(body.product_id);
    const actresses: string[] = body.actresses
        .map((a: unknown) => String(a).trim())
        .filter((a: string) => a.length > 0);

    if (actresses.length === 0) {
        return NextResponse.json({ error: '出演者名を1名以上入力してください' }, { status: 400 });
    }

    const sessionId = request.headers.get('x-session-id') || '';
    const mgsClient = getMgsClient();

    if (!mgsClient) {
        return NextResponse.json({ error: 'DB接続エラー' }, { status: 503 });
    }

    // 同一セッションの重複投稿チェック
    if (sessionId) {
        const dup = await mgsClient.execute({
            sql: 'SELECT id FROM cast_submissions WHERE product_id = ? AND session_id = ? LIMIT 1',
            args: [productId, sessionId],
        });
        if (dup.rows.length > 0) {
            return NextResponse.json({ ok: true, message: 'already_submitted' });
        }
    }

    // 投稿を保存
    const actressesStr = actresses.join(',');
    await mgsClient.execute({
        sql: 'INSERT INTO cast_submissions (product_id, actresses, session_id) VALUES (?, ?, ?)',
        args: [productId, actressesStr, sessionId],
    });

    // 貢献ポイント記録（投稿時点でカウント）
    if (sessionId) {
        await initSiteSchema();
        await recordContribution(sessionId, productId);
    }

    // 同じ作品に2件以上一致する投稿があれば自動承認してDB更新
    const pending = await mgsClient.execute({
        sql: `SELECT actresses FROM cast_submissions
              WHERE product_id = ? AND status = 'pending'
              ORDER BY submitted_at ASC`,
        args: [productId],
    });

    if (pending.rows.length >= 2) {
        // 最多得票の出演者リストを選出
        const counts: Record<string, number> = {};
        for (const row of pending.rows) {
            const key = String(row.actresses);
            counts[key] = (counts[key] || 0) + 1;
        }
        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

        if (best[1] >= 2) {
            const approvedActresses = best[0];

            // MGS DB のproductsテーブルを更新
            await mgsClient.execute({
                sql: `UPDATE products SET actresses = ? WHERE product_id = ? AND (actresses IS NULL OR actresses = '')`,
                args: [approvedActresses, productId],
            });

            // FANZAにも同じ作品があれば更新
            const fanzaClient = getFanzaClient();
            if (fanzaClient) {
                await fanzaClient.execute({
                    sql: `UPDATE products SET actresses = ? WHERE product_id = ? AND (actresses IS NULL OR actresses = '')`,
                    args: [approvedActresses, productId],
                }).catch(() => {});
            }

            // 承認済みに更新
            await mgsClient.execute({
                sql: `UPDATE cast_submissions SET status = 'approved' WHERE product_id = ? AND status = 'pending'`,
                args: [productId],
            });

            return NextResponse.json({ ok: true, message: 'approved', actresses: approvedActresses });
        }
    }

    return NextResponse.json({ ok: true, message: 'pending' });
}

// 投稿一覧取得（管理用）
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') || 'pending';
    const productId = searchParams.get('product_id') || '';

    const mgsClient = getMgsClient();
    if (!mgsClient) return NextResponse.json([], { status: 503 });

    const args: string[] = [status];
    let sql = `SELECT id, product_id, actresses, session_id, submitted_at, status
               FROM cast_submissions WHERE status = ?`;
    if (productId) { sql += ' AND product_id = ?'; args.push(productId); }
    sql += ' ORDER BY submitted_at DESC LIMIT 100';

    const result = await mgsClient.execute({ sql, args });
    return NextResponse.json(result.rows);
}
