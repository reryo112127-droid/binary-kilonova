/**
 * data/*.json の静的キャッシュファイルを読み込むユーティリティ。
 * Cloudflare Workers 環境では ASSETS バインディングから /public/data/ 経由で取得する。
 * ファイルが存在しない場合は null を返す（Tursoフォールバック用）。
 */

import { getCloudflareContext } from '@opennextjs/cloudflare';

const _mem = new Map<string, unknown>();

export function readStaticCache<T>(filename: string): T | null {
    if (_mem.has(filename)) return _mem.get(filename) as T;
    try {
        // Cloudflare Workers: ASSETS バインディングから取得（同期風に見えるが実際は非同期なのでキャッシュ済みのみ返す）
        // 初回は null を返し、preloadStaticCache() で事前ロードする
        return null;
    } catch {
        return null;
    }
}

export async function preloadStaticCache(filename: string): Promise<void> {
    if (_mem.has(filename)) return;
    try {
        const { env } = await getCloudflareContext({ async: true });
        const assets = (env as unknown as { ASSETS: { fetch: (r: Request) => Promise<Response> } }).ASSETS;
        const res = await assets.fetch(new Request(`https://assets.internal/data/${filename}`));
        if (!res.ok) return;
        const data = await res.json();
        _mem.set(filename, data);
    } catch {
        // ignore - Turso にフォールバック
    }
}

export async function readStaticCacheAsync<T>(filename: string): Promise<T | null> {
    if (_mem.has(filename)) return _mem.get(filename) as T;
    await preloadStaticCache(filename);
    return (_mem.get(filename) as T) ?? null;
}

/**
 * Cache-Control ヘッダーを生成する。
 * @param maxAge      CDN/ブラウザキャッシュ秒数（0 = no-store）
 * @param swr         stale-while-revalidate 秒数
 */
export function cacheHeaders(maxAge: number, swr = 0): Record<string, string> {
    if (maxAge <= 0) return { 'Cache-Control': 'no-store' };
    const parts = [`public`, `s-maxage=${maxAge}`, `max-age=${Math.min(maxAge, 60)}`];
    if (swr > 0) parts.push(`stale-while-revalidate=${swr}`);
    return {
        'Cache-Control': parts.join(', '),
        'CDN-Cache-Control': `public, s-maxage=${maxAge}`,
    };
}
