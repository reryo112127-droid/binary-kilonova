import { NextRequest } from 'next/server';
import { renderIndexPage } from '../../lib/landingPage';
import { loadSeries } from '../../lib/lpData';

export const dynamic = 'force-dynamic';

// シリーズ一覧ハブ (/series)。各 /series/[name] へのクロール入口。
export async function GET(req: NextRequest) {
    const series = await loadSeries();
    return renderIndexPage(req, {
        title: 'AVシリーズ一覧',
        h1: 'AVシリーズ一覧',
        description: `人気AVシリーズ${series.length}本を一覧化。各シリーズの作品一覧へ。`,
        intro: `AV作品のシリーズ一覧です。気になるシリーズを選ぶと、そのシリーズの作品一覧が見られます。`,
        canonicalPath: '/series',
        items: series.map(s => ({ href: `/series/${encodeURIComponent(s.name)}`, label: s.name, count: s.count })),
    });
}
