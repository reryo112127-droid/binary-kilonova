/**
 * MGS: sale_start_date が NULL の作品を詳細ページから取得して埋める。
 * 新作がDBにあるのに日付NULLで「新作一覧」に出ない問題を解消する。
 * local mgs.db + D1(avrankings-mgs) を更新。再開対応(埋まったらスキップ)。
 *   node scripts/backfill_mgs_dates.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { fetchPage, buildDetailUrl } = require('../lib/fetcher');
const WAIT_MS = 1000; // 詳細ページは軽量なので短め
const politeWait = () => new Promise(r => setTimeout(r, WAIT_MS));
const { parseDetailPage } = require('../lib/parser');
const { d1 } = require('./lib/d1.js');

(async () => {
  const db = new Database(path.join(__dirname, '..', 'data', 'mgs.db'));
  // 最近取得分(新作の可能性)を優先して処理
  const rows = db.prepare(
    "SELECT product_id FROM products WHERE (sale_start_date IS NULL OR TRIM(sale_start_date)='') ORDER BY scraped_at DESC"
  ).all();
  console.log('日付NULL 対象:', rows.length, '件');

  const mgs = d1('mgs');
  const upLocal = db.prepare(
    "UPDATE products SET sale_start_date=@d, maker=COALESCE(NULLIF(@m,''),maker), duration_min=COALESCE(@dur,duration_min), genres=COALESCE(NULLIF(@g,''),genres), main_image_url=COALESCE(NULLIF(@img,''),main_image_url), updated_at=@now WHERE product_id=@id"
  );

  let filled = 0, nodate = 0, err = 0;
  for (let i = 0; i < rows.length; i++) {
    const id = String(rows[i].product_id);
    try {
      const html = await fetchPage(buildDetailUrl(id));
      const d = html ? parseDetailPage(html, id) : null;
      const date = d && d.sale_start_date ? d.sale_start_date : null;
      if (!date) { nodate++; }
      else {
        const now = new Date().toISOString();
        upLocal.run({ d: date, m: d.maker || '', dur: d.duration_min ?? null, g: d.genres || '', img: d.main_image_url || '', now, id });
        await mgs.execute({
          sql: "UPDATE products SET sale_start_date=?, maker=COALESCE(NULLIF(?,''),maker), duration_min=COALESCE(?,duration_min), genres=COALESCE(NULLIF(?,''),genres), main_image_url=COALESCE(NULLIF(?,''),main_image_url), updated_at=? WHERE product_id=?",
          args: [date, d.maker || '', d.duration_min ?? null, d.genres || '', d.main_image_url || '', now, id],
        });
        filled++;
      }
    } catch (e) { err++; }
    if ((i + 1) % 25 === 0) { db.save ? db.save() : null; process.stdout.write(`  ${i + 1}/${rows.length} (埋:${filled} 日付無:${nodate} 失敗:${err})\r`); }
    await politeWait();
  }
  db.close();
  console.log(`\n完了: 日付補完 ${filled}件 / 日付無し ${nodate}件 / 失敗 ${err}件`);
  console.log('次: generate-static-cache-local → deploy');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
