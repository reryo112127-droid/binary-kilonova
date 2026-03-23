'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';

type SuggestResult = {
    actresses: string[];
    makers: string[];
    labels: string[];
    genres: string[];
};

export default function Header() {
    const [query, setQuery] = useState('');
    const [suggests, setSuggests] = useState<SuggestResult | null>(null);
    const [isOpen, setIsOpen] = useState(false);
    const router = useRouter();
    const searchRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!query.trim()) {
            setSuggests(null);
            setIsOpen(false);
            return;
        }

        const timer = setTimeout(async () => {
            try {
                const res = await fetch(`/api/suggest?q=${encodeURIComponent(query.trim())}`);
                if (res.ok) {
                    const data = await res.json();
                    const hasItems = data.actresses.length > 0 || data.makers.length > 0 || data.labels.length > 0 || data.genres.length > 0;
                    if (hasItems) {
                        setSuggests(data);
                        setIsOpen(true);
                    } else {
                        setSuggests(null);
                        setIsOpen(false);
                    }
                }
            } catch (error) {
                console.error('Suggest API calling failed', error);
            }
        }, 300);

        return () => clearTimeout(timer);
    }, [query]);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        setIsOpen(false);
        if (query.trim()) {
            router.push(`/search?q=${encodeURIComponent(query.trim())}`);
        }
    };

    const handleSuggestClick = (type: string, value: string) => {
        setIsOpen(false);
        setQuery('');
        if (type === 'actress') {
            router.push(`/actress/${encodeURIComponent(value)}`);
        } else {
            router.push(`/search?${type}=${encodeURIComponent(value)}`);
        }
    };

    return (
        <header className="header">
            <div className="header-inner">
                {/* ロゴ */}
                <Link href="/" className="flex items-center gap-2 group">
                    <span className="material-symbols-outlined text-primary text-3xl">play_circle</span>
                    <span className="font-black text-xl tracking-tighter hidden sm:inline-block">STREAM.JP</span>
                    <span className="font-black text-xl tracking-tighter sm:hidden">S.JP</span>
                </Link>

                {/* 検索バー */}
                <div className="flex-1 max-w-md mx-4 relative" ref={searchRef}>
                    <form onSubmit={handleSearch} className="relative group">
                        <input
                            type="text"
                            placeholder="検索..."
                            value={query}
                            onChange={(e) => {
                                setQuery(e.target.value);
                                setIsOpen(true);
                            }}
                            onFocus={() => setIsOpen(true)}
                            className="w-full h-8 px-4 pr-10 bg-gray-100 border-none rounded-full text-sm focus:ring-2 focus:ring-primary/20 transition-all"
                        />
                        <button type="submit" className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-primary">
                            <span className="material-symbols-outlined text-sm">search</span>
                        </button>
                    </form>

                    {/* サジェストドロップダウン */}
                    {isOpen && suggests && (
                        <div className="suggest-list">
                            <div className="p-2 border-b text-[10px] font-bold text-gray-400 uppercase tracking-widest bg-gray-50/50">
                                おすすめの作品
                            </div>
                            {suggests.actresses.slice(0, 3).map(name => (
                                <div key={`act_${name}`} className="suggest-item" onClick={() => handleSuggestClick('actress', name)}>
                                    <span className="material-symbols-outlined text-gray-400 text-sm">person</span>
                                    <span className="text-sm">{name}</span>
                                </div>
                            ))}
                            {suggests.makers.slice(0, 2).map(name => (
                                <div key={`mk_${name}`} className="suggest-item" onClick={() => handleSuggestClick('maker', name)}>
                                    <span className="material-symbols-outlined text-gray-400 text-sm">factory</span>
                                    <span className="text-sm">{name}</span>
                                </div>
                            ))}
                            <div
                                className="p-3 text-center text-xs font-bold text-primary bg-primary/5 hover:bg-primary/10 transition-colors cursor-pointer"
                                onClick={() => {
                                    setIsOpen(false);
                                    router.push(`/search?q=${encodeURIComponent(query.trim())}`);
                                }}
                            >
                                全ての結果を表示 →
                            </div>
                        </div>
                    )}
                </div>

                {/* 右側アクション */}
                <div className="flex items-center gap-2 sm:gap-4">
                    <button className="p-1 text-gray-600 hover:text-primary transition-colors">
                        <span className="material-symbols-outlined">add_circle</span>
                    </button>
                    <div className="hidden xs:flex items-center gap-2">
                        <Link href="/login" className="px-3 py-1 text-[10px] sm:text-xs font-bold text-gray-600 hover:bg-gray-100 rounded-full transition-colors">
                            ログイン
                        </Link>
                        <Link href="/signup" className="px-3 py-1 text-[10px] sm:text-xs font-bold text-white bg-primary rounded-full hover:bg-primary-light transition-colors">
                            新規登録
                        </Link>
                    </div>
                </div>
            </div>
        </header>
    );
}
