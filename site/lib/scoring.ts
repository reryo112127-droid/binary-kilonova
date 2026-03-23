// ============================================================
//  AV Concierge スコアリングシステム
//  複数シグナルを統合してランキングスコアを計算する
// ============================================================

// ─── 作品スコア定数 ───────────────────────────────────────
export const PRODUCT_SCORE = {
    /** FANZA お気に入り / MGS 欲しいものリスト（数千件規模の基準値） */
    WISH_COUNT: 1,
    /** サイトいいね（wish_count 100件相当の強い意図シグナル） */
    SITE_LIKE: 100,
    /** レビュー星評価ごとのポイント */
    REVIEW: { 5: 150, 4: 80, 3: 10, 2: -40, 1: -100 } as Record<number, number>,
    /** アフィリエイトリンク経由購入（最強シグナル） */
    PURCHASE: 1000,
} as const;

// ─── 女優スコア定数 ───────────────────────────────────────
export const ACTRESS_SCORE = {
    /** サイト女優いいね */
    SITE_LIKE: 150,
    /** 出演作レビュー星評価ごとのポイント */
    WORK_REVIEW: { 5: 50, 4: 25, 3: 5, 2: -15, 1: -40 } as Record<number, number>,
    /** 出演作アフィリエイト購入 */
    WORK_PURCHASE: 200,
} as const;

// ─── スコア計算関数 ──────────────────────────────────────

export interface ProductSiteData {
    siteLikes: number;
    reviewStarCounts: Partial<Record<number, number>>; // {5:3, 4:1, ...}
    purchaseCount: number;
}

export function computeProductScore(
    wishCount: number,
    siteData: ProductSiteData
): number {
    let score = wishCount * PRODUCT_SCORE.WISH_COUNT;
    score += siteData.siteLikes * PRODUCT_SCORE.SITE_LIKE;
    for (const [stars, count] of Object.entries(siteData.reviewStarCounts)) {
        score += (count ?? 0) * (PRODUCT_SCORE.REVIEW[Number(stars)] ?? 0);
    }
    score += siteData.purchaseCount * PRODUCT_SCORE.PURCHASE;
    return Math.max(0, score);
}

export interface ActressSiteData {
    actressLikes: number;
    workReviewStarCounts: Partial<Record<number, number>>;
    workPurchaseCount: number;
}

export function computeActressScore(siteData: ActressSiteData): number {
    let score = siteData.actressLikes * ACTRESS_SCORE.SITE_LIKE;
    for (const [stars, count] of Object.entries(siteData.workReviewStarCounts)) {
        score += (count ?? 0) * (ACTRESS_SCORE.WORK_REVIEW[Number(stars)] ?? 0);
    }
    score += siteData.workPurchaseCount * ACTRESS_SCORE.WORK_PURCHASE;
    return Math.max(0, score);
}

// ─── スコア内訳（UI表示用） ───────────────────────────────
export function productScoreBreakdown(
    wishCount: number,
    siteData: ProductSiteData
) {
    const reviewScore = Object.entries(siteData.reviewStarCounts).reduce(
        (acc, [stars, count]) => acc + (count ?? 0) * (PRODUCT_SCORE.REVIEW[Number(stars)] ?? 0),
        0
    );
    return {
        wishScore:    wishCount * PRODUCT_SCORE.WISH_COUNT,
        likeScore:    siteData.siteLikes * PRODUCT_SCORE.SITE_LIKE,
        reviewScore,
        purchaseScore: siteData.purchaseCount * PRODUCT_SCORE.PURCHASE,
        total: computeProductScore(wishCount, siteData),
    };
}
