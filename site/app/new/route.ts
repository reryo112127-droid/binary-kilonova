import { NextRequest } from 'next/server';
import { renderProductsPage, NEW_PRODUCTS_SEO } from '../../lib/productsPage';

export const dynamic = 'force-dynamic';

// 以前は /products?type=new へ302していたが、その転送先は robots.txt の `Disallow: /*?` で
// クロール拒否している＝サイトマップに載せた /new が永久に索引されない状態だった。
// 転送をやめてここで直接描画する。
export async function GET(request: NextRequest) {
    return renderProductsPage(request, 'new', NEW_PRODUCTS_SEO);
}
