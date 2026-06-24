// ============================================================
//  Cloudflare Workers エッジキャッシュ補助
//  Worker が返す HTML 応答は Cache-Control ヘッダだけでは edge キャッシュされない
//  (cf-cache-status が付かず毎回 Worker 起動=無料枠を消費)。Cache API(caches.default)で
//  明示的に保存/取得し、Googlebot の再クロール・リピート訪問を「Worker非起動」で返す。
//  TTL は応答の Cache-Control(s-maxage) に従う。
// ============================================================

type CFCache = {
    match(req: Request): Promise<Response | undefined>;
    put(req: Request, res: Response): Promise<void>;
};

function getCache(): CFCache | null {
    // `caches.default` は Workers ランタイムのみ。型上 CacheStorage に default は無いのでキャスト。
    return typeof caches !== 'undefined'
        ? (caches as unknown as { default: CFCache }).default
        : null;
}

// mobile/web や ?page など内容が変わる軸を variant に含めて別エントリにする
function buildKey(requestUrl: string, variant: string): Request {
    const u = new URL(requestUrl);
    u.searchParams.set('_cfk', variant);
    return new Request(u.toString(), { method: 'GET' });
}

export type EdgeCtx = { cache: CFCache | null; key: Request | null; hit: Response | null };

/** キャッシュヒットを試みる。hit があればそれを返して Worker 本体処理をスキップできる。 */
export async function edgeLookup(requestUrl: string, variant: string): Promise<EdgeCtx> {
    const cache = getCache();
    if (!cache) return { cache: null, key: null, hit: null };
    const key = buildKey(requestUrl, variant);
    const hit = await cache.match(key).catch(() => undefined);
    return { cache, key, hit: hit ?? null };
}

/** 生成した応答をキャッシュへ保存(TTLは応答のCache-Controlに従う)。clone して本体も返せるように。 */
export async function edgeStore(ctx: EdgeCtx, res: Response): Promise<void> {
    if (ctx.cache && ctx.key && res.status === 200) {
        try { await ctx.cache.put(ctx.key, res.clone()); } catch { /* キャッシュ失敗は無視 */ }
    }
}
