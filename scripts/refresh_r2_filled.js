/**
 * 今日(scrape)で出演者が入った作品のR2詳細キャッシュを更新する。
 * R2は詳細ページで優先配信されるため、古い(出演者空の)R2を更新しないと反映されない。
 * 公開API(現R2=画像付き)取得 → actresses をD1値に差替 → /api/admin/r2-populate へPOST。
 *   node scripts/refresh_r2_filled.js [YYYY-MM-DD]   # 既定: 今日
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { fanzaShards, d1 } = require('./lib/d1.js');

const SINCE = process.argv[2] || new Date().toISOString().slice(0, 10);
const SITE = 'https://avrankings.com';
function adminKey() {
  for (const p of [path.join(__dirname, '..', 'site', '.env.local'), path.join(__dirname, '..', '.env.local')]) {
    if (!fs.existsSync(p)) continue;
    for (const ln of fs.readFileSync(p, 'utf-8').split('\n')) { const m = ln.match(/^ADMIN_KEY=(.+)$/); if (m) return m[1].trim(); }
  }
  return null;
}

async function collect(client, label) {
  const out = [];
  const PAGE = 4000;
  for (let off = 0; ; off += PAGE) {
    let r;
    for (let a = 0; a < 4; a++) {
      try { r = await client.execute({ sql: `SELECT product_id, actresses FROM products WHERE actresses IS NOT NULL AND TRIM(actresses) <> '' AND updated_at >= ? LIMIT ? OFFSET ?`, args: [SINCE, PAGE, off] }); break; }
      catch (e) { if (/429|CPU/.test(e.message) && a < 3) { await new Promise(r => setTimeout(r, 4000 * (a + 1))); continue; } throw e; }
    }
    out.push(...r.rows.map(x => [String(x.product_id), String(x.actresses)]));
    if (r.rows.length < PAGE) break;
  }
  console.log(`${label} 対象:`, out.length, '件');
  return out;
}

(async () => {
  const KEY = adminKey();
  if (!KEY) { console.error('ADMIN_KEY なし'); process.exit(1); }
  const fz = fanzaShards();
  const mgs = d1('mgs');
  const targets = [...await collect(fz, 'FANZA'), ...await collect(mgs, 'MGS')];
  // 重複品番除去（後勝ち）
  const map = new Map(); for (const [id, a] of targets) map.set(id, a);
  const list = [...map.entries()];
  console.log('R2更新対象 合計:', list.length, '件 (since ' + SINCE + ')');

  const url = `${SITE}/api/admin/r2-populate`;
  let fetched = 0, fetchFail = 0, saved = 0, idx = 0;
  const items = [];
  const CONC = 6;
  async function fworker() {
    while (idx < list.length) {
      const i = idx++; const [id, acts] = list[i];
      try {
        const res = await fetch(`${SITE}/api/product/${encodeURIComponent(id)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) { fetchFail++; continue; }
        const data = await res.json();
        data.actresses = acts;
        items.push({ id, data }); fetched++;
        if (fetched % 200 === 0) process.stdout.write('  取得 ' + fetched + '/' + list.length + '\r');
      } catch { fetchFail++; }
    }
  }
  await Promise.all(Array.from({ length: CONC }, fworker));
  console.log('\n取得完了:', fetched, '| 失敗:', fetchFail);

  const BATCH = 40, PCONC = 5; const batches = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  const q = [...batches];
  async function pworker() {
    while (q.length) { const chunk = q.shift();
      for (let a = 0; a < 3; a++) {
        try { const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': KEY }, body: JSON.stringify({ items: chunk }) });
          if (!res.ok) { await new Promise(r => setTimeout(r, 1000 * (a + 1))); continue; }
          const j = await res.json(); saved += (j.saved || 0); break;
        } catch { await new Promise(r => setTimeout(r, 1000 * (a + 1))); }
      }
    }
  }
  await Promise.all(Array.from({ length: PCONC }, pworker));
  console.log('✅ R2更新 saved:', saved);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
