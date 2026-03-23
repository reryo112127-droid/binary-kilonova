'use client';

import Link from 'next/link';

export default function ReviewSuccessPage() {
    return (
        <div className="animate-fade-in bg-white min-h-[90vh] flex flex-col items-center justify-center p-6 text-center">
            <div className="w-24 h-24 bg-primary/5 rounded-full flex items-center justify-center mb-8 animate-bounce">
                <span className="material-symbols-outlined text-5xl text-primary FILL">verified_user</span>
            </div>

            <h1 className="text-2xl font-black tracking-tighter text-gray-900 mb-4">レビューありがとうございます</h1>
            <p className="text-sm font-medium text-gray-400 leading-relaxed max-w-xs mx-auto mb-12">
                お客様の貴重な感想を承りました。<br />
                審査完了後、サイト内に掲載されます。
            </p>

            <div className="w-full max-w-sm space-y-4">
                <Link href="/" className="flex items-center justify-center w-full h-14 bg-primary text-white font-black text-xs tracking-widest rounded-full shadow-xl shadow-primary/20 hover:scale-105 transition-all">
                    HOMEに戻る
                </Link>
                <Link href="/mypage" className="flex items-center justify-center w-full h-14 bg-gray-50 text-gray-600 font-black text-xs tracking-widest rounded-full hover:bg-gray-100 transition-all">
                    マイページを確認
                </Link>
            </div>

            <div className="mt-16 flex items-center gap-2 opacity-20 filter grayscale">
                 <span className="material-symbols-outlined text-4xl">auto_awesome</span>
                 <p className="text-[10px] font-black tracking-widest uppercase">Stream.jp Concierge</p>
            </div>
        </div>
    );
}
