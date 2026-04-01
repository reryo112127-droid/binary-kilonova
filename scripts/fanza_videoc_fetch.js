/**
 * FANZA 素人Floor（videoc）全作品 一括取得・Turso直接投入スクリプト
 *
 * DMM API v3 で service=digital, floor=videoc を月別に全取得し、
 * Turso FANZA DB へ直接 UPSERT。中断・再開対応。
 *
 * 実行:
 *   node scripts/fanza_videoc_fetch.js              # 通常実行
 *   node scripts/fanza_videoc_fetch.js --dry-run    # 件数確認のみ（DB書き込みなし）
 *   node scripts/fanza_videoc_fetch.js --from 2020-01  # 指定月から開始
 *
 * 進捗: data/fanza_videoc_progress.json
 *
 * 完了後、AVWIKI女優特定を反映する場合:
 *   node scripts/scrape_avwiki_products.js --apply-videoc
 */

const path = require('path');
const { createClient } = require('@libsql/client');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DMM_API_ID       = process.env.DMM_API_ID;
const DMM_AFFILIATE_ID = process.env.DMM_AFFILIATE_ID;

const DATA_DIR      = path.join(__dirname, '..', 'data');
const PROGRESS_FILE = path.join(DATA_DIR, 'fanza_videoc_progress.json');

const HITS_PER_REQUEST   = 100;    // DMM API最大値
const RATE_LIMIT_MS      = 1000;   // APIリクエスト間隔(ms)
const TURSO_BATCH_SIZE   = 50;     // Tursoへの1バッチあたり件数
const START_YEAR_MONTH   = '2010-01';
const DISCORD_WEBHOOK    = 'https://discord.com/api/webhooks/1485815872688885892/78U4bkE7SNNTIMuW91ru_bJXH6D6hynnf88dYAnzkgq2hECA4gUSNa6hzq5DWquwRJYe';
const DISCORD_REPORT_INTERVAL = 10; // N ヶ月ごとにDiscord進捗報告

// -------- 引数パース --------
const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const fromIdx = args.indexOf('--from');
const FROM_YM = fromIdx !== -1 ? args[fromIdx + 1] : null;

// -------- ユーティリティ --------
const sleep = ms => new Promise(r => setTimeout(r, ms));

function nowJST() {
    return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

async function sendDiscord(content) {
    try {
        await fetch(DISCORD_WEBHOOK, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ content }),
        });
    } catch (e) {
        console.warn('[Discord] 通知失敗:', e.message);
    }
}

function getCurrentYearMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getNextMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m, 1); // m は 1-indexed なので new Date(y, 1, 1) = 2月1日
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function loadProgress() {
    if (fs.existsSync(PROGRESS_FILE)) {
        return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    }
    return { completed_months: [], total_fetched: 0 };
}

function saveProgress(p) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

// -------- DMM API 呼び出し --------
async function fetchPage(yearMonth, offset = 1) {
    const [year, month] = yearMonth.split('-');
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    const params = new URLSearchParams({
        api_id:       DMM_API_ID,
        affiliate_id: DMM_AFFILIATE_ID,
        site:         'FANZA',
        service:      'digital',
        floor:        'videoc',
        hits:         HITS_PER_REQUEST.toString(),
        offset:       offset.toString(),
        sort:         'date',
        gte_date:     `${year}-${month}-01T00:00:00`,
        lte_date:     `${year}-${month}-${String(lastDay).padStart(2, '0')}T23:59:59`,
        output:       'json',
    });

    const res = await fetch(`https://api.dmm.com/affiliate/v3/ItemList?${params}`);
    if (!res.ok) throw new Error(`DMM API HTTP ${res.status}`);
    const data = await res.json();
    if (data.result?.status !== 200) {
        throw new Error(`DMM API error: ${JSON.stringify(data.result)}`);
    }
    return {
        total: data.result.total_count || 0,
        items: data.result.items || [],
    };
}

// -------- 価格パース --------
function parsePrice(item) {
    const deliveries = item.prices?.deliveries?.delivery || [];
    const target = deliveries.find(d => d.type === 'download')
                || deliveries.find(d => d.type === 'hd')
                || deliveries[0];
    if (!target) return { listPrice: null, currentPrice: null, discountPct: 0, saleEndDate: null };

    const listPrice    = parseInt(String(target.list_price).replace(/[^0-9]/g, '')) || null;
    const currentPrice = parseInt(String(target.price).replace(/[^0-9]/g, ''))      || null;
    const discountPct  = (listPrice && currentPrice && listPrice > currentPrice)
        ? Math.round((listPrice - currentPrice) / listPrice * 100) : 0;
    const saleEndDate  = target.campaign?.date_end || null;
    return { listPrice, currentPrice, discountPct, saleEndDate };
}

// -------- アイテム変換 --------
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
        price_updated_at:   now,
        scraped_at:         now,
        updated_at:         now,
    };
}

