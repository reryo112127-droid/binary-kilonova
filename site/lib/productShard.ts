/**
 * 商品詳細の静的シャード（D1 枠切れ時のフォールバック）。
 *
 * D1 の無料枠が切れると商品詳細は R2 無効化([[avrankings-r2-cache]])以降 D1 が唯一の供給源のため
 * `/api/product/[id]` が 404 を返し、ページが骨組みだけになる。そこで **静的キャッシュから
 * クリック可能な作品（新作/人気/セール/ランキング/女優ページの一覧に載る作品）** を
 * product_id ハッシュで 128 分割した JSON にして ASSETS へ置き、D1 が使えないときだけ読む。
 * Workers Assets のリクエストは D1 無料枠を消費しないので、これが無料の読み取りレプリカになる。
 *
 * シャードの中身は **products テーブルの行と同じ列名**にしてある。呼び出し側は D1 の行の
 * 代わりに差し込むだけでよく、応答組み立てのコードを二重に持たなくて済む。
 *
 * 生成は `site/scripts/build_product_shards.mjs`（ハッシュ実装はそちらと必ず同じにすること。
 * ずれると全作品がフォールバックできなくなる）。
 */
import { readStaticCacheAsync } from './staticCache';

export const PRODUCT_SHARD_COUNT = 128;

/** FNV-1a 32bit → "00".."7f"。product_id は大文字小文字の表記ゆれがあるので小文字で正規化する。 */
export function productShardKey(id: string): string {
    const s = id.toLowerCase();
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % PRODUCT_SHARD_COUNT).toString(16).padStart(2, '0');
}

export const productShardFile = (id: string) => `product/${productShardKey(id)}.json`;

/**
 * シャードから 1 作品を引く。未収録なら null。
 * 戻り値は products 行と同じ形（`source` 列付き）。
 */
export async function readShardProduct(id: string): Promise<Record<string, unknown> | null> {
    if (!id) return null;
    const shard = await readStaticCacheAsync<Record<string, Record<string, unknown>>>(productShardFile(id));
    if (!shard) return null;
    return shard[id.toLowerCase()] ?? null;
}
