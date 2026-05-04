#!/usr/bin/env node
/**
 * @libsql/hrana-client の cross-fetch インポートを
 * Cloudflare Workers ネイティブ fetch に置き換えるパッチスクリプト
 *
 * npm install 後に自動実行される (postinstall)
 */

const fs = require('fs');
const path = require('path');

const files = [
    {
        file: 'node_modules/@libsql/hrana-client/lib-esm/http/client.js',
        from: `import { fetch, Request } from "cross-fetch";`,
        to: `// patched: use native fetch (Cloudflare Workers compatible)\nconst fetch = globalThis.fetch.bind(globalThis);\nconst Request = globalThis.Request;`,
    },
    {
        file: 'node_modules/@libsql/hrana-client/lib-esm/http/stream.js',
        from: `import { Request, Headers } from "cross-fetch";`,
        to: `// patched: use native fetch (Cloudflare Workers compatible)\nconst Request = globalThis.Request;\nconst Headers = globalThis.Headers;`,
    },
    {
        file: 'node_modules/@libsql/hrana-client/lib-esm/index.js',
        from: `export { fetch, Request, Headers } from "cross-fetch";`,
        to: `// patched: use native fetch (Cloudflare Workers compatible)\nexport const fetch = globalThis.fetch.bind(globalThis);\nexport const Request = globalThis.Request;\nexport const Headers = globalThis.Headers;`,
    },
];

let patched = 0;
for (const { file, from, to } of files) {
    const fullPath = path.join(__dirname, '..', file);
    if (!fs.existsSync(fullPath)) {
        console.log(`[patch-hrana] skip (not found): ${file}`);
        continue;
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    if (content.includes(to.split('\n')[0])) {
        console.log(`[patch-hrana] already patched: ${file}`);
        continue;
    }
    if (!content.includes(from)) {
        console.log(`[patch-hrana] pattern not found (may be different version): ${file}`);
        continue;
    }
    fs.writeFileSync(fullPath, content.replace(from, to), 'utf8');
    console.log(`[patch-hrana] patched: ${file}`);
    patched++;
}
console.log(`[patch-hrana] done (${patched} files patched)`);