const ALL_COLUMNS = [
    'product_id','title','actresses','maker','label','duration_min',
    'genres','sale_start_date','main_image_url','sample_images_json',
    'sample_video_url','affiliate_url','detail_url',
    'list_price','current_price','discount_pct','sale_end_date','price_updated_at',
    'scraped_at','updated_at',
];

// -------- Turso UPSERT --------
async function tursoUpsertBatch(turso, rows) {
    const placeholders = ALL_COLUMNS.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO products (${ALL_COLUMNS.join(', ')}) VALUES (${placeholders})`;
    for (let i = 0; i < rows.length; i += TURSO_BATCH_SIZE) {
        const batch = rows.slice(i, i + TURSO_BATCH_SIZE);
        try {
            await turso.batch(
                batch.map(row => ({ sql, args: ALL_COLUMNS.map(c => row[c] ?? null) })),
                'write'
            );
        } catch {
            // バッチ失敗時は1件ずつリトライ
            for (const row of batch) {
                try {
                    await turso.execute({ sql, args: ALL_COLUMNS.map(c => row[c] ?? null) });
                } catch (e2) {
                    console.error(`  [スキップ] ${row.product_id}: ${e2.message}`);
                }
            }
        }
    }
}

// -------- スキーマ確認・マイグレーション --------
async function ensureSchema(turso) {
    // 基本スキーマ（既存でも IF NOT EXISTS で安全）
    await turso.execute(`CREATE TABLE IF NOT EXISTS products (
        product_id TEXT PRIMARY KEY,
        title TEXT, actresses TEXT, maker TEXT, label TEXT,
        duration_min INTEGER, genres TEXT, sale_start_date TEXT,
        main_image_url TEXT, sample_images_json TEXT, sample_video_url TEXT,
        affiliate_url TEXT, detail_url TEXT,
        list_price INTEGER, current_price INTEGER,
        discount_pct INTEGER DEFAULT 0, sale_end_date TEXT, price_updated_at TEXT,
        scraped_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    )`);
    // インデックス
    for (const sql of [
        'CREATE INDEX IF NOT EXISTS idx_sale_date ON products(sale_start_date)',
        'CREATE INDEX IF NOT EXISTS idx_maker ON products(maker)',
        'CREATE INDEX IF NOT EXISTS idx_label ON products(label)',
        'CREATE INDEX IF NOT EXISTS idx_discount ON products(discount_pct)',
    ]) {
        try { await turso.execute(sql); } catch {}
    }
    // 価格カラム追加（古いスキーマ対応）
    for (const sql of [
        'ALTER TABLE products ADD COLUMN list_price INTEGER',
        'ALTER TABLE products ADD COLUMN current_price INTEGER',
        'ALTER TABLE products ADD COLUMN discount_pct INTEGER DEFAULT 0',
        'ALTER TABLE products ADD COLUMN sale_end_date TEXT',
        'ALTER TABLE products ADD COLUMN price_updated_at TEXT',
        'ALTER TABLE products ADD COLUMN sample_video_url TEXT',
    ]) {
        try { await turso.execute(sql); } catch {}
    }
}

// -------- メイン --------
async function main() {
    console.log('══════════════════════════════════════════════');
    console.log('  FANZA 素人Floor（videoc）全作品 一括取得');
    console.log('══════════════════════════════════════════════');
    if (DRY_RUN) console.log('  [DRY RUN] DB書き込みなし');
    console.log('');

    if (!DMM_API_ID || !DMM_AFFILIATE_ID) {
        console.error('❌ DMM_API_ID / DMM_AFFILIATE_ID が未設定');
        process.exit(1);
    }
    if (!process.env.TURSO_FANZA_URL || !process.env.TURSO_FANZA_TOKEN) {
        console.error('❌ TURSO_FANZA_URL / TURSO_FANZA_TOKEN が未設定');
        process.exit(1);
    }

    const turso = createClient({
        url:       process.env.TURSO_FANZA_URL,
        authToken: process.env.TURSO_FANZA_TOKEN,
    });

    if (!DRY_RUN) await ensureSchema(turso);

    const countResult = await turso.execute('SELECT COUNT(*) as cnt FROM products');
    const initialCount = Number(countResult.rows[0].cnt);
    console.log(`Turso現在のレコード数: ${initialCount.toLocaleString()}件\n`);

    const progress = loadProgress();
    console.log(`[進捗] 完了月: ${progress.completed_months.length}ヶ月 / 取得済み: ${progress.total_fetched.toLocaleString()}件`);

    const startYM   = FROM_YM || START_YEAR_MONTH;
    const currentYM = getCurrentYearMonth();
    let targetMonth  = startYM;
    let totalFetched = progress.total_fetched;
    let monthsProcessed = 0; // 今回のセッションで処理した月数

    // 開始通知
    if (!DRY_RUN) {
        await sendDiscord(
            `🚀 **FANZA 素人Floor スクレイピング開始** (${nowJST()})\n` +
            `開始月: ${startYM} → ${currentYM}\n` +
            `Turso既存: ${initialCount.toLocaleString()}件 / 完了済み: ${progress.completed_months.length}ヶ月`
        );
    }

    while (targetMonth <= currentYM) {
        if (progress.completed_months.includes(targetMonth)) {
            targetMonth = getNextMonth(targetMonth);
            continue;
        }

        console.log(`\n[${targetMonth}] 取得開始...`);
        let offset = 1;
        let monthFetched = 0;
        let totalInMonth = null;
        const monthItems = [];

        try {
            while (true) {
                const { total, items } = await fetchPage(targetMonth, offset);

                if (totalInMonth === null) {
                    totalInMonth = total;
                    if (total === 0) {
                        console.log(`  件数0件 スキップ`);
                        break;
                    }
                    console.log(`  DMM API 件数: ${total.toLocaleString()}件`);
                }

                if (items.length === 0) break;

                for (const item of items) {
                    const genres = item.iteminfo?.genre?.map(g => g.name) || [];
                    if (genres.includes('ゲイ')) continue;
                    monthItems.push(convertItem(item));
                }

                monthFetched += items.length;
                totalFetched += items.length;
                process.stdout.write(`  取得中: ${monthFetched}/${totalInMonth} (offset=${offset})\r`);

                if (items.length < HITS_PER_REQUEST) break;
                if (offset + HITS_PER_REQUEST > 50000) break; // DMM API上限

                offset += HITS_PER_REQUEST;
                await sleep(RATE_LIMIT_MS);
            }

            // Turso投入
            if (monthItems.length > 0 && !DRY_RUN) {
                process.stdout.write(`\n  Turso投入中... `);
                await tursoUpsertBatch(turso, monthItems);
                console.log(`${monthItems.length}件投入完了`);
            } else if (DRY_RUN && monthItems.length > 0) {
                console.log(`\n  [DRY RUN] ${monthItems.length}件 (未書き込み)`);
            }

            progress.completed_months.push(targetMonth);
            progress.total_fetched = totalFetched;
            saveProgress(progress);
            monthsProcessed++;

            console.log(`  ✅ ${targetMonth}: ${monthFetched.toLocaleString()}件完了 (累計: ${totalFetched.toLocaleString()}件)`);

            // N ヶ月ごとに Discord 進捗報告
            if (!DRY_RUN && monthsProcessed % DISCORD_REPORT_INTERVAL === 0) {
                await sendDiscord(
                    `📊 **FANZA 素人Floor 進捗** (${nowJST()})\n` +
                    `完了: **${progress.completed_months.length}ヶ月** / 取得累計: **${totalFetched.toLocaleString()}件**\n` +
                    `現在: ${targetMonth} まで完了`
                );
            }

        } catch (err) {
            console.error(`\n  ❌ ${targetMonth}: ${err.message}`);
            console.error('  5秒後にリトライ...');
            if (!DRY_RUN) {
                await sendDiscord(
                    `⚠️ **FANZA 素人Floor エラー** (${nowJST()})\n` +
                    `月: ${targetMonth} / エラー: ${err.message}\n` +
                    `5秒後にリトライします`
                );
            }
            await sleep(5000);
            continue; // 同じ月を再試行
        }

        targetMonth = getNextMonth(targetMonth);
        await sleep(RATE_LIMIT_MS);
    }

    turso.close();

    const finalCount = DRY_RUN ? '(dry run)' : await (async () => {
        const tc = createClient({ url: process.env.TURSO_FANZA_URL, authToken: process.env.TURSO_FANZA_TOKEN });
        const r = await tc.execute('SELECT COUNT(*) as cnt FROM products');
        tc.close();
        return Number(r.rows[0].cnt).toLocaleString();
    })();

    console.log('\n══════════════════════════════════════════════');
    console.log('  完了！');
    console.log('══════════════════════════════════════════════');
    console.log(`  取得完了月数: ${progress.completed_months.length}ヶ月`);
    console.log(`  今回取得件数: ${totalFetched.toLocaleString()}件`);
    console.log(`  Turso総レコード数: ${finalCount}件`);
    console.log('');
    console.log('次のステップ（AVWIKI女優特定を反映）:');
    console.log('  node scripts/scrape_avwiki_products.js --apply-videoc');
    console.log('══════════════════════════════════════════════\n');

    // 完了通知
    if (!DRY_RUN) {
        await sendDiscord(
            `✅ **FANZA 素人Floor スクレイピング完了** (${nowJST()})\n` +
            `完了月数: **${progress.completed_months.length}ヶ月**\n` +
            `今回取得: **${totalFetched.toLocaleString()}件**\n` +
            `Turso総レコード: **${finalCount}件**\n` +
            `次: \`node scripts/scrape_avwiki_products.js --apply-videoc\` で女優情報を反映`
        );
    }
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
