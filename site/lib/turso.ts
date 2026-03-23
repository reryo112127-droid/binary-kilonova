import { createClient, type Client } from '@libsql/client';

let mgsClient: Client | null = null;
let fanzaClient: Client | null = null;
let siteClient: Client | null = null;

export function getMgsClient(): Client | null {
    const url = process.env.TURSO_MGS_URL;
    const authToken = process.env.TURSO_MGS_TOKEN;
    if (!url || !authToken) return null;
    if (!mgsClient) {
        mgsClient = createClient({ url, authToken });
    }
    return mgsClient;
}

export function getFanzaClient(): Client | null {
    const url = process.env.TURSO_FANZA_URL;
    const authToken = process.env.TURSO_FANZA_TOKEN;
    if (!url || !authToken) return null;
    if (!fanzaClient) {
        fanzaClient = createClient({ url, authToken });
    }
    return fanzaClient;
}

export function getSiteClient(): Client | null {
    const url = process.env.TURSO_SITE_URL;
    const authToken = process.env.TURSO_SITE_TOKEN;
    if (!url || !authToken) return null;
    if (!siteClient) {
        siteClient = createClient({ url, authToken });
    }
    return siteClient;
}
