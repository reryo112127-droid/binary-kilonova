'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

export default function ReviewSubmissionPage() {
    const params = useParams();
    const router = useRouter();
    const id = params.id as string;
    
    const [rating, setRating] = useState(0);
    const [title, setTitle] = useState('');
    const [comment, setComment] = useState('');
    const [product, setProduct] = useState<any>(null);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);

    useEffect(() => {
        // Fetch product info briefly for context
        fetch(`/api/product/${id}`)
            .then(res => res.json())
            .then(data => setProduct(data))
            .catch(console.error);
    }, [id]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (rating === 0 || !comment || submitting) return;
        setSubmitting(true);
        setSubmitError(null);

        let sid = '';
        if (typeof window !== 'undefined') {
            sid = localStorage.getItem('session_id') || '';
            if (!sid) {
                sid = crypto.randomUUID();
                localStorage.setItem('session_id', sid);
            }
        }

        try {
            const res = await fetch(`/api/review/${id}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-session-id': sid,
                },
                body: JSON.stringify({ stars: rating, title: title || undefined, comment }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'エラーが発生しました');
            }
            router.push('/review/success');
        } catch (err: any) {
            setSubmitError(err.message);
            setSubmitting(false);
        }
    };

    return (
        <div className="animate-fade-in bg-white min-h-screen">
            {/* Header */}
            <header className="sticky top-0 z-30 bg-white border-b border-gray-100 h-14 flex items-center px-4">
                <button onClick={() => router.back()} className="mr-4 text-gray-400">
                    <span className="material-symbols-outlined">close</span>
                </button>
                <h1 className="text-sm font-black tracking-tight flex-1 text-center pr-10">レビューを書く</h1>
            </header>

            <main className="p-6 max-w-xl mx-auto space-y-8">
                {/* Product Context */}
                {product && (
                    <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-2xl">
                        <div className="relative w-16 aspect-[2/3] bg-gray-200 rounded-lg overflow-hidden shadow-sm">
                            <img src={product.main_image_url} alt={product.title} className="object-cover w-full h-full" />
                        </div>
                        <div className="flex-1">
                            <p className="text-[10px] font-black text-primary uppercase tracking-widest mb-1">{product.product_id}</p>
                            <h2 className="text-xs font-bold text-gray-800 line-clamp-2">{product.title}</h2>
                        </div>
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-8">
                    {/* Star Rating */}
                    <div className="flex flex-col items-center gap-4">
                        <h3 className="text-[10px] font-black text-gray-400 uppercase tracking-widest">General Rating</h3>
                        <div className="flex gap-2">
                            {[1, 2, 3, 4, 5].map((star) => (
                                <button
                                    key={star}
                                    type="button"
                                    onClick={() => setRating(star)}
                                    className="focus:outline-none transition-transform active:scale-90"
                                >
                                    <span className={`material-symbols-outlined text-4xl ${rating >= star ? 'text-primary FILL' : 'text-gray-100'}`}>
                                        star
                                    </span>
                                </button>
                            ))}
                        </div>
                        <p className="text-[10px] font-bold text-gray-400">
                            {rating === 5 ? '感動した！' : rating === 4 ? '満足' : rating === 3 ? 'ふつう' : rating === 2 ? 'いまいち' : rating === 1 ? '残念' : 'タップして評価'}
                        </p>
                    </div>

                    <div className="space-y-4">
                        <div className="space-y-1">
                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest px-1">Review Title</label>
                            <input 
                                type="text"
                                placeholder="見出し（例：最高傑作でした）"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                className="w-full h-14 px-4 bg-gray-50 border-none rounded-2xl text-sm font-medium focus:ring-2 focus:ring-primary/20"
                            />
                        </div>
                        <div className="space-y-1">
                            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest px-1">Detailed Comment</label>
                            <textarea 
                                placeholder="作品を視聴した感想を教えてください"
                                rows={6}
                                value={comment}
                                onChange={(e) => setComment(e.target.value)}
                                className="w-full p-4 bg-gray-50 border-none rounded-2xl text-sm font-medium focus:ring-2 focus:ring-primary/20 resize-none"
                            ></textarea>
                        </div>
                    </div>

                    {submitError && (
                        <p className="text-xs text-red-500 text-center font-bold">{submitError}</p>
                    )}
                    <div className="pt-4">
                        <button
                            type="submit"
                            disabled={rating === 0 || !comment || submitting}
                            className={`w-full h-16 rounded-2xl font-black text-sm tracking-widest shadow-xl transition-all ${rating > 0 && comment && !submitting ? 'bg-primary text-white shadow-primary/30 hover:bg-primary-light active:scale-98' : 'bg-gray-100 text-gray-300 cursor-not-allowed shadow-none'}`}
                        >
                            {submitting ? '送信中...' : 'SUBMIT REVIEW'}
                        </button>
                    </div>
                </form>
            </main>
        </div>
    );
}
