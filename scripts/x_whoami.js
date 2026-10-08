/**
 * 投稿用 Cookie（site/.env.local の XCK_<acct>_AUTH_TOKEN / _CT0）で各アカウントにログインし、
 * 公開ハンドル（@ユーザー名）を読み取って data/x_handles.json に書く。読むだけで何も投稿しない。
 * サイトの「Xでフォロー」リンク（site/lib/xFollow.ts）はこのファイルの値を使う。
 *
 *   node scripts/x_whoami.js
 */
require('dotenv').config({ path: './site/.env.local' });
const fs = require('fs');
const path = require('path');

const ACCOUNTS = { '005': 'new', '004': 'sale', '007': 'vr', '002': 'collab', '008': 'anon', '006': 'lady' };
const OUT = path.join(__dirname, '..', 'data', 'x_handles.json');

(async () => {
    const { chromium } = require('playwright');
    const out = {};
    for (const [acct, genre] of Object.entries(ACCOUNTS)) {
        const auth = process.env[`XCK_${acct}_AUTH_TOKEN`], ct0 = process.env[`XCK_${acct}_CT0`];
        if (!auth || !ct0) { console.log(`@${acct}: Cookie未設定`); continue; }
        // 1アカウントずつ起動して閉じる（メモリを溜めない）
        const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
        try {
            const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
            const cookies = [];
            for (const dom of ['.x.com', '.twitter.com']) {
                cookies.push({ name: 'auth_token', value: auth, domain: dom, path: '/', secure: true, httpOnly: true });
                cookies.push({ name: 'ct0', value: ct0, domain: dom, path: '/', secure: true });
            }
            await ctx.addCookies(cookies);
            const page = await ctx.newPage();
            await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
            const link = page.locator('[data-testid="AppTabBar_Profile_Link"]').first();
            const href = await link.getAttribute('href', { timeout: 20000 }).catch(() => null);
            const handle = href ? href.replace(/^\//, '') : '';
            if (handle) { out[genre] = { account: acct, handle }; console.log(`@${acct}(${genre}) → @${handle}`); }
            else console.log(`@${acct}(${genre}) → 取得できず（${page.url()}）`);
        } catch (e) {
            console.log(`@${acct}: ${String(e.message).split(/\r?\n/)[0]}`);
        } finally { await browser.close().catch(() => {}); }
    }
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(`→ ${OUT}`);
})();
