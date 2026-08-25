import { NextRequest } from 'next/server';
import { renderProductsPage, PREORDER_PRODUCTS_SEO } from '../../lib/productsPage';

export const dynamic = 'force-dynamic';

// /products?type=pre-order への302をやめて直接描画する（転送先は robots.txt でクロール拒否のため）。
export async function GET(request: NextRequest) {
    return renderProductsPage(request, 'pre-order', PREORDER_PRODUCTS_SEO);
}
