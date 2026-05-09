/**
 * fanza_series_vr_backfill.js
 *
 * 既存の全作品（約22万件）に対して series_id / series_name / vr_flag を backfill する。
 *
 * 処理:
 *   1. まず titles から vr_flag を即時 UPDATE（SQLのみ、高速）
 *   2. FANZA API を月別に叩き直し series_id / series_name を取得して UPDATE
 *
 * 使い方:
 *   node scripts/fanza_series_vr_backfill.js            # 全期間
 *   node scripts/fanza_series_vr_backfill.js --vr-only  # VRフラグのみ（API不要）
 *   node scripts/fanza_series_vr_backfill.js --from 2023-01  # 指定月から再開
 */

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DMM_API_ID       = process.env.DMM_API_ID;
const DMM_AFFILIATE_ID = 'desireav-990';

const DATA_DIR    = path.join(__dirname, '..', 'data');
const CKPT_FILE   = path.join(DATA_DIR, 'series_backfill_checkpoint.json');
const RATE_MS     = 2000;
const HITS        = 100;
const START_YM    = '2010-01';
const END_YM      = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; })();

const args    = process.argv.slice(2);
const VR_ONLY = args.includes('--vr-only');
const fromIdx = args.indexOf('--from');
const FROM_YM = fromIdx !== -1 ? args[fromIdx + 1] : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Turso クライアント
function turso() {
    return createClient({ url: process.env.TURSO_FANZA_URL, authToken: process.env.TURSO_FANZA_TOKEN });
}

// 月リスト生成
function allMonths(start, end) {
    const months = [];
    let [y, m] = start.split('-').map(Number);
    const [ey, em] = end.split('-').map(Number);
    while (y < ey || (y === ey && m <= em)) {
        months.push(`${y}-${String(m).padStart(2,'0')}`);
        if (++m > 12) { m = 1; y++; }
    }
    return months;
}

// ========== STEP 1: VRフラグ即時 UPDATE ==========
async function backfillVrFlag(db) {
    console.log('\n[STEP 1] VRフラグ backfill (タイトルパターン)...');
    const res = await db.execute(
        "UPDATE products SET vr_flag = 1 WHERE (title LIKE '%【VR】%' OR title LIKE '%[VR]%') AND (vr_flag IS NULL OR vr_flag = 0)"
    );
    console.log(`  VRフラグ更新: ${res.rowsAffected}件`);
}

