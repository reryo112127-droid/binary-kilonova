/**
 * actress_display_cache.json(約24MB・6万人) を女優名ハッシュで64分割する。
 *
 * 理由: 女優API `/api/actress/[name]` はこの1ファイルを ASSETS から丸ごと取得して
 * JSON.parse し、isolate内(`staticCache.ts` の _mem)に常駐させていた。Workersのisolateは
 * メモリ128MBなので、24MBのJSONをパースしたオブジェクトが居座るのは危険（同時に19MBの
 * actress_extended_products.json も載る可能性がある）。加えて **Cloudflareのアセット上限は
 * 1ファイル25MB** で、24.3MBは限界ぎりぎり＝女優が増えるとデプロイが失敗する。
 *
 * 出力（data/ と public/data/ の両方）:
 *   actress_display/<nn>.json        … nn = 00..3f のシャード（各400KB前後）
 *   actress_display_alias_index.json … 別名 → 正規名（別名の逆引きに全件走査が要るため）
 *
 * 元の actress_display_cache.json は残す（build_actress_whitelist.js 等のNodeスクリプトが
 * ローカルファイルとして読むため）。デプロイ対象からは public/.assetsignore で除外する。
 *
 * 使い方: node scripts/build_actress_display_shards.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHARD_COUNT = 64;

/** FNV-1a 32bit。site/lib/actressShard.ts と必ず同じ実装にすること。 */
export function actressShardKey(name) {
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) {
        h ^= name.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % SHARD_COUNT).toString(16).padStart(2, '0');
}

export function buildActressDisplayShards(displayCache) {
    const shards = {};
    for (let i = 0; i < SHARD_COUNT; i++) shards[i.toString(16).padStart(2, '0')] = {};
    const aliasIndex = {};

    for (const [canonical, entry] of Object.entries(displayCache)) {
        shards[actressShardKey(canonical)][canonical] = entry;
        for (const alias of entry?.aliases ?? []) {
            // 同じ別名が複数の正規名に紐づく場合は先勝ち（元の実装も最初に見つけた1件を採用）
            if (alias && alias !== canonical && !(alias in aliasIndex)) aliasIndex[alias] = canonical;
        }
    }
    return { shards, aliasIndex };
}

function writeBoth(relPath, json) {
    for (const base of [path.join(ROOT, 'data'), path.join(ROOT, 'public', 'data')]) {
        const p = path.join(base, relPath);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, json);
    }
}

function main() {
    const src = path.join(ROOT, 'public', 'data', 'actress_display_cache.json');
    if (!fs.existsSync(src)) {
        console.error(`✗ ${src} が見つかりません`);
        process.exit(1);
    }
    const displayCache = JSON.parse(fs.readFileSync(src, 'utf-8'));
    const { shards, aliasIndex } = buildActressDisplayShards(displayCache);

    let total = 0, maxBytes = 0;
    for (const [key, obj] of Object.entries(shards)) {
        const json = JSON.stringify(obj);
        writeBoth(path.join('actress_display', `${key}.json`), json);
        total += Object.keys(obj).length;
        maxBytes = Math.max(maxBytes, Buffer.byteLength(json));
    }
    const aliasJson = JSON.stringify(aliasIndex);
    writeBoth('actress_display_alias_index.json', aliasJson);

    console.log(`✓ actress_display/*.json — ${SHARD_COUNT}シャード / ${total}人 / 最大 ${(maxBytes / 1024 / 1024).toFixed(2)}MB`);
    console.log(`✓ actress_display_alias_index.json — ${Object.keys(aliasIndex).length}件 / ${(Buffer.byteLength(aliasJson) / 1024 / 1024).toFixed(2)}MB`);
    if (total !== Object.keys(displayCache).length) {
        console.error(`✗ 件数不一致: 元 ${Object.keys(displayCache).length} → シャード合計 ${total}`);
        process.exit(1);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
