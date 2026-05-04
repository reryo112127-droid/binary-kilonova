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

    const fanzaClient = getFanzaClient();
    if (!fanzaClient) {
        return NextResponse.json({ error: 'DB接続エラー' }, { status: 503 });
    }

    const siteDb = getSiteClient();
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
        // Fetch decided product_ids from siteDb (separate DB — can't use subquery cross-DB)
        let excludePlaceholder = '';
        const args: (string | number)[] = [];
        if (siteDb) {
            const decided = await siteDb.execute('SELECT product_id FROM x_post_decisions');
            const decidedIds = decided.rows.map(r => String(r.product_id));
            if (decidedIds.length > 0) {
                excludePlaceholder = `AND product_id NOT IN (${decidedIds.map(() => '?').join(',')})`;
                args.push(...decidedIds);
            }
        }

        const sql = `
            SELECT product_id, title, main_image_url, sample_images_json,
                   affiliate_url, actresses, discount_pct, sale_start_date
            FROM products
            WHERE 1=1
            ${excludePlaceholder}
            ${genreWhere}
            ${orderBy}
            LIMIT ?
        `;
        args.push(limit);

        const result = await fanzaClient.execute({ sql, args });

        const products = result.rows.map(row => {
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

    const { product_id, decision, new_genre } = body;

    const db = getSiteClient();
    if (!db) {
        return NextResponse.json({ error: 'DB接続エラー' }, { status: 503 });
    }

    await initSiteSchema();

    try {
        await db.execute({
            sql: `INSERT OR REPLACE INTO x_post_decisions (product_id, decision, new_genre)
                  VALUES (?, ?, ?)`,
            args: [String(product_id), String(decision), new_genre ? String(new_genre) : null],
        });

        return NextResponse.json({ ok: true });

    } catch (err) {
        console.error('[admin/x-post POST]', err);
        return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
    }
}
