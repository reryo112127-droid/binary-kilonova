'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import ProductCard from '@/components/ProductCard';

export default function VideoListPage() {
    const [products, setProducts] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchVideos = useCallback(async () => {
        setLoading(true);
        try {
            // Fetch products that typically have videos
            const res = await fetch(`/api/products?limit=60&sort=new`);
            const data = await res.json();
            setProducts(data);
        } catch (error) {
            console.error(error);
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        fetchVideos();
    }, [fetchVideos]);

    return (
        <div className="animate-fade-in bg-white min-h-screen">
            {/* Header */}
            <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-gray-100 h-14 flex items-center px-4">
                <Link href="/" className="mr-4 text-gray-400 hover:text-primary transition-colors">
                    <span className="material-symbols-outlined">arrow_back</span>
                </Link>
                <h1 className="text-sm font-black tracking-tight flex-1">動画作品一覧</h1>
                <button className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center">
                    <span className="material-symbols-outlined text-xs">filter_list</span>
                </button>
            </header>

            <main className="p-4">
                <div className="flex items-center justify-between mb-8 px-1">
                    <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-primary text-sm">play_circle</span>
                        <h2 className="text-[10px] font-black tracking-widest text-gray-400 uppercase">Streaming Now</h2>
                    </div>
                    <p className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">
                        {products.length} TITLES
                    </p>
                </div>

                {loading ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                        {Array.from({ length: 12 }).map((_, i) => (
                            <div key={i} className="space-y-2 animate-pulse">
                                <div className="aspect-video bg-gray-100 rounded-xl"></div>
                                <div className="h-3 bg-gray-100 rounded w-3/4"></div>
                                <div className="h-2 bg-gray-100 rounded w-1/2"></div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                        {products.map((p) => (
                            <ProductCard
                                key={p.product_id}
                                product_id={p.product_id}
                                title={p.title}
                                actresses={p.actresses}
                                main_image_url={p.main_image_url}
                                wish_count={p.wish_count}
                                aspectRatio="landscape"
                            />
                        ))}
                    </div>
                )}

                <div className="flex justify-center py-16">
                     <button className="px-12 py-4 bg-primary/5 text-primary font-black text-xs tracking-widest rounded-full hover:bg-primary/10 transition-all">
                        LOAD MORE VIDEOS
                    </button>
                </div>
            </main>
        </div>
    );
}
