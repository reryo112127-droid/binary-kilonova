/**
 * FANZA 日次アップデートスクリプト
 *
 * 1. 予約商品取得: 明日以降にリリース予定の作品を DMM API から取得しローカルDB + Turso に追加
 * 2. 価格更新: DB内の直近N年の全作品を cid[] 一括クエリでスキャンし差分適用
 *    - スキャン中はDBを変更しない（空白期間なし）
 *    - スキャン完了後: セール中→更新、非セールに変化→クリア、スキャン外の古いセール→クリア
 *
 * 実行:
 *   node scripts/fanza_daily_update.js              # デフォルト: 直近2年
 *   node scripts/fanza_daily_update.js --ahead 3    # 3ヶ月先まで予約商品取得
 *   node scripts/fanza_daily_update.js --no-price   # 価格更新スキップ
 *   node scripts/fanza_daily_update.js --years 3    # 価格更新を直近3年に拡大
 *   node scripts/fanza_daily_update.js --dry-run    # 件数確認のみ（DB書き込みなし）
 */

const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const { fanzaShards } = require('./lib/d1');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Turso 廃止: FANZAカタログ書き込みは Cloudflare D1 の2シャードへ（ハッシュ振り分け）。
// 必要 env: CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_D1_TOKEN / D1_FANZA_0_ID / D1_FANZA_1_ID
const hasD1 = !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_D1_TOKEN
    && process.env.D1_FANZA_0_ID && process.env.D1_FANZA_1_ID);
const fanzaDb = () => fanzaShards();  // スマートシャードクライアント（execute/batch互換）

// MGS動画と重複する FANZA videoc(素人)作品の判定用インデックス（無ければスキップ無効）
const { isDuplicate } = require('./lib/dedup.cjs');
let DEDUP_INDEX = {};
try {
    DEDUP_INDEX = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'data', 'videoc_dedup_index.json'), 'utf-8'));
} catch { /* インデックス未生成なら重複スキップしない */ }

const DMM_API_ID      = process.env.DMM_API_ID;
const DMM_AFFILIATE_ID = process.env.DMM_AFFILIATE_ID;
const DISCORD_WEBHOOK  = 'https://discord.com/api/webhooks/1485815872688885892/78U4bkE7SNNTIMuW91ru_bJXH6D6hynnf88dYAnzkgq2hECA4gUSNa6hzq5DWquwRJYe';

const DB_PATH          = path.join(__dirname, '..', 'data', 'fanza.db');
const BLOCKED_MAKERS_PATH = path.join(__dirname, '..', 'data', 'blocked_makers.json');
const BLOCKED_MAKERS = new Set(
    require('fs').existsSync(BLOCKED_MAKERS_PATH)
        ? JSON.parse(require('fs').readFileSync(BLOCKED_MAKERS_PATH, 'utf-8')).makers
        : []
);
const HITS_PER_REQUEST = 100;
const RATE_LIMIT_MS    = 1200;
const PRICE_SCAN_YEARS_DEFAULT = 2; // cid[]スキャンで対象とする年数（デフォルト2年）

// FANZAデジタル動画のfloor一覧
// videoa: ビデオ（一般AV）, videoc: 素人
// ※ vrはDMM APIのfloorパラメータとして無効(HTTP 400) → VR作品はvideoa内に含まれる
const FLOORS = ['videoa', 'videoc'];

// ---- 引数パース ----
const args      = process.argv.slice(2);
const aheadArg  = args.indexOf('--ahead');
const MONTHS_AHEAD = aheadArg !== -1 ? parseInt(args[aheadArg + 1], 10) : 2;
const yearsArg  = args.indexOf('--years');
const PRICE_SCAN_YEARS = yearsArg !== -1 ? parseInt(args[yearsArg + 1], 10) : PRICE_SCAN_YEARS_DEFAULT;
const DRY_RUN      = args.includes('--dry-run');
const NO_PRICE     = args.includes('--no-price');
const NO_PREORDER  = args.includes('--no-preorder');

// ---- ユーティリティ ----
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function toApiDatetime(dateStr, isEnd = false) {
    return isEnd ? `${dateStr}T23:59:59` : `${dateStr}T00:00:00`;
}

function getMonthRange(yearMonth) {
    const [y, m] = yearMonth.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    return {
        gte: toApiDatetime(`${yearMonth}-01`),
        lte: toApiDatetime(`${yearMonth}-${String(lastDay).padStart(2, '0')}`, true),
    };
}