// ========== STEP 2: 月別API取得でシリーズを UPDATE ==========
async function fetchMonth(ym) {
    const [y, m] = ym.split('-');
    const lastDay = new Date(Number(y), Number(m), 0).getDate();
    const gteDate = `${y}-${m}-01T00:00:00`;
    const lteDate = `${y}-${m}-${String(lastDay).padStart(2,'0')}T23:59:59`;

    const results = [];
    let offset = 1;
    while (true) {
        const params = new URLSearchParams({
            api_id:       DMM_API_ID,
            affiliate_id: DMM_AFFILIATE_ID,
            site:         'FANZA',
            service:      'digital',
            floor:        'videoa',
            hits:         HITS.toString(),
            offset:       offset.toString(),
            sort:         'date',
            gte_date:     gteDate,
            lte_date:     lteDate,
            output:       'json',
        });
        let res = await fetch(`https://api.dmm.com/affiliate/v3/ItemList?${params}`, {
            signal: AbortSignal.timeout(15_000),
        });
        // レートリミット時は5秒待ってリトライ
        if (res.status === 400 || res.status === 429) {
            await sleep(5000);
            res = await fetch(`https://api.dmm.com/affiliate/v3/ItemList?${params}`, {
                signal: AbortSignal.timeout(15_000),
            });
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
        const data = await res.json();
        const items = data.result?.items || [];
        if (items.length === 0) break;

        for (const item of items) {
            const seriesId   = item.iteminfo?.series?.[0]?.id   ? String(item.iteminfo.series[0].id) : null;
            const seriesName = item.iteminfo?.series?.[0]?.name || null;
            const vrFlag     = (item.title || '').includes('【VR】') ||
                               (item.prices?.deliveries?.delivery || []).some(d => d.type === '8k') ? 1 : 0;
            if (seriesId || seriesName || vrFlag) {
                results.push({ product_id: item.content_id, series_id: seriesId, series_name: seriesName, vr_flag: vrFlag });
            }
        }

        await sleep(RATE_MS);
        if (items.length < HITS) break;
        offset += HITS;
    }
    return results;
}

async function backfillSeries(db) {
    console.log('\n[STEP 2] シリーズ backfill (API月別取得)...');

    const ckpt = fs.existsSync(CKPT_FILE) ? JSON.parse(fs.readFileSync(CKPT_FILE, 'utf-8')) : { completedMonths: [] };
    const completed = new Set(ckpt.completedMonths);

    let months = allMonths(START_YM, END_YM);
    if (FROM_YM) {
        const idx = months.indexOf(FROM_YM);
        if (idx >= 0) months = months.slice(idx);
    }
    const pending = months.filter(m => !completed.has(m));
    console.log(`  対象: ${pending.length}ヶ月 (完了済み: ${completed.size}ヶ月)`);

    let totalUpdated = 0;

    for (let i = 0; i < pending.length; i++) {
        const ym = pending[i];
        process.stdout.write(`[${i+1}/${pending.length}] ${ym} ... `);

        try {
            const rows = await fetchMonth(ym);
            process.stdout.write(`${rows.length}件取得 → `);

            // Turso に BATCH UPDATE
            if (rows.length > 0) {
                const BATCH = 50;
                let updated = 0;
                for (let j = 0; j < rows.length; j += BATCH) {
                    const chunk = rows.slice(j, j + BATCH);
                    await db.batch(chunk.map(r => ({
                        sql: 'UPDATE products SET series_id=?, series_name=?, vr_flag=? WHERE product_id=?',
                        args: [r.series_id, r.series_name, r.vr_flag, r.product_id],
                    })));
                    updated += chunk.length;
                }
                totalUpdated += updated;
                process.stdout.write(`DB更新${updated}件\n`);
            } else {
                process.stdout.write(`スキップ\n`);
            }

            completed.add(ym);
            ckpt.completedMonths = [...completed];
            fs.writeFileSync(CKPT_FILE, JSON.stringify(ckpt, null, 2));
        } catch (e) {
            process.stdout.write(`エラー: ${e.message}\n`);
        }

        await sleep(RATE_MS);
    }

    console.log(`\n  シリーズ backfill 完了: 合計更新 ${totalUpdated.toLocaleString()}件`);
}

// ========== メイン ==========
async function main() {
    console.log('========================================');
    console.log('  FANZA シリーズ/VRフラグ Backfill');
    console.log('========================================');

    const db = turso();

    // カラム追加（冪等）
    try { await db.execute('ALTER TABLE products ADD COLUMN series_id TEXT'); } catch {}
    try { await db.execute('ALTER TABLE products ADD COLUMN series_name TEXT'); } catch {}
    try { await db.execute('ALTER TABLE products ADD COLUMN vr_flag INTEGER DEFAULT 0'); } catch {}
    try { await db.execute('CREATE INDEX IF NOT EXISTS idx_series ON products(series_name)'); } catch {}
    try { await db.execute('CREATE INDEX IF NOT EXISTS idx_vr ON products(vr_flag)'); } catch {}

    // STEP 1: VRフラグ即時
    await backfillVrFlag(db);

    if (!VR_ONLY) {
        // STEP 2: シリーズ（API）
        await backfillSeries(db);
    }

    db.close();
    console.log('\n✅ 完了');
}

main().catch(e => { console.error(e); process.exit(1); });
