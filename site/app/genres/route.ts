import { NextRequest } from 'next/server';
import { renderIndexPage } from '../../lib/landingPage';
import { loadGenres } from '../../lib/lpData';

export const dynamic = 'force-dynamic';

// ジャンル一覧ハブ (/genres)。各 /genre/[name] への内部リンク集約＝クロール入口。
export async function GET(req: NextRequest) {
    const genres = await loadGenres();
    return renderIndexPage(req, {
        title: 'AVジャンル一覧',
        h1: 'AVジャンル一覧',
        description: `巨乳・人妻・素人・痴女などAVのジャンル${genres.length}種を一覧化。各ジャンルの人気作品ランキングへ。`,
        intro: `AV作品のジャンル一覧です。気になるジャンルを選ぶと、そのジャンルの人気作品ランキングが見られます。`,
        canonicalPath: '/genres',
        items: genres.map(g => ({ href: `/genre/${encodeURIComponent(g.name)}`, label: g.name, count: g.count })),
    });
}
