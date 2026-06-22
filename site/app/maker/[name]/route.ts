import { NextRequest, NextResponse } from 'next/server';
import { renderLandingPage } from '../../../lib/landingPage';
import { findMaker } from '../../../lib/lpData';

export const dynamic = 'force-dynamic';

// メーカー/レーベル別LP (/maker/エスワン 等)。slugは makers_cache.json で検証。
// 旧実装は maker-detail.html を出すだけで SSR/メタ/絞り込みが無くSEO不可視だったため、
// 他LPと同じ renderLandingPage(SSRカード＋固有メタ＋JSON-LD)に統一する。
export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
    const name = decodeURIComponent((await params).name || '');
    const m = await findMaker(name);
    if (!m) return new NextResponse('Not found', { status: 404 });
    const cnt = m.count.toLocaleString();
    return renderLandingPage(req, {
        type: 'maker', slug: name,
        title: `${name}の作品一覧・人気ランキング`,
        h1: `${name} の人気作品`,
        description: `${name}のAV作品を人気順に約${cnt}件掲載。${name}の新作・セール・サンプル動画・最安値をまとめてチェックできます。`,
        intro: `メーカー/レーベル「${name}」の作品を人気順に表示しています。サンプル動画・出演女優・最安値を確認できます。`,
        apiQuery: `maker=${encodeURIComponent(name)}&sort=wish_count&excludeBest=1`,
        hub: { path: '/makers', label: 'メーカー' },
        canonicalPath: `/maker/${encodeURIComponent(name)}`,
    });
}
