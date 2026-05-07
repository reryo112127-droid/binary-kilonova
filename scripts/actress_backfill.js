/**
 * 女優名から出演作を検索してTurso DBに追加するスクリプト
 *
 * 使い方:
 *   node scripts/actress_backfill.js --name "田中ねね"         # 特定女優
 *   node scripts/actress_backfill.js --name "田中ねね" --pages 10  # 最大10ページ
 *   node scripts/actress_backfill.js --all                    # インデックス全女優
 *   node scripts/actress_backfill.js --all --limit 50         # 最大50名
 *   node scripts/actress_backfill.js --all --since 2026-04-01 # 指定日以降に確認した女優のみ
 *   node scripts/actress_backfill.js --all --dry-run          # 追加件数確認のみ
 */
const path  = require('path');
const fs    = require('fs');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', 'site', '.env.local') });

const { createClient } = require('@libsql/client');
const { fetchPage, politeWait } = require('../lib/fetcher');
const { parseSearchPage, parseDetailPage } = require('../lib/parser');

// ---- 引数パース ----
const args = process.argv.slice(2);
const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

const TARGET_NAME  = getArg('--name');
const DO_ALL       = hasFlag('--all');
const LIMIT        = getArg('--limit') ? parseInt(getArg('--limit'), 10) : Infinity;
const MAX_PAGES    = getArg('--pages') ? parseInt(getArg('--pages'), 10) : 50;
const SINCE_DATE   = getArg('--since') || null;
const DRY_RUN      = hasFlag('--dry-run');

const ACTRESS_INDEX_FILE = path.join(__dirname, '..', 'data', 'mgs_actress_index.json');
const KNOWN_IDS_CACHE    = path.join(__dirname, '..', 'data', 'known_ids_mgs_cache.json');
const ITEMS_PER_PAGE = 120;
const KNOWN_THRESHOLD = 30; // 女優別スキャンは閾値を低めに

if (!TARGET_NAME && !DO_ALL) {
    console.error('使い方: --name "女優名" または --all を指定してください');
    process.exit(1);
}

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
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        try {
            await turso.batch(
                batch.map(row => ({ sql, args: MGS_COLUMNS.map(c => row[c] ?? null) })),
                'write'
            );
            inserted += batch.length;
        } catch {
            for (const row of batch) {
                try {
                    await turso.execute({ sql, args: MGS_COLUMNS.map(c => row[c] ?? null) });
                    inserted++;
                } catch (e2) {
                    console.error(`  [スキップ] ${row.product_id}: ${e2.message}`);
                }
            }
        }
    }
    return inserted;
}

/**
 * 女優ページURLを構築（ページ番号付き）
 */
function buildActressPageUrl(baseActressUrl, page) {
    // baseActressUrl: https://www.mgstage.com/search/cSearch.php?type=top&actor[]=...
    // sort=new と list_cnt, page を付加
    const url = new URL(baseActressUrl);
    url.searchParams.set('sort', 'new');
    url.searchParams.set('list_cnt', String(ITEMS_PER_PAGE));
    url.searchParams.set('page', String(page));
    return url.toString();
}

/**
 * MGSのキーワード検索URL（インデックスにない女優を名前で直接検索）
 */
function buildKeywordSearchUrl(name, page) {
    return `https://www.mgstage.com/search/cSearch.php?search_word=${encodeURIComponent(name)}&sort=new&list_cnt=${ITEMS_PER_PAGE}&page=${page}`;
}

/**
 * 1人の女優について出演作をスキャンし、未登録作品を返す
 */
