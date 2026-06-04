/**
 * 商品詳細の R2 read-through キャッシュ。
 * Tursoから初回1回だけ読み、R2に保存。以降はR2から返してTuruso読み込みを削減する。
 * Cloudflare Workers 環境でのみ動作（getCloudflareContext で R2 バインディングを取得）。
 */
import { getCloudflareContext } from '@opennextjs/cloudflare';

// R2Bucket の最小型定義（@cloudflare/workers-types に依存しない）
interface R2ObjectBody {
    text(): Promise<string>;
}
interface R2BucketLike {
    get(key: string): Promise<R2ObjectBody | null>;
    put(key: string, value: string, opts?: unknown): Promise<unknown>;
    delete(key: string): Promise<unknown>;
}

const productKey = (id: string) => `product/${id}.json`;

async function getBucket(): Promise<R2BucketLike | null> {
    try {
        const { env } = await getCloudflareContext({ async: true });
        return (env as unknown as { PRODUCTS_BUCKET?: R2BucketLike }).PRODUCTS_BUCKET ?? null;
    } catch {
        return null;
    }
}

/** R2から商品詳細JSONを取得（なければ null） */
export async function r2GetProduct(id: string): Promise<Record<string, unknown> | null> {
    const bucket = await getBucket();
    if (!bucket) return null;
    try {
        const obj = await bucket.get(productKey(id));
        if (!obj) return null;
        return JSON.parse(await obj.text());
    } catch {
        return null;
    }
}

// 書き込み上限ガード: R2無料枠(Class A 100万/月)を超えないための保険。
// isolateごとのカウンタなので厳密ではないが、暴走的な書き込み増加を防ぐ。
// 上限到達後はR2書き込みをスキップし、Turso/CFキャッシュで動作継続する。
const MAX_WRITES_PER_DAY = 30000; // 30000/日 × 30 = 90万 < 100万枠
let _writeCount = 0;
let _writeDay = '';

/** R2に商品詳細JSONを保存（失敗・上限超過しても無視） */
export async function r2PutProduct(id: string, data: Record<string, unknown>): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== _writeDay) { _writeDay = today; _writeCount = 0; }
    if (_writeCount >= MAX_WRITES_PER_DAY) return; // 日次上限ガード

    const bucket = await getBucket();
    if (!bucket) return;
    try {
        await bucket.put(productKey(id), JSON.stringify(data), {
            httpMetadata: { contentType: 'application/json' },
        });
        _writeCount++;
    } catch {
        /* 書き込み失敗は無視（次回アクセスで再試行） */
    }
}

/** R2の商品詳細を削除（価格更新時の無効化用） */
export async function r2DeleteProduct(id: string): Promise<void> {
    const bucket = await getBucket();
    if (!bucket) return;
    try {
        await bucket.delete(productKey(id));
    } catch {
        /* ignore */
    }
}
