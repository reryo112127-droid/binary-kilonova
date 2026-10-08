import { NextRequest } from 'next/server';
import { renderFeature } from '../../../lib/featurePage';

export const dynamic = 'force-dynamic';

// 特集ページ (/feature/<slug>)。features.json に無い slug は 404。
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    return renderFeature(req, decodeURIComponent(slug));
}
