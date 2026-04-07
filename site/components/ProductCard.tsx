'use client';

import Link from 'next/link';
import { useState } from 'react';
import Image from 'next/image';
import { getPosterImageUrl } from '@/lib/imageUtils';

interface ProductCardProps {
    product_id: string;
    title: string;
    actresses?: string;
    main_image_url?: string;
    wish_count?: number;
    genres?: string;
    badge?: string;          // 右下の番号バッジ (#1, #2 等)
    labelBadge?: string;     // 左上のタイプラベル (新作, 予約 等)
    aspectRatio?: 'poster' | 'landscape' | 'square';
    discount_pct?: number;
}

export default function ProductCard({
    product_id,
    title,
    actresses,
    main_image_url,
    wish_count,
    badge,
    labelBadge,
    aspectRatio = 'poster',
    discount_pct,
}: ProductCardProps) {
    const [imgSrc, setImgSrc] = useState(
        main_image_url
            ? (aspectRatio === 'landscape' ? main_image_url : getPosterImageUrl(main_image_url))
            : ''
    );

    const ratioClasses = {
        poster: 'aspect-[2/3]',
        landscape: 'aspect-[16/9]',
        square: 'aspect-square',
    };

    const labelColor = labelBadge === '予約' ? 'bg-red-600' : 'bg-blue-600';

    return (
        <div className="product-card">
            <Link href={`/product/${product_id}`} className="block relative group overflow-hidden bg-gray-100 rounded-[4px]">
                <div className={`${ratioClasses[aspectRatio]} relative w-full overflow-hidden`}>
                    {imgSrc ? (
                        <Image
                            src={imgSrc}
                            alt={title}
                            fill
                            className="object-cover object-center transition-transform duration-500 group-hover:scale-105"
                            sizes="(max-width: 640px) 50vw, 25vw"
                            priority={false}
                            unoptimized
                            onError={() => {
                                if (main_image_url && imgSrc !== main_image_url) {
                                    setImgSrc(main_image_url);
                                }
                            }}
                        />
                    ) : (
                        <div className="w-full h-full bg-gray-200 animate-pulse" />
                    )}

                    {/* ホバーオーバーレイ */}
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <span className="px-4 py-2 bg-primary text-white text-[10px] font-bold rounded-full transform scale-90 group-hover:scale-100 transition-transform">
                            VIEW DETAILS
                        </span>
                    </div>

                    {/* 左上: セールバッジ（discount_pct優先、次にlabelBadge） */}
                    {discount_pct && discount_pct > 0 ? (
                        <span className="absolute top-2 left-2 bg-red-500 text-white text-[9px] font-black px-1.5 py-0.5 rounded-sm z-10 leading-tight">
                            SALE
                        </span>
                    ) : labelBadge ? (
                        <span className={`absolute top-2 left-2 ${labelColor} text-white text-[9px] font-bold px-1.5 py-0.5 rounded-sm z-10`}>
                            {labelBadge}
                        </span>
                    ) : null}

                    {/* 右下: 番号バッジ */}
                    {badge && (
                        <span className="absolute bottom-2 right-2 bg-black/70 text-white text-sm font-black italic px-2 py-0.5 rounded-sm z-10">
                            {badge.replace('#', '')}
                        </span>
                    )}
                </div>
            </Link>

            <div className="pt-2 space-y-0.5">
                <h3 className="text-xs font-bold truncate text-gray-900">
                    <Link href={`/product/${product_id}`} className="hover:underline">{title}</Link>
                </h3>
                {actresses && (
                    <p className="text-[10px] text-gray-400 truncate">
                        <Link href={`/actress/${encodeURIComponent(actresses.split(',')[0].trim())}`} className="hover:text-primary transition-colors">
                            {actresses}
                        </Link>
                    </p>
                )}
            </div>
        </div>
    );
}
