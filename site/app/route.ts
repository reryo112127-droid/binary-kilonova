import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../lib/injectLayout';
import {
    ssrFetchFanzaPreOrders,
    ssrFetchFanzaNewProducts,
    ssrFetchRanking,
    injectSsrScript,
} from '../lib/ssrFetch';
import { edgeLookup, edgeStore } from '../lib/edgeCache';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    // エッジキャッシュ優先(s-maxage窓内は Worker非起動=D1読み取りも発生しない)
    const edge = await edgeLookup(request.url, isMobile ? 'm' : 'w');
    if (edge.hit) return edge.hit;

    const htmlFile = isMobile
        ? '/design/home.html'
        : '/design/web/home.html';

    try {
        let html = await readHtml(request.url, htmlFile);
        html = isMobile ? injectMobileLayout(html, 'home') : injectWebLayout(html);

        // ホームのSEOメタ(旧: title「〜アートワークデータベース」のみ・description/canonical/構造化データ無し)。
        // title最適化＋description＋canonical＋OG＋WebSite(SearchActionでサイトリンク検索ボックス)/Organization を注入。
        const SITE = 'https://avrankings.com';
        const seoTitle = 'AVランキング｜FANZA・MGSの人気AV作品ランキング・新作・女優検索';
        const seoDesc = 'FANZA・MGSのAV作品を人気順にランキング。新作・予約・セール情報、女優別の出演作・サンプル動画・最安値比較まで無料でチェックできます。';
        const ld = [
            { '@context': 'https://schema.org', '@type': 'WebSite', name: 'AVランキング', url: SITE + '/',
              potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${SITE}/search?q={search_term_string}` }, 'query-input': 'required name=search_term_string' } },
            { '@context': 'https://schema.org', '@type': 'Organization', name: 'AVランキング', url: SITE + '/' },
        ];
        const metaBlock = [
            `<title>${seoTitle}</title>`,
            `<meta name="description" content="${seoDesc}"/>`,
            `<link rel="canonical" href="${SITE}/"/>`,
            `<meta property="og:title" content="${seoTitle}"/>`,
            `<meta property="og:description" content="${seoDesc}"/>`,
            `<meta property="og:type" content="website"/>`,
            `<meta property="og:url" content="${SITE}/"/>`,
            `<meta name="twitter:card" content="summary"/>`,
            ...ld.map(j => `<script type="application/ld+json">${JSON.stringify(j)}</script>`),
        ].join('\n');
        html = html.replace(/<title>[^<]*<\/title>/, metaBlock);

        // PC版home.htmlにはH1が無い(h2のみ)ため、索引用のH1を <main> 直後に補う(モバイルは既存H1あり)。
        if (!isMobile) {
            html = html.replace(/<main[^>]*>/, m => m
                + '<h1 class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 text-xl font-bold tracking-tight text-slate-900 dark:text-white">'
                + 'AVランキング — FANZA・MGSの人気AV作品ランキング</h1>');
        }

        // SSRデータ取得・注入（失敗してもクライアントfetchにフォールバック）
        try {
            const [preOrders, newProducts, ranking] = await Promise.all([
                ssrFetchFanzaPreOrders(12),
                ssrFetchFanzaNewProducts(12),
                ssrFetchRanking(10),
            ]);
            html = injectSsrScript(html, '__SSR_HOME_DATA__', { preOrders, newProducts, ranking });
        } catch (e) {
            console.error('SSR home data fetch failed:', e);
        }

        const resp = new NextResponse(html, {
            // Cache API に保存。s-maxage(30分)窓内のアクセスは Worker非起動で返り、D1優先化した予約取得の
            // D1読み取りも窓ごとに1回へ激減。予約/新作/ランキングは日次更新なので30分鮮度で十分。bfcacheは max-age=60 で維持。
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, s-maxage=1800, max-age=60',
                'CDN-Cache-Control': 'public, s-maxage=1800',
            },
        });
        await edgeStore(edge, resp);
        return resp;
    } catch {
        return new NextResponse('Not found', { status: 404 });
    }
}
