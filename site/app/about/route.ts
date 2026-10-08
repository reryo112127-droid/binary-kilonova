import { NextRequest, NextResponse } from 'next/server';
import { readHtml } from '../../lib/readHtml';
import { injectMobileLayout, injectWebLayout } from '../../lib/injectLayout';
import { injectHubSeo } from '../../lib/pageMeta';
import { PRODUCT_SCORE } from '../../lib/scoring';

export const dynamic = 'force-dynamic';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

/**
 * 「このサイトについて」（運営者情報・データの出どころ・ランキングの決め方・PR表記）。
 *
 * 運営者情報もランキングの集計方法もどこにも書いておらず、誰が何を根拠に並べているのか
 * 分からないサイトになっていた（Google の E-E-A-T、アフィリエイトのステマ規制の両面で弱い）。
 * 数値は lib/scoring.ts の定数をそのまま出すので、重みを変えればこのページも変わる。
 */
function section(title: string, body: string): string {
    return `<section>`
        + `<h2 class="text-xl font-bold mb-4 flex items-center gap-2"><span class="w-1.5 h-6 bg-primary rounded-full"></span>${title}</h2>`
        + `<div class="space-y-3 text-slate-700 dark:text-slate-300 leading-loose">${body}</div>`
        + `</section>`;
}

function aboutMain(): string {
    const S = PRODUCT_SCORE;
    const li = (s: string) => `<li>${s}</li>`;
    const ul = (items: string[]) => `<ul class="list-disc pl-6 space-y-1">${items.map(li).join('')}</ul>`;
    return `<main class="max-w-3xl mx-auto px-5 pt-8 pb-32">`
        + `<div class="mb-10"><h1 class="text-3xl font-bold mb-3 tracking-tight">AVランキングについて</h1>`
        + `<p class="text-slate-500 dark:text-slate-400 text-sm">運営者情報・データの出どころ・ランキングの決め方</p></div>`
        + `<div class="space-y-10">`
        + section('AVランキングとは', `<p>AVランキング（avrankings.com）は、FANZA動画とMGS動画の2つの配信サイトの作品をまとめて探せるサイトです。人気ランキング・新作・予約・セールを1か所で見られるほか、両方のサイトで配信されている作品は価格を並べて比べられます。</p>`)
        + section('掲載している作品とデータの出どころ', `<p>作品のタイトル・出演者・メーカー・ジャンル・配信日・価格・レビュー件数などは、FANZA と MGS動画が公開している作品情報をもとにしています。掲載作品は両サイト合わせて30万作品以上です。</p>`
            + ul([
                '新作・予約・価格・セール情報は<strong>毎日</strong>更新しています。',
                'ベスト盤・総集編は新作一覧やランキングから外しています（同じ映像の再収録が上位を占めないようにするため）。',
                '出演者名は配信元の情報に加え、公開されている出演者情報とユーザーからの情報提供で補っています。誤りを見つけたら<a class="text-primary underline" href="/info/add">情報追加</a>からお知らせください。',
            ]))
        + section('作品ランキングの決め方', `<p>作品ランキングは、次の数値を足し合わせた点数の高い順です。配信サイトの売上ランキングをそのまま写したものではありません。</p>`
            + ul([
                `MGS動画の「お気に入り」登録数（1件 = ${S.WISH_COUNT}点）`,
                `FANZAのレビュー（件数 × 平均★ ÷ 5 × ${S.FANZA_REVIEW}点。例：★4.5のレビュー100件なら36,000点）`,
                `当サイトでの「いいね」（1件 = ${S.SITE_LIKE}点）`,
                `当サイトでのレビュー（★5 = ${S.REVIEW[5]}点、★4 = ${S.REVIEW[4]}点、★3 = ${S.REVIEW[3]}点、★2 = ${S.REVIEW[2]}点、★1 = ${S.REVIEW[1]}点）`,
                `当サイト経由での購入（1件 = ${S.PURCHASE}点）`,
            ])
            + `<p>MGS とFANZAでは集まる数値の種類が違うため、それぞれの中で点数順に並べたうえで、MGS 2作・FANZA 1作の割合で交互に並べています。年別ランキングは、その年に配信された作品だけで集計しています。</p>`)
        + section('出演者ランキングの決め方', `<p>出演者ランキングは、その女優の出演作の「お気に入り」登録数の合計に、当サイトでの女優への「いいね」（1件 = 5,000点相当）を足した点数の高い順です。</p>`)
        + section('価格とセール情報について', `<p>価格・割引率・セール期間は掲載時点のもので、配信サイト側で予告なく変わることがあります。購入前に必ず配信サイトの表示をご確認ください。</p>`)
        + section('広告（PR）について', `<p>当サイトは、FANZA（DMMアフィリエイト）と MGS動画のアフィリエイトプログラムに参加しています。作品ページの購入ボタンなど「PR」と表示したリンクから作品が購入されると、当サイトに紹介料が支払われます。</p>`
            + `<p><strong>ランキングの順位や掲載内容は、紹介料の金額によって変えていません。</strong>順位は上の「ランキングの決め方」の点数だけで決まります。</p>`)
        + section('年齢制限', `<p>当サイトは成人向けの作品情報を扱っています。18歳未満の方はご利用いただけません。</p>`)
        + section('運営者情報', `<dl class="grid grid-cols-3 gap-y-3 text-sm">`
            + `<dt class="text-slate-500">サイト名</dt><dd class="col-span-2">AVランキング</dd>`
            + `<dt class="text-slate-500">URL</dt><dd class="col-span-2">https://avrankings.com</dd>`
            + `<dt class="text-slate-500">運営</dt><dd class="col-span-2">AVランキング運営事務局</dd>`
            + `<dt class="text-slate-500">お問い合わせ</dt><dd class="col-span-2"><a class="text-primary underline" href="mailto:contact@avrankings.com">contact@avrankings.com</a></dd>`
            + `<dt class="text-slate-500">関連ページ</dt><dd class="col-span-2"><a class="text-primary underline" href="/terms">利用規約</a>・<a class="text-primary underline" href="/privacy">プライバシーポリシー</a></dd>`
            + `</dl>`)
        + `</div></main>`;
}

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);
    // 見た目は利用規約ページのテンプレ（ヘッダー/フッター）を借り、<main> だけ差し替える
    const htmlFile = isMobile ? '/design/terms.html' : '/design/web/terms.html';
    try {
        let html = await readHtml(request.url, htmlFile);
        html = html.replace(/<main[\s\S]*<\/main>/, () => aboutMain());
        html = injectHubSeo(html, {
            title: 'AVランキングについて（運営者情報・ランキングの決め方）',
            description: 'AVランキングの運営者情報、掲載データの出どころ、作品ランキング・出演者ランキングの点数の決め方、広告（PR）についての説明です。',
            path: '/about',
            breadcrumb: 'AVランキングについて',
        });
        html = isMobile ? injectMobileLayout(html, '') : injectWebLayout(html);
        return new NextResponse(html, {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, s-maxage=86400, max-age=3600',
            },
        });
    } catch {
        return new NextResponse('Not found', { status: 404 });
    }
}
