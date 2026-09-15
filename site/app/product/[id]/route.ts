import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../../../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../../../lib/injectLayout';
import { getMgsClient, getFanzaClient } from '../../../lib/turso';
import { filterActresses } from '../../../lib/actressFilter';
import { loadGenres, loadMakers, isIndexableProduct } from '../../../lib/lpData';
import { fetchActressProfile } from '../../../lib/actressProfile';
import { edgeLookup, edgeStore } from '../../../lib/edgeCache';
import { readShardProduct } from '../../../lib/productShard';
import { readLpCards } from '../../../lib/lpCache';
import { fillById, carouselCardHtml, productCardsHtml, type Product } from '../../../lib/landingPage';

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

// SSR用プロダクトデータの取得
// （R2 read-through は課金のため 2026-07-04 に停止し、2026-09-15 にコードごと撤去。D1 直取得＋エッジキャッシュ）
const _ssrProductCache = new Map<string, { data: Record<string, unknown>; at: number }>();
const SSR_PRODUCT_TTL = 24 * 60 * 60 * 1000;

async function fetchProduct(id: string): Promise<Record<string, unknown> | null> {
    // in-memoryキャッシュ（同一isolate内）
    const mem = _ssrProductCache.get(id);
    if (mem && Date.now() - mem.at < SSR_PRODUCT_TTL) return mem.data;

    // D1 の最小クエリ（SSRはtitle/actresses/maker等の一部のみ使用）
    // series_name は FANZA だけが持つ（同じシリーズの作品への内部リンクに使う）
    const SQL = 'SELECT product_id, title, actresses, maker, label, genres, main_image_url, sale_start_date, duration_min, series_name FROM products WHERE product_id = ? LIMIT 1';
    // MGS だけが商品発売日(release_date)を持つ（旧作の再配信で配信開始日と食い違う）
    const SQL_MGS = 'SELECT product_id, title, actresses, maker, label, genres, main_image_url, sale_start_date, release_date, duration_min FROM products WHERE product_id = ? LIMIT 1';
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
                const r = await mgsClient.execute({ sql: SQL_MGS, args: [id] });
                if (r.rows.length > 0) result = { ...r.rows[0] } as Record<string, unknown>;
            } catch { /* ignore */ }
        }
    }

    if (result) {
        _ssrProductCache.set(id, { data: result, at: Date.now() });
        return result;
    }

    // D1 が枠切れ/障害のときは静的シャードでタイトル・出演者だけでも出す（OGP と H1 が空にならない）。
    // 不完全なので isolate キャッシュには載せず、D1 が戻り次第そちらを使う。
    return await readShardProduct(id);
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

/**
 * 配信日を ISO 8601（JST）へ（構造化データの datePublished 用）。
 * FANZA '2018-11-30 10:00:53' / MGS '2024/01/05' の両形式に対応。
 */
function isoJst(v: string): string {
    const m = v.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return '';
    const p = (x: string | undefined) => (x ?? '0').padStart(2, '0');
    return `${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4])}:${p(m[5])}:${p(m[6])}+09:00`;
}

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
    // 旧作の再配信は配信開始日だけ新しい。商品発売日が別にあれば併記し、構造化データは古い方を使う。
    const dayOf = (s: string) => s.replace(/\//g, '-').slice(0, 10);
    const rawRelease = product ? String(product.release_date || '') : '';
    const releaseDate = rawRelease && dayOf(rawRelease) !== dayOf(saleDate) ? rawRelease : '';

    // タイトル: 「作品タイトル 出演者(最大2名) 品番 | AVランキング」。
    // 流入はほぼ品番検索なので品番は必須。旧実装は女優名を全員羅列し作品タイトルを使わず(20人羅列/品番のみ)
    // 検索スニペットが弱くCTRを取りこぼしていた。作品名を主役にし女優は先頭2名までに絞る。ブランド名はホームと統一。
    // 作品名に既に入っている女優名は重ねない（「…AVデビュー！！ 百瀬とあ 百瀬とあ MIFD00060」になっていた）。
    // 判定は title に載せる先頭42字で行う（切り捨てで消える名前は付け直す）。
    const titlePart = title.slice(0, 42);
    const actShort = actresses
        ? actresses.split(',').map(s => s.trim()).filter(a => a && !titlePart.includes(a)).slice(0, 2).join(', ')
        : '';
    const titleHead = [titlePart, actShort].filter(Boolean).join(' ');
    const seoTitle = titleHead
        ? `${titleHead} ${displayId} | AVランキング`
        : `${displayId} | AVランキング`;

    // Description: 130字以内(作品名を先頭に、空要素は除外)
    const descParts = [title.slice(0, 80)];
    if (actresses) descParts.push(`出演: ${actresses.split(',').slice(0, 5).join(', ')}`);
    if (maker)     descParts.push(`制作: ${maker}`);
    if (saleDate)  descParts.push(`配信: ${saleDate}${releaseDate ? `（発売: ${releaseDate}）` : ''}`);
    const desc = descParts.filter(Boolean).join(' | ').slice(0, 130);

    // OGP画像: 通常は女優プロフィール写真（非露骨）を優先。
    // ?og=pkg（SNS自動投稿フィード経由）の時はパッケージ表紙を使う（投稿で画像カードを出すため）。
    const ogImageUrl = preferPackage ? (posterUrl(imgUrl) || actressImageUrl || '') : (actressImageUrl || '');

    // JSON-LD は **Movie**（作品そのものの説明）。以前は VideoObject を出していたが、作品ページには
    // 読み込み時点で再生できる動画が無い（サンプルはボタンで外部プレーヤーを開くだけ）ため、
    // Search Console で 4,030件が「動画再生ページに動画がありません」になっていた（2026-09-13 確認）。
    // VideoObject は「このページの主役が動画」という宣言なので、動画を置けない限り出さない。
    const actorList = actresses
        ? actresses.split(',').map(a => ({ '@type': 'Person', name: a.trim() }))
        : undefined;
    const jsonLd: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'Movie',
        name: title || displayId,
        description: desc,
    };
    if (imgUrl)    jsonLd.image = imgUrl; // パッケージ画像（検索エンジン向け）
    const published = isoJst(releaseDate && dayOf(releaseDate) < dayOf(saleDate) ? releaseDate : saleDate);
    if (published) jsonLd.datePublished = published;
    const durMin = Number(product?.duration_min);
    if (Number.isFinite(durMin) && durMin > 0) jsonLd.duration = `PT${Math.round(durMin)}M`;
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

