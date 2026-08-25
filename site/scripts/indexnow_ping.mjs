/**
 * IndexNow へ「更新したURL」を通知する（Bing / Yandex / Naver / Seznam が対応。Googleは非対応）。
 *
 * 無料でできる発見性の底上げ。サイトマップは巡回されるまで待ちだが、IndexNow は即時に
 * 「このURLが変わった」と伝えられるので、日次の新作が Bing 系で早く拾われる。
 *
 * 送るURL（多くても数百件/日。無差別に送ると spam 扱いされるので索引対象だけに絞る）:
 *   - 毎日中身が変わるハブ: / , /new , /sale , /ranking , /pre-order
 *   - products_new_cache.json の新作のうち sitemap_cache.products に載っている作品
 *
 * 鍵ファイル: public/<key>.txt（デプロイされて https://avrankings.com/<key>.txt で引ける必要がある）
 * 通知に失敗してもデプロイを失敗させない（必ず exit 0）。
 *
 * 使い方: node scripts/indexnow_ping.mjs [--limit 200] [--dry-run]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'avrankings.com';
const BASE = `https://${HOST}`;
const KEY = '35e3be054c6fbf8e76d77d64ac8355d5';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

const argInt = (flag, def) => {
    const i = process.argv.indexOf(flag);
    const v = i >= 0 ? parseInt(process.argv[i + 1], 10) : NaN;
    return Number.isFinite(v) ? v : def;
};
const LIMIT = argInt('--limit', 200);
const DRY = process.argv.includes('--dry-run');

const readJson = (rel, fallback) => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', rel), 'utf-8')); }
    catch { return fallback; }
};

function main() {
    if (!fs.existsSync(path.join(ROOT, 'public', `${KEY}.txt`))) {
        console.warn(`⚠ IndexNow: 鍵ファイル public/${KEY}.txt が無いので通知しません`);
        return;
    }

    const urls = ['/', '/new', '/sale', '/ranking', '/pre-order'].map(p => BASE + p);

    // 索引対象(サイトマップに載っている作品)だけを通知する。noindex の作品を送っても無駄。
    const indexable = new Set((readJson('sitemap_cache.json', {})?.products ?? []).map(String));
    const fresh = readJson('products_new_cache.json', []) || [];
    for (const p of fresh) {
        const id = String(p?.product_id ?? '');
        if (!id || (indexable.size && !indexable.has(id))) continue;
        urls.push(`${BASE}/product/${encodeURIComponent(id)}`);
        if (urls.length >= LIMIT) break;
    }

    const body = { host: HOST, key: KEY, keyLocation: `${BASE}/${KEY}.txt`, urlList: [...new Set(urls)] };
    console.log(`[IndexNow] ${body.urlList.length}件を通知${DRY ? '(dry-run)' : ''}`);
    if (DRY) { console.log(body.urlList.slice(0, 10).join('\n')); return; }

    fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
    }).then(r => {
        // 200/202 = 受理、403 = 鍵が引けない、422 = URLとhostの不一致
        console.log(`[IndexNow] HTTP ${r.status}${r.status === 403 ? ' (鍵ファイルが公開されているか確認)' : ''}`);
    }).catch(e => {
        console.warn(`⚠ IndexNow 通知失敗(無視): ${e.message}`);
    });
}

try { main(); } catch (e) { console.warn(`⚠ IndexNow スキップ: ${e.message}`); }
