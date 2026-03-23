'use client';

import { useEffect, useState } from 'react';

export default function AgeGate() {
    const [verified, setVerified] = useState<boolean | null>(null);

    useEffect(() => {
        const stored = localStorage.getItem('age_verified');
        setVerified(stored === 'true');
    }, []);

    if (verified === null) return null; // 初期ロード中
    if (verified) return null; // 認証済み

    const handleYes = () => {
        localStorage.setItem('age_verified', 'true');
        setVerified(true);
    };

    const handleNo = () => {
        window.location.href = 'https://www.yahoo.co.jp';
    };

    return (
        <div className="age-gate-overlay">
            <div className="age-gate-box animate-slide-up">
                <h2>年齢確認</h2>
                <p>
                    当サイトはアダルトコンテンツを含む<br />
                    情報を取り扱っております。<br />
                    あなたは18歳以上ですか？
                </p>
                <div className="age-gate-buttons">
                    <button className="btn-yes" onClick={handleYes}>
                        はい（18歳以上）
                    </button>
                    <button className="btn-no" onClick={handleNo}>
                        いいえ
                    </button>
                </div>
            </div>
        </div>
    );
}
