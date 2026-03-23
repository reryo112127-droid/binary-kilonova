import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { injectMobileLayout, injectWebLayout } from '../../lib/injectLayout';

const MOBILE_UA = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;

export async function GET(request: NextRequest) {
    const ua = request.headers.get('user-agent') || '';
    const isMobile = MOBILE_UA.test(ua);

    const htmlFile = isMobile
        ? path.join(process.cwd(), 'public', 'design', 'mypage.html')
        : path.join(process.cwd(), 'public', 'design', 'web', 'mypage.html');

    try {
        let html = fs.readFileSync(htmlFile, 'utf-8');
        html = isMobile ? injectMobileLayout(html, 'mypage') : injectWebLayout(html);
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
