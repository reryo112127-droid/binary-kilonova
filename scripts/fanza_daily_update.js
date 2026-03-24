/**
 * FANZA 日次アップデートスクリプト
 *
 * 1. 新作取得: 直近N日の新作を DMM API から取得しローカルDB + Turso に追加
 * 2. 価格更新: 直近12ヶ月の既存作品の価格情報（セール検出）を更新
 *
 * 実行:
 *   node scripts/fanza_daily_update.js              # デフォルト: 過去7日
 *   node scripts/fanza_daily_update.js --days 14    # 過去14日
 *   node scripts/fanza_daily_update.js --no-price   # 価格更新スキップ
 *   node scripts/fanza_daily_update.js --dry-run    # 件数確認のみ（DB書き込みなし）
 */

const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DMM_API_ID      = process.env.DMM_API_ID;
const DMM_AFFILIATE_ID = process.env.DMM_AFFILIATE_ID;
const DISCORD_WEBHOOK  = 'https://discord.com/api/webhooks/1485815872688885892/78U4bkE7SNNTIMuW91ru_bJXH6D6hynnf88dYAnzkgq2hECA4gUSNa6hzq5DWquwRJYe';

const DB_PATH          = path.join(__dirname, '..', 'data', 'fanza.db');
const HITS_PER_REQUEST = 100;
const RATE_LIMIT_MS    = 1200;
const PRICE_REFRESH_MONTHS = 12; // 直近何ヶ月分の価格を更新するか

// ---- 引数パース ----
const args    = process.argv.slice(2);
const daysArg = args.indexOf('--days');
const DAYS_BACK  = daysArg !== -1 ? parseInt(args[daysArg + 1], 10) : 7;
const DRY_RUN    = args.includes('--dry-run');
const NO_PRICE   = args.includes('--no-price');

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

    // セール終了日時 (DMM API: campaign.date_end)
    const saleEndDate = target.campaign?.date_end || null;

    return { listPrice, currentPrice, discountPct, saleEndDate };
}