/**
 * 出演者欄の生の値を「実在女優」と「素人名義（年齢・職業入りの通称）」に分ける。
 * 表示用の filterActresses は素人作品で通称を落とすので、名義を出すには生の値から拾い直す。
 * seesaawiki で本人が特定された作品は「ひなこ 24歳 広告代理店, 瀬戸ひなこ」の形で入っている。
 */
function splitCast(product: Record<string, unknown>): { real: string[]; alias: string[] } {
    const raw = String(product.actresses || '');
    const filtered = filterActresses(raw || null, String(product.genres || '') || null, String(product.maker || '') || null) || '';
    const real = filtered.split(',').map(s => s.trim()).filter(Boolean);
    const strip = (s: string) => s.replace(/（[^）]*）|\([^)]*\)/g, '').trim();
    const realSet = new Set(real.map(strip));
    const alias = raw.replace(/（[^）]*）/g, m => m.replace(/[,、]/g, ' '))
        .split(/[,、]/).map(s => s.trim())
        .filter(s => s && !/^[＊*\-]+$/.test(s) && !realSet.has(strip(s)));
    return { real, alias: alias.slice(0, 3) };
}

/**
 * 関連作品（同じ女優 → 同じシリーズ → 同じメーカー）を静的キャッシュから集める。D1 は読まない。
 * 作品ページは他の作品へのリンクが0本の行き止まりだった（2026-09-15 実測）。
 */
async function relatedCards(product: Record<string, unknown>, id: string, real: string[]): Promise<Product[]> {
    const seen = new Set([id.toLowerCase()]);
    const out: Product[] = [];
    const add = (cards: Product[] | null | undefined, max: number) => {
        let n = 0;
        for (const c of cards ?? []) {
            const k = String(c.product_id).toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k); out.push(c); n++;
            if (n >= max || out.length >= 12) break;
        }
    };
    const series = String(product.series_name || '').trim();
    const maker = String(product.maker || '').trim();
    const [a1, a2, s, m] = await Promise.all([
        real[0] ? readLpCards('actress', real[0]).catch(() => null) : null,
        real[1] ? readLpCards('actress', real[1]).catch(() => null) : null,
        series ? readLpCards('series', series).catch(() => null) : null,
        maker ? readLpCards('maker', maker).catch(() => null) : null,
    ]);
    add(a1, 8); add(a2, 4); add(s, 12); add(m, 12);
    return out.slice(0, 12);
}

