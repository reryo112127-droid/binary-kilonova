'use client';

import Link from 'next/link';

export default function Sidebar({ className }: { className?: string }) {
    const popularGenres = ['巨乳', '美乳', '美脚', '単体作品', 'ハイビジョン', '美少女'];
    const focusMakers = ['プレステージ', 'エスワン', 'アイデアル', 'MAXING'];

    return (
        <aside className={`${className} space-y-8`}>
            {/* Widget: Genres */}
            <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
                <div className="flex items-center gap-2 mb-6">
                    <span className="material-symbols-outlined text-primary text-xl">label</span>
                    <h3 className="text-sm font-black tracking-tight">人気のタグ</h3>
                </div>
                <div className="flex flex-wrap gap-2">
                    {popularGenres.map(genre => (
                        <Link 
                            key={genre} 
                            href={`/search?genre=${encodeURIComponent(genre)}`}
                            className="text-[10px] font-bold px-3 py-1.5 bg-gray-50 text-gray-400 border border-gray-100 rounded-full hover:bg-primary hover:text-white hover:border-primary transition-all"
                        >
                            {genre}
                        </Link>
                    ))}
                </div>
            </div>

            {/* Widget: Makers */}
            <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
                <div className="flex items-center gap-2 mb-6">
                    <span className="material-symbols-outlined text-primary text-xl">factory</span>
                    <h3 className="text-sm font-black tracking-tight">注目メーカー</h3>
                </div>
                <div className="space-y-3">
                    {focusMakers.map(maker => (
                        <Link 
                            key={maker} 
                            href={`/search?maker=${encodeURIComponent(maker)}`}
                            className="flex items-center justify-between group"
                        >
                            <span className="text-xs font-bold text-gray-500 group-hover:text-primary transition-colors">{maker}</span>
                            <span className="material-symbols-outlined text-xs text-gray-200 group-hover:text-primary transition-colors">arrow_forward</span>
                        </Link>
                    ))}
                </div>
            </div>

            {/* Widget: Concierge Tip */}
            <div className="bg-primary/5 rounded-xl p-6 border border-primary/10">
                <div className="flex items-center gap-2 mb-4">
                    <span className="material-symbols-outlined text-primary">support_agent</span>
                    <h3 className="text-[10px] font-black tracking-widest uppercase text-primary">Concierge's Tip</h3>
                </div>
                <p className="text-[11px] text-gray-500 leading-relaxed font-medium">
                    理想の作品をお探しですか？詳細検索では「身長」や「カップ数」での絞り込みも可能です。あなただけの至極の一本をご提案いたします。
                </p>
            </div>
        </aside>
    );
}
