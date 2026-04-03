/**
 * MGS サンプル動画MP4 URL事前取得スクリプト
 * ローカル（日本IP）から実行することでVercelのIPブロックを回避
 * node scripts/prefetch_mgs_mp4_urls.js
 */
const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');

const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '../site/.env.local'), 'utf8')
    .split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const db = createClient({ url: env.TURSO_MGS_URL, authToken: env.TURSO_MGS_TOKEN });

const BATCH = 15;       // 同時リクエスト数
const LIMIT = 5000;     // 1回の実行で処理する最大件数
const PROGRESS_FILE = path.join(__dirname, 'prefetch_mp4_progress.json');

async function fetchMp4Url(sampleUrl) {
  const uuid = sampleUrl.split('/').pop();
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) return null;
  try {
    const res = await fetch(
      `https://www.mgstage.com/sampleplayer/sampleRespons.php?pid=${uuid}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://www.mgstage.com/',
          'Cookie': 'adc=1',
        },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.url) return null;
    return data.url.replace(/\.ism\/request.*$/, '.mp4');
  } catch {
    return null;
  }
}

async function main() {
  // 進捗ファイル読み込み
  let progress = { offset: 0, done: 0, failed: 0 };
  if (fs.existsSync(PROGRESS_FILE)) {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  }
  console.log(`開始 offset=${progress.offset}, 完了=${progress.done}, 失敗=${progress.failed}`);

  // 未取得のレコードを取得（wish_count降順 = 人気順から処理）
  const result = await db.execute({
    sql: 'SELECT product_id, sample_video_url FROM products WHERE sample_video_url IS NOT NULL AND sample_mp4_url IS NULL ORDER BY wish_count DESC LIMIT ? OFFSET ?',
    args: [LIMIT, progress.offset]
  });

  if (!result.rows.length) {
    console.log('全件処理完了！');
    process.exit(0);
  }
  console.log(`対象: ${result.rows.length}件`);

  let localDone = 0, localFailed = 0;

  for (let i = 0; i < result.rows.length; i += BATCH) {
    const batch = result.rows.slice(i, i + BATCH);
    const updates = [];

    await Promise.all(batch.map(async (row) => {
      const mp4 = await fetchMp4Url(String(row[1]));
      if (mp4) {
        updates.push({ sql: 'UPDATE products SET sample_mp4_url = ? WHERE product_id = ?', args: [mp4, row[0]] });
        localDone++;
      } else {
        localFailed++;
      }
    }));

    // バッチ更新
    for (const upd of updates) {
      await db.execute(upd).catch(() => {});
    }

    progress.offset += batch.length;
    progress.done += updates.length;
    progress.failed += (batch.length - updates.length);
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));

    const total = progress.done + progress.failed;
    console.log(`[${total}] 完了=${progress.done} 失敗=${progress.failed} (${Math.round(progress.done/total*100)}%)`);
  }

  console.log(`\n今回: 取得=${localDone} 失敗=${localFailed}`);
  console.log('再実行して続きを処理できます。');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
