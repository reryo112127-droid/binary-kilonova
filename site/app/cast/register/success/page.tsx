'use client';

import Link from 'next/link';

export default function CastRegistrationSuccessPage() {
    return (
        <div className="animate-fade-in bg-white min-h-[90vh] flex flex-col items-center justify-center p-6 text-center">
            <div className="relative mb-12">
                <div className="w-24 h-24 bg-primary rounded-[32px] flex items-center justify-center rotate-6 shadow-2xl shadow-primary/20">
                    <span className="material-symbols-outlined text-5xl text-white font-black -rotate-6">send</span>
                </div>
                <div className="absolute -top-4 -right-4 w-12 h-12 bg-white rounded-full shadow-lg flex items-center justify-center">
                     <span className="material-symbols-outlined text-primary FILL">check_circle</span>
                </div>
            </div>

            <h1 className="text-2xl font-black tracking-tighter text-gray-900 mb-4">申請ありがとうございます</h1>
            <p className="text-sm font-medium text-gray-400 leading-relaxed max-w-xs mx-auto mb-12">
                出演者情報の追加リクエストを受け付けました。<br />
                コンシェルジュが内容を確認次第、反映させていただきます。
            </p>

            <div className="w-full max-w-sm space-y-4">
                <Link href="/" className="flex items-center justify-center w-full h-14 bg-primary text-white font-black text-xs tracking-widest rounded-full shadow-xl shadow-primary/20 hover:scale-105 transition-all">
                    HOMEに戻る
                </Link>
                <div className="flex gap-4">
                    <button onClick={() => window.history.go(-2)} className="flex-1 h-14 bg-gray-50 text-gray-600 font-black text-[10px] tracking-widest rounded-full hover:bg-gray-100 transition-all">
                        作品ページへ
                    </button>
                    <button onClick={() => window.location.reload()} className="flex-1 h-14 bg-gray-50 text-gray-600 font-black text-[10px] tracking-widest rounded-full hover:bg-gray-100 transition-all">
                        続けて登録
                    </button>
                </div>
            </div>
        </div>
    );
}