async function scanActress(name, searchUrl, knownIds) {
    const newProducts = [];
    let consecutiveKnown = 0;
    let totalScanned = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
        const url = buildActressPageUrl(searchUrl, page);
        let products;
        try {
            const html = await fetchPage(url);
            ({ products } = parseSearchPage(html));
        } catch (e) {
            console.log(`    [エラー] ページ${page}: ${e.message}`);
            break;
        }

        if (products.length === 0) break;
        totalScanned += products.length;

        let pageNew = 0;
        for (const product of products) {
            if (knownIds.has(String(product.product_id))) {
                consecutiveKnown++;
                if (consecutiveKnown >= KNOWN_THRESHOLD) break;
            } else {
                consecutiveKnown = 0;
                pageNew++;

                // 詳細ページ取得
                const now = new Date().toISOString();
                const row = {
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
                    list_price:         product.list_price ?? null,
                    current_price:      product.current_price ?? null,
                    discount_pct:       product.discount_pct ?? 0,
                    sale_end_date:      product.sale_end_date ?? null,
                    price_updated_at:   now,
                };

                if (!DRY_RUN) {
                    try {
                        await politeWait();
                        const detailHtml = await fetchPage(
                            `https://www.mgstage.com/product/product_detail/${product.product_id}/`
                        );
                        const detail = parseDetailPage(detailHtml);
                        row.maker           = detail.maker || null;
                        row.label           = detail.label || null;
                        row.duration_min    = detail.duration_min || null;
                        row.genres          = detail.genres || null;
                        row.sale_start_date = detail.sale_start_date || null;
                        if (detail.actresses) row.actresses = detail.actresses;
                        row.detail_scraped  = 1;
                        if (detail.list_price    != null) row.list_price    = detail.list_price;
                        if (detail.current_price != null) row.current_price = detail.current_price;
                        if (detail.discount_pct  != null) row.discount_pct  = detail.discount_pct;
                        if (detail.sale_end_date)          row.sale_end_date  = detail.sale_end_date;
                    } catch (e) {
                        // 詳細取得失敗はスキップ（作品自体は追加）
                    }
                }

                // 30分未満フィルター
                if (row.duration_min !== null && row.duration_min < 30) {
                    process.stdout.write(`    [スキップ] ${product.product_id} (${row.duration_min}分未満)\n`);
                    knownIds.add(String(product.product_id)); // 重複防止
                    continue;
                }

                knownIds.add(String(product.product_id));
                newProducts.push(row);
                process.stdout.write(`    [新規] ${product.product_id}  ${row.maker || '?'} / ${row.duration_min || '?'}分\n`);
            }
        }

        process.stdout.write(`  page${page}: 新規${pageNew}件 / スキャン${products.length}件\n`);

        if (consecutiveKnown >= KNOWN_THRESHOLD) {
            process.stdout.write(`  [完了] ${consecutiveKnown}連続既知 → スキャン終了\n`);
            break;
        }

        if (page < MAX_PAGES && products.length === ITEMS_PER_PAGE) {
            await politeWait();
        }
    }

    return { newProducts, totalScanned };
}

