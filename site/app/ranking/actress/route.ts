import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { injectMobileLayout, injectWebLayout } from '../../../lib/injectLayout';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    const htmlFile = path.join(process.cwd(), 'public', 'design', 'web', 'actress-ranking-2026.html');

    try {
        let html = fs.readFileSync(htmlFile, 'utf-8');
        html = isMobile ? injectMobileLayout(html, 'ranking') : injectWebLayout(html);
        return new NextResponse(html, {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
            },
        });
    } catch {
        return new NextResponse('Not found', { status: 404 });
    }
}
