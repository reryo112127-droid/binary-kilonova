import type { Metadata } from 'next';
import './globals.css';
import Header from '@/components/Header';
import BottomNav from '@/components/BottomNav';
import AgeGate from '@/components/AgeGate';

const SITE_NAME = 'AVコンシェルジュ';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://lunar-zodiac.vercel.app';
const DESCRIPTION = 'MGS動画11万件以上の作品情報を横断検索。女優・ジャンル・スリーサイズによる高精度フィルター搭載。期待度ランキング・新着・素人作品も完全網羅。';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — 高級AVコンシェルジュ`,
    template: `%s | ${SITE_NAME}`,
  },
  description: DESCRIPTION,
  keywords: ['AV', 'FANZA', 'MGS動画', 'AV女優', '動画', 'ランキング', 'アダルト', '品番', '無料', '動画配信'],
  authors: [{ name: SITE_NAME }],
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  openGraph: {
    type: 'website',
    locale: 'ja_JP',
    url: SITE_URL,
    siteName: SITE_NAME,
    title: `${SITE_NAME} — 高級AVコンシェルジュ`,
    description: DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} — 高級AVコンシェルジュ`,
    description: DESCRIPTION,
  },
  alternates: {
    canonical: SITE_URL,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <head>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" />
      </head>
      <body>
        <AgeGate />
        <Header />
        <main className="main">
          {children}
        </main>
        <BottomNav />
      </body>
    </html>
  );
}
