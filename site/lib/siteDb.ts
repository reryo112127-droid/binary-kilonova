import { getSiteClient } from './turso';
import type { ProductSiteData, ActressSiteData } from './scoring';

// ─── スキーマ初期化 ───────────────────────────────────────
let schemaInitialized = false;

export async function initSiteSchema() {
    if (schemaInitialized) return;
    const db = getSiteClient();
    if (!db) return;

    const statements = [
        `CREATE TABLE IF NOT EXISTS product_likes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(product_id, session_id)
        )`,
        `CREATE TABLE IF NOT EXISTS actress_likes (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            actress_name TEXT NOT NULL,
            session_id   TEXT NOT NULL,
            created_at   TEXT DEFAULT (datetime('now')),
            UNIQUE(actress_name, session_id)
        )`,
        `CREATE TABLE IF NOT EXISTS product_reviews (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            stars      INTEGER NOT NULL CHECK(stars >= 1 AND stars <= 5),
            title      TEXT,
            comment    TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(product_id, session_id)
        )`,
        `CREATE TABLE IF NOT EXISTS purchase_events (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id TEXT NOT NULL,
            platform   TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS cast_contributions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(session_id, product_id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_product_likes_pid   ON product_likes(product_id)`,
        `CREATE INDEX IF NOT EXISTS idx_actress_likes_name  ON actress_likes(actress_name)`,
        `CREATE INDEX IF NOT EXISTS idx_product_reviews_pid ON product_reviews(product_id)`,
        `CREATE INDEX IF NOT EXISTS idx_purchase_events_pid ON purchase_events(product_id)`,
        `CREATE INDEX IF NOT EXISTS idx_cast_contrib_session ON cast_contributions(session_id)`,
    ];

    for (const sql of statements) {
        await db.execute(sql);
    }
    schemaInitialized = true;
}

// ─── サイトデータ取得 ─────────────────────────────────────

export async function getProductSiteData(productId: string): Promise<ProductSiteData> {
    const db = getSiteClient();
    if (!db) return { siteLikes: 0, reviewStarCounts: {}, purchaseCount: 0 };

    await initSiteSchema();

    const [likes, reviews, purchases] = await Promise.all([
        db.execute({ sql: 'SELECT COUNT(*) as cnt FROM product_likes WHERE product_id = ?', args: [productId] }),
        db.execute({ sql: 'SELECT stars, COUNT(*) as cnt FROM product_reviews WHERE product_id = ? GROUP BY stars', args: [productId] }),
        db.execute({ sql: 'SELECT COUNT(*) as cnt FROM purchase_events WHERE product_id = ?', args: [productId] }),
    ]);

    const reviewStarCounts: Partial<Record<number, number>> = {};
    for (const row of reviews.rows) {
        reviewStarCounts[Number(row.stars)] = Number(row.cnt);
    }

    return {
        siteLikes:        Number(likes.rows[0]?.cnt ?? 0),
        reviewStarCounts,
        purchaseCount:    Number(purchases.rows[0]?.cnt ?? 0),
    };
}

export async function getActressSiteData(actressName: string): Promise<ActressSiteData> {
    const db = getSiteClient();
    if (!db) return { actressLikes: 0, workReviewStarCounts: {}, workPurchaseCount: 0 };

    await initSiteSchema();

    // 女優のいいね
    const likesRes = await db.execute({
        sql: 'SELECT COUNT(*) as cnt FROM actress_likes WHERE actress_name = ?',
        args: [actressName],
    });

    // 出演作のレビューと購入は product_id がわからないので
    // ここでは actress_name を使った間接取得はできないため、
    // 呼び出し側で product_id リストを渡す形にする
    return {
        actressLikes:          Number(likesRes.rows[0]?.cnt ?? 0),
        workReviewStarCounts:  {},
        workPurchaseCount:     0,
    };
}

export async function getActressSiteDataFull(
    actressName: string,
    productIds: string[]
): Promise<ActressSiteData> {
    const db = getSiteClient();
    if (!db) return { actressLikes: 0, workReviewStarCounts: {}, workPurchaseCount: 0 };

    await initSiteSchema();

    const placeholders = productIds.map(() => '?').join(',');
    const [likesRes, reviewsRes, purchasesRes] = await Promise.all([
        db.execute({
            sql: 'SELECT COUNT(*) as cnt FROM actress_likes WHERE actress_name = ?',
            args: [actressName],
        }),
        productIds.length > 0
            ? db.execute({
                sql: `SELECT stars, COUNT(*) as cnt FROM product_reviews WHERE product_id IN (${placeholders}) GROUP BY stars`,
                args: productIds,
              })
            : Promise.resolve({ rows: [] }),
        productIds.length > 0
            ? db.execute({
                sql: `SELECT COUNT(*) as cnt FROM purchase_events WHERE product_id IN (${placeholders})`,
                args: productIds,
              })
            : Promise.resolve({ rows: [{ cnt: 0 }] }),
    ]);

    const workReviewStarCounts: Partial<Record<number, number>> = {};
    for (const row of reviewsRes.rows) {
        workReviewStarCounts[Number(row.stars)] = Number(row.cnt);
    }

    return {
        actressLikes:         Number(likesRes.rows[0]?.cnt ?? 0),
        workReviewStarCounts,
        workPurchaseCount:    Number(purchasesRes.rows[0]?.cnt ?? 0),
    };
}

