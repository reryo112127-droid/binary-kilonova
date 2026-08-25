import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../../../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../../../lib/injectLayout';
import { getMgsClient, getFanzaClient } from '../../../lib/turso';
import { filterActresses } from '../../../lib/actressFilter';
import { r2GetProduct } from '../../../lib/productR2';
import { loadGenres, loadMakers, isIndexableProduct } from '../../../lib/lpData';
import { fetchActressProfile } from '../../../lib/actressProfile';
import { edgeLookup, edgeStore } from '../../../lib/edgeCache';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

function escHtml(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// パッケージ画像のSNS用URL（MGS裏→表紙、素人jm→jp-001）
function posterUrl(u: string): string {
    if (!u) return '';
    if (u.includes('pb_e_')) return u.replace('pb_e_', 'pf_e_');
    if (u.includes('/digital/amateur/') && u.endsWith('jm.jpg')) return u.replace('jm.jpg', 'jp-001.jpg');
    return u;
}

// SSR用プロダクトデータの取得（R2 read-through）
const _ssrProductCache = new Map<string, { data: Record<string, unknown>; at: number }>();
const SSR_PRODUCT_TTL = 24 * 60 * 60 * 1000;

async function fetchProduct(id: string): Promise<Record<string, unknown> | null> {
    // in-memoryキャッシュ（同一isolate内）
    const mem = _ssrProductCache.get(id);
    if (mem && Date.now() - mem.at < SSR_PRODUCT_TTL) return mem.data;

    // R2 read-through: /api/product/[id] が保存した全フィールドエントリを共有利用
    // （SSRはtitle/actresses/maker等の一部のみ使用）
    const r2 = await r2GetProduct(id);
    if (r2) {
        _ssrProductCache.set(id, { data: r2, at: Date.now() });
        return r2;
    }

    // R2 miss: Turso最小クエリ（R2書き込みはAPI側に任せ、全フィールドで保存させる）
    const SQL = 'SELECT product_id, title, actresses, maker, label, genres, main_image_url, sale_start_date FROM products WHERE product_id = ? LIMIT 1';
    let result: Record<string, unknown> | null = null;

    const fanzaClient = await getFanzaClient();
    if (fanzaClient) {
        try {
            const r = await fanzaClient.execute({ sql: SQL, args: [id] });
            if (r.rows.length > 0) result = { ...r.rows[0] } as Record<string, unknown>;
        } catch { /* fallthrough */ }
    }
    if (!result) {
        const mgsClient = await getMgsClient();
        if (mgsClient) {
            try {
                const r = await mgsClient.execute({ sql: SQL, args: [id] });
                if (r.rows.length > 0) result = { ...r.rows[0] } as Record<string, unknown>;
            } catch { /* ignore */ }
        }
    }

    if (result) _ssrProductCache.set(id, { data: result, at: Date.now() });
    return result;
}

// OGP用: 女優プロフィール画像をASSETS静的JSONから取得（Tursoクエリ廃止）
// 供給源は actress_display/<nn>.json シャード(16,652人ぶんの画像)。集約版の actress_profiles.json は
// フィルタ用に cup/height/birthday だけへ痩せさせたので image_url を持たない。
async function fetchActressImageUrl(actressName: string): Promise<string | null> {
    if (!actressName) return null;
    const profile = await fetchActressProfile(actressName);
    return profile?.image_url ?? null;
}

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://avrankings.com';

function injectSEOMeta(html: string, product: Record<string, unknown> | null, id: string, actressImageUrl: string | null, preferPackage = false): string {
    const displayId = id.toUpperCase();

    // 女優名フィルタ適用
    const actresses = product
        ? filterActresses(
            (product.actresses as string | null) || null,
            (product.genres as string | null) || null,
            (product.maker as string | null) || null,
          ) || ''
        : '';

    const title    = product ? String(product.title   || '') : '';
    const maker    = product ? String(product.maker   || '') : '';
    const imgUrl   = product ? String(product.main_image_url || '') : '';
    const saleDate = product ? String(product.sale_start_date || '') : '';

    // タイトル: 「作品タイトル 出演者(最大2名) 品番 | AVランキング」。
    // 流入はほぼ品番検索なので品番は必須。旧実装は女優名を全員羅列し作品タイトルを使わず(20人羅列/品番のみ)
    // 検索スニペットが弱くCTRを取りこぼしていた。作品名を主役にし女優は先頭2名までに絞る。ブランド名はホームと統一。
    const actShort = actresses
        ? actresses.split(',').map(s => s.trim()).filter(Boolean).slice(0, 2).join(', ')
        : '';
    const titleHead = [title.slice(0, 42), actShort].filter(Boolean).join(' ');
    const seoTitle = titleHead
        ? `${titleHead} ${displayId} | AVランキング`
        : `${displayId} | AVランキング`;

    // Description: 130字以内(作品名を先頭に、空要素は除外)
    const descParts = [title.slice(0, 80)];
    if (actresses) descParts.push(`出演: ${actresses.split(',').slice(0, 5).join(', ')}`);
    if (maker)     descParts.push(`制作: ${maker}`);
    if (saleDate)  descParts.push(`配信: ${saleDate}`);
    const desc = descParts.filter(Boolean).join(' | ').slice(0, 130);

    // OGP画像: 通常は女優プロフィール写真（非露骨）を優先。
    // ?og=pkg（SNS自動投稿フィード経由）の時はパッケージ表紙を使う（投稿で画像カードを出すため）。
    const ogImageUrl = preferPackage ? (posterUrl(imgUrl) || actressImageUrl || '') : (actressImageUrl || '');

    // JSON-LD (VideoObject) にはパッケージ画像を使用（検索エンジン向け）
    const actorList = actresses
        ? actresses.split(',').map(a => ({ '@type': 'Person', name: a.trim() }))
        : undefined;
    const jsonLd: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'VideoObject',
        name: title || displayId,
        description: desc,
    };
    if (imgUrl)    jsonLd.thumbnailUrl = imgUrl;
    if (actorList) jsonLd.actor = actorList;
    if (maker)     jsonLd.productionCompany = { '@type': 'Organization', name: maker };

    const canonicalUrl = `${SITE_URL}/product/${encodeURIComponent(id)}`;
    const metaBlock = [
        `<title>${escHtml(seoTitle)}</title>`,
        `<meta name="description" content="${escHtml(desc)}"/>`,
        `<link rel="canonical" href="${canonicalUrl}"/>`,
        `<meta property="og:title" content="${escHtml(seoTitle)}"/>`,
        `<meta property="og:description" content="${escHtml(desc)}"/>`,
        `<meta property="og:type" content="video.other"/>`,
        `<meta property="og:url" content="${canonicalUrl}"/>`,
        ogImageUrl ? `<meta property="og:image" content="${escHtml(ogImageUrl)}"/>` : '',
        ogImageUrl
            ? `<meta name="twitter:card" content="summary_large_image"/>`
            : `<meta name="twitter:card" content="summary"/>`,
        `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
    ].filter(Boolean).join('\n');

    // 既存の<title>タグをメタブロック全体に差し替え
    return html.replace(/<title>[^<]*<\/title>/, metaBlock);
}

// 作品の出演ジャンル・メーカーを、対応LPが存在するもの(キャッシュ掲載=有効ページ)に限り
// クロール可能な内部リンクとして本文末に挿入する(404リンクを作らない)。
async function injectProductLinks(html: string, product: Record<string, unknown> | null): Promise<string> {
    if (!product) return html;
    const [genres, makers] = await Promise.all([loadGenres(), loadMakers()]);
    const gset = new Set(genres.map(g => g.name));
    const mset = new Set(makers.map(m => m.name));
    const chip = (href: string, label: string) =>
        `<a class="inline-flex items-center rounded-full border border-slate-200 dark:border-slate-700 px-3 py-1 text-xs hover:border-primary hover:text-primary transition-colors" href="${href}">${escHtml(label)}</a>`;
    const links: string[] = [];
    for (const g of String(product.genres || '').split(/[,、]/).map(s => s.trim()).filter(Boolean)) {
        if (gset.has(g)) links.push(chip(`/genre/${encodeURIComponent(g)}`, g));
        if (links.length >= 10) break;
    }
    const maker = String(product.maker || '').trim();
    if (maker && mset.has(maker)) links.push(chip(`/maker/${encodeURIComponent(maker)}`, maker));
    const label = String(product.label || '').trim();
    if (label && label !== maker && mset.has(label)) links.push(chip(`/maker/${encodeURIComponent(label)}`, label));
    if (!links.length) return html;
    const block = `<section class="px-4 py-4 border-t border-slate-200 dark:border-slate-800">`
        + `<p class="font-bold text-xs mb-2 text-slate-700 dark:text-slate-300">関連ジャンル・メーカー</p>`
        + `<div class="flex flex-wrap gap-2">${links.join('')}</div></section>`;
    return html.replace('</body>', block + '\n</body>');
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    // エッジキャッシュ(Cache API)優先。ヒットすれば Worker/D1/R2 を一切叩かず返す＝無料枠を保護。
    const edge = await edgeLookup(request.url, isMobile ? 'm' : 'w');
    if (edge.hit) return edge.hit;

    const htmlFile = isMobile
        ? '/design/product-detail.html'
        : '/design/web/product-detail.html';

    try {
        // 作品データ取得（先に取得し、存在しない品番は空HTMLの200ではなく404を返す）。
        // 削除済み作品(Best/総集編/低品質メーカー約8.8万件削除)やD1に無い品番のURLを200で返すと
        // Googleが「ソフト404(中身が空)」と判定しインデックス品質を落とすため、実データが無ければ404にする。
        const product = await fetchProduct(id);
        if (!product) return new NextResponse('Not found', { status: 404 });

        let html = await readHtml(request.url, htmlFile);

        // OGP用: 女優プロフィール画像を並列取得（露骨なパッケージ画像の代替）
        let actressImageUrl: string | null = null;
        if (product?.actresses) {
            const filtered = filterActresses(
                String(product.actresses),
                String(product.genres || ''),
                String(product.maker || '')
            );
            const firstName = filtered?.split(',')[0]?.trim();
            if (firstName) {
                actressImageUrl = await fetchActressImageUrl(firstName);
            }
        }

        // ?og=pkg のときは og:image にパッケージ表紙を使う（SNS自動投稿フィード用）
        const preferPackage = new URL(request.url).searchParams.get('og') === 'pkg';
        html = injectSEOMeta(html, product, id, actressImageUrl, preferPackage);
        // 索引対象(18メーカー＋人気作)以外は noindex。Googleの索引/クロールを売れ筋に集中させ無料枠超過を防ぐ。
        if (!(await isIndexableProduct(id))) {
            html = html.replace('</head>', '<meta name="robots" content="noindex,follow"/>\n</head>');
        }
        html = await injectProductLinks(html, product); // 関連ジャンル/メーカーへの内部リンク

        html = isMobile ? injectMobileLayout(html) : injectWebLayout(html);
        const resp = new NextResponse(html, {
            // Cache API に保存され、再クロール・リピート訪問は Worker非起動で返る=無料枠の消費を大幅削減。
            // max-age=60 で bfcache(戻る復元)維持。価格は最大1時間古くなり得るが R2 read-through(1h)もあり許容。
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, s-maxage=3600, max-age=60',
                'CDN-Cache-Control': 'public, s-maxage=3600',
            },
        });
        await edgeStore(edge, resp);
        return resp;
    } catch {
        return new NextResponse('Not found', { status: 404 });
    }
}
