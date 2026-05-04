/**
 * HTMLテンプレートファイルを読み込むユーティリティ。
 * Cloudflare Workers 環境では ASSETS バインディングを使って直接取得する。
 */

import { getCloudflareContext } from '@opennextjs/cloudflare';

export async function readHtml(_requestUrl: string, htmlPath: string): Promise<string> {
    try {
        // Cloudflare Workers: ASSETS バインディングから直接取得（Next.jsルーティングをバイパス）
        const { env } = await getCloudflareContext({ async: true });
        const res = await (env as unknown as { ASSETS: { fetch: (r: Request) => Promise<Response> } })
            .ASSETS.fetch(new Request(`https://assets.internal${htmlPath}`));
        if (!res.ok) throw new Error(`ASSETS fetch failed: ${htmlPath} → ${res.status}`);
        return res.text();
    } catch (e: unknown) {
        // フォールバック: 通常の fetch（ローカル開発環境用）
        if (e instanceof Error && e.message.startsWith('ASSETS fetch failed')) throw e;
        const res = await fetch(new URL(htmlPath, 'http://localhost:3000').toString());
        if (!res.ok) throw new Error(`readHtml: ${htmlPath} → ${res.status}`);
        return res.text();
    }
}