// ---- DMM API 呼び出し ----
async function fetchPage(gteDate, lteDate, offset = 1) {
    const params = new URLSearchParams({
        api_id:       DMM_API_ID,
        affiliate_id: DMM_AFFILIATE_ID,
        site:         'FANZA',
        service:      'digital',
        floor:        'videoa',
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
//  STEP 1: 新作取得
// ============================================================
async function fetchNewProducts(gteDateStr, lteDateStr) {
    const gteDateTime = toApiDatetime(gteDateStr);
    const lteDateTime = toApiDatetime(lteDateStr, true);

    console.log(`\n[STEP 1] 新作取得: ${gteDateStr} 〜 ${lteDateStr}`);

    let offset = 1, totalInApi = null;
    const fetched = [];

    while (true) {
        const { total, items } = await fetchPage(gteDateTime, lteDateTime, offset);
        if (totalInApi === null) {
            totalInApi = total;
            console.log(`  DMM API 件数: ${total.toLocaleString()} 件`);
        }
        if (items.length === 0) break;
        for (const item of items) fetched.push(convertItem(item));
        process.stdout.write(`  取得中: ${fetched.length} / ${totalInApi}\r`);
        if (items.length < HITS_PER_REQUEST) break;
        offset += HITS_PER_REQUEST;
        await sleep(RATE_LIMIT_MS);
    }

    console.log(`\n  取得完了: ${fetched.length} 件`);
    return fetched;
}

// ============================================================
//  STEP 2: 価格更新（直近12ヶ月の既存作品）
// ============================================================
async function refreshPrices() {
    const months = getPastMonths(PRICE_REFRESH_MONTHS);
    console.log(`\n[STEP 2] 価格更新: 直近${PRICE_REFRESH_MONTHS}ヶ月 (${months[0]} 〜 ${months[months.length - 1]})`);

    // product_id → 価格情報 のマップ
    const priceMap = new Map(); // product_id -> { listPrice, currentPrice, discountPct }

    for (let mi = 0; mi < months.length; mi++) {
        const ym = months[mi];
        const { gte, lte } = getMonthRange(ym);
        let offset = 1, monthTotal = null;

        while (true) {
            try {
                const { total, items } = await fetchPage(gte, lte, offset);
                if (monthTotal === null) monthTotal = total;
                if (items.length === 0) break;

                for (const item of items) {
                    const { listPrice, currentPrice, discountPct, saleEndDate } = parsePrice(item);
                    priceMap.set(item.content_id, {
                        listPrice, currentPrice, discountPct, saleEndDate,
                        price_updated_at: new Date().toISOString(),
                    });
                }

                if (items.length < HITS_PER_REQUEST) break;
                offset += HITS_PER_REQUEST;
                await sleep(RATE_LIMIT_MS);
            } catch (e) {
                console.warn(`\n  [警告] ${ym} 取得エラー: ${e.message}`);
                break;
            }
        }

        process.stdout.write(`  ${mi + 1}/${months.length} ${ym}: ${monthTotal ?? 0}件  \r`);
    }

    console.log(`\n  価格取得完了: ${priceMap.size.toLocaleString()} 件`);

    // セール中の件数を集計
    let saleCount = 0;
    for (const v of priceMap.values()) {
        if (v.discountPct > 0) saleCount++;
    }
    console.log(`  セール中: ${saleCount.toLocaleString()} 件 (割引率 > 0%)`);

    return priceMap;
}

// ============================================================
//  メイン
// ============================================================
async function main() {
    if (!DMM_API_ID || !DMM_AFFILIATE_ID) {
        console.error('❌ DMM_API_ID / DMM_AFFILIATE_ID が未設定');
        process.exit(1);
    }

    // ---- Turso スキーママイグレーション（sale_end_date カラム追加、冪等） ----
    {
        const _url   = process.env.TURSO_FANZA_URL;
        const _token = process.env.TURSO_FANZA_TOKEN;
        if (_url && _token) {
            const _turso = createClient({ url: _url, authToken: _token });
            try { await _turso.execute('ALTER TABLE products ADD COLUMN sale_end_date TEXT'); } catch {}
            _turso.close();
        }
        // ローカルDB マイグレーション
        if (!process.env.CI && require('fs').existsSync(DB_PATH)) {
            const _db = new Database(DB_PATH);
            try { _db.prepare('ALTER TABLE products ADD COLUMN sale_end_date TEXT').run(); } catch {}
            _db.close();
        }
    }

    const today    = new Date();
    const fromDate = new Date(today);
    fromDate.setDate(today.getDate() - DAYS_BACK);
    const gteDateStr = formatDate(fromDate);
    const lteDateStr = formatDate(today);

    console.log('========================================');
    console.log('  FANZA 日次アップデート');
    console.log('========================================');
    console.log(`  新作期間: ${gteDateStr} 〜 ${lteDateStr} (${DAYS_BACK}日間)`);
    console.log(`  価格更新: 直近${PRICE_REFRESH_MONTHS}ヶ月${NO_PRICE ? ' [スキップ]' : ''}`);
    if (DRY_RUN) console.log('  [DRY RUN] DB書き込みなし');

    // ---- STEP 1: 新作取得 ----
    const newItems = await fetchNewProducts(gteDateStr, lteDateStr);

    // ---- STEP 2: 価格更新 ----
    const priceMap = NO_PRICE ? new Map() : await refreshPrices();

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
        'list_price','current_price','discount_pct','sale_end_date','price_updated_at',
        'scraped_at','updated_at',
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
                    price_updated_at = @price_updated_at,
                    updated_at       = @price_updated_at
                WHERE product_id = @product_id
            `);
            const updateMany = localDb.transaction(entries => {
                for (const [product_id, v] of entries) {
                    const r = updateStmt.run({
                        product_id,
                        listPrice:    v.listPrice,
                        currentPrice: v.currentPrice,
                        discountPct:  v.discountPct,
                        saleEndDate:  v.saleEndDate ?? null,
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

    console.log(`  新規追加: ${newCount}件 / 価格更新: ${priceUpdated.toLocaleString()}件`);
    console.log(`  セール中: ${saleStats.cnt.toLocaleString()}件 (最大割引率: ${saleStats.max_disc ?? 0}%)`);

    // ---- Turso 書き込み ----
    const tursoUrl   = process.env.TURSO_FANZA_URL;
    const tursoToken = process.env.TURSO_FANZA_TOKEN;

    if (!tursoUrl || !tursoToken) {
        console.warn('  ⚠️ TURSO_FANZA_URL/TOKEN 未設定 — Turso同期スキップ');
    } else {
        console.log('\n[STEP 4] Turso 同期...');
        const turso = createClient({ url: tursoUrl, authToken: tursoToken });

        // 新作 upsert
        if (newItems.length > 0) {
            await tursoUpsertBatch(turso, newItems, allColumns);
            console.log(`  新作: ${newItems.length}件 Turso書き込み完了`);
        }

        // 価格 update (バッチ UPDATE)
        if (priceMap.size > 0) {
            const updateSql = `UPDATE products SET
                list_price=?, current_price=?, discount_pct=?, sale_end_date=?, price_updated_at=?, updated_at=?
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
                            args: [v.listPrice, v.currentPrice, v.discountPct, v.saleEndDate ?? null, v.price_updated_at, v.price_updated_at, pid],
                        })),
                        'write'
                    );
                    tUpdated += batch.length;
                } catch {
                    for (const [pid, v] of batch) {
                        try {
                            await turso.execute({ sql: updateSql, args: [v.listPrice, v.currentPrice, v.discountPct, v.saleEndDate ?? null, v.price_updated_at, v.price_updated_at, pid] });
                            tUpdated++;
                        } catch (e2) { /* skip */ }
                    }
                }
                process.stdout.write(`  価格更新Turso: ${tUpdated}/${entries.length}\r`);
            }
            console.log(`\n  価格: ${tUpdated.toLocaleString()}件 Turso更新完了`);
        }

        turso.close();
    }

    // ---- 新出演女優のプロフィール自動取得 → Turso ----
    if (newItems.length > 0 && DMM_API_ID && DMM_AFFILIATE_ID && tursoUrl && tursoToken) {
        console.log('\n[STEP 5] 新出演女優プロフィール更新...');
        try {
            const profilesDb = createClient({ url: tursoUrl, authToken: tursoToken });

            // 新作から女優名を収集
            const newNames = new Set();
            for (const item of newItems) {
                if (item.actresses) {
                    item.actresses.split(',').map(n => n.trim()).filter(Boolean).forEach(n => newNames.add(n));
                }
            }

            // Tursoに存在しない女優のみ対象
            const existing = await profilesDb.execute({
                sql: `SELECT name FROM actress_profiles WHERE name IN (${[...newNames].map(() => '?').join(',')})`,
                args: [...newNames],
            }).then(r => new Set(r.rows.map(row => row.name))).catch(() => new Set());

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
            console.log(`  ${fetched}名のプロフィールをTursoに保存`);
        } catch (e) {
            console.warn('  ⚠️ プロフィール更新失敗:', e.message);
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

    if (newCount > 0 || saleStats.cnt > 0) {
        const lines = [
            `📦 **FANZA日次更新** (${now})`,
            `新作: **${newCount}件** / 価格更新: **${priceUpdated.toLocaleString()}件**`,
        ];
        if (saleStats.cnt > 0) {
            lines.push(`🏷️ セール中: **${saleStats.cnt.toLocaleString()}件** (最大 ${saleStats.max_disc}%OFF)`);
        }
        await sendDiscord(lines.join('\n'));
    }

    // ---- Telegram通知（新作・セール） ----
    if (process.env.TELEGRAM_BOT_TOKEN) {
        try {
            if (newCount > 0) {
                execSync(
                    `node ${path.join(__dirname, 'telegram_bot.js')} --mode=notify --genre=new --count=3`,
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
