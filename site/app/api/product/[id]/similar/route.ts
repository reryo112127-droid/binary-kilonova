import { NextRequest, NextResponse } from 'next/server';
import { getMgsClient, getFanzaClient } from '../../../../../lib/turso';
import { filterActresses } from '../../../../../lib/actressFilter';
import { getCached, setCached } from '../../../../../lib/apiCache';

const SIMILAR_TTL = 30 * 60 * 1000; // 30分

export const dynamic = 'force-dynamic';

// タイトルから特徴的なキーワードを抽出
function extractTitleKeywords(title: string): string[] {
    if (!title) return [];
    // 括弧・記号を除去、長さ2以上の単語を抽出
    const cleaned = title
        .replace(/【[^】]*】/g, '') // 【...】を除去
        .replace(/[「」『』【】〔〕\[\]（）()]/g, ' ')
        .replace(/[!！?？。、・～〜\-_\/\\|]/g, ' ')
        .trim();
    // スペースで分割、2文字以上の日本語/英数字トークンを抽出
    const tokens = cleaned.split(/\s+/).filter(t => t.length >= 2);
    // 一般的すぎる語を除外
    const STOP = new Set(['the','vol','No','DVD','HD','with','and','for','that','new','全て','完全','収録','作品','映像','特典','限定']);
    return tokens.filter(t => !STOP.has(t)).slice(0, 4);
}

type ProductRow = Record<string, unknown>;