function getPastMonths(n) {
    const months = [];
    const d = new Date();
    for (let i = 0; i < n; i++) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        months.unshift(`${y}-${m}`);
        d.setMonth(d.getMonth() - 1);
    }
    return months;
}

// ---- 価格パース ----
function parsePrice(item) {
    const deliveries = item.prices?.deliveries?.delivery || [];
    // download > hd > 最初のもの の優先順
    const target = deliveries.find(d => d.type === 'download')
                || deliveries.find(d => d.type === 'hd')
                || deliveries[0];

    if (!target) return { listPrice: null, currentPrice: null, discountPct: 0, saleEndDate: null };

    // "~" サフィックスや カンマを除去して数値化
    const listPrice    = parseInt(String(target.list_price).replace(/[^0-9]/g, '')) || null;
    const currentPrice = parseInt(String(target.price).replace(/[^0-9]/g, ''))      || null;

    const discountPct = (listPrice && currentPrice && listPrice > currentPrice)
        ? Math.round((listPrice - currentPrice) / listPrice * 100)
        : 0;

    // セール終了日時: item level → prices level → delivery level の順で探す
    const saleEndDate = item.campaign?.date_end
                     || item.prices?.campaign?.date_end
                     || target.campaign?.date_end
                     || null;

    return { listPrice, currentPrice, discountPct, saleEndDate };
}

// ---- DMM API 呼び出し ----
async function fetchPage(gteDate, lteDate, offset = 1, floor = 'videoa') {
    const params = new URLSearchParams({
        api_id:       DMM_API_ID,
        affiliate_id: DMM_AFFILIATE_ID,
        site:         'FANZA',
        service:      'digital',
        floor,
        hits:         HITS_PER_REQUEST.toString(),
        offset:       offset.toString(),
        sort:         'date',
        gte_date:     gteDate,
        lte_date:     lteDate,
        output:       'json',
    });

    const res = await fetch(`https://api.dmm.com/affiliate/v3/ItemList?${params}`);
    if (!res.ok) throw new Error(`DMM API HTTP ${res.status}`);
    const data = await res.json();

    if (data.result?.status !== 200) {
        throw new Error(`DMM API error: ${JSON.stringify(data.result)}`);
    }

    return { total: data.result.total_count || 0, items: data.result.items || [] };
}

// ---- 作品データ変換 ----
function convertItem(item) {
    const sampleImages = [];
    if (item.sampleImageURL) {
        const large = item.sampleImageURL.sample_l?.image || [];
        const small = item.sampleImageURL.sample_s?.image || [];
        sampleImages.push(...(large.length > 0 ? large : small));
    }

    let durationMin = null;
    if (item.volume) {
        const m = String(item.volume).match(/(\d+)/);
        if (m) durationMin = parseInt(m[1], 10);
    }

    let sampleVideoUrl = null;
    if (item.sampleMovieURL) {
        const mv = item.sampleMovieURL;
        sampleVideoUrl = mv.size_720_480 || mv.size_560_360 || mv.size_476_306 || null;
    }

    let saleDate = item.date || null;
    if (saleDate) saleDate = saleDate.replace(' 00:00:00', '').trim();

    const { listPrice, currentPrice, discountPct, saleEndDate } = parsePrice(item);
    const now = new Date().toISOString();

    return {
        product_id:         item.content_id,
        title:              item.title || null,
        actresses:          item.iteminfo?.actress?.map(a => a.name).join(', ') || null,
        maker:              item.iteminfo?.maker?.[0]?.name || null,
        label:              item.iteminfo?.label?.[0]?.name || null,
        duration_min:       durationMin,
        genres:             item.iteminfo?.genre?.map(g => g.name).join(', ') || null,
        sale_start_date:    saleDate,
        main_image_url:     item.imageURL?.large || item.imageURL?.list || null,
        sample_images_json: sampleImages.length > 0 ? JSON.stringify(sampleImages) : null,
        sample_video_url:   sampleVideoUrl,
        affiliate_url:      item.affiliateURL || null,
        detail_url:         item.URL || null,
        list_price:         listPrice,
        current_price:      currentPrice,
        discount_pct:       discountPct,
        sale_end_date:      saleEndDate,
        review_count:       item.review?.count != null ? Number(item.review.count) : null,
        review_average:     item.review?.average != null ? parseFloat(item.review.average) : null,
        series_id:          item.iteminfo?.series?.[0]?.id   ? String(item.iteminfo.series[0].id) : null,
        series_name:        item.iteminfo?.series?.[0]?.name || null,
        vr_flag:            (item.title || '').includes('【VR】') ||
                            (item.prices?.deliveries?.delivery || []).some(d => d.type === '8k') ? 1 : 0,
        price_updated_at:   now,
        scraped_at:         now,
        updated_at:         now,
    };
}

