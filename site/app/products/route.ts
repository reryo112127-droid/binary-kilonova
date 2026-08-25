import { NextRequest } from 'next/server';
import { renderProductsPage } from '../../lib/productsPage';

export const dynamic = 'force-dynamic';

// 実体は lib/productsPage.ts（/new と /pre-order が同じレンダラを直接呼ぶ）。
// ここはクエリ付きURL＝robots.txt でクロール拒否しているため、SEOメタは付けない。
export async function GET(request: NextRequest) {
    return renderProductsPage(request);
}