function toProduct(row: ProductRow, source: string) {
    return {
        product_id: String(row.product_id ?? ''),
        title: String(row.title ?? ''),
        main_image_url: String(row.main_image_url ?? ''),
        actresses: filterActresses(
            (row.actresses as string | null) || null,
            (row.genres as string | null) || null,
            (row.maker as string | null) || null,
        ),
        maker: String(row.maker ?? ''),
        genres: String(row.genres ?? ''),
        source,
    };
}

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;

    const cacheKey = `similar_${id}`;
    const cached = getCached<ReturnType<typeof toProduct>[]>(cacheKey, SIMILAR_TTL);
    if (cached) return NextResponse.json(cached);

    const mgsClient = getMgsClient();
    const fanzaClient = getFanzaClient();

    // ─── まず対象作品を取得 ───────────────────────────────────
    let base: ProductRow | null = null;
    let baseSource = 'mgs';

    if (mgsClient) {
        const r = await mgsClient.execute({ sql: 'SELECT * FROM products WHERE product_id = ?', args: [id] }).catch(() => null);
        if (r?.rows.length) { base = { ...r.rows[0] } as ProductRow; baseSource = 'mgs'; }
    }
    if (!base && fanzaClient) {
        const r = await fanzaClient.execute({ sql: 'SELECT * FROM products WHERE product_id = ?', args: [id] }).catch(() => null);
        if (r?.rows.length) { base = { ...r.rows[0] } as ProductRow; baseSource = 'fanza'; }
    }
    if (!base) return NextResponse.json([]);

    const baseGenres  = String(base.genres   ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const baseActresses = String(base.actresses ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const baseMaker   = String(base.maker    ?? '').trim();
    const baseTitle   = String(base.title    ?? '');
    const titleKws    = extractTitleKeywords(baseTitle);

    // ─── 候補作品を並列取得 ───────────────────────────────────
    const SAMPLE = 40;
    const fetches: Promise<{ rows: ProductRow[]; src: string }[]>[] = [];

    // ① 同じ女優の作品
    if (baseActresses.length) {
        const actQuery = baseActresses.slice(0, 2).map(a => `"${a.replace(/"/g, '')}"`).join(' OR ');
        const actSql = `SELECT product_id,title,main_image_url,actresses,maker,genres FROM products WHERE actresses IS NOT NULL AND product_id != ? ORDER BY wish_count DESC, scraped_at DESC LIMIT ${SAMPLE}`;
        if (mgsClient) fetches.push(mgsClient.execute({ sql: `SELECT product_id,title,main_image_url,actresses,maker,genres FROM products WHERE actresses LIKE ? AND product_id != ? ORDER BY wish_count DESC LIMIT ${SAMPLE}`, args: [`%${baseActresses[0]}%`, id] }).then(r => [{ rows: r.rows as ProductRow[], src: 'mgs' }]).catch(() => []));
        if (fanzaClient) fetches.push(fanzaClient.execute({ sql: `SELECT product_id,title,main_image_url,actresses,maker,genres FROM products WHERE actresses LIKE ? AND product_id != ? ORDER BY wish_count DESC LIMIT ${SAMPLE}`, args: [`%${baseActresses[0]}%`, id] }).then(r => [{ rows: r.rows as ProductRow[], src: 'fanza' }]).catch(() => []));
        void actQuery; void actSql;
    }

    // ② 同じメーカーの作品（人気順）
    if (baseMaker) {
        if (mgsClient) fetches.push(mgsClient.execute({ sql: `SELECT product_id,title,main_image_url,actresses,maker,genres FROM products WHERE maker = ? AND product_id != ? ORDER BY wish_count DESC LIMIT ${SAMPLE}`, args: [baseMaker, id] }).then(r => [{ rows: r.rows as ProductRow[], src: 'mgs' }]).catch(() => []));
        if (fanzaClient) fetches.push(fanzaClient.execute({ sql: `SELECT product_id,title,main_image_url,actresses,maker,genres FROM products WHERE maker = ? AND product_id != ? ORDER BY wish_count DESC LIMIT ${SAMPLE}`, args: [baseMaker, id] }).then(r => [{ rows: r.rows as ProductRow[], src: 'fanza' }]).catch(() => []));
    }

    // ③ 上位ジャンル一致
    if (baseGenres.length) {
        const g = baseGenres[0];
        if (mgsClient) fetches.push(mgsClient.execute({ sql: `SELECT product_id,title,main_image_url,actresses,maker,genres FROM products WHERE genres LIKE ? AND product_id != ? ORDER BY wish_count DESC LIMIT ${SAMPLE}`, args: [`%${g}%`, id] }).then(r => [{ rows: r.rows as ProductRow[], src: 'mgs' }]).catch(() => []));
        if (fanzaClient) fetches.push(fanzaClient.execute({ sql: `SELECT product_id,title,main_image_url,actresses,maker,genres FROM products WHERE genres LIKE ? AND product_id != ? ORDER BY wish_count DESC LIMIT ${SAMPLE}`, args: [`%${g}%`, id] }).then(r => [{ rows: r.rows as ProductRow[], src: 'fanza' }]).catch(() => []));
    }

    // ④ タイトルキーワード一致
    if (titleKws.length) {
        const kw = titleKws[0];
        if (mgsClient) fetches.push(mgsClient.execute({ sql: `SELECT product_id,title,main_image_url,actresses,maker,genres FROM products WHERE title LIKE ? AND product_id != ? ORDER BY wish_count DESC LIMIT 20`, args: [`%${kw}%`, id] }).then(r => [{ rows: r.rows as ProductRow[], src: 'mgs' }]).catch(() => []));
        if (fanzaClient) fetches.push(fanzaClient.execute({ sql: `SELECT product_id,title,main_image_url,actresses,maker,genres FROM products WHERE title LIKE ? AND product_id != ? ORDER BY wish_count DESC LIMIT 20`, args: [`%${kw}%`, id] }).then(r => [{ rows: r.rows as ProductRow[], src: 'fanza' }]).catch(() => []));
    }

    const batches = (await Promise.all(fetches)).flat();

    // ─── スコアリング & デduplication ────────────────────────
    const seen = new Set<string>();
    const scored: Array<ReturnType<typeof toProduct> & { _score: number }> = [];

    for (const { rows, src } of batches) {
        for (const row of rows) {
            const pid = String(row.product_id ?? '');
            if (!pid || seen.has(pid)) continue;
            seen.add(pid);

            const prod = toProduct(row, src);
            const rowGenres   = prod.genres.split(',').map(s => s.trim()).filter(Boolean);
            const rowActresses = String(row.actresses ?? '').split(',').map(s => s.trim()).filter(Boolean);
            const rowTitle    = prod.title;

            let score = 0;
            // ジャンル一致 (最大5点)
            score += rowGenres.filter(g => baseGenres.includes(g)).length;
            // 女優一致 (3点/人)
            score += rowActresses.filter(a => baseActresses.includes(a)).length * 3;
            // メーカー一致 (1点)
            if (prod.maker && prod.maker === baseMaker) score += 1;
            // タイトルキーワード一致 (1点/語)
            score += titleKws.filter(kw => rowTitle.includes(kw)).length;

            scored.push({ ...prod, _score: score });
        }
    }

    // スコア降順 → 上位8件
    scored.sort((a, b) => b._score - a._score);
    const result = scored.slice(0, 8).map(({ _score: _, ...p }) => p);

    setCached(cacheKey, result);
    return NextResponse.json(result);
}