// ---- Discord通知 ----
async function sendDiscord(content) {
    try {
        await fetch(DISCORD_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
        });
    } catch (e) {
        console.warn('[Discord] 通知失敗:', e.message);
    }
}

// ---- Turso バッチ書き込み ----
async function tursoUpsertBatch(turso, rows, columns) {
    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO products (${columns.join(', ')}) VALUES (${placeholders})`;
    const BATCH = 50;
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        try {
            await turso.batch(
                batch.map(row => ({ sql, args: columns.map(c => row[c] ?? null) })),
                'write'
            );
        } catch {
            for (const row of batch) {
                try {
                    await turso.execute({ sql, args: columns.map(c => row[c] ?? null) });
                } catch (e2) {
                    console.error(`  [スキップ] ${row.product_id}: ${e2.message}`);
                }
            }
        }
    }
}

// ============================================================
//  STEP 1: 予約商品取得（明日以降のリリース予定作品）— 全floor対応
// ============================================================
async function fetchPreorders(gteDateStr, lteDateStr) {
    const gteDateTime = toApiDatetime(gteDateStr);
    const lteDateTime = toApiDatetime(lteDateStr, true);

    console.log(`\n[STEP 1] 予約商品取得: ${gteDateStr} 〜 ${lteDateStr} (floor: ${FLOORS.join(', ')})`);

    const fetched = [];

    for (const floor of FLOORS) {
        let offset = 1, totalInApi = null;
        console.log(`  [${floor}] 取得開始...`);

        while (true) {
            try {
                const { total, items } = await fetchPage(gteDateTime, lteDateTime, offset, floor);
                if (totalInApi === null) {
                    totalInApi = total;
                    console.log(`  [${floor}] DMM API 件数: ${total.toLocaleString()} 件`);
                }
                if (items.length === 0) break;
                for (const item of items) {
                    const genres = item.iteminfo?.genre?.map(g => g.name) || [];
                    if (genres.includes('ゲイ')) continue;
                    const converted = convertItem(item);
                    converted.floor = floor;
                    fetched.push(converted);
                }
                process.stdout.write(`  [${floor}] 取得中: ${fetched.length} 件\r`);
                if (items.length < HITS_PER_REQUEST) break;
                offset += HITS_PER_REQUEST;
                await sleep(RATE_LIMIT_MS);
            } catch (e) {
                console.warn(`\n  [警告] ${floor} 予約商品取得エラー: ${e.message}`);
                break;
            }
        }
        console.log(`\n  [${floor}] 完了`);
    }

    console.log(`  全floor取得完了: ${fetched.length} 件`);
    return fetched;
}

// ============================================================
//  STEP 2: 価格更新（cid[]一括スキャン・差分適用方式）
//
//  流れ:
//    1. TursoからN年以内の全product_idを取得
//    2. 100件ずつ cid[] で DMM API に問い合わせ（両floor）
//    3. スキャン完了後に差分適用（空白期間なし）
// ============================================================
async function refreshPricesByCid(turso) {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - PRICE_SCAN_YEARS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    console.log(`\n[STEP 2] 価格更新 (cid[]方式): 直近${PRICE_SCAN_YEARS}年 (${cutoffStr} 〜 今日)`);

    // 1. スキャン対象IDをTursoから取得
    const idRows = (await turso.execute({
        sql: 'SELECT product_id FROM products WHERE sale_start_date IS NOT NULL AND sale_start_date >= ?',
        args: [cutoffStr],
    })).rows;
    const allIds = idRows.map(r => String(r.product_id));
    console.log(`  スキャン対象: ${allIds.length.toLocaleString()}件`);

    // 2. cid[]で100件ずつ両floorに問い合わせ
    // product_id → 価格情報（セール中・非セール問わず全件）
    const priceMap = new Map();

    const totalBatches = Math.ceil(allIds.length / HITS_PER_REQUEST);
    let batchDone = 0;

    for (let i = 0; i < allIds.length; i += HITS_PER_REQUEST) {
        const chunk = allIds.slice(i, i + HITS_PER_REQUEST);
        const now = new Date().toISOString();

        for (const floor of FLOORS) {
            try {
                const params = new URLSearchParams({
                    api_id:       DMM_API_ID,
                    affiliate_id: DMM_AFFILIATE_ID,
                    site:         'FANZA',
                    service:      'digital',
                    floor,
                    hits:         String(HITS_PER_REQUEST),
                    output:       'json',
                });
                chunk.forEach(id => params.append('cid[]', id));

                const res = await fetch(`https://api.dmm.com/affiliate/v3/ItemList?${params}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (data.result?.status !== 200) continue;

                for (const item of data.result.items || []) {
                    const cid = item.content_id;
                    if (priceMap.has(cid)) continue; // 先に見つかったfloorの結果を優先
                    const { listPrice, currentPrice, discountPct, saleEndDate } = parsePrice(item);
                    const isBest = /BEST|ベスト|総集編|コレクション/i.test(item.title || '');
                    priceMap.set(cid, {
                        listPrice, currentPrice, discountPct, saleEndDate,
                        reviewCount:   !isBest && item.review?.count != null ? Number(item.review.count) : null,
                        reviewAverage: !isBest && item.review?.average != null ? parseFloat(item.review.average) : null,
                        price_updated_at: now,
                    });
                }

                await sleep(RATE_LIMIT_MS);
            } catch (e) {
                console.warn(`\n  [警告] floor=${floor} offset=${i}: ${e.message}`);
            }
        }

        batchDone++;
        if (batchDone % 20 === 0) {
            const saleCount = [...priceMap.values()].filter(v => v.discountPct > 0).length;
            process.stdout.write(`  ${Math.min(i + HITS_PER_REQUEST, allIds.length)}/${allIds.length} 確認 セール: ${saleCount}件\r`);
        }
    }

    const saleCount = [...priceMap.values()].filter(v => v.discountPct > 0).length;
    console.log(`\n  スキャン完了: ${priceMap.size.toLocaleString()}件確認 / セール中: ${saleCount.toLocaleString()}件`);

    return { priceMap, cutoffStr };
}

