import { NextRequest, NextResponse } from 'next/server';
import { renderLandingPage } from '../../../lib/landingPage';
import { isValidCup } from '../../../lib/lpData';

export const dynamic = 'force-dynamic';

// カップ別LP (/cup/G 等)。/api/products?cup= は actress_profiles.json 経由で女優→作品を解決。
export async function GET(req: NextRequest, { params }: { params: Promise<{ letter: string }> }) {
    const letter = decodeURIComponent((await params).letter || '').toUpperCase();
    if (!isValidCup(letter)) return new NextResponse('Not found', { status: 404 });
    return renderLandingPage(req, {
        type: 'cup', slug: letter,
        title: `${letter}カップ女優のAV作品・人気ランキング`,
        h1: `${letter}カップ女優の人気AV作品`,
        description: `${letter}カップの女優が出演するAV作品を人気順に掲載。${letter}カップ女優の新作・セール・サンプル動画・最安値をまとめてチェックできます。`,
        intro: `${letter}カップの女優が出演する作品を人気順に表示しています。サンプル動画・出演女優・最安値を確認できます。`,
        apiQuery: `cup=${encodeURIComponent(letter)}&sort=wish_count&excludeBest=1`,
        hub: { path: '/cup', label: 'カップ' },
        canonicalPath: `/cup/${encodeURIComponent(letter)}`,
    });
}
