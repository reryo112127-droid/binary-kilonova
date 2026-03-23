import { Metadata } from 'next';

export const metadata: Metadata = {
    title: 'サンプル動画 — 無料視聴',
    description: 'FANZA・MGS動画のAVサンプル動画を無料視聴。新着・人気作のプレビューを今すぐチェック。',
    alternates: { canonical: '/video' },
};

export default function VideoLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
