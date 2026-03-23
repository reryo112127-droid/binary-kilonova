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

function SmallCard({ p }: { p: Product }) {
    const poster = getPosterImageUrl(p.main_image_url);
    return (
        <Link href={`/product/${encodeURIComponent(p.product_id)}`} className="min-w-[110px] w-[110px] shrink-0 block group">
            <div className="aspect-[2/3] rounded-lg bg-slate-200 mb-2 overflow-hidden shadow-sm">
                {poster && (
                    <img alt="" className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform" src={poster} loading="lazy"
                        onError={e => { if (p.main_image_url && e.currentTarget.src !== p.main_image_url) e.currentTarget.src = p.main_image_url!; }} />
                )}
            </div>
            <p className="text-[11px] font-bold leading-tight line-clamp-2 text-gray-800">{p.title}</p>
        </Link>
    );
}

function NewCard({ p }: { p: Product }) {
    const actress = p.actresses ? p.actresses.split(',')[0].trim() : '';
    return (
        <Link href={`/product/${encodeURIComponent(p.product_id)}`} className="min-w-[260px] p-3 bg-white rounded-xl border border-primary/10 shadow-sm flex gap-3 shrink-0 block group">
            <div className="w-16 aspect-square rounded-lg overflow-hidden shrink-0 bg-slate-100">
                {p.main_image_url && (
                    <img alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform" src={p.main_image_url} loading="lazy" />
                )}
            </div>
            <div className="flex flex-col justify-center min-w-0">
                {actress && <span className="text-[9px] text-primary font-bold truncate">{actress}</span>}
                <h3 className="font-bold text-[13px] line-clamp-2 mt-0.5 text-gray-800">{p.title}</h3>
            </div>
        </Link>
    );
}

function RankCard({ p, rank }: { p: Product; rank: number }) {
    const poster = getPosterImageUrl(p.main_image_url);
    return (
        <Link href={`/product/${encodeURIComponent(p.product_id)}`} className="relative min-w-[160px] aspect-[3/4] rounded-xl overflow-hidden shadow-md shrink-0 block group">
            {poster && (
                <div className="absolute inset-0 bg-cover bg-top group-hover:scale-105 transition-transform" style={{ backgroundImage: `url('${poster}')` }} />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
            <div className={`absolute top-2 left-2 size-7 flex items-center justify-center text-white text-xs font-bold rounded ${rank === 1 ? 'bg-primary' : 'bg-black/60 backdrop-blur-md'}`}>
                {rank}
            </div>
            <div className="absolute bottom-0 p-2.5 w-full">
                <p className="text-white text-[13px] font-bold line-clamp-2">{p.title}</p>
            </div>
        </Link>
    );
}

export default function HomePageMobile() {
    const [popular, setPopular] = useState<Product[]>([]);
    const [newArrivals, setNewArrivals] = useState<Product[]>([]);

    useEffect(() => {
        fetch('/api/products?sort=wish_count&limit=8')
            .then(r => r.json())
            .then(setPopular)
            .catch(() => {});
        fetch('/api/products?sort=new&limit=6')
            .then(r => r.json())
            .then(setNewArrivals)
            .catch(() => {});
    }, []);

    const skeletonCards = (n: number) =>
        Array.from({ length: n }).map((_, i) => (
            <div key={i} className="min-w-[110px] w-[110px] shrink-0 animate-pulse">
                <div className="aspect-[2/3] rounded-lg bg-slate-100 mb-2" />
                <div className="h-2 bg-slate-100 rounded w-3/4 mb-1" />
                <div className="h-2 bg-slate-100 rounded w-1/2" />
            </div>
        ));

    return (
        <div className="pb-4">
            {/* 注目作品 */}
            <section className="mt-4">
                <div className="flex items-center justify-between px-4 mb-3">
                    <h2 className="text-base font-black tracking-tight">注目作品</h2>
                    <Link href="/search?sort=wish_count" className="text-xs text-primary font-bold">すべて見る</Link>
                </div>
                <div className="flex gap-3 overflow-x-auto px-4 no-scrollbar">
                    {popular.length > 0 ? popular.slice(0, 5).map(p => <SmallCard key={p.product_id} p={p} />) : skeletonCards(4)}
                </div>
            </section>

            {/* 新作 */}
            <section className="mt-8">
                <div className="flex items-center justify-between px-4 mb-3">
                    <h2 className="text-base font-black tracking-tight">新作</h2>
                    <Link href="/search?sort=new" className="text-xs text-primary font-bold">すべて見る</Link>
                </div>
                <div className="flex gap-3 overflow-x-auto px-4 no-scrollbar">
                    {newArrivals.length > 0 ? newArrivals.map(p => <NewCard key={p.product_id} p={p} />) : (
                        Array.from({ length: 3 }).map((_, i) => (
                            <div key={i} className="min-w-[260px] h-24 rounded-xl bg-slate-100 animate-pulse shrink-0" />
                        ))
                    )}
                </div>
            </section>

            {/* ランキング */}
            <section className="mt-8 mb-8">
                <div className="flex items-center justify-between px-4 mb-3">
                    <h2 className="text-base font-black tracking-tight">人気ランキング</h2>
                    <Link href="/ranking" className="text-xs text-primary font-bold">すべて見る</Link>
                </div>
                <div className="flex gap-3 overflow-x-auto px-4 no-scrollbar pb-2">
                    {popular.length > 0 ? popular.slice(0, 5).map((p, i) => <RankCard key={p.product_id} p={p} rank={i + 1} />) : (
                        Array.from({ length: 3 }).map((_, i) => (
                            <div key={i} className="min-w-[160px] aspect-[3/4] rounded-xl bg-slate-100 animate-pulse shrink-0" />
                        ))
                    )}
                </div>
            </section>

            {/* Footer */}
            <footer className="bg-gray-50 px-5 pt-6 pb-4 border-t border-gray-100 mt-4">
                <div className="max-w-md mx-auto space-y-4">
                    <div className="flex justify-center gap-6">
                        <a className="text-[11px] font-medium text-gray-500 hover:text-primary transition-colors" href="#">利用規約</a>
                        <a className="text-[11px] font-medium text-gray-500 hover:text-primary transition-colors" href="#">プライバシーポリシー</a>
                    </div>
                    <p className="text-[10px] leading-relaxed text-gray-400 text-justify">
                        本サイトに掲載されている豊胸情報、素人作品の出演者予想、および別名義情報は、インターネット上の推測やユーザー提供情報を含む独自の調査に基づくものであり、公式な事実を断定・保証するものではありません。
                    </p>
                    <p className="text-[10px] text-center text-gray-400">© 2026 AV Concierge</p>
                </div>
            </footer>
        </div>
    );
}
