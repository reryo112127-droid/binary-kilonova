import { NextRequest } from 'next/server';
import { renderIndexPage } from '../../lib/landingPage';
import { CUPS } from '../../lib/lpData';

export const dynamic = 'force-dynamic';

// カップ一覧ハブ (/cup)。各 /cup/[letter] へのクロール入口。
export async function GET(req: NextRequest) {
    return renderIndexPage(req, {
        title: 'カップ別 AV女優・作品一覧',
        h1: 'カップ別 AV作品',
        description: `A〜Pカップ別にAV女優の出演作品を探せます。気になるカップサイズの人気作品ランキングへ。`,
        intro: `カップサイズ別に出演作品を表示します。気になるカップを選ぶと、そのカップの女優が出演する人気作品が見られます。`,
        canonicalPath: '/cup',
        items: CUPS.map(c => ({ href: `/cup/${c}`, label: `${c}カップ` })),
    });
}
