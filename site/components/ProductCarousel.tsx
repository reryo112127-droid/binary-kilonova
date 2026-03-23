'use client';

import { useRef } from 'react';
import ProductCard from './ProductCard';

export default function ProductCarousel({
    products,
    badge,
    labelBadge,
    aspectRatio = 'poster'
}: {
    products: any[],
    badge?: string,
    labelBadge?: string,
    aspectRatio?: 'poster' | 'landscape' | 'square'
}) {
    const scrollRef = useRef<HTMLDivElement>(null);

    const scroll = (offset: number) => {
        if (scrollRef.current) {
            scrollRef.current.scrollBy({ left: offset, behavior: 'smooth' });
        }
    };

    const widthClass = aspectRatio === 'landscape' ? 'w-[280px]' : 'w-[160px]';

    return (
        <div className="relative group">
            {/* スクロールボタン (デスクトップのみ) */}
            <button
                onClick={() => scroll(-300)}
                className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 z-10 w-10 h-10 bg-white shadow-lg rounded-full hidden md:flex items-center justify-center text-primary group-hover:scale-110 transition-transform"
            >
                <span className="material-symbols-outlined">chevron_left</span>
            </button>
            <button
                onClick={() => scroll(300)}
                className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-10 w-10 h-10 bg-white shadow-lg rounded-full hidden md:flex items-center justify-center text-primary group-hover:scale-110 transition-transform"
            >
                <span className="material-symbols-outlined">chevron_right</span>
            </button>

            <div
                ref={scrollRef}
                className="flex gap-4 overflow-x-auto no-scrollbar scroll-smooth pb-2"
                style={{ scrollbarWidth: 'none' }}
            >
                {products.map((p, i) => (
                    <div key={p.product_id} className={`${widthClass} flex-shrink-0`}>
                        <ProductCard
                            product_id={p.product_id}
                            title={p.title}
                            actresses={p.actresses}
                            main_image_url={p.main_image_url}
                            wish_count={p.wish_count}
                            badge={`${i + 1}`}
                            labelBadge={labelBadge}
                            aspectRatio={aspectRatio}
                        />
                    </div>
                ))}
            </div>
        </div>
    );
}
