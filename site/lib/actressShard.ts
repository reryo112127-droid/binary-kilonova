/**
 * 女優表示キャッシュのシャードキー計算。
 * scripts/build_actress_display_shards.mjs の actressShardKey と **必ず同じ実装**にすること
 * （ずれると女優ページが全員404相当になる）。
 */
// 2026-10-08 に 64→512（1ファイル平均 約375KB → 約47KB）。作品ページは毎回このファイルを1つ JSON.parse するので、
// 大きいと CPU 時間の上限超過（Workers の exceededCpu）の原因になっていた。生成側と必ず同じ値にすること。
export const ACTRESS_SHARD_COUNT = 512;

/** FNV-1a 32bit → 16進（分割数が256を超えるので3桁 "000".."1ff"） */
export function actressShardKey(name: string): string {
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) {
        h ^= name.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % ACTRESS_SHARD_COUNT).toString(16).padStart(ACTRESS_SHARD_COUNT > 256 ? 3 : 2, '0');
}

export const actressShardFile = (name: string) => `actress_display/${actressShardKey(name)}.json`;
