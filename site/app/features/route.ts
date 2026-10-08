import { NextRequest } from 'next/server';
import { renderFeatureHub } from '../../lib/featurePage';

export const dynamic = 'force-dynamic';

// 特集一覧ハブ (/features)。中身は scripts/build_features.mjs が日次で焼く features.json。
export async function GET(req: NextRequest) {
    return renderFeatureHub(req);
}
