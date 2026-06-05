/**
 * フェーズ3: 日次アップデート（差分取得）
 *
 * 新着順で検索一覧ページを巡回し、
 * DBに未登録の新規作品だけを追加する。
 * 既知の作品IDが一定数見つかったら終了する。
 * 更新後は Turso にも同期する。
 *
 * 使い方:
 *   node scripts/phase3_daily_update.js              # デフォルト（直近2年）
 *   node scripts/phase3_daily_update.js --years 1    # 価格更新を直近1年に縮小
 *   node scripts/phase3_daily_update.js --years 3    # 価格更新を直近3年に拡大
 *   node scripts/phase3_daily_update.js --pages 700  # 価格更新を固定ページ数で指定
 *   node scripts/phase3_daily_update.js --no-preorder # 新規作品取得をスキップ
 */
const path  = require('path');
const fs    = require('fs');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { d1 } = require('./lib/d1');
const db = require('../db/database');

// Turso 廃止: MGS カタログ書き込みは Cloudflare D1(MGS) へ。
// 必要 env: CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_D1_TOKEN / D1_MGS_ID
const hasD1 = !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_D1_TOKEN && process.env.D1_MGS_ID);
const mgsDb = () => d1('mgs');
const { fetchPage, politeWait, buildSearchUrl, buildDetailUrl } = require('../lib/fetcher');
const { parseSearchPage, parseDetailPage } = require('../lib/parser');