// ─── セッション状態確認 ──────────────────────────────────

export async function hasProductLike(productId: string, sessionId: string): Promise<boolean> {
    const db = getSiteClient();
    if (!db) return false;
    await initSiteSchema();
    const res = await db.execute({
        sql: 'SELECT 1 FROM product_likes WHERE product_id = ? AND session_id = ?',
        args: [productId, sessionId],
    });
    return res.rows.length > 0;
}

export async function hasActressLike(actressName: string, sessionId: string): Promise<boolean> {
    const db = getSiteClient();
    if (!db) return false;
    await initSiteSchema();
    const res = await db.execute({
        sql: 'SELECT 1 FROM actress_likes WHERE actress_name = ? AND session_id = ?',
        args: [actressName, sessionId],
    });
    return res.rows.length > 0;
}

export async function getProductReviews(productId: string) {
    const db = getSiteClient();
    if (!db) return [];
    await initSiteSchema();
    const res = await db.execute({
        sql: 'SELECT stars, title, comment, created_at FROM product_reviews WHERE product_id = ? ORDER BY created_at DESC',
        args: [productId],
    });
    return res.rows.map(r => ({ ...r }));
}

// ─── 貢献者バッジ定義 ─────────────────────────────────────────
export const CONTRIBUTOR_BADGES = [
    { min: 100, label: '殿堂入り', emoji: '🏆', color: 'text-yellow-500' },
    { min:  50, label: 'プラチナ',  emoji: '💎', color: 'text-sky-400'    },
    { min:  20, label: 'ゴールド',  emoji: '🥇', color: 'text-amber-500'  },
    { min:   5, label: 'シルバー',  emoji: '🥈', color: 'text-slate-400'  },
    { min:   1, label: 'ブロンズ',  emoji: '🥉', color: 'text-orange-400' },
] as const;

export function getContributorBadge(count: number) {
    return CONTRIBUTOR_BADGES.find(b => count >= b.min) ?? null;
}

// ─── 貢献記録 ─────────────────────────────────────────────────
export async function recordContribution(sessionId: string, productId: string): Promise<void> {
    const db = getSiteClient();
    if (!db || !sessionId) return;
    await initSiteSchema();
    // UNIQUE制約で重複は無視
    await db.execute({
        sql: `INSERT OR IGNORE INTO cast_contributions (session_id, product_id) VALUES (?, ?)`,
        args: [sessionId, productId],
    }).catch(() => {});
}

// ─── 自分の貢献統計 ──────────────────────────────────────────
export async function getMyContributions(sessionId: string): Promise<{
    count: number;
    badge: typeof CONTRIBUTOR_BADGES[number] | null;
    recent: { product_id: string; created_at: string }[];
}> {
    const db = getSiteClient();
    if (!db || !sessionId) return { count: 0, badge: null, recent: [] };
    await initSiteSchema();

    const [countRes, recentRes] = await Promise.all([
        db.execute({
            sql: 'SELECT COUNT(*) as cnt FROM cast_contributions WHERE session_id = ?',
            args: [sessionId],
        }),
        db.execute({
            sql: 'SELECT product_id, created_at FROM cast_contributions WHERE session_id = ? ORDER BY created_at DESC LIMIT 10',
            args: [sessionId],
        }),
    ]);

    const count = Number(countRes.rows[0]?.cnt ?? 0);
    return {
        count,
        badge: getContributorBadge(count),
        recent: recentRes.rows.map(r => ({ product_id: String(r.product_id), created_at: String(r.created_at) })),
    };
}

// ─── 貢献者ランキング ─────────────────────────────────────────
export async function getContributorLeaderboard(limit = 20): Promise<{
    rank: number;
    session_display: string;  // 最初の8文字のみ表示
    count: number;
    badge: typeof CONTRIBUTOR_BADGES[number] | null;
}[]> {
    const db = getSiteClient();
    if (!db) return [];
    await initSiteSchema();

    const res = await db.execute({
        sql: `SELECT session_id, COUNT(*) as cnt
              FROM cast_contributions
              GROUP BY session_id
              ORDER BY cnt DESC
              LIMIT ?`,
        args: [limit],
    });

    return res.rows.map((row, i) => {
        const count = Number(row.cnt);
        const sid   = String(row.session_id);
        return {
            rank:            i + 1,
            session_display: sid.slice(0, 8) + '…',
            count,
            badge:           getContributorBadge(count),
        };
    });
}
