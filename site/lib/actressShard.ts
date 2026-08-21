/**
 * 女優表示キャッシュのシャードキー計算。
 * scripts/build_actress_display_shards.mjs の actressShardKey と **必ず同じ実装**にすること
 * （ずれると女優ページが全員404相当になる）。
 */
export const ACTRESS_SHARD_COUNT = 64;

/** FNV-1a 32bit → "00".."3f" */
export function actressShardKey(name: string): string {
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) {
        h ^= name.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % ACTRESS_SHARD_COUNT).toString(16).padStart(2, '0');
}

export const actressShardFile = (name: string) => `actress_display/${actressShardKey(name)}.json`;