const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1485815872688885892/78U4bkE7SNNTIMuW91ru_bJXH6D6hynnf88dYAnzkgq2hECA4gUSNa6hzq5DWquwRJYe';
async function sendDiscord(content) {
    return new Promise((resolve) => {
        const url     = new URL(DISCORD_WEBHOOK);
        const payload = JSON.stringify({ content });
        const req = https.request({
            hostname: url.hostname, path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => { res.resume(); res.on('end', resolve); });
        req.on('error', (e) => { console.warn('[Discord] 送信失敗:', e.message); resolve(); });
        req.write(payload); req.end();
    });
}

const ACTRESS_INDEX_FILE  = path.join(__dirname, '..', 'data', 'mgs_actress_index.json');
const KNOWN_IDS_CACHE     = path.join(__dirname, '..', 'data', 'known_ids_mgs_cache.json');
const BLOCKED_MAKERS_PATH = path.join(__dirname, '..', 'data', 'blocked_makers.json');
const BLOCKED_MAKERS = new Set(
    fs.existsSync(BLOCKED_MAKERS_PATH)
        ? JSON.parse(fs.readFileSync(BLOCKED_MAKERS_PATH, 'utf-8')).makers
        : []
);

const IS_CI = !!process.env.CI;

// STEP2: 1ページ=120件
const _ITEMS_PER_PAGE = 120;
const ITEMS_PER_YEAR_APPROX = 12000; // MGS年間新作数の概算（安全マージン込み）

// ---- 引数パース ----
const _args = process.argv.slice(2);
const _pagesIdx = _args.indexOf('--pages');
const _yearsIdx = _args.indexOf('--years');
const PRICE_SCAN_YEARS = _yearsIdx !== -1 ? parseInt(_args[_yearsIdx + 1], 10) : 2; // デフォルト2年
const PRICE_REFRESH_PAGES = Math.ceil(ITEMS_PER_YEAR_APPROX * PRICE_SCAN_YEARS / _ITEMS_PER_PAGE);
const PRICE_REFRESH_PAGES_OVERRIDE = _pagesIdx !== -1 ? parseInt(_args[_pagesIdx + 1], 10) : null;
const NO_PREORDER = _args.includes('--no-preorder');

const MGS_COLUMNS = [
    'product_id','title','actresses','maker','label','duration_min',
    'genres','sale_start_date','main_image_url','sample_images_json',
    'sample_video_url','detail_scraped','scraped_at','updated_at',
    'list_price','current_price','discount_pct','sale_end_date','price_updated_at',
];

async function tursoUpsertBatch(turso, rows) {
    const placeholders = MGS_COLUMNS.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO products (${MGS_COLUMNS.join(', ')}) VALUES (${placeholders})`;
    const BATCH = 50;
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        try {
            await turso.batch(
                batch.map(row => ({ sql, args: MGS_COLUMNS.map(c => row[c] ?? null) })),
                'write'
            );
        } catch {
            for (const row of batch) {
                try {
                    await turso.execute({ sql, args: MGS_COLUMNS.map(c => row[c] ?? null) });
                } catch (e2) {
                    console.error(`  [スキップ] ${row.product_id}: ${e2.message}`);
                }
            }
        }
    }
}

const ITEMS_PER_PAGE = 120;
const KNOWN_THRESHOLD = 60; // 既知IDがこの数見つかったら終了（半ページ分）

// ============================================================
//  STEP 2: 価格更新（直近 PRICE_REFRESH_PAGES ページ分）
// ============================================================
async function buildPriceMap(pages) {
    const priceMap = new Map();
    for (let p = 1; p <= pages; p++) {
        const url = buildSearchUrl(p, ITEMS_PER_PAGE);
        try {
            const html = await fetchPage(url);
            const { products } = parseSearchPage(html);
            if (products.length === 0) {
                if (p === 1) {
                    // page 1 が空 = ページ取得失敗か想定外レスポンス
                    throw new Error('ページ1の商品取得が0件 (ブロック・メンテ・認証エラーの可能性)');
                }
                break;
            }
            const now = new Date().toISOString();
            for (const product of products) {
                priceMap.set(product.product_id, {
                    list_price:      product.list_price,
                    current_price:   product.current_price,
                    discount_pct:    product.discount_pct,
                    sale_end_date:   product.sale_end_date,
                    price_updated_at: now,
                });
            }
            process.stdout.write(`  価格取得: ${p}/${pages}ページ (${priceMap.size}件)\r`);
            if (p < pages) await politeWait();
        } catch (e) {
            console.warn(`\n  [価格更新] ページ${p}エラー: ${e.message}`);
            if (p === 1) throw e; // page 1 失敗は致命的 → 呼び出し元の catch へ
            break;
        }
    }
    console.log(`\n  価格取得完了: ${priceMap.size.toLocaleString()}件`);
    return priceMap;
}

async function main() {
    // ---- スキーママイグレーション: D1 のスキーマは site/migrations/* で管理（ここでは何もしない）----

    // ---- CI環境: D1から既知IDを取得（ローカルDB代替） ----
    let knownIds   = new Set();
    let tursoShared = null; // CI用に事前作成したD1クライアント

    if (IS_CI) {
        if (!hasD1) {
            console.error('CI環境では CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_D1_TOKEN / D1_MGS_ID が必要です');
            process.exit(1);
        }
        tursoShared = mgsDb();

        // ローカルキャッシュ優先、差分のみTursoから取得
        let cacheUpdatedAt = null;
        if (fs.existsSync(KNOWN_IDS_CACHE)) {
            try {
                const cache = JSON.parse(fs.readFileSync(KNOWN_IDS_CACHE, 'utf-8'));
                (cache.ids || []).forEach(id => knownIds.add(id));
                cacheUpdatedAt = cache.updated_at || null;
                console.log(`[CI] キャッシュ: ${knownIds.size.toLocaleString()}件 (${(cacheUpdatedAt || '').slice(0, 10)})`);
            } catch (e) {
                console.warn('[CI] キャッシュ読み込み失敗 → Tursoから全件取得');
            }
        }
        {
            const sql  = cacheUpdatedAt
                ? 'SELECT product_id FROM products WHERE scraped_at > ?'
                : 'SELECT product_id FROM products ORDER BY scraped_at DESC LIMIT 3000';
            const args = cacheUpdatedAt ? [cacheUpdatedAt] : [];
            const r = await tursoShared.execute({ sql, args });
            let delta = 0;
            r.rows.forEach(row => { if (!knownIds.has(String(row[0]))) { knownIds.add(String(row[0])); delta++; } });
            console.log(`[CI] Turso差分: ${delta}件追加 / 合計: ${knownIds.size.toLocaleString()}件`);
        }
    } else {
        await db.init();
    }

    // ---- 女優インデックス読み込み ----
    const actressIndex = fs.existsSync(ACTRESS_INDEX_FILE)
        ? JSON.parse(fs.readFileSync(ACTRESS_INDEX_FILE, 'utf-8'))
        : {};
    // 今日の出演記録: 女優名 → 品番リスト
    const todayAppearances = new Map(); // name → [product_id, ...]

    console.log('========================================');
    console.log('  MGS動画 フェーズ3: 日次アップデート');
    console.log('========================================\n');

    const statsBefore = IS_CI ? { total: knownIds.size } : db.getStats();
    console.log(`  現在のDB件数: ${statsBefore.total.toLocaleString()}\n`);

    let currentPage = 1;
    let totalNew = 0;
    let totalKnown = 0;
    let consecutiveKnown = 0;
    const startTime = Date.now();
    const newProducts = []; // Turso同期用

    if (NO_PREORDER) {
        console.log('[STEP 1] 新規作品取得: スキップ (--no-preorder)\n');
    }

    try {
      if (!NO_PREORDER) while (true) {
            const url = buildSearchUrl(currentPage, ITEMS_PER_PAGE);
            console.log(`[ページ ${currentPage}] 新着チェック...`);

            const html = await fetchPage(url);
            const { products } = parseSearchPage(html);

            if (products.length === 0) {
                if (currentPage === 1) {
                    // page 1 が空 = ブロック・メンテ・認証エラーの可能性
                    throw new Error('ページ1の商品取得が0件 (ブロック・メンテ・認証エラーの可能性)');
                }
                console.log('  [終了] 商品なし');
                break;
            }

            let pageNew = 0;
            let pageKnown = 0;

            for (const product of products) {
                const exists = IS_CI
                    ? knownIds.has(String(product.product_id))
                    : db.productExists(product.product_id);

                if (exists) {
                    pageKnown++;
                    consecutiveKnown++;
                } else if (/BEST|ベスト|総集編|オムニバス|リマスター/i.test(product.title || '')) {
                    // 総集編系はスキップ
                } else if (BLOCKED_MAKERS.has(product.maker || '')) {
                    // ブロックメーカーはスキップ
                } else {
                    // 新規作品！
                    if (!IS_CI) db.upsertProductFromList(product);
                    knownIds.add(String(product.product_id)); // 重複防止
                    pageNew++;
                    consecutiveKnown = 0;

                    // 新規作品は即座に詳細ページもスクレイピング
                    const now = new Date().toISOString();
                    const productRow = {
                        product_id:         product.product_id,
                        title:              product.title || null,
                        actresses:          product.actresses || null,
                        maker:              null,
                        label:              null,
                        duration_min:       null,
                        genres:             null,
                        sale_start_date:    null,
                        main_image_url:     product.main_image_url || null,
                        sample_images_json: product.sample_images ? JSON.stringify(product.sample_images) : null,
                        sample_video_url:   product.sample_video_url || null,
                        detail_scraped:     0,
                        scraped_at:         now,
                        updated_at:         now,
                        // 一覧ページから取得した価格
                        list_price:         product.list_price ?? null,
                        current_price:      product.current_price ?? null,
                        discount_pct:       product.discount_pct ?? 0,
                        sale_end_date:      product.sale_end_date ?? null,
                        price_updated_at:   now,
                    };
                    try {
                        await politeWait();
                        const detailHtml = await fetchPage(buildDetailUrl(product.product_id));
                        const detail = parseDetailPage(detailHtml);
                        if (!IS_CI) db.updateProductDetail(product.product_id, detail);
                        productRow.maker           = detail.maker || null;
                        productRow.label           = detail.label || null;
                        productRow.duration_min    = detail.duration_min || null;
                        productRow.genres          = detail.genres || null;
                        productRow.sale_start_date = detail.sale_start_date || null;
                        if (detail.actresses)      productRow.actresses = detail.actresses;
                        productRow.detail_scraped  = 1;
                        // 詳細ページの価格で上書き（より正確）
                        if (detail.list_price != null)    productRow.list_price    = detail.list_price;
                        if (detail.current_price != null) productRow.current_price = detail.current_price;
                        if (detail.discount_pct  != null) productRow.discount_pct  = detail.discount_pct;
                        if (detail.sale_end_date)          productRow.sale_end_date  = detail.sale_end_date;
                        // 女優インデックス更新（詳細ページの actress_links を優先）
                        const links = detail.actress_links?.length ? detail.actress_links : (product.actress_links || []);
                        const today = new Date().toISOString().slice(0, 10);
                        for (const { name, mgs_id } of links) {
                            if (!actressIndex[name]) {
                                actressIndex[name] = { mgs_id, mgs_url: `https://www.mgstage.com/search/cSearch.php?type=top&actor[]=${encodeURIComponent(mgs_id)}`, first_seen: today, last_seen: today };
                            } else {
                                actressIndex[name].last_seen = today;
                                if (mgs_id) actressIndex[name].mgs_id = mgs_id;
                            }
                            if (!todayAppearances.has(name)) todayAppearances.set(name, []);
                            todayAppearances.get(name).push(product.product_id);
                        }
                        console.log(`    [新規+詳細] ${product.product_id}: ${detail.maker || '?'} / ${detail.duration_min || '?'}分${detail.discount_pct > 0 ? ` / ${detail.discount_pct}%OFF` : ''}`);
                    } catch (e) {
                        console.log(`    [新規] ${product.product_id} (詳細取得失敗: ${e.message})`);
                    }
                    newProducts.push(productRow);
                }
            }

            totalNew += pageNew;
            totalKnown += pageKnown;

            console.log(`  新規: ${pageNew}件 / 既知: ${pageKnown}件`);

            // 終了条件: 既知IDが十分見つかった（古いデータ領域に入った）
            if (consecutiveKnown >= KNOWN_THRESHOLD) {
                console.log(`\n[完了] ${consecutiveKnown}件連続で既知ID → 差分取得完了`);
                break;
            }

            if (!IS_CI) db.save();
            currentPage++;
            await politeWait();
        }
    } catch (error) {
        console.error(`\n[エラー] ${error.message}`);
        // page 1 取得失敗はCIで致命的 → Discord通知後にexit 1
        if (IS_CI && error.message.includes('ページ1の商品取得が0件')) {
            await sendDiscord([
                `🚨 **MGS動画 日次更新 失敗** (${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })})`,
                `❌ MGSサイトへのアクセス失敗: ${error.message}`,
                'GitHub ActionsのIPがMGSにブロックされている可能性があります。ローカルで手動実行してください: `CI=true node scripts/phase3_daily_update.js`',
            ].join('\n'));
            process.exit(1);
        }
    } finally {
        if (!IS_CI) db.save();

        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        const statsAfter = IS_CI
            ? { total: statsBefore.total + totalNew }
            : db.getStats();

        console.log('\n========================================');
        console.log('  フェーズ3 STEP1 サマリー');
        console.log('========================================');
        console.log(`  新規追加: ${totalNew}件`);
        console.log(`  既知スキップ: ${totalKnown}件`);
        console.log(`  経過時間: ${elapsed}分`);
        console.log(`  DB件数: ${statsBefore.total.toLocaleString()} → ${statsAfter.total.toLocaleString()}`);
        console.log('========================================\n');

        // ---- 女優インデックス保存・レポート ----
        if (todayAppearances.size > 0) {
            if (!IS_CI) {
                fs.writeFileSync(ACTRESS_INDEX_FILE, JSON.stringify(actressIndex, null, 2));
            }
            console.log(`[女優] 今日の新作出演: ${todayAppearances.size}名`);
            for (const [name, products] of [...todayAppearances.entries()].sort((a, b) => b[1].length - a[1].length)) {
                console.log(`  ${name}: ${products.join(', ')}`);
            }
            console.log(`  インデックス累計: ${Object.keys(actressIndex).length.toLocaleString()}名\n`);
        } else {
            console.log('[女優] 今日の新作なし\n');
        }

        // ---- STEP 2: 価格更新 ----
        const effectivePages = PRICE_REFRESH_PAGES_OVERRIDE ?? PRICE_REFRESH_PAGES;
        let priceMap = new Map();
        let saleCount = 0;
        let step2Error = null;
        try {
            console.log(`[STEP 2] 価格更新: 直近${PRICE_SCAN_YEARS}年 / ${effectivePages}ページ (${effectivePages * ITEMS_PER_PAGE}件)`);
            priceMap = await buildPriceMap(effectivePages);
            for (const v of priceMap.values()) {
                if (v.discount_pct > 0) saleCount++;
            }
            console.log(`  セール中: ${saleCount.toLocaleString()}件`);

            if (!IS_CI && priceMap.size > 0) {
                for (const [product_id, price] of priceMap) {
                    db.updateProductPrice(product_id, price);
                }
                db.save();
                console.log(`  ローカルDB 価格更新完了`);
            }
        } catch (e) {
            step2Error = e.message;
            console.warn('[STEP 2] 価格更新エラー:', e.message);
        }

        // ---- D1 同期 ----
        // 30分未満の作品はTursoに登録しない
        const afterDuration = newProducts.filter(p => p.duration_min === null || p.duration_min >= 30);
        const shortSkipped = newProducts.length - afterDuration.length;
        if (shortSkipped > 0) console.log(`[D1] 30分未満スキップ: ${shortSkipped}件`);

        // Best/総集編/オムニバス/リマスターはTursoに登録しない
        const COMPILATION_RE = /BEST|ベスト|総集編|オムニバス|リマスター/i;
        const afterCompilation = afterDuration.filter(p => !COMPILATION_RE.test(p.title || ''));
        const compilationSkipped = afterDuration.length - afterCompilation.length;
        if (compilationSkipped > 0) console.log(`[D1] 総集編系スキップ: ${compilationSkipped}件`);

        // ブロックメーカーはTursoに登録しない
        const filteredNewProducts = afterCompilation.filter(p => !BLOCKED_MAKERS.has(p.maker || ''));
        const makerSkipped = afterCompilation.length - filteredNewProducts.length;
        if (makerSkipped > 0) console.log(`[D1] ブロックメーカースキップ: ${makerSkipped}件`);

        if (filteredNewProducts.length === 0 && priceMap.size === 0) {
            console.log('[D1] 更新なし — スキップ');
        } else if (!hasD1) {
            console.warn('[D1] D1認証情報 未設定 — スキップ');
        } else {
            const turso = tursoShared || mgsDb();
            // FTS は products_au/ai/ad トリガ(WHENガード付き)で自動同期されるため DROP/手動更新は不要。
            // 新規作品 upsert
            if (filteredNewProducts.length > 0) {
                console.log(`[D1] 新規${filteredNewProducts.length}件 同期中...`);
                try {
                    await tursoUpsertBatch(turso, filteredNewProducts);
                    console.log(`[D1] ✅ 新規${filteredNewProducts.length}件 同期完了`);
                    // FTS は INSERT OR REPLACE 時にトリガが自動でメンテナンスする（手動更新不要）
                    // キャッシュ更新（新規IDを追加）
                    try {
                        filteredNewProducts.forEach(p => knownIds.add(String(p.product_id)));
                        fs.writeFileSync(KNOWN_IDS_CACHE, JSON.stringify({ updated_at: new Date().toISOString(), ids: [...knownIds] }));
                    } catch {}
                } catch (e) {
                    console.error('[D1] 新規同期エラー:', e.message);
                }
            }
            // 価格 update（既存作品はUPDATE）
            if (priceMap.size > 0) {
                const updateSql = `UPDATE products SET
                    list_price=?, current_price=?, discount_pct=?, sale_end_date=?, price_updated_at=?, updated_at=?
                    WHERE product_id=?`;
                const entries = Array.from(priceMap.entries());
                const BATCH = 50;
                let tUpdated = 0;
                let firstBatchError = null;
                for (let i = 0; i < entries.length; i += BATCH) {
                    const batch = entries.slice(i, i + BATCH);
                    try {
                        await turso.batch(
                            batch.map(([pid, v]) => ({
                                sql: updateSql,
                                args: [v.list_price ?? null, v.current_price ?? null, v.discount_pct ?? 0, v.sale_end_date ?? null, v.price_updated_at, v.price_updated_at, pid],
                            })),
                            'write'
                        );
                        tUpdated += batch.length;
                    } catch (batchErr) {
                        if (!firstBatchError) {
                            firstBatchError = batchErr.message;
                            console.warn(`\n  [価格batch失敗 offset=${i}] ${batchErr.message}`);
                        }
                        for (const [pid, v] of batch) {
                            try {
                                await turso.execute({ sql: updateSql, args: [v.list_price ?? null, v.current_price ?? null, v.discount_pct ?? 0, v.sale_end_date ?? null, v.price_updated_at, v.price_updated_at, pid] });
                                tUpdated++;
                            } catch (execErr) {
                                if (tUpdated === 0 && i === 0) console.warn(`  [価格exec失敗] ${pid}: ${execErr.message}`);
                            }
                        }
                    }
                    process.stdout.write(`  価格Turso更新: ${tUpdated}/${entries.length}\r`);
                }
                console.log(`\n[D1] ✅ 価格${tUpdated.toLocaleString()}件 更新完了`);
            }
            if (!tursoShared) turso.close();
        }

        // ---- 期限切れセール情報クリア（D1 MGS） ----
        {
            if (hasD1) {
                try {
                    const turso = tursoShared || mgsDb();
                    // JST で比較（sale_end_date は JST 形式 "YYYY/MM/DD HH:MM"）
                    const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 16);
                    // DB側でフィルタ（全件取得→JS側フィルタを廃止し行読み取り削減）
                    // MGSの sale_end_date は "YYYY/MM/DD HH:MM" 形式なのでREPLACEで正規化
                    const expiredRes = await turso.execute({
                        sql: "SELECT product_id FROM products WHERE discount_pct > 0 AND sale_end_date IS NOT NULL AND REPLACE(sale_end_date, '/', '-') <= ? LIMIT 500",
                        args: [nowJST],
                    });
                    const expired = expiredRes.rows;
                    if (expired.length > 0) {
                        for (const row of expired) {
                            await turso.execute({
                                sql: 'UPDATE products SET discount_pct=0, list_price=NULL, current_price=NULL, sale_end_date=NULL WHERE product_id=?',
                                args: [String(row.product_id)],
                            });
                        }
                        // FTS5はprice/discount_pctをインデックスしないためrebuild不要
                        console.log(`[D1] 🧹 期限切れセール ${expired.length}件 クリア`);
                    } else {
                        console.log('[D1] 期限切れセールなし');
                    }
                    if (!tursoShared) turso.close();
                } catch (e) {
                    console.warn('[D1] 期限切れクリアエラー:', e.message);
                }
            }
        }

        if (tursoShared) { tursoShared.close(); tursoShared = null; }
        if (!IS_CI) db.close();

        const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        console.log('\n========================================');
        console.log(`  ✅ 完了 (${now})`);
        if (saleCount > 0) console.log(`  🏷️ セール中: ${saleCount}件`);
        console.log('========================================\n');

        // Discord通知
        const lines = [
            `🎬 **MGS動画 日次更新** (${now})`,
            `新作: **${newProducts.length}件** / 価格取得: **${priceMap.size.toLocaleString()}件**`,
        ];
        if (saleCount > 0) lines.push(`🏷️ セール中: **${saleCount.toLocaleString()}件**`);
        if (newProducts.length === 0) lines.push('ℹ️ 本日の新作なし');
        if (step2Error) lines.push(`⚠️ 価格更新エラー: ${step2Error}`);
        await sendDiscord(lines.join('\n'));
    }
}

main().catch((err) => {
    console.error('致命的エラー:', err);
    if (!IS_CI) db.close();
    process.exit(1);
});
