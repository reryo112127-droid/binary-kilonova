/**
 * fanza_identify_actresses.js
 *
 * 女優不明のFANZA作品をDMM APIのcid検索で女優特定し、Turso DBに反映する。
 *
 * DMM API の ItemList?cid= は、DBに「女優不明」として登録されている素人作品でも
 * iteminfo.actress[] に出演者名が入っていることがある。
 *
 * 実行:
 *   node scripts/fanza_identify_actresses.js
 *   node scripts/fanza_identify_actresses.js --dry-run   # DB書き込みなし
 *   node scripts/fanza_identify_actresses.js --reset     # 進捗リセット
 *   node scripts/fanza_identify_actresses.js --limit 5000  # 処理件数上限
 *
 * 進捗は data/fanza_identify_progress.json に保存（中断・再開可能）
 */

const path = require('path');
const fs   = require('fs');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ========== 設定 ==========
const DMM_API_ID       = process.env.DMM_API_ID || 'sXmYFJnNNfqnZ0WbB2Tc';
const DMM_AFFILIATE_IDS = (process.env.DMM_AFFILIATE_IDS || 'desireav-990').split(',').map(s => s.trim());

const TURSO_URL   = process.env.TURSO_FANZA_URL;
const TURSO_TOKEN = process.env.TURSO_FANZA_TOKEN;

const DATA_DIR      = path.join(__dirname, '..', 'data');
const PROGRESS_FILE = path.join(DATA_DIR, 'fanza_identify_progress.json');

const FETCH_BATCH_SIZE = 500;   // Tursoから一度に取得するproduct_id数
const CONCURRENCY      = Math.min(DMM_AFFILIATE_IDS.length, 8); // 同時リクエスト数
const RATE_LIMIT_MS    = 1100;  // アフィリエイトIDごとのレート制限（ms）
const UPDATE_BATCH_SIZE = 50;   // Tursoへのバッチ更新サイズ

// ========== 引数 ==========
const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESET   = args.includes('--reset');
const limitIdx = args.indexOf('--limit');
const MAX_PROCESS = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

// ========== ユーティリティ ==========
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadProgress() {
    if (!RESET && fs.existsSync(PROGRESS_FILE)) {
        return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    }
    return { cursor: '', processed: 0, identified: 0, not_found: 0, no_actress: 0 };
}

function saveProgress(p) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

// ========== DMM API ==========
async function fetchActressByCid(cid, affiliateId) {
    const params = new URLSearchParams({
        api_id:       DMM_API_ID,
        affiliate_id: affiliateId,
        site:         'FANZA',
        service:      'digital',
        floor:        'videoa',
        hits:         '1',
        cid:          cid,
        output:       'json',
    });

    const url = `https://api.dmm.com/affiliate/v3/ItemList?${params}`;
    const res = await fetch(url);

    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();

    if (!data.result || data.result.status !== 200) {
        // APIエラー（レートリミット等）
        const status = data.result?.status || 'unknown';
        throw new Error(`API status ${status}`);
    }

    const items = data.result.items || [];
    if (items.length === 0) {
        return { found: false, actresses: null }; // 作品が見つからない
    }

    const item = items[0];
    const actresses = item.iteminfo?.actress?.map(a => a.name) || [];
    return { found: true, actresses: actresses.length > 0 ? actresses.join(', ') : null };
}

// ========== Turso ==========
function createTursoClient() {
    if (!TURSO_URL || !TURSO_TOKEN) {
        throw new Error('TURSO_FANZA_URL / TURSO_FANZA_TOKEN が設定されていません。.env を確認してください。');
    }
    return createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
}

async function fetchUnidentifiedBatch(client, cursor, limit) {
    // cursor-based pagination: product_id > cursor ORDER BY product_id
    const result = await client.execute({
        sql: `SELECT product_id FROM products
              WHERE (actresses IS NULL OR actresses = '')
                AND product_id > ?
              ORDER BY product_id
              LIMIT ?`,
        args: [cursor, limit],
    });
    return result.rows.map(r => r[0]);
}

async function updateActresses(client, updates) {
    // updates = [{product_id, actresses}]
    if (updates.length === 0) return;
    // Turso libSQL は executeBatch が使える
    const statements = updates.map(u => ({
        sql: `UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ?`,
        args: [u.actresses, new Date().toISOString(), u.product_id],
    }));
    await client.batch(statements, 'write');
}

// ========== 並列ワーカー ==========
/**
 * workerPool: 最大CONCURRENCY個の並列ワーカーでcidsを処理。
 * 各ワーカーはアフィリエイトIDをローテーションしながら使う。
 */
