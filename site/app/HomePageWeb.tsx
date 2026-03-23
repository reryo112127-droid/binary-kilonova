'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getPosterImageUrl } from '@/lib/imageUtils';

interface Product {
    product_id: string;
    title: string;
    main_image_url?: string;
    actresses?: string;
    wish_count?: number;
}

function PosterCard({ p }: { p: Product }) {
    const poster = getPosterImageUrl(p.main_image_url);
    return (
        <Link href={`/product/${encodeURIComponent(p.product_id)}`} className="flex-none w-[160px] group cursor-pointer block">
            <div className="aspect-[3/4] overflow-hidden rounded bg-gray-100 relative mb-2">
                {poster && (
                    <img alt="" className="w-full h-full object-cover object-top transition-transform group-hover:scale-105" src={poster} loading="lazy"
                        onError={e => { if (p.main_image_url && e.currentTarget.src !== p.main_image_url) e.currentTarget.src = p.main_image_url!; }} />
                )}
                <div className="absolute bottom-2 right-2 flex items-center gap-1">
                    <button className="w-7 h-7 flex items-center justify-center bg-white/90 rounded-full shadow-sm text-primary hover:bg-primary hover:text-white transition-colors" onClick={e => e.preventDefault()}>
                        <span className="material-symbols-outlined text-[18px]">favorite</span>
                    </button>
                </div>
            </div>
            <h5 className="text-xs font-bold truncate text-gray-900">{p.title}</h5>
            <p className="text-[10px] text-gray-400 mt-0.5">
                {p.actresses ? p.actresses.split(',')[0].trim() : ''}
            </p>
        </Link>
    );
}

function RankCard({ p, rank }: { p: Product; rank: number }) {
    const medals: Record<number, string> = { 1: 'bg-yellow-400 text-yellow-900', 2: 'bg-gray-300 text-gray-700', 3: 'bg-amber-600 text-white' };
    const medalClass = medals[rank] || 'bg-gray-100 text-gray-500';
    return (
        <Link href={`/product/${encodeURIComponent(p.product_id)}`} className="flex items-center gap-4 py-3 border-b border-gray-50 group hover:bg-gray-50/50 transition-colors px-2 -mx-2 rounded block">
            <span className={`w-8 h-8 rounded flex items-center justify-center text-xs font-black shrink-0 ${medalClass}`}>{rank}</span>
            <div className="w-10 h-14 rounded overflow-hidden shrink-0 bg-gray-100">
                {p.main_image_url && <img alt="" className="w-full h-full object-cover object-top" src={getPosterImageUrl(p.main_image_url)} loading="lazy"
                    onError={e => { if (e.currentTarget.src !== p.main_image_url) e.currentTarget.src = p.main_image_url!; }} />}
            </div>
            <div className="flex-1 min-w-0">
                <p className="text-sm font-bold line-clamp-2 text-gray-900 group-hover:text-primary transition-colors">{p.title}</p>
                <p className="text-[10px] text-gray-400 mt-0.5">
                    {p.actresses ? p.actresses.split(',').slice(0, 2).map(a => a.trim()).join(' / ') : ''}
                </p>
            </div>
            {p.wish_count != null && (
                <span className="text-[10px] font-black text-primary shrink-0">♥ {p.wish_count.toLocaleString()}</span>
            )}
        </Link>
    );
}

function SkeletonRow() {
    return (
        <div className="flex items-center gap-4 py-3 border-b border-gray-50 animate-pulse">
            <div className="w-8 h-8 rounded bg-gray-100 shrink-0" />
            <div className="w-10 h-14 rounded bg-gray-100 shrink-0" />
            <div className="flex-1 space-y-2">
                <div className="h-3 bg-gray-100 rounded w-3/4" />
                <div className="h-2 bg-gray-100 rounded w-1/2" />
            </div>
        </div>
    );
}

export default function HomePageWeb() {
    const [popular, setPopular] = useState<Product[]>([]);
    const [newArrivals, setNewArrivals] = useState<Product[]>([]);

    useEffect(() => {
        fetch('/api/products?sort=wish_count&limit=20')
            .then(r => r.json())
            .then(setPopular)
            .catch(() => {});
        fetch('/api/products?sort=new&limit=12')
            .then(r => r.json())
            .then(setNewArrivals)
            .catch(() => {});
    }, []);

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

                {/* Left: New Arrivals + Featured */}
                <div className="lg:col-span-2 space-y-10">
                    {/* 新作 */}
                    <section>
                        <div className="flex items-center justify-between mb-4 border-b border-gray-100 pb-2">
                            <h2 className="text-base font-black tracking-tight flex items-center gap-2">
                                新作
                                <span className="text-[10px] font-normal text-gray-400 uppercase tracking-widest">New Arrivals</span>
                            </h2>
                            <Link href="/search?sort=new" className="text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:text-primary transition-colors">もっと見る</Link>
                        </div>
                        <div className="flex overflow-x-auto gap-4 no-scrollbar pb-2">
                            {newArrivals.length > 0
                                ? newArrivals.map(p => <PosterCard key={p.product_id} p={p} />)
                                : Array.from({ length: 6 }).map((_, i) => (
                                    <div key={i} className="flex-none w-[160px] animate-pulse">
                                        <div className="aspect-[3/4] rounded bg-gray-100 mb-2" />
                                        <div className="h-3 bg-gray-100 rounded w-3/4 mb-1" />
                                        <div className="h-2 bg-gray-100 rounded w-1/2" />
                                    </div>
                                ))
                            }
                        </div>
                    </section>

                    {/* 注目作品 */}
                    <section>
                        <div className="flex items-center justify-between mb-4 border-b border-gray-100 pb-2">
                            <h2 className="text-base font-black tracking-tight flex items-center gap-2">
                                注目作品
                                <span className="text-[10px] font-normal text-gray-400 uppercase tracking-widest">Featured</span>
                            </h2>
                            <Link href="/search?sort=wish_count" className="text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:text-primary transition-colors">もっと見る</Link>
                        </div>
                        <div className="flex overflow-x-auto gap-4 no-scrollbar pb-2">
                            {popular.length > 0
                                ? popular.slice(0, 10).map(p => <PosterCard key={p.product_id} p={p} />)
                                : Array.from({ length: 6 }).map((_, i) => (
                                    <div key={i} className="flex-none w-[160px] animate-pulse">
                                        <div className="aspect-[3/4] rounded bg-gray-100 mb-2" />
                                        <div className="h-3 bg-gray-100 rounded w-3/4 mb-1" />
                                        <div className="h-2 bg-gray-100 rounded w-1/2" />
                                    </div>
                                ))
                            }
                        </div>
                    </section>
                </div>

                {/* Right: Ranking */}
                <div>
                    <div className="sticky top-20">
                        <div className="flex items-center justify-between mb-4 border-b border-gray-100 pb-2">
                            <h2 className="text-base font-black tracking-tight flex items-center gap-2">
                                人気ランキング
                                <span className="text-[10px] font-normal text-gray-400 uppercase tracking-widest">Top 20</span>
                            </h2>
                            <Link href="/ranking" className="text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:text-primary transition-colors">全ランキング</Link>
                        </div>
                        <div>
                            {popular.length > 0
                                ? popular.slice(0, 20).map((p, i) => <RankCard key={p.product_id} p={p} rank={i + 1} />)
                                : Array.from({ length: 10 }).map((_, i) => <SkeletonRow key={i} />)
                            }
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