// 作品の出演ジャンル・メーカーを、対応LPが存在するもの(キャッシュ掲載=有効ページ)に限り
// クロール可能な内部リンクとして本文末に挿入する(404リンクを作らない)。
// あわせて出演者欄・おすすめ作品欄をサーバ側で埋める（クライアントJSは同じ id を innerHTML で
// 描き直すので二重にはならない）。
async function injectProductLinks(html: string, product: Record<string, unknown> | null, id: string, isMobile: boolean): Promise<string> {
    if (!product) return html;
    const { real, alias } = splitCast(product);
    const [genres, makers, related] = await Promise.all([loadGenres(), loadMakers(), relatedCards(product, id, real)]);
    const gset = new Set(genres.map(g => g.name));
    const mset = new Set(makers.map(m => m.name));
    const chip = (href: string, label: string) =>
        `<a class="inline-flex items-center rounded-full border border-slate-200 dark:border-slate-700 px-3 py-1 text-xs hover:border-primary hover:text-primary transition-colors" href="${href}">${escHtml(label)}</a>`;
    const actressLink = (n: string) => `<a class="text-primary hover:underline" href="/actress/${encodeURIComponent(n)}">${escHtml(n)}</a>`;

    // 出演者欄（実在女優は女優ページへのリンク、素人名義は併記）
    if (real.length || alias.length) {
        const cell = (real.length ? real.map(actressLink).join('、') : '')
            + (alias.length ? `${real.length ? '（' : ''}素人名義：${escHtml(alias.join('、'))}${real.length ? '）' : ''}` : '');
        html = html.replace(/(<(dd|span)[^>]*id="pd-actresses"[^>]*>)[\s\S]*?(<\/\2>)/, (_m, open, _t, close) => `${open}${cell}${close}`);
    }
    // おすすめ作品欄（モバイルは横スクロール、PCはグリッド）
    if (related.length) {
        html = fillById(html, 'pd-recommend', isMobile
            ? related.map(p => carouselCardHtml(p, 110)).join('')
            : productCardsHtml(related));
    }

    const links: string[] = [];
    for (const g of String(product.genres || '').split(/[,、]/).map(s => s.trim()).filter(Boolean)) {
        if (gset.has(g)) links.push(chip(`/genre/${encodeURIComponent(g)}`, g));
        if (links.length >= 10) break;
    }
    const maker = String(product.maker || '').trim();
    if (maker && mset.has(maker)) links.push(chip(`/maker/${encodeURIComponent(maker)}`, maker));
    const label = String(product.label || '').trim();
    if (label && label !== maker && mset.has(label)) links.push(chip(`/maker/${encodeURIComponent(label)}`, label));
    // 出演者の一文（JS 実行後も残る本文テキスト）。「品番 女優」「素人名義 誰」の検索に当てる。
    const castLine = real.length
        ? `<p class="text-xs leading-relaxed text-slate-600 dark:text-slate-300 mb-3">この作品の出演者は${real.map(actressLink).join('、')}`
          + `${alias.length ? `（${escHtml(alias.join('、'))} 名義）` : ''}です。</p>`
        : '';
    if (!links.length && !castLine) return html;
    const block = `<section class="px-4 py-4 border-t border-slate-200 dark:border-slate-800">`
        + castLine
        + (links.length
            ? `<p class="font-bold text-xs mb-2 text-slate-700 dark:text-slate-300">関連ジャンル・メーカー</p>`
              + `<div class="flex flex-wrap gap-2">${links.join('')}</div>`
            : '')
        + `</section>`;
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
        // 作品名の見出しを H1 にしてサーバ側で埋める。テンプレは <h2 id="pd-title"> をクライアントJSが
        // 埋める作りで、ヘッダーの H1 はレイアウト注入で消えるため**作品ページに H1 が1つも無かった**。
        // クライアントは id で textContent を上書きするだけなのでタグを変えても動作は同じ。
        html = html.replace(/<h2 id="pd-title"([^>]*)>[\s\S]*?<\/h2>/,
            (_m, attrs: string) => `<h1 id="pd-title"${attrs}>${escHtml(String(product.title || id.toUpperCase()))}</h1>`);
        // 索引対象(18メーカー＋人気作)以外は noindex。Googleの索引/クロールを売れ筋に集中させ無料枠超過を防ぐ。
        if (!(await isIndexableProduct(id))) {
            html = html.replace('</head>', '<meta name="robots" content="noindex,follow"/>\n</head>');
        }
        html = await injectProductLinks(html, product, id, isMobile); // 出演者・関連作品・ジャンル/メーカーへの内部リンク

        html = isMobile ? injectMobileLayout(html) : injectWebLayout(html);
        const resp = new NextResponse(html, {
            // Cache API に保存され、再クロール・リピート訪問は Worker非起動で返る=無料枠の消費を大幅削減。
            // max-age=60 で bfcache(戻る復元)維持。価格は最大1時間古くなり得るが R2 read-through(1h)もあり許容。
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                // 商品ページの中身が変わるのは日次バッチの価格/セール更新時なので24h保持。
                // 再クロール(索引済み5.5万URL)で Worker も D1 も使わないようにする。
                'Cache-Control': 'public, s-maxage=86400, max-age=300, stale-while-revalidate=86400',
                'CDN-Cache-Control': 'public, s-maxage=86400',
            },
        });
        await edgeStore(edge, resp);
        return resp;
    } catch {
        return new NextResponse('Not found', { status: 404 });
    }
}
