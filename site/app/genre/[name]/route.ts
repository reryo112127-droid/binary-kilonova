import { NextRequest, NextResponse } from 'next/server';
import { renderLandingPage } from '../../../lib/landingPage';
import { findGenre } from '../../../lib/lpData';

export const dynamic = 'force-dynamic';

// ジャンル別 人気ランキングLP (/genre/巨乳 等)。slugは genres_cache.json で検証(薄いページ回避)。
export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
    const name = decodeURIComponent((await params).name || '');
    const g = await findGenre(name);
    if (!g) return new NextResponse('Not found', { status: 404 });
    const cnt = g.count.toLocaleString();
    return renderLandingPage(req, {
        type: 'genre', slug: name,
        title: `${name}のAV作品・人気ランキング`,
        h1: `${name} の人気AV作品`,
        description: `${name}のAV作品を人気順に約${cnt}件掲載。MGS・FANZAの${name}ジャンルの新作・セール・サンプル動画・最安値をまとめてチェックできます。`,
        intro: `${name}ジャンルのAV作品を人気順に表示しています。サンプル動画・出演女優・両プラットフォームの最安値を確認できます。`,
        apiQuery: `genre=${encodeURIComponent(name)}&sort=wish_count&excludeBest=1`,
        hub: { path: '/genres', label: 'ジャンル' },
        canonicalPath: `/genre/${encodeURIComponent(name)}`,
    });
}
