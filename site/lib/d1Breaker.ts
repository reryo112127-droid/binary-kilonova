// ============================================================
//  D1 無料枠切れサーキットブレーカ
//
//  D1 の無料枠は **アカウント全体で 500万行読取/日・10万行書込/日**（UTC 0時リセット）。
//  枠を使い切ると全クエリが例外を投げるが、各呼び出し側は catch で握り潰しているため
//  「500エラー」ではなく「中身が空のサイト」になる。しかも失敗クエリを投げ続けるので
//  レイテンシだけ悪化する。
//
//  そこで枠切れらしきエラーを検知したら一定時間 D1 を叩くのをやめ、
//  `getMgsClient()/getFanzaClient()` に null を返させる。null は「D1 が無い環境」と
//  同じ扱いなので、各所の **既存の静的キャッシュ経路がそのまま生きる**。
//
//  状態は isolate ローカル（Workers に共有ストレージは無い）。isolate ごとに
//  数回失敗して学習するだけなのでコストは無視できる。
// ============================================================

/** 枠切れ以外のエラー（バインド上限・FTS構文・subrequest上限など）は誤爆させない */
const NOT_QUOTA_RE = /sql variables|too many terms|expression tree|subrequest|api requests by single worker/i;

/** 枠切れ・レート超過らしきメッセージ */
const QUOTA_RE =
    /\b429\b|too many requests|exceed\w*[\s\S]{0,60}(?:daily|limit|quota)|(?:daily|quota|free tier|free plan)[\s\S]{0,60}exceed/i;

/** 連続 N 回で作動（単発の一時エラーで1日静的モードに落ちないように） */
export const STRIKES_TO_TRIP = 3;
/** ストライクの有効期間。これを過ぎた古い失敗は忘れる */
export const STRIKE_WINDOW_MS = 60 * 1000;
/** 作動後の再プローブ間隔。枠が復活していれば自動で通常運転に戻る */
export const PROBE_INTERVAL_MS = 15 * 60 * 1000;

let _strikes: number[] = [];   // 直近の枠切れエラー発生時刻
let _blockedUntil = 0;         // これを過ぎるまで D1 を叩かない
let _trippedAt = 0;            // 最後に作動した時刻（観測用）
let _tripCount = 0;            // 作動回数（観測用）

/** 次の UTC 0時（D1 の日次枠リセット時刻）*/
function nextUtcMidnight(now: number): number {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

export function isQuotaError(err: unknown): boolean {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
    if (!msg) return false;
    if (NOT_QUOTA_RE.test(msg)) return false;
    return QUOTA_RE.test(msg);
}

/** D1 クエリが失敗したときに呼ぶ。枠切れらしければストライクを積み、規定回数で作動する。 */
export function noteD1Error(err: unknown, now = Date.now()): void {
    if (!isQuotaError(err)) return;
    _strikes = _strikes.filter(t => now - t < STRIKE_WINDOW_MS);
    _strikes.push(now);
    if (_strikes.length >= STRIKES_TO_TRIP) {
        // 枠は UTC 0時に戻るので、それ以降まで止める意味はない。
        _blockedUntil = Math.min(now + PROBE_INTERVAL_MS, nextUtcMidnight(now));
        _trippedAt = now;
        _tripCount++;
        _strikes = [];
        console.warn(`[d1Breaker] tripped: D1 blocked until ${new Date(_blockedUntil).toISOString()}`);
    }
}

/** D1 クエリが成功したときに呼ぶ。ストライクを解消する。 */
export function noteD1Success(): void {
    if (_strikes.length > 0) _strikes = [];
}

/** true の間は D1 を叩かず、静的キャッシュだけで応答する */
export function isD1Blocked(now = Date.now()): boolean {
    return now < _blockedUntil;
}

/** 観測用（/api/admin/health などから読む想定）*/
export function d1BreakerState(now = Date.now()) {
    return {
        blocked: isD1Blocked(now),
        blockedUntil: _blockedUntil ? new Date(_blockedUntil).toISOString() : null,
        trippedAt: _trippedAt ? new Date(_trippedAt).toISOString() : null,
        tripCount: _tripCount,
        strikes: _strikes.length,
    };
}

/** テスト用 */
export function resetD1Breaker(): void {
    _strikes = [];
    _blockedUntil = 0;
    _trippedAt = 0;
    _tripCount = 0;
}
