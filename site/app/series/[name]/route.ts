import { NextRequest, NextResponse } from 'next/server';
import { renderLandingPage } from '../../../lib/landingPage';
import { findSeries } from '../../../lib/lpData';

export const dynamic = 'force-dynamic';

// シリーズ別LP (/series/S1%20GIRLS%20COLLECTION 等)。slugは series_cache.json で検証。
// series は FANZA のみが持つメタなので /api/products?series= は自動でFANZA限定になる。
export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
    const name = decodeURIComponent((await params).name || '');
    const s = await findSeries(name);
    if (!s) return new NextResponse('Not found', { status: 404 });
    const cnt = s.count.toLocaleString();
    return renderLandingPage(req, {
        type: 'series', slug: name,
        title: `${name}シリーズの作品一覧`,
        h1: `${name} シリーズ`,
        description: `「${name}」シリーズのAV作品を約${cnt}件掲載。新作・セール・サンプル動画・最安値をまとめてチェックできます。`,
        intro: `シリーズ「${name}」の作品を表示しています。サンプル動画・出演女優・最安値を確認できます。`,
        apiQuery: `series=${encodeURIComponent(name)}&sort=new`,
        hub: { path: '/series', label: 'シリーズ' },
        canonicalPath: `/series/${encodeURIComponent(name)}`,
    });
}
