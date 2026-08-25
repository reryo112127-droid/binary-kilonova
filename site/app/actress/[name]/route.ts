import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../../../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../../../lib/injectLayout';
import { fetchProducts, productCardsHtml, replaceGridInner, esc, type Product } from '../../../lib/landingPage';
import { edgeLookup, edgeStore } from '../../../lib/edgeCache';
import { fetchActressProfile, profileHtml, profileSummary } from '../../../lib/actressProfile';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://avrankings.com';
const SSR_COUNT = 30;

// 取得作品の出演者から、本人以外の共演女優を頻度順に抽出(内部リンク用)
function collectCoStars(products: Product[], self: string): string[] {
    const selfNorm = self.trim();
    const clean = (s: string) => !!s && s.length > 1 && s.length <= 30 && !/\d+歳|[（()【】\[\]]/.test(s) && s !== '----';
    const counts = new Map<string, number>();
    for (const p of products) {
        for (const raw of String(p.actresses || '').split(/[,、/／]+/)) {
            const n = raw.trim();
            if (!clean(n) || n === selfNorm) continue;
            counts.set(n, (counts.get(n) || 0) + 1);
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n]) => n);
}

const pagePath = (base: string, p: number) => (p > 0 ? `${base}?page=${p}` : base);

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ name: string }> },
) {
    const { name } = await params;
    const actressName = decodeURIComponent(name);
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);
    const htmlFile = isMobile ? '/design/search-actress.html' : '/design/web/search-actress.html';

    const page = Math.max(0, parseInt(new URL(request.url).searchParams.get('page') || '0', 10) || 0);
    const offset = page * SSR_COUNT;

    // エッジキャッシュ優先(再クロール・リピート訪問は Worker非起動=無料枠を保護)
    const edge = await edgeLookup(request.url, isMobile ? 'm' : 'w');
    if (edge.hit) return edge.hit;

    try {
        // 出演作品をD1から同一プロセスで取得(本番でSSRカード化＝索引可能に)。
        const apiQuery = `actress=${encodeURIComponent(actressName)}&sort=wish_count`;
        // プロフィールは静的シャード(0.4MB以下)から。作品取得と並行して引く。
        const [products, profile] = await Promise.all([
            fetchProducts(request, apiQuery, SSR_COUNT, offset),
            fetchActressProfile(actressName),
        ]);
        // 作品0件(=中身が空)は 200の薄いHTMLだとGoogleが「ソフト404」と判定するため404を返す。
        if (products.length === 0) return new NextResponse('Not found', { status: 404 });
        const hasNext = products.length === SSR_COUNT;
        const coStars = collectCoStars(products, actressName);
        const noindex = false; // 0件は上で404済み。ここに来るのは作品ありのページ

        let html = await readHtml(request.url, htmlFile);
        html = isMobile ? injectMobileLayout(html, 'search') : injectWebLayout(html);

        // プレースホルダ「女優名」を実名へ(生HTMLでGooglebotに実名が見えるように)
        html = html.replace(/(<h1[^>]*>)女優名(<\/h1>)/, `$1${esc(actressName)}$2`);
        html = html.replace(/(<h2 id="actress-name"[^>]*>)女優名(<\/h2>)/, `$1${esc(actressName)}$2`);

        // ─ SEO meta(既存ベース＋ItemList/Breadcrumb、ページネーション、noindex) ─
        const base = `/actress/${encodeURIComponent(actressName)}`;
        const canonical = `${SITE_URL}${pagePath(base, page)}`;
        const seoTitle = `${esc(actressName)} | AV女優 出演作品・プロフィール | AVランキング`;
        // 身長/カップ/出身を description に入れて「女優名＋身長」等の長尾クエリに当てる
        const desc = `${esc(actressName)}の出演AV作品を人気順に掲載。${esc(profileSummary(profile))}`
            + `FANZA・MGSの新作・人気作・サンプル動画・最安値をまとめてチェック。`;
        const person: Record<string, unknown> = {
            '@context': 'https://schema.org', '@type': 'Person', name: actressName, url: `${SITE_URL}${base}`,
        };
        {
            const h = parseInt(String(profile?.height ?? ''), 10);
            if (Number.isFinite(h) && h > 0) person.height = { '@type': 'QuantitativeValue', value: h, unitCode: 'CMT' };
            if (profile?.birthday && /^\d{4}-\d{2}-\d{2}/.test(profile.birthday)) person.birthDate = profile.birthday.slice(0, 10);
            if (profile?.image_url) person.image = profile.image_url;
            const alt = (profile?.aliases ?? []).filter(a => a && a !== actressName).slice(0, 6);
            if (alt.length) person.alternateName = alt;
        }
        const ld = [
            person,
            {
                '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'ホーム', item: `${SITE_URL}/` },
                    { '@type': 'ListItem', position: 2, name: 'AV女優', item: `${SITE_URL}/ranking/actress` },
                    { '@type': 'ListItem', position: 3, name: actressName, item: `${SITE_URL}${base}` },
                ],
            },
        ];
        if (products.length) ld.push({
            '@context': 'https://schema.org', '@type': 'ItemList', name: `${actressName}の出演作品`,
            itemListElement: products.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE_URL}/product/${encodeURIComponent(String(p.product_id))}` })),
        } as unknown as typeof ld[0]);

        const metaBlock = [
            `<title>${seoTitle}</title>`,
            `<meta name="description" content="${desc}"/>`,
            noindex ? `<meta name="robots" content="noindex,follow"/>` : '',
            `<link rel="canonical" href="${canonical}"/>`,
            page > 0 ? `<link rel="prev" href="${SITE_URL}${pagePath(base, page - 1)}"/>` : '',
            hasNext ? `<link rel="next" href="${SITE_URL}${pagePath(base, page + 1)}"/>` : '',
            `<meta property="og:title" content="${seoTitle}"/>`,
            `<meta property="og:description" content="${desc}"/>`,
            `<meta property="og:url" content="${canonical}"/>`,
            `<meta property="og:type" content="profile"/>`,
            profile?.image_url ? `<meta property="og:image" content="${esc(profile.image_url)}"/>` : '',
            `<meta name="twitter:card" content="summary"/>`,
            ...ld.map(j => `<script type="application/ld+json">${JSON.stringify(j)}</script>`),
        ].filter(Boolean).join('\n');
        html = html.replace(/<title>[^<]*<\/title>/, metaBlock);

        // プロフィール表＋固有intro文をグリッド直前に挿入(索引テキスト)
        const profileBlock = profileHtml(actressName, profile, esc);
        // プロフィール表を出せたときは同じ内容をintroに繰り返さない
        const introFacts = profileBlock ? '' : profileSummary(profile);
        const intro = profileBlock
            + `<section class="px-4 pt-2 pb-1"><p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">`
            + `${esc(actressName)}の出演AV作品を人気順に表示しています。${esc(introFacts)}`
            + `サンプル動画・両プラットフォームの最安値・共演女優を確認できます。`
            + `</p></section>`;
        html = html.replace(/<div[^>]*id="products-grid"[^>]*>/, m => intro + m);

        // SSR作品カードをグリッドへ(クライアントの埋め込みローダが上書きするが、生HTMLには残り索引に効く)
        if (products.length) html = replaceGridInner(html, productCardsHtml(products));

        // 共演女優リンク＋ページネーションをフッター前へ
        let extra = '';
        if (coStars.length) {
            extra += `<section class="px-4 py-4 border-t border-slate-200 dark:border-slate-800"><h2 class="text-sm font-bold mb-2 text-slate-700 dark:text-slate-300">共演が多い女優</h2><div class="flex flex-wrap gap-2">`
                + coStars.map(c => `<a class="inline-flex items-center rounded-full border border-slate-200 dark:border-slate-700 px-3 py-1 text-xs hover:border-primary hover:text-primary" href="/actress/${encodeURIComponent(c)}">${esc(c)}</a>`).join('')
                + `</div></section>`;
        }
        if (page > 0 || hasNext) {
            const link = (href: string, label: string) => `<a class="rounded-full border border-slate-200 dark:border-slate-700 px-4 py-1.5 text-xs font-medium hover:border-primary hover:text-primary" href="${esc(href)}">${label}</a>`;
            const prev = page > 0 ? link(pagePath(base, page - 1), '‹ 前へ') : '<span></span>';
            const next = hasNext ? link(pagePath(base, page + 1), '次へ ›') : '<span></span>';
            extra += `<nav class="flex items-center justify-between px-4 py-4">${prev}<span class="text-[11px] text-slate-400">ページ ${page + 1}</span>${next}</nav>`;
        }
        if (extra) html = html.replace('<footer id="site-footer"', extra + '<footer id="site-footer"');

        const resp = new NextResponse(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, s-maxage=3600, max-age=120', 'CDN-Cache-Control': 'public, s-maxage=3600' },
        });
        await edgeStore(edge, resp);
        return resp;
    } catch {
        return new NextResponse('Not found', { status: 404 });
    }
}
