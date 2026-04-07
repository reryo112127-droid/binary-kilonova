import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest) {
    return NextResponse.redirect(new URL('/products?type=new', _request.url), 302);
}
