/**
 * 長尾LP（/genre/… ・/maker/… ・/series/…）の作品カード静的キャッシュ。
 *
 * LP の本文カードは lib/landingPage.ts が内部で /api/products を呼んで作っており、
 * genre/maker/series には静的経路が無いので **クロールのたびに D1 を読んでいた**。
 * LPは約3,900URLあるため、SEOでLPを増やすほど D1 の日次枠を線形に消費する。
 * ここで ASSETS 配信の静的JSONを先に見ることで、LPのクロールは D1 を1行も読まなくなる
 * （Workers Assets へのリクエストは D1 無料枠を消費しない）。
 *
 * 生成は `site/scripts/build_lp_cache.mjs`（ハッシュ実装は必ず同じにすること。
 * ずれると全LPがキャッシュを外して D1 に落ちる）。
 */
import { readStaticCacheNoMemo } from './staticCache';

export const LP_SHARD_COUNT = 128;

/**
 * 1スラッグあたりの収録上限（scripts/build_lp_cache.mjs の --per 既定値と同じ）。
 * 収録数がこれ未満なら「そのLPの全件が入っている」＝短いページを返しても正しい。
 * ちょうど上限なら打ち切られている可能性があるので、続きは D1 に任せる。
 */
export const LP_MAX_PER = 60;

export type LpCard = {
    product_id: string;
    title?: string;
    actresses?: string;
    main_image_url?: string;
    source?: string;
};

/** FNV-1a 32bit → "00".."3f"。scripts/build_lp_cache.mjs の lpShardKey と同じ実装。 */
export function lpShardKey(slug: string): string {
    let h = 2166136261;
    for (let i = 0; i < slug.length; i++) {
        h ^= slug.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % LP_SHARD_COUNT).toString(16).padStart(2, '0');
}

export const lpShardFile = (type: string, slug: string) => `lp/${type}/${lpShardKey(slug)}.json`;

/**
 * LPの作品カードを静的キャッシュから引く。未収録なら null（呼び出し側は D1 経由へ）。
 * 収録は先頭 N 件（既定60＝2ページぶん）だけなので、それ以降のページは null 相当になる。
 */
export async function readLpCards(type: string, slug: string): Promise<LpCard[] | null> {
    if (!type || !slug) return null;
    const shard = await readShard(lpShardFile(type, slug));
    const cards = shard?.[slug];
    return Array.isArray(cards) && cards.length > 0 ? cards : null;
}

// ── シャードの常駐は直近 N 個まで（LRU）──────────────────────────────
// 1シャード 0.4〜0.8MB（女優 128分割で計67MB、メーカー 46MB）。staticCache の _mem は読んだものを
// 全部 isolate に常駐させるが、作品ページは1ページで女優・メーカー・シリーズの3種を引き、
// 閲覧ごとに違うシャードに当たるので、常駐させると isolate のメモリ(128MB)を食い潰す（2026-09-15）。
const SHARD_LRU_MAX = 24;
const _shardLru = new Map<string, Record<string, LpCard[]> | null>();
async function readShard(file: string): Promise<Record<string, LpCard[]> | null> {
    if (_shardLru.has(file)) {
        const v = _shardLru.get(file) ?? null;
        _shardLru.delete(file); _shardLru.set(file, v); // 最近使ったものを末尾へ
        return v;
    }
    const v = await readStaticCacheNoMemo<Record<string, LpCard[]>>(file);
    _shardLru.set(file, v);
    while (_shardLru.size > SHARD_LRU_MAX) _shardLru.delete(_shardLru.keys().next().value as string);
    return v;
}