async function processWithPool(cids, onResult) {
    let cidIdx = 0;
    let affiliateIdx = 0;
    const lastCallTime = new Array(DMM_AFFILIATE_IDS.length).fill(0);

    async function worker() {
        while (cidIdx < cids.length) {
            const myIdx = cidIdx++;
            const cid   = cids[myIdx];

            // アフィリエイトIDをラウンドロビン
            const affSlot = affiliateIdx % DMM_AFFILIATE_IDS.length;
            affiliateIdx++;
            const affiliateId = DMM_AFFILIATE_IDS[affSlot];

            // レートリミット：同じaffiliateIdの最後の呼び出しから RATE_LIMIT_MS 待つ
            const now = Date.now();
            const wait = RATE_LIMIT_MS - (now - lastCallTime[affSlot]);
            if (wait > 0) await sleep(wait);
            lastCallTime[affSlot] = Date.now();

            try {
                const result = await fetchActressByCid(cid, affiliateId);
                onResult({ cid, found: result.found, actresses: result.actresses, error: null });
            } catch (err) {
                onResult({ cid, found: false, actresses: null, error: err.message });
            }
        }
    }

    // CONCURRENCY個のワーカーを起動
    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);
}

// ========== メイン ==========
async function main() {
    console.log('========================================');
    console.log('  FANZA 女優特定スクリプト');
    console.log('========================================');
    console.log(`  並列数: ${CONCURRENCY} (アフィリエイトID: ${DMM_AFFILIATE_IDS.length}個)`);
    if (DRY_RUN) console.log('  [DRY RUN] DB書き込みは行いません');
    if (RESET)   console.log('  [RESET] 進捗をリセットします');
    console.log('');

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    const client   = createTursoClient();
    const progress = loadProgress();

    console.log(`[進捗] cursor="${progress.cursor}" / 処理済み: ${progress.processed.toLocaleString()} / 特定済み: ${progress.identified.toLocaleString()}\n`);

    let totalProcessed = 0;
    let pendingUpdates = [];

    const flushUpdates = async () => {
        if (pendingUpdates.length === 0) return;
        if (!DRY_RUN) {
            await updateActresses(client, pendingUpdates);
        }
        pendingUpdates = [];
    };

    try {
        while (totalProcessed < MAX_PROCESS) {
            // Tursoから未特定作品を取得
            const batch = await fetchUnidentifiedBatch(client, progress.cursor, FETCH_BATCH_SIZE);

            if (batch.length === 0) {
                console.log('\n✅ 未特定の作品がなくなりました（全件処理完了）');
                break;
            }

            console.log(`[バッチ] ${batch.length}件取得 (cursor="${progress.cursor}")`);

            // 並列でDMM APIを叩く
            const results = [];
            await processWithPool(batch, (r) => results.push(r));

            // 結果を集計
            let batchIdentified = 0;
            let batchNotFound   = 0;
            let batchNoActress  = 0;
            let batchError      = 0;

            for (const r of results) {
                if (r.error) {
                    batchError++;
                    // エラーはスキップ（次回再試行のためカーソルを更新しない）
                    continue;
                }

                if (!r.found) {
                    batchNotFound++;
                } else if (!r.actresses) {
                    batchNoActress++;
                } else {
                    // 女優特定！
                    batchIdentified++;
                    progress.identified++;
                    pendingUpdates.push({ product_id: r.cid, actresses: r.actresses });

                    if (pendingUpdates.length >= UPDATE_BATCH_SIZE) {
                        await flushUpdates();
                    }
                }
            }

            // バッチ最後のIDをカーソルに
            progress.cursor = batch[batch.length - 1];
            progress.processed += results.length;
            progress.not_found = (progress.not_found || 0) + batchNotFound;
            progress.no_actress = (progress.no_actress || 0) + batchNoActress;
            totalProcessed += results.length;

            // 残りのアップデートをフラッシュ
            await flushUpdates();
            saveProgress(progress);

            console.log(
                `  → 特定: ${batchIdentified} / 見つからず: ${batchNotFound} / 女優なし: ${batchNoActress} / エラー: ${batchError}` +
                ` | 累計: 処理${progress.processed.toLocaleString()} 特定${progress.identified.toLocaleString()}`
            );

            if (batch.length < FETCH_BATCH_SIZE) {
                // DBの末尾に達した
                console.log('\n✅ DBの末尾まで処理しました（全件確認完了）');
                break;
            }
        }
    } finally {
        await flushUpdates();
        saveProgress(progress);
        console.log('\n========================================');
        console.log(`  処理完了`);
        console.log(`  処理済み:   ${progress.processed.toLocaleString()} 件`);
        console.log(`  特定成功:   ${progress.identified.toLocaleString()} 件`);
        console.log(`  見つからず: ${(progress.not_found || 0).toLocaleString()} 件`);
        console.log(`  女優なし:   ${(progress.no_actress || 0).toLocaleString()} 件`);
        console.log('========================================\n');
    }
}

main().catch(err => {
    console.error('致命的エラー:', err.message);
    process.exit(1);
});
