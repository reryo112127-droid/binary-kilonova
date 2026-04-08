/**
 * Shared in-memory TTL cache for API routes.
 * Survives across requests within the same serverless instance lifecycle.
 */

const _cache = new Map<string, { data: unknown; at: number }>();
const MAX_ENTRIES = 100;

export function getCached<T>(key: string, ttlMs: number): T | null {
    const entry = _cache.get(key);
    if (entry && Date.now() - entry.at < ttlMs) return entry.data as T;
    return null;
}

export function setCached(key: string, data: unknown): void {
    if (_cache.size >= MAX_ENTRIES) {
        // evict oldest entry
        let oldestKey = '';
        let oldestAt = Infinity;
        for (const [k, v] of _cache.entries()) {
            if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
        }
        if (oldestKey) _cache.delete(oldestKey);
    }
    _cache.set(key, { data, at: Date.now() });
}