// ============================================================
//  メイン
// ============================================================
async function main() {
    if (!DMM_API_ID || !DMM_AFFILIATE_ID) {
        console.error('❌ DMM_API_ID / DMM_AFFILIATE_ID が未設定');
        process.exit(1);
    }

    // ---- スキーママイグレーション（ローカルDBのみ。D1 のスキーマは site/migrations/* で管理）----
    {
        // ローカルDB マイグレーション
        if (!process.env.CI && require('fs').existsSync(DB_PATH)) {
            const _db = new Database(DB_PATH);
            try { _db.prepare('ALTER TABLE products ADD COLUMN sale_end_date TEXT').run(); } catch {}
            try { _db.prepare('ALTER TABLE products ADD COLUMN review_count INTEGER').run(); } catch {}
            try { _db.prepare('ALTER TABLE products ADD COLUMN review_average REAL').run(); } catch {}
            try { _db.prepare('ALTER TABLE products ADD COLUMN series_id TEXT').run(); } catch {}
            try { _db.prepare('ALTER TABLE products ADD COLUMN series_name TEXT').run(); } catch {}
            try { _db.prepare('ALTER TABLE products ADD COLUMN vr_flag INTEGER DEFAULT 0').run(); } catch {}
            _db.close();
        }
    }

    const today     = new Date();
    const tomorrow  = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const futureEnd = new Date(today);
    futureEnd.setMonth(today.getMonth() + MONTHS_AHEAD);
    const gteDateStr = formatDate(tomorrow);
    const lteDateStr = formatDate(futureEnd);

    console.log('========================================');
    console.log('  FANZA 日次アップデート');
    console.log('========================================');
    console.log(`  予約商品期間: ${gteDateStr} 〜 ${lteDateStr} (${MONTHS_AHEAD}ヶ月先まで)`);
    console.log(`  価格更新: 直近${PRICE_SCAN_YEARS}年 (cid[]差分方式)${NO_PRICE ? ' [スキップ]' : ''}`);
    if (NO_PREORDER) console.log('  予約商品取得: [スキップ]');
    if (DRY_RUN) console.log('  [DRY RUN] DB書き込みなし');

    // ---- STEP 1: 予約商品取得 ----
    const rawNewItems = NO_PREORDER ? [] : await fetchPreorders(gteDateStr, lteDateStr);

    // 30分未満の作品はDBに登録しない
    const afterDuration = rawNewItems.filter(p => p.duration_min === null || p.duration_min >= 30);
    const shortSkipped = rawNewItems.length - afterDuration.length;
    if (shortSkipped > 0) console.log(`  30分未満スキップ: ${shortSkipped}件`);

    // Best/総集編/オムニバス/リマスターはDBに登録しない
    const COMPILATION_RE = /BEST|ベスト|総集編|オムニバス|リマスター/i;
    const afterCompilation = afterDuration.filter(p => !COMPILATION_RE.test(p.title || ''));
    const compilationSkipped = afterDuration.length - afterCompilation.length;
    if (compilationSkipped > 0) console.log(`  総集編系スキップ: ${compilationSkipped}件`);

    // ブロックメーカーはDBに登録しない
    const afterMaker = afterCompilation.filter(p => !BLOCKED_MAKERS.has(p.maker || ''));
    const makerSkipped = afterCompilation.length - afterMaker.length;
    if (makerSkipped > 0) console.log(`  ブロックメーカースキップ: ${makerSkipped}件`);

    // MGS動画と重複する videoc(素人)作品は登録しない（MGSの方がパッケージ画質が良いため）
    const newItems = afterMaker.filter(p => !(p.floor === 'videoc' && isDuplicate(p.product_id, p.title, DEDUP_INDEX)));
    const dupSkipped = afterMaker.length - newItems.length;
    if (dupSkipped > 0) console.log(`  MGS重複videocスキップ: ${dupSkipped}件`);

    // ---- STEP 2: 価格更新（D1が必要なためクライアントを先に作成） ----
    let scanResult = { priceMap: new Map(), cutoffStr: null };

    if (!NO_PRICE && hasD1) {
        const dbForScan = fanzaDb();
        scanResult = await refreshPricesByCid(dbForScan);
        dbForScan.close();
    } else if (!NO_PRICE) {
        console.warn('  ⚠️ CLOUDFLARE_ACCOUNT_ID/D1_TOKEN/D1_FANZA_ID 未設定 — 価格更新スキップ');
    }
    const { priceMap, cutoffStr } = scanResult;

    if (DRY_RUN) {
        console.log('\n[DRY RUN 完了] 書き込みなし');
        return;
    }

    if (newItems.length === 0 && priceMap.size === 0) {
        console.log('\n更新対象なし');
        return;
    }

    const allColumns = [
        'product_id','title','actresses','maker','label','duration_min',
        'genres','sale_start_date','main_image_url','sample_images_json',
        'sample_video_url','affiliate_url','detail_url',
        'list_price','current_price','discount_pct','sale_end_date',
        'review_count','review_average',
        'series_id','series_name','vr_flag',
        'floor',
        'price_updated_at','scraped_at','updated_at',
    ];

    let newCount    = newItems.length; // CI環境ではAPI取得数をそのまま使用
    let priceUpdated = 0;
    let saleStats   = { cnt: 0, max_disc: 0 };

    // ---- ローカルDB 書き込み（CI環境ではスキップ） ----
    if (!process.env.CI) {
        console.log('\n[STEP 3] ローカルDB 書き込み...');
        const localDb = new Database(DB_PATH);
        const priceColumns = ['list_price','current_price','discount_pct','price_updated_at','updated_at'];

        const countBefore = localDb.prepare('SELECT COUNT(*) as cnt FROM products').get().cnt;

        // 新作 upsert
        if (newItems.length > 0) {
            const cols = allColumns.join(', ');
            const vals = allColumns.map(c => `@${c}`).join(', ');
            const insertStmt = localDb.prepare(`INSERT OR REPLACE INTO products (${cols}) VALUES (${vals})`);
            const insertMany = localDb.transaction(rows => { for (const r of rows) insertStmt.run(r); });
            insertMany(newItems);
        }

        // 価格 update（既存作品 — INSERT で上書きせず UPDATE のみ）
        if (priceMap.size > 0) {
            const updateStmt = localDb.prepare(`
                UPDATE products SET
                    list_price       = @listPrice,
                    current_price    = @currentPrice,
                    discount_pct     = @discountPct,
                    sale_end_date    = @saleEndDate,
                    review_count     = COALESCE(@reviewCount, review_count),
                    review_average   = COALESCE(@reviewAverage, review_average),
                    price_updated_at = @price_updated_at,
                    updated_at       = @price_updated_at
                WHERE product_id = @product_id
            `);
            const updateMany = localDb.transaction(entries => {
                for (const [product_id, v] of entries) {
                    const r = updateStmt.run({
                        product_id,
                        listPrice:     v.listPrice,
                        currentPrice:  v.currentPrice,
                        discountPct:   v.discountPct,
                        saleEndDate:   v.saleEndDate ?? null,
                        reviewCount:   v.reviewCount ?? null,
                        reviewAverage: v.reviewAverage ?? null,
                        price_updated_at: v.price_updated_at,
                    });
                    if (r.changes > 0) priceUpdated++;
                }
            });
            updateMany(priceMap.entries());
        }

        const countAfter = localDb.prepare('SELECT COUNT(*) as cnt FROM products').get().cnt;
        newCount = countAfter - countBefore;

        saleStats = localDb.prepare(`
            SELECT COUNT(*) as cnt, MAX(discount_pct) as max_disc
            FROM products WHERE discount_pct > 0
        `).get();
        localDb.close();
    } else {
        console.log('\n[STEP 3] CI環境 — ローカルDB スキップ');
    }

    // セール件数はpriceMapから集計（CI環境ではローカルDBなし）
    const saleCountFromScan = [...priceMap.values()].filter(v => v.discountPct > 0).length;
    console.log(`  予約商品追加: ${newCount}件 / 価格更新: ${priceUpdated.toLocaleString()}件`);
    console.log(`  セール中: ${saleCountFromScan > 0 ? saleCountFromScan : saleStats.cnt}件 (最大割引率: ${saleStats.max_disc ?? 0}%)`);

    // ---- D1 書き込み ----
    if (!hasD1) {
        console.warn('  ⚠️ D1認証情報 未設定 — D1同期スキップ');
    } else {
        console.log('\n[STEP 4] D1 同期...');
        const turso = fanzaDb();

        // FTS5 トリガー(products_au)は FTS列が変化した時のみ発火する WHEN ガード付き
        // （site/migrations/0004_catalog_fts.sql）。価格更新では発火しないため DROP 不要。

        // 新作 upsert
        if (newItems.length > 0) {
            await tursoUpsertBatch(turso, newItems, allColumns);
            console.log(`  新作: ${newItems.length}件 Turso書き込み完了`);
        }

        // 価格 update (バッチ UPDATE)
        if (priceMap.size > 0) {
            const updateSql = `UPDATE products SET
                list_price=?, current_price=?, discount_pct=?, sale_end_date=?,
                review_count=COALESCE(?,review_count), review_average=COALESCE(?,review_average),
                price_updated_at=?, updated_at=?
                WHERE product_id=?`;
            const entries = Array.from(priceMap.entries());
            const BATCH = 50;
            let tUpdated = 0;
            for (let i = 0; i < entries.length; i += BATCH) {
                const batch = entries.slice(i, i + BATCH);
                try {
                    await turso.batch(
                        batch.map(([pid, v]) => ({
                            sql: updateSql,
                            args: [v.listPrice, v.currentPrice, v.discountPct, v.saleEndDate ?? null, v.reviewCount ?? null, v.reviewAverage ?? null, v.price_updated_at, v.price_updated_at, pid],
                        })),
                        'write'
                    );
                    tUpdated += batch.length;
                } catch {
                    for (const [pid, v] of batch) {
                        try {
                            await turso.execute({ sql: updateSql, args: [v.listPrice, v.currentPrice, v.discountPct, v.saleEndDate ?? null, v.reviewCount ?? null, v.reviewAverage ?? null, v.price_updated_at, v.price_updated_at, pid] });
                            tUpdated++;
                        } catch (e2) { /* skip */ }
                    }
                }
                process.stdout.write(`  価格更新Turso: ${tUpdated}/${entries.length}\r`);
            }
            console.log(`\n  価格: ${tUpdated.toLocaleString()}件 Turso更新完了`);
        }

        // ---- 差分クリア ----
        // [A] スキャン窓内でAPIに返ってこなかった作品（削除・取り扱い終了等）のセール情報をクリア
        // [B] スキャン窓外（N年より古い）の残存セール情報をクリア
        if (cutoffStr) {
            const nowIso = new Date().toISOString();
            try {
                // [A] スキャン窓内の「未返却作品」のセールクリア
                // priceMapに含まれる作品はUPDATEで更新済み（discount_pct=0も含む）
                // 含まれなかった作品＝APIに存在しない → セールのはずがない
                const scannedIds = Array.from(priceMap.keys());
                if (scannedIds.length > 0) {
                    // 窓内でdiscount_pct>0 かつ 今回スキャンに引っかからなかった作品
                    const inWindowOnSale = (await turso.execute({
                        sql: 'SELECT product_id FROM products WHERE discount_pct > 0 AND sale_start_date >= ?',
                        args: [cutoffStr],
                    })).rows.map(r => String(r.product_id));

                    const notFound = inWindowOnSale.filter(pid => !priceMap.has(pid));
                    if (notFound.length > 0) {
                        const CHUNK = 100;
                        for (let i = 0; i < notFound.length; i += CHUNK) {
                            const chunk = notFound.slice(i, i + CHUNK);
                            const ph = chunk.map(() => '?').join(',');
                            await turso.execute({
                                sql: `UPDATE products SET discount_pct=0, list_price=NULL, current_price=NULL, sale_end_date=NULL, updated_at=? WHERE product_id IN (${ph})`,
                                args: [nowIso, ...chunk],
                            });
                        }
                        console.log(`  🧹 窓内未返却セールクリア: ${notFound.length}件`);
                    }
                }

                // [B] スキャン窓外（N年より古い）の残存セールクリア
                const staleResult = await turso.execute({
                    sql: 'SELECT COUNT(*) AS cnt FROM products WHERE discount_pct > 0 AND sale_start_date IS NOT NULL AND sale_start_date < ?',
                    args: [cutoffStr],
                });
                const staleCount = Number(staleResult.rows[0]?.[0] ?? staleResult.rows[0]?.cnt ?? 0);
                if (staleCount > 0) {
                    await turso.execute({
                        sql: `UPDATE products SET discount_pct=0, list_price=NULL, current_price=NULL, sale_end_date=NULL, updated_at=? WHERE discount_pct > 0 AND sale_start_date IS NOT NULL AND sale_start_date < ?`,
                        args: [nowIso, cutoffStr],
                    });
                    console.log(`  🧹 窓外古いセールクリア: ${staleCount}件 (発売日 < ${cutoffStr})`);
                }
            } catch (e) {
                console.warn('  ⚠️ 差分クリア失敗:', e.message);
            }
        }

        turso.close();
    }

    // ---- 新出演女優のプロフィール自動取得 → D1 ----
    if (newItems.length > 0 && DMM_API_ID && DMM_AFFILIATE_ID && hasD1) {
        console.log('\n[STEP 5] 新出演女優プロフィール更新...');
        try {
            const profilesDb = fanzaDb();

            // 新作から女優名を収集
            const newNames = new Set();
            for (const item of newItems) {
                if (item.actresses) {
                    item.actresses.split(',').map(n => n.trim()).filter(Boolean).forEach(n => newNames.add(n));
                }
            }

            // ローカル actress_profiles.json に存在しない女優のみ対象（Turso行読み取り削減）
            const localProfilesPath = path.join(__dirname, '..', 'data', 'actress_profiles.json');
            let existing = new Set();
            if (require('fs').existsSync(localProfilesPath)) {
                const localProfiles = JSON.parse(require('fs').readFileSync(localProfilesPath, 'utf-8'));
                existing = new Set(Object.keys(localProfiles));
            } else {
                // フォールバック: Tursoから確認
                existing = await profilesDb.execute({
                    sql: `SELECT name FROM actress_profiles WHERE name IN (${[...newNames].map(() => '?').join(',')})`,
                    args: [...newNames],
                }).then(r => new Set(r.rows.map(row => row.name))).catch(() => new Set());
            }

            const missing = [...newNames].filter(n => !existing.has(n));
            console.log(`  新出演女優: ${newNames.size}名 / 未取得: ${missing.length}名`);

            let fetched = 0;
            for (const name of missing) {
                const url = `https://api.dmm.com/affiliate/v3/ActressSearch?api_id=${DMM_API_ID}&affiliate_id=${DMM_AFFILIATE_ID}&keyword=${encodeURIComponent(name)}&output=json`;
                try {
                    const res = await fetch(url);
                    const data = await res.json();
                    if (data.result?.status == 200 && data.result.actress?.length > 0) {
                        const hit = data.result.actress.find(a => a.name === name) || data.result.actress[0];
                        await profilesDb.execute({
                            sql: `INSERT OR REPLACE INTO actress_profiles
                                (name,fanza_id,ruby,height,bust,waist,hip,cup,birthday,blood_type,
                                 hobby,prefectures,image_url,updated_at)
                                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                            args: [
                                name, hit.id, hit.ruby || null,
                                parseInt(hit.height) || null, parseInt(hit.bust) || null,
                                parseInt(hit.waist) || null, parseInt(hit.hip) || null,
                                hit.cup || null, hit.birthday || null, hit.blood_type || null,
                                hit.hobby || null, hit.prefectures || null,
                                hit.imageURL?.large || null, new Date().toISOString(),
                            ],
                        });
                        fetched++;
                    }
                } catch (e) {
                    console.warn(`  [プロフィール取得失敗] ${name}: ${e.message}`);
                }
                await sleep(1000);
            }

            profilesDb.close();
            console.log(`  ${fetched}名のプロフィールをD1に保存`);
        } catch (e) {
            console.warn('  ⚠️ プロフィール更新失敗:', e.message);
        }
    }

    // ---- 期限切れセール情報クリア（D1 FANZA） ----
    {
        if (hasD1) {
            try {
                const turso = fanzaDb();
                // JST で比較（DMM API の sale_end_date は JST 形式 "YYYY-MM-DD HH:MM:SS"）
                const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 16);
                // sale_end_date <= nowJST の条件をDB側で絞る（全件取得→JS側フィルタを廃止）
                const expiredRes = await turso.execute({
                    sql: 'SELECT product_id FROM products WHERE discount_pct > 0 AND sale_end_date IS NOT NULL AND sale_end_date <= ? LIMIT 500',
                    args: [nowJST],
                });
                const expired = expiredRes.rows;
                if (expired.length > 0) {
                    // discount_pct/price 系のみ更新 → FTS5インデックス(title/actresses/genres)は変わらないため rebuild 不要
                    for (const row of expired) {
                        await turso.execute({
                            sql: 'UPDATE products SET discount_pct=0, list_price=NULL, current_price=NULL, sale_end_date=NULL WHERE product_id=?',
                            args: [String(row.product_id)],
                        });
                    }
                    console.log(`[D1] 🧹 期限切れセール ${expired.length}件 クリア`);
                } else {
                    console.log('[D1] 期限切れセールなし');
                }
                turso.close();
            } catch (e) {
                console.warn('[D1] 期限切れクリアエラー:', e.message);
            }
        }
    }

    // ---- サジェストキャッシュ再生成 ----
    if (newCount > 0) {
        console.log('\n[STEP 6] サジェストキャッシュ更新...');
        try {
            execSync(`node ${path.join(__dirname, 'build_suggest_cache.js')}`, { stdio: 'inherit' });
        } catch (e) {
            console.warn('  ⚠️ キャッシュ生成失敗:', e.message);
        }
    }

    // ---- Discord通知 ----
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    console.log('\n========================================');
    console.log(`  ✅ 完了 (${now})`);
    console.log('========================================\n');

    {
        const lines = [
            `📦 **FANZA日次更新** (${now})`,
            `予約商品: **${newCount}件** / 価格更新: **${priceUpdated.toLocaleString()}件**`,
        ];
        if (saleStats.cnt > 0) {
            lines.push(`🏷️ セール中: **${saleStats.cnt.toLocaleString()}件** (最大 ${saleStats.max_disc}%OFF)`);
        }
        if (newCount === 0 && saleStats.cnt === 0) {
            lines.push('ℹ️ 本日の予約商品・セールなし');
        }
        await sendDiscord(lines.join('\n'));
    }

    // ---- Telegram通知（予約商品・セール） ----
    if (process.env.TELEGRAM_BOT_TOKEN) {
        try {
            if (newCount > 0) {
                execSync(
                    `node ${path.join(__dirname, 'telegram_bot.js')} --mode=notify --genre=preorder --count=3`,
                    { stdio: 'inherit' }
                );
            }
            if (saleStats.cnt > 0) {
                execSync(
                    `node ${path.join(__dirname, 'telegram_bot.js')} --mode=notify --genre=sale --count=3`,
                    { stdio: 'inherit' }
                );
            }
        } catch (e) {
            console.warn('  ⚠️ Telegram通知失敗:', e.message);
        }
    }
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
