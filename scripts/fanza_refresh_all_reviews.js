/**
 * FANZA 全作品レビュー収集スクリプト
 *
 * DBに存在する全作品（2010年〜現在）のレビュー件数・評価を
 * DMM API から取得して review_count / review_average を更新する。
 *
 * 実行:
 *   node scripts/fanza_refresh_all_reviews.js
 *   node scripts/fanza_refresh_all_reviews.js --from 2020-01      # 開始月を指定
 *   node scripts/fanza_refresh_all_reviews.js --from 2024-01 --to 2024-12
 *   node scripts/fanza_refresh_all_reviews.js --dry-run           # DB書き込みなし
 *   node scripts/fanza_refresh_all_reviews.js --resume            # チェックポイントから再開
 *
 * チェックポイント: scripts/fanza_review_checkpoint.json に最後に処理した月を保存
 */

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DMM_API_ID       = process.env.DMM_API_ID;
const DMM_AFFILIATE_ID = process.env.DMM_AFFILIATE_ID;
const DB_PATH          = path.join(__dirname, '..', 'data', 'fanza.db');
const CHECKPOINT_PATH  = path.join(__dirname, 'fanza_review_checkpoint.json');
const HITS_PER_REQUEST = 100;
const RATE_LIMIT_MS    = 1200;
const FLOORS = ['videoa', 'videoc'];

// ---- 引数パース ----
const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESUME  = args.includes('--resume');
const fromArg = args.indexOf('--from');
const toArg   = args.indexOf('--to');
const ARG_FROM = fromArg !== -1 ? args[fromArg + 1] : null;
const ARG_TO   = toArg   !== -1 ? args[toArg + 1]   : null;

// ---- ユーティリティ ----
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatYM(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** start から end まで全 YYYY-MM を列挙 */
function allMonths(startYM, endYM) {
    const months = [];
    const [sy, sm] = startYM.split('-').map(Number);
    const [ey, em] = endYM.split('-').map(Number);
    let y = sy, m = sm;
    while (y < ey || (y === ey && m <= em)) {
        months.push(`${y}-${String(m).padStart(2, '0')}`);
        m++;
        if (m > 12) { m = 1; y++; }
    }
    return months;
}

function getMonthRange(yearMonth) {
    const [y, m] = yearMonth.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const pad = n => String(n).padStart(2, '0');
    return {
        gte: `${yearMonth}-01T00:00:00`,
        lte: `${yearMonth}-${pad(lastDay)}T23:59:59`,
    };
}

// ---- チェックポイント ----
function loadCheckpoint() {
    try {
        if (fs.existsSync(CHECKPOINT_PATH)) {
            return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8'));
        }
    } catch {}
    return null;
}

function saveCheckpoint(lastYM, stats) {
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify({ lastYM, stats, savedAt: new Date().toISOString() }, null, 2));
}