async function main() {
    const tursoUrl   = process.env.TURSO_MGS_URL;
    const tursoToken = process.env.TURSO_MGS_TOKEN;
    if (!tursoUrl || !tursoToken) {
        console.error('TURSO_MGS_URL / TURSO_MGS_TOKEN が未設定です');
        process.exit(1);
    }

    const turso = createClient({ url: tursoUrl, authToken: tursoToken });

    // ---- 既知ID取得（ローカルキャッシュ優先 + Turso差分） ----
    const knownIds = new Set();
    let cacheUpdatedAt = null;

    if (fs.existsSync(KNOWN_IDS_CACHE)) {
        try {
            const cache = JSON.parse(fs.readFileSync(KNOWN_IDS_CACHE, 'utf-8'));
            (cache.ids || []).forEach(id => knownIds.add(id));
            cacheUpdatedAt = cache.updated_at || null;
            console.log(`ローカルキャッシュ: ${knownIds.size.toLocaleString()}件 (${(cacheUpdatedAt || '').slice(0, 10)})`);
        } catch (e) {
            console.warn('キャッシュ読み込み失敗 → Tursoから全件取得:', e.message);
        }
    }

    {
        const sql  = cacheUpdatedAt
            ? 'SELECT product_id FROM products WHERE scraped_at > ?'
            : 'SELECT product_id FROM products ORDER BY scraped_at DESC LIMIT 5000';
        const args = cacheUpdatedAt ? [cacheUpdatedAt] : [];
        const r = await turso.execute({ sql, args });
        let delta = 0;
        r.rows.forEach(row => { if (!knownIds.has(String(row[0]))) { knownIds.add(String(row[0])); delta++; } });
        console.log(`Turso差分: ${delta}件追加 / 合計既知ID: ${knownIds.size.toLocaleString()}件\n`);
    }

    // キャッシュ保存
    try {
        fs.writeFileSync(KNOWN_IDS_CACHE, JSON.stringify({ updated_at: new Date().toISOString(), ids: [...knownIds] }));
    } catch (e) { console.warn('キャッシュ保存失敗:', e.message); }

    if (DRY_RUN) console.log('=== DRY RUN（追加は行いません）===\n');

    // ---- 女優インデックス読み込み ----
    if (!fs.existsSync(ACTRESS_INDEX_FILE)) {
        console.error(`女優インデックスが見つかりません: ${ACTRESS_INDEX_FILE}`);
        console.error('先に phase3_daily_update.js を実行してください');
        process.exit(1);
    }
    const actressIndex = JSON.parse(fs.readFileSync(ACTRESS_INDEX_FILE, 'utf-8'));

    // ---- 処理対象女優リスト作成 ----
    let targets = [];

    if (TARGET_NAME) {
        // 名前で検索（部分一致対応）
        const exact = actressIndex[TARGET_NAME];
        if (exact) {
            targets = [{ name: TARGET_NAME, ...exact }];
        } else {
            // 部分一致
            const matched = Object.entries(actressIndex)
                .filter(([name]) => name.includes(TARGET_NAME))
                .map(([name, data]) => ({ name, ...data }));
            if (matched.length === 0) {
                // インデックスにない → キーワード検索URLで直接スキャン
                console.log(`「${TARGET_NAME}」はインデックスに未登録 → MGSキーワード検索で直接スキャン`);
                targets = [{
                    name: TARGET_NAME,
                    mgs_url: buildKeywordSearchUrl(TARGET_NAME, 1).replace(/&list_cnt=\d+&page=\d+/, ''),
                    mgs_id: null,
                }];
            } else {
                console.log(`「${TARGET_NAME}」に部分一致する女優: ${matched.length}名`);
                for (const m of matched) console.log(`  ${m.name}`);
                console.log('');
                targets = matched;
            }
        }
    } else if (DO_ALL) {
        // 全女優 — last_seen 降順（最近確認したものから）
        targets = Object.entries(actressIndex)
            .map(([name, data]) => ({ name, ...data }))
            .filter(t => {
                if (SINCE_DATE && t.last_seen < SINCE_DATE) return false;
                return true;
            })
            .sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || ''))
            .slice(0, LIMIT);
        console.log(`処理対象: ${targets.length.toLocaleString()}名`);
        if (SINCE_DATE) console.log(`  (${SINCE_DATE} 以降に確認した女優)`);
        console.log('');
    }

    // ---- スキャン実行 ----
    let totalNew = 0;
    let totalInserted = 0;
    const allInsertedIds = []; // FTS5差分更新用
    const startTime = Date.now();

    for (let i = 0; i < targets.length; i++) {
        const actress = targets[i];
        const progress = targets.length > 1 ? `[${i + 1}/${targets.length}] ` : '';
        console.log(`${progress}${actress.name}  (${actress.mgs_url})`);

        // URLが直接スキャン用かチェック
        const searchBase = actress.mgs_url.includes('actor[]')
            ? actress.mgs_url
            : buildKeywordSearchUrl(actress.name, 1).replace(/&list_cnt=\d+&page=\d+/, '');

        const { newProducts, totalScanned } = await scanActress(
            actress.name,
            searchBase,
            knownIds
        );

        console.log(`  → 新規: ${newProducts.length}件 / スキャン合計: ${totalScanned}件`);
        totalNew += newProducts.length;

        if (!DRY_RUN && newProducts.length > 0) {
            const inserted = await tursoUpsertBatch(turso, newProducts);
            totalInserted += inserted;
            newProducts.forEach(p => allInsertedIds.push(p.product_id));
            console.log(`  → Turso登録: ${inserted}件`);
        }

        if (i < targets.length - 1) {
            await politeWait();
        }
    }

    // ---- FTS5差分更新（全件rebuildの代わりに新規分のみ挿入） ----
    if (!DRY_RUN && allInsertedIds.length > 0) {
        try {
            const CHUNK = 100;
            for (let i = 0; i < allInsertedIds.length; i += CHUNK) {
                const chunk = allInsertedIds.slice(i, i + CHUNK);
                const phs = chunk.map(() => '?').join(',');
                await turso.execute({
                    sql: `INSERT OR IGNORE INTO products_fts(rowid, product_id, title, actresses, genres)
                          SELECT rowid, product_id, title, actresses, genres FROM products
                          WHERE product_id IN (${phs})`,
                    args: chunk,
                });
            }
            console.log(`\nFTS5差分更新完了 (${allInsertedIds.length}件)`);
        } catch (e) {
            console.warn('\nFTS5更新スキップ:', e.message);
        }
    }

    turso.close();

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log('\n========================================');
    console.log('  完了');
    console.log(`  処理女優: ${targets.length}名`);
    console.log(`  新規検出: ${totalNew}件`);
    if (!DRY_RUN) console.log(`  Turso登録: ${totalInserted}件`);
    console.log(`  経過時間: ${elapsed}分`);
    console.log('========================================');
}

main().catch(e => { console.error('致命的エラー:', e); process.exit(1); });
