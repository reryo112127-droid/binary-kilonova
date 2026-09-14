/**
 * MGS: 商品発売日(release_date)を詳細ページから埋める（2026-09-14）。
 *
 * 旧作を MGS で再配信すると「配信開始日」(sale_start_date) だけが新しい日付になるため、
 * 2016年の作品が2026年の新作としてサイトに出ていた（906KAGH-045: 配信開始日 2026/09/13・
 * 商品発売日 2016/01/25）。parser は 2026-09-14 から商品発売日も読むので新作は phase3 で入る。
 * これは既存作品の後追い用。
 *
 *   node scripts/backfill_mgs_release_dates.js [--days 60] [--limit 300]
 *
 * 対象: release_date が未取得(NULL)で、配信開始日が直近 --days 日の作品（新しい順に --limit 件）。
 * 詳細ページに商品発売日が無い作品は '' を入れて再訪しない。local mgs.db と D1(avrankings-mgs) を更新。
 * release_date は FTS の対象列ではないので、UPDATE しても products_fts のトリガは動かない（1行=1書込）。
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { fetchPage, buildDetailUrl } = require('../lib/fetcher');
const { parseDetailPage } = require('../lib/parser');
const { d1 } = require('./lib/d1.js');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? parseInt(process.argv[i + 1], 10) : d; };
const DAYS = arg('--days', 60);
const LIMIT = arg('--limit', 300);
const WAIT_MS = 1000;
const politeWait = () => new Promise(r => setTimeout(r, WAIT_MS));

(async () => {
  const db = new Database(path.join(__dirname, '..', 'data', 'mgs.db'));
  const cols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
  if (!cols.includes('release_date')) {
    db.exec('ALTER TABLE products ADD COLUMN release_date TEXT');
    console.log('local mgs.db: release_date 列を追加');
  }
  const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(
    "SELECT product_id FROM products WHERE release_date IS NULL AND REPLACE(sale_start_date, '/', '-') >= ? " +
    "ORDER BY REPLACE(sale_start_date, '/', '-') DESC LIMIT ?"
  ).all(cutoff, LIMIT);
  console.log(`商品発売日 未取得: ${rows.length}件（配信開始日 ${cutoff} 以降・上限${LIMIT}）`);

  const mgs = d1('mgs');
  const upLocal = db.prepare('UPDATE products SET release_date=? WHERE product_id=?');
  let found = 0, reissue = 0, none = 0, err = 0, d1err = 0, d1streak = 0;
  for (let i = 0; i < rows.length; i++) {
    const id = String(rows[i].product_id);
    try {
      const html = await fetchPage(buildDetailUrl(id));
      const d = html ? parseDetailPage(html, id) : null;
      if (!d) { err++; }
      else {
        const rd = d.release_date || '';
        // **D1 を先に書き、成功したときだけローカルを埋める**。ローカルの release_date は「処理済み」の
        // 目印でもあるので、D1 が枠切れ等で落ちたのにローカルだけ埋めると二度と再訪されず D1 が空のまま残る。
        try {
          await mgs.execute({ sql: 'UPDATE products SET release_date=? WHERE product_id=?', args: [rd, id] });
          upLocal.run(rd, id);
          d1streak = 0;
        } catch (e) {
          d1err++; d1streak++;
          if (d1err <= 3) console.error(`\n  D1 更新失敗 ${id}: ${e.message}`);
          // 一時的な "database is locked" は散発する（2026-09-14 実測 300件中10件）ので、
          // 総数ではなく**連続**失敗で打ち切る（連続＝枠切れ等で書けない状態）。落ちた分は NULL のまま翌日再訪。
          if (d1streak >= 10) { console.error('\n  D1 が10回連続で失敗したので中断（枠切れの可能性）'); break; }
          await politeWait();
          continue;
        }
        if (rd) {
          found++;
          const day = s => String(s || '').replace(/\//g, '-').slice(0, 10);
          if (d.sale_start_date && day(rd) < day(d.sale_start_date)) reissue++;
        } else none++;
      }
    } catch { err++; }
    if ((i + 1) % 25 === 0) process.stdout.write(`  ${i + 1}/${rows.length} (発売日あり:${found} うち再配信:${reissue} 欄なし:${none} 失敗:${err} D1失敗:${d1err})\r`);
    await politeWait();
  }
  db.close();
  console.log(`\n完了: 発売日あり ${found}件（うち再配信＝発売日が配信開始日より前 ${reissue}件）/ 欄なし ${none}件 / 失敗 ${err}件 / D1失敗 ${d1err}件`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
