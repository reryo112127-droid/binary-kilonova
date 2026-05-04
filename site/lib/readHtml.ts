/**
 * HTMLテンプレートファイルを読み込むユーティリティ。
 * Cloudflare Workers 環境では ASSETS バインディングを使って直接取得する。
 * Node.js（Vercel/ローカル）環境では fs.readFileSync を使う。
 */

import { getCloudflareContext } from '@opennextjs/cloudflare';

export async function readHtml(_requestUrl: string, htmlPath: string): Promise<string> {
    try {
        // Cloudflare Workers: ASSETS バインディングから直接取得
        const { env } = await getCloudflareContext({ async: true });
        const res = await (env as unknown as { ASSETS: { fetch: (r: Request) => Promise<Response> } })
            .ASSETS.fetch(new Request(`https://assets.internal${htmlPath}`));
        if (!res.ok) throw new Error(`ASSETS fetch failed: ${htmlPath} → ${res.status}`);
        return res.text();
    } catch (e: unknown) {
        if (e instanceof Error && e.message.startsWith('ASSETS fetch failed')) throw e;
        // Node.js フォールバック（Vercel・ローカル開発）
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs') as typeof import('fs');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const path = require('path') as typeof import('path');
        const filePath = path.join(process.cwd(), 'public', htmlPath);
        return fs.readFileSync(filePath, 'utf-8');
    }
}
