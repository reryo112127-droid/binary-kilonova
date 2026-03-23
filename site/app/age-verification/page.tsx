'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function AgeVerificationPage() {
    const router = useRouter();
    const [agreed, setAgreed] = useState(false);

    const handleEnter = () => {
        if (agreed) {
            router.push('/');
        }
    };

    return (
        <div className="fixed inset-0 z-[1000] bg-white flex flex-col items-center justify-center p-6 sm:p-12 overflow-y-auto">
            {/* Background Accent */}
            <div className="absolute inset-0 bg-gradient-to-b from-gray-50 to-white pointer-events-none"></div>

            <div className="relative w-full max-w-xl bg-white shadow-2xl shadow-gray-200 border border-gray-100 rounded-[40px] p-8 sm:p-16 text-center">
                <div className="w-20 h-20 bg-primary/10 rounded-3xl flex items-center justify-center mx-auto mb-8 transform -rotate-6">
                    <span className="material-symbols-outlined text-4xl text-primary font-black">lock</span>
                </div>

                <p className="text-[10px] font-black text-gray-300 uppercase tracking-[0.3em] mb-4">Age Verification Required</p>
                <h1 className="text-3xl font-black tracking-tighter text-gray-900 mb-8 leading-tight">
                    このサイトは<span className="text-primary italic">18歳以上の方専用</span>のコンテンツを含みます。
                </h1>

                <p className="text-[13px] font-medium text-gray-500 leading-relaxed mb-12 text-left bg-gray-50 p-6 rounded-2xl border border-gray-100">
                    当ウェブサイトにはアダルトコンテンツ（性的描写を含む作品、情報）が含まれています。
                    ご利用にあたっては、18歳以上であることを確認させていただきます。また、公共の場での閲覧はお控えください。
                </p>

                <div className="space-y-6">
                    <label className="flex items-center justify-center gap-3 cursor-pointer group">
                        <div className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all ${agreed ? 'bg-primary border-primary shadow-lg shadow-primary/20' : 'bg-white border-gray-200 group-hover:border-primary'}`}>
                            {agreed && <span className="material-symbols-outlined text-white text-lg font-black">check</span>}
                        </div>
                        <input 
                            type="checkbox" 
                            className="hidden" 
                            checked={agreed} 
                            onChange={(e) => setAgreed(e.target.checked)} 
                        />
                        <span className="text-sm font-black text-gray-700 select-none">私は18歳以上であり、上記に同意します</span>
                    </label>

                    <button 
                        onClick={handleEnter}
                        disabled={!agreed}
                        className={`w-full h-16 rounded-2xl font-black text-xs tracking-[0.2em] transition-all shadow-xl ${agreed ? 'bg-primary text-white shadow-primary/30 hover:bg-primary-light hover:scale-105 active:scale-95' : 'bg-gray-100 text-gray-300 shadow-none cursor-not-allowed'}`}
                    >
                        ENTER THE STREAM
                    </button>
                </div>

                <div className="mt-12 pt-8 border-t border-gray-50 flex items-center justify-center gap-8">
                    <a href="https://www.google.com" className="text-[10px] font-bold text-gray-300 hover:text-primary transition-colors">退場する</a>
                    <span className="w-1.5 h-1.5 bg-gray-100 rounded-full"></span>
                    <p className="text-[10px] font-bold text-gray-300">STREAM.JP CONCIERGE</p>
                </div>
            </div>

            {/* Support Info */}
            <p className="mt-8 text-[9px] font-bold text-gray-300 tracking-widest uppercase">
                2026 Premium Digital Content Service.
            </p>
        </div>
    );
}
