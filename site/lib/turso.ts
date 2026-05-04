import { createClient, type Client } from '@libsql/client/web';

let mgsClient: Client | null = null;
let fanzaClient: Client | null = null;
let siteClient: Client | null = null;

// libsql:// → https:// に変換することで fetch ベースの HTTP トランスポートを使用する
// Cloudflare Workers では WebSocket / Node https.request が使えないため必須
function toHttpsUrl(url: string): string {
    return url.replace(/^libsql:\/\//, 'https://');
}

export function getMgsClient(): Client | null {
    const url = process.env.TURSO_MGS_URL;
    const authToken = process.env.TURSO_MGS_TOKEN;
    if (!url || !authToken) return null;
    if (!mgsClient) {
        mgsClient = createClient({ url: toHttpsUrl(url), authToken });
    }
    return mgsClient;
}

export function getFanzaClient(): Client | null {
    const url = process.env.TURSO_FANZA_URL;
    const authToken = process.env.TURSO_FANZA_TOKEN;
    if (!url || !authToken) return null;
    if (!fanzaClient) {
        fanzaClient = createClient({ url: toHttpsUrl(url), authToken });
    }
    return fanzaClient;
}

export function getSiteClient(): Client | null {
    const url = process.env.TURSO_SITE_URL;
    const authToken = process.env.TURSO_SITE_TOKEN;
    if (!url || !authToken) return null;
    if (!siteClient) {
        siteClient = createClient({ url: toHttpsUrl(url), authToken });
    }
    return siteClient;
}
