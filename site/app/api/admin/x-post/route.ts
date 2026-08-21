import { NextRequest, NextResponse } from 'next/server';
import { getSiteClient, getFanzaClient } from '../../../../lib/turso';
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
    const genre = searchParams.get('genre') || 'new';
    const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10), 100);

    const fanzaClient = await getFanzaClient();
    if (!fanzaClient) {
        return NextResponse.json({ error: 'DB接続エラー' }, { status: 503 });
    }

    const siteDb = await getSiteClient();
    await initSiteSchema();

    // Build genre-specific WHERE clause
    let genreWhere = '';
    let orderBy = 'ORDER BY sale_start_date DESC';

    switch (genre) {
        case 'new':
            genreWhere = '';
            orderBy = 'ORDER BY sale_start_date DESC';
            break;
        case 'sale':
            genreWhere = 'AND discount_pct > 0';
            orderBy = 'ORDER BY discount_pct DESC';
            break;
        case 'anon':
            genreWhere = `AND (actresses IS NULL OR actresses = '' OR actresses = '----')`;
            orderBy = 'ORDER BY sale_start_date DESC';
            break;
        case 'lady':
            genreWhere = `AND genres LIKE '%淑女%'`;
            orderBy = 'ORDER BY sale_start_date DESC';
            break;
        case 'vr':
            genreWhere = 'AND vr_flag = 1';
            orderBy = 'ORDER BY sale_start_date DESC';
            break;
        case 'collab':
            genreWhere = `AND actresses LIKE '%,%'`;
            orderBy = 'ORDER BY sale_start_date DESC';
            break;
        default:
            genreWhere = '';
            orderBy = 'ORDER BY sale_start_date DESC';
    }

    try {
        // 除外リスト（投稿済み・NG判定）は最大1,000件になり得るが、D1のバインド変数は
        // 1クエリ100個までなので NOT IN(?,?...) には載せられない（載せると常に失敗し
        // 除外が一切効かないまま候補が返る）。SQLでは多めに取り、除外はJS側で行う。
        const excluded = new Set<string>();
        const [decidedIds, ngIds] = await Promise.all([
            siteDb
                ? siteDb.execute('SELECT product_id FROM x_post_decisions ORDER BY decided_at DESC LIMIT 500')
                    .then(r => r.rows.map(r => String(r.product_id))).catch(() => [] as string[])
                : Promise.resolve([] as string[]),
            siteDb
                ? siteDb.execute("SELECT product_id FROM product_safety WHERE x_safe = 0 ORDER BY checked_at DESC LIMIT 500")
                    .then(r => r.rows.map(r => String(r.product_id))).catch(() => [] as string[])
                : Promise.resolve([] as string[]),
        ]);
        decidedIds.forEach(id => excluded.add(id));
        ngIds.forEach(id => excluded.add(id));

        const args: (string | number)[] = [];
        // 除外分を吸収するため候補を多めに取得してからJSで絞る
        const fetchLimit = limit + excluded.size;
        const sql = `
            SELECT product_id, title, main_image_url, sample_images_json,
                   affiliate_url, actresses, discount_pct, sale_start_date
            FROM products
            WHERE 1=1
            ${genreWhere}
            ${orderBy}
            LIMIT ?
        `;
        args.push(fetchLimit);

        const result = await fanzaClient.execute({ sql, args });
        const candidateRows = result.rows
            .filter(r => !excluded.has(String(r.product_id)))
            .slice(0, limit);

        const products = candidateRows.map(row => {
            let sampleImages: string[] = [];
            try {
                if (row.sample_images_json) {
                    sampleImages = JSON.parse(String(row.sample_images_json));
                }
            } catch {
                sampleImages = [];
            }
            return {
                product_id: row.product_id,
                title: row.title,
                main_image_url: row.main_image_url,
                sample_images: sampleImages,
                affiliate_url: row.affiliate_url,
                actresses: row.actresses,
                discount_pct: row.discount_pct,
                sale_start_date: row.sale_start_date,
            };
        });

        return NextResponse.json(products);

    } catch (err) {
        console.error('[admin/x-post GET]', err);
        return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    if (!checkAdmin(request)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    if (!body?.product_id || !body?.decision) {
        return NextResponse.json({ error: 'product_id と decision は必須です' }, { status: 400 });
    }

    const { product_id, decision, new_genre, post_type } = body;

    const db = await getSiteClient();
    if (!db) {
        return NextResponse.json({ error: 'DB接続エラー' }, { status: 503 });
    }

    await initSiteSchema();

    try {
        await db.execute({
            sql: `INSERT OR REPLACE INTO x_post_decisions (product_id, decision, new_genre, post_type)
                  VALUES (?, ?, ?, ?)`,
            args: [String(product_id), String(decision), new_genre ? String(new_genre) : null, post_type ? String(post_type) : 'package'],
        });

        return NextResponse.json({ ok: true });

    } catch (err) {
        console.error('[admin/x-post POST]', err);
        return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
    }
}
