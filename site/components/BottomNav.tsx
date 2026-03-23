'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function BottomNav() {
    const pathname = usePathname();

    const navItems = [
        { href: '/', icon: 'home', label: 'ホーム' },
        { href: '/search/advanced', icon: 'manage_search', label: '詳細検索' },
        { href: '/ranking', icon: 'social_leaderboard', label: 'ランキング' },
        { href: '/video', icon: 'play_circle', label: '動画' },
        { href: '/mypage', icon: 'person', label: 'マイページ' },
    ];

    return (
        <nav className="bottom-nav">
            {navItems.map((item) => {
                const isActive = pathname === item.href;
                return (
                    <Link
                        key={item.href}
                        href={item.href}
                        className={`nav-item ${isActive ? 'active' : ''}`}
                    >
                        <span className={`material-symbols-outlined ${isActive ? 'FILL' : ''}`} style={{ fontVariationSettings: isActive ? "'FILL' 1" : "" }}>
                            {item.icon}
                        </span>
                        <span className="text-[10px] font-bold">{item.label}</span>
                    </Link>
                );
            })}
        </nav>
    );
}
