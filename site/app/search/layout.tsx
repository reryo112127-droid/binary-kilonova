import { Metadata } from 'next';

export const metadata: Metadata = {
    title: '作品検索 — 女優・ジャンル・スリーサイズで絞り込み',
    description: 'FANZA・MGS動画の作品をキーワード、女優名、ジャンル、カップサイズで高精度検索。11万件以上のAV作品を横断検索できます。',
    alternates: { canonical: '/search' },
};

export default function SearchLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
