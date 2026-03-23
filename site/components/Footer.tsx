export default function Footer() {
    return (
        <footer className="bg-[#f9f9f9] border-t border-gray-200 py-8 mb-16 sm:mb-0">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
                {/* リンク */}
                <div className="flex justify-center space-x-6 mb-6">
                    <a href="/info/terms" className="text-[11px] font-bold text-gray-600 hover:text-black transition-colors">利用規約</a>
                    <a href="/info/privacy" className="text-[11px] font-bold text-gray-600 hover:text-black transition-colors">プライバシーポリシー</a>
                </div>

                {/* 免責事項 */}
                <div className="max-w-3xl mx-auto mb-6">
                    <p className="text-[10px] leading-relaxed text-gray-500">
                        本サイトに掲載されている情報は、インターネット上の推測やユーザー提供情報を含む独自の調査に基づくものであり、公式な事実を断定・保証するものではありません。
                    </p>
                </div>

                {/* クレジット */}
                <div className="space-y-2">
                    <p className="text-[10px] text-gray-400">当サイトはアフィリエイトプログラムにより収益を得ています</p>
                    <div className="flex flex-wrap justify-center gap-x-4 text-[10px] text-gray-400">
                        <a href="https://affiliate.dmm.com/api/" target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">
                            Powered by DMM.com Webサービス
                        </a>
                        <a href="https://www.mgstage.com/" target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">
                            Powered by MGS動画
                        </a>
                    </div>
                    <p className="text-[10px] text-gray-400 mt-4">&copy; 2026 STREAM.JP — All Rights Reserved.</p>
                </div>
            </div>
        </footer>
    );
}
