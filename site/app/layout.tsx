import type { Metadata } from 'next';
import './globals.css';
import Header from '@/components/Header';
import BottomNav from '@/components/BottomNav';
import AgeGate from '@/components/AgeGate';

const SITE_NAME = 'AVランキング';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://avrankings.com';
const DESCRIPTION = 'FANZA・MGS動画の作品を横断して、人気ランキング・新作・予約・セールと両サイトの価格を比較できます。女優・ジャンル・メーカーから探せます。';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — FANZA・MGSの人気AV作品ランキング`,
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
    title: `${SITE_NAME} — FANZA・MGSの人気AV作品ランキング`,
    description: DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} — FANZA・MGSの人気AV作品ランキング`,
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