// ---- DMM API ----
async function fetchPage(gte, lte, offset, floor) {
    const params = new URLSearchParams({
        api_id:       DMM_API_ID,
        affiliate_id: DMM_AFFILIATE_ID,
        site:         'FANZA',
        service:      'digital',
        floor,
        hits:         HITS_PER_REQUEST.toString(),
        offset:       offset.toString(),
        sort:         'date',
        gte_date:     gte,
        lte_date:     lte,
        output:       'json',
    });
    const res = await fetch(`https://api.dmm.com/affiliate/v3/ItemList?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.result?.status !== 200) throw new Error(`DMM API: ${JSON.stringify(data.result)}`);
    return { total: data.result.total_count || 0, items: data.result.items || [] };
}

// ---- 1ヶ月分を全ページ取得し、content_id → {review_count, review_average} を返す ----
async function fetchMonthReviews(yearMonth, floor) {
    const { gte, lte } = getMonthRange(yearMonth);
    const map = new Map();
    let offset = 1, total = null;

    while (true) {
        let items, t;
        try {
            ({ total: t, items } = await fetchPage(gte, lte, offset, floor));
        } catch (e) {
            console.warn(`\n  [警告] ${floor}/${yearMonth} offset=${offset}: ${e.message}`);
            break;
        }
        if (total === null) total = t;
        if (items.length === 0) break;

        for (const item of items) {
            const rc = item.review?.count   != null ? Number(item.review.count)          : null;
            const ra = item.review?.average != null ? parseFloat(item.review.average)    : null;
            if (rc !== null || ra !== null) {
                map.set(item.content_id, { review_count: rc, review_average: ra });
            }
        }

        if (items.length < HITS_PER_REQUEST) break;
        offset += HITS_PER_REQUEST;
        await sleep(RATE_LIMIT_MS);
    }

    return { map, total: total ?? 0 };
}

// ---- Turso バッチ UPDATE ----
async function tursoUpdateBatch(turso, entries) {
    const sql = `UPDATE products SET
        review_count   = COALESCE(?, review_count),
        review_average = COALESCE(?, review_average),
        price_updated_at = ?
        WHERE product_id = ?`;
    const now = new Date().toISOString();
    const BATCH = 50;
    for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH);
        try {
            await turso.batch(
                batch.map(([pid, v]) => ({
                    sql,
                    args: [v.review_count ?? null, v.review_average ?? null, now, pid],
                })),
                'write'
            );
        } catch {
            for (const [pid, v] of batch) {
                try {
                    await turso.execute({ sql, args: [v.review_count ?? null, v.review_average ?? null, now, pid] });
                } catch {}
            }
        }
    }
}

// ============================================================
//  メイン
// ============================================================
async function main() {
    if (!DMM_API_ID || !DMM_AFFILIATE_ID) {
        console.error('❌ DMM_API_ID / DMM_AFFILIATE_ID が未設定');
        process.exit(1);
    }

    const today  = new Date();
    const endYM  = ARG_TO   || formatYM(today);
    let   startYM = ARG_FROM || '2010-01';

    // チェックポイントから再開
    let checkpoint = null;
    if (RESUME && !ARG_FROM) {
        checkpoint = loadCheckpoint();
        if (checkpoint?.lastYM) {
            // 前回最後に完了した月の翌月から再開
            const [ly, lm] = checkpoint.lastYM.split('-').map(Number);
            const next = lm === 12 ? `${ly + 1}-01` : `${ly}-${String(lm + 1).padStart(2, '0')}`;
            startYM = next;
            console.log(`\n📂 チェックポイントから再開: ${checkpoint.lastYM} → 次月 ${startYM}`);
        }
    }

    const months = allMonths(startYM, endYM);
    console.log('========================================');
    console.log('  FANZA 全作品レビュー収集');
    console.log('========================================');
    console.log(`  期間: ${startYM} 〜 ${endYM} (${months.length}ヶ月)`);
    console.log(`  floor: ${FLOORS.join(', ')}`);
    if (DRY_RUN) console.log('  [DRY RUN] DB書き込みなし');

    // ---- DB接続 ----
    let localDb = null;
    if (!DRY_RUN && !process.env.CI && fs.existsSync(DB_PATH)) {
        localDb = new Database(DB_PATH);
        localDb.pragma('journal_mode = WAL');
        localDb.pragma('busy_timeout = 10000'); // 10秒待機
    }

    const tursoUrl   = process.env.TURSO_FANZA_URL;
    const tursoToken = process.env.TURSO_FANZA_TOKEN;
    let turso = null;
    if (!DRY_RUN && tursoUrl && tursoToken) {
        turso = createClient({ url: tursoUrl, authToken: tursoToken });
    }

    // ローカルDB 更新用ステートメント
    let updateStmt = null;
    if (localDb) {
        updateStmt = localDb.prepare(`
            UPDATE products SET
                review_count   = COALESCE(?, review_count),
                review_average = COALESCE(?, review_average),
                price_updated_at = ?
            WHERE product_id = ?
        `);
    }

    // ---- 統計 ----
    let totalFetched = 0;
    let totalUpdated = 0;
    const startTime = Date.now();

    // ---- 月ループ ----
    for (let mi = 0; mi < months.length; mi++) {
        const ym = months[mi];
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const pct = ((mi / months.length) * 100).toFixed(1);
        process.stdout.write(`\r[${mi + 1}/${months.length}] ${ym}  ${pct}%  取得済: ${totalFetched.toLocaleString()}件  更新: ${totalUpdated.toLocaleString()}件  ${elapsed}s  `);

        // 全floorのレビューを統合
        const monthMap = new Map();
        for (const floor of FLOORS) {
            const { map, total } = await fetchMonthReviews(ym, floor);
            for (const [pid, v] of map) {
                const existing = monthMap.get(pid);
                if (!existing) {
                    monthMap.set(pid, v);
                } else {
                    // 両floorで同じ product_id が出たら件数の多い方を採用
                    if ((v.review_count ?? 0) > (existing.review_count ?? 0)) {
                        monthMap.set(pid, v);
                    }
                }
            }
            totalFetched += map.size;
        }

        if (!DRY_RUN && monthMap.size > 0) {
            const entries = Array.from(monthMap.entries());
            const now = new Date().toISOString();

            // ローカルDB
            if (localDb && updateStmt) {
                const updateMany = localDb.transaction(rows => {
                    for (const [pid, v] of rows) {
                        const r = updateStmt.run(v.review_count ?? null, v.review_average ?? null, now, pid);
                        if (r.changes > 0) totalUpdated++;
                    }
                });
                updateMany(entries);
            }

            // Turso
            if (turso) {
                await tursoUpdateBatch(turso, entries);
                // Turso はローカルDBがない場合にも加算
                if (!localDb) totalUpdated += entries.length;
            }
        }

        // チェックポイント保存（10ヶ月ごと）
        if ((mi + 1) % 10 === 0) {
            saveCheckpoint(ym, { totalFetched, totalUpdated });
        }
    }

    console.log('\n');

    // 最終チェックポイント保存
    saveCheckpoint(endYM, { totalFetched, totalUpdated, completed: true });

    if (localDb) localDb.close();
    if (turso) turso.close();

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log('========================================');
    console.log(`  ✅ 完了`);
    console.log(`  API取得: ${totalFetched.toLocaleString()} 件`);
    console.log(`  DB更新: ${totalUpdated.toLocaleString()} 件`);
    console.log(`  所要時間: ${elapsed} 分`);
    console.log('========================================');
}

main().catch(err => {
    console.error('\n致命的エラー:', err);
    process.exit(1);
});
