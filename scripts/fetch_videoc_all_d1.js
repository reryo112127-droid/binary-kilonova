/**
 * FANZA 素人Floor（videoc）全作品を DMM API で月別に全取得し、
 * 未取り込み分を D1(両シャード) + ローカル fanza.db に投入する。
 *  - MGS重複(videoc)は除外（isDuplicate）
 *  - ブロックメーカーは除外
 *  - 既にDBにある品番はスキップ（D1書込予算節約）
 *
 *   node scripts/fetch_videoc_all_d1.js            # 2010-01〜現在を全走査
 *   node scripts/fetch_videoc_all_d1.js --from 2018-01
 *   node scripts/fetch_videoc_all_d1.js --dry-run  # 取得・件数のみ（書込なし）
 * 進捗: data/fanza_videoc_full_progress.json（中断・再開対応）
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { fanzaShards } = require('./lib/d1');
const { isDuplicate } = require('./lib/dedup.cjs');

const DMM_API_ID       = process.env.DMM_API_ID;
const DMM_AFFILIATE_ID = process.env.DMM_AFFILIATE_ID;
const DATA_DIR  = path.join(__dirname, '..', 'data');
const DB_PATH   = path.join(DATA_DIR, 'fanza.db');
const PROGRESS  = path.join(DATA_DIR, 'fanza_videoc_full_progress.json');

const HITS = 100, RATE_MS = 800, START_YM = '2010-01';
const args = process.argv.slice(2);
const DRY  = args.includes('--dry-run');
const FROM = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;

const DEDUP_INDEX = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'videoc_dedup_index.json'), 'utf-8'));
const BLOCKED = new Set(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'blocked_makers.json'), 'utf-8')).makers || []);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();
const ym = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
function nextMonth(s) { const [y, m] = s.split('-').map(Number); return ym(new Date(y, m, 1)); }

function loadProgress() { try { return JSON.parse(fs.readFileSync(PROGRESS, 'utf-8')); } catch { return { completed_months: [], added: 0 }; } }
function saveProgress(p) { fs.writeFileSync(PROGRESS, JSON.stringify(p, null, 2)); }

const LOCAL_COLS = ['product_id','title','actresses','maker','label','duration_min','genres','sale_start_date','main_image_url','sample_images_json','sample_video_url','affiliate_url','detail_url','list_price','current_price','discount_pct','sale_end_date','review_count','review_average','series_id','series_name','vr_flag','floor','price_updated_at','scraped_at','updated_at'];
const D1_COLS    = ['product_id','title','actresses','maker','label','duration_min','genres','sale_start_date','main_image_url','sample_video_url','affiliate_url','list_price','current_price','discount_pct','sale_end_date','series_id','series_name','vr_flag','scraped_at','updated_at','price_updated_at','review_count','review_average','detail_url','floor'];

function parsePrice(item) {
    const ds = item.prices?.deliveries?.delivery || [];
    const t = ds.find(d => d.type === 'download') || ds.find(d => d.type === 'hd') || ds[0];
    if (!t) return { list_price: null, current_price: null, discount_pct: 0, sale_end_date: null };
    const lp = parseInt(String(t.list_price).replace(/[^0-9]/g, '')) || null;
    const cp = parseInt(String(t.price).replace(/[^0-9]/g, '')) || null;
    const dp = (lp && cp && lp > cp) ? Math.round((lp - cp) / lp * 100) : 0;
    return { list_price: lp, current_price: cp, discount_pct: dp, sale_end_date: t.campaign?.date_end || null };
}

function convertItem(item) {
    const sample = [];
    if (item.sampleImageURL) {
        const l = item.sampleImageURL.sample_l?.image || [];
        const s = item.sampleImageURL.sample_s?.image || [];
        sample.push(...(l.length ? l : s));
    }
    let dur = null;
    if (item.volume) { const m = String(item.volume).match(/(\d+)/); if (m) dur = parseInt(m[1], 10); }
    let mv = null;
    if (item.sampleMovieURL) { const x = item.sampleMovieURL; mv = x.size_720_480 || x.size_560_360 || x.size_476_306 || null; }
    let d = item.date || null; if (d) d = d.replace(' 00:00:00', '').trim();
    const pr = parsePrice(item);
    const now = nowISO();
    return {
        product_id: item.content_id, title: item.title || null,
        actresses: item.iteminfo?.actress?.map(a => a.name).join(', ') || null,
        maker: item.iteminfo?.maker?.[0]?.name || null,
        label: item.iteminfo?.label?.[0]?.name || null,
        duration_min: dur,
        genres: item.iteminfo?.genre?.map(g => g.name).join(', ') || null,
        sale_start_date: d,
        main_image_url: item.imageURL?.large || item.imageURL?.list || null,
        sample_images_json: sample.length ? JSON.stringify(sample) : null,
        sample_video_url: mv,
        affiliate_url: item.affiliateURL || null,
        detail_url: item.URL || null,
        ...pr,
        review_count: Number(item.review?.count || 0),
        review_average: Number(item.review?.average || 0),
        series_id: item.iteminfo?.series?.[0]?.id ?? null,
        series_name: item.iteminfo?.series?.[0]?.name ?? null,
        vr_flag: 0,
        floor: 'videoc',
        price_updated_at: now, scraped_at: now, updated_at: now,
    };
}

async function fetchPage(yearMonth, offset) {
    const [y, m] = yearMonth.split('-');
    const last = new Date(Number(y), Number(m), 0).getDate();
    const p = new URLSearchParams({
        api_id: DMM_API_ID, affiliate_id: DMM_AFFILIATE_ID, site: 'FANZA', service: 'digital', floor: 'videoc',
        hits: String(HITS), offset: String(offset), sort: 'date',
        gte_date: `${y}-${m}-01T00:00:00`, lte_date: `${y}-${m}-${String(last).padStart(2, '0')}T23:59:59`, output: 'json',
    });
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const res = await fetch(`https://api.dmm.com/affiliate/v3/ItemList?${p}`);
            const j = await res.json();
            if (j.result?.status !== 200) throw new Error(JSON.stringify(j.result?.errors || j.result).slice(0, 100));
            return { total: j.result.total_count || 0, items: j.result.items || [] };
        } catch (e) { if (attempt === 3) throw e; await sleep(2000 * (attempt + 1)); }
    }
}

async function d1Upsert(fz, rows) {
    const ph = D1_COLS.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO products (${D1_COLS.join(', ')}) VALUES (${ph})`;
    const BATCH = 40;
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH).map(r => ({ sql, args: D1_COLS.map(c => r[c] ?? null) }));
        for (let attempt = 0; attempt < 4; attempt++) {
            try { await fz.batch(batch, 'write'); break; }
            catch (e) {
                if (/429|CPU/.test(e.message) && attempt < 3) { await sleep(5000 * (attempt + 1)); continue; }
                // 最終手段: 1件ずつ
                for (const st of batch) { try { await fz.execute(st); } catch (e2) { console.error('  skip', st.args[0], e2.message); } }
                break;
            }
        }
    }
}

(async () => {
    if (!DMM_API_ID || !DMM_AFFILIATE_ID) { console.error('DMM APIキー未設定'); process.exit(1); }
    console.log('FANZA videoc 全件取得 → D1 + ローカル', DRY ? '[DRY RUN]' : '');

    // 既存品番（ローカルから全件ロード）
    const localDb = new Database(DB_PATH);
    const existing = new Set(localDb.prepare('SELECT product_id FROM products').all().map(r => String(r.product_id)));
    console.log('既存品番:', existing.size.toLocaleString());
    const localStmt = localDb.prepare(`INSERT OR REPLACE INTO products (${LOCAL_COLS.join(', ')}) VALUES (${LOCAL_COLS.map(c => '@' + c).join(', ')})`);
    const localInsertMany = localDb.transaction(rs => { for (const r of rs) localStmt.run(r); });

    const fz = fanzaShards();
    const prog = loadProgress();
    const done = new Set(prog.completed_months);

    const cur = ym(new Date());
    let m = FROM || START_YM;
    let totalAdded = 0, totalSkipDup = 0, totalSkipBlock = 0, totalExist = 0;

    while (m <= cur) {
        if (done.has(m)) { m = nextMonth(m); continue; }
        // 1ページ目で総数確認
        let first;
        try { first = await fetchPage(m, 1); } catch (e) { console.error(`[${m}] 取得失敗:`, e.message); await sleep(3000); continue; }
        const total = first.total;
        const pages = Math.min(Math.ceil(total / HITS), 500); // DMM offset上限対策
        const monthRows = [];
        const collect = items => {
            for (const it of items) {
                const row = convertItem(it);
                if (!row.product_id) continue;
                if (existing.has(row.product_id)) { totalExist++; continue; }
                if (BLOCKED.has(row.maker || '')) { totalSkipBlock++; continue; }
                if (isDuplicate(row.product_id, row.title, DEDUP_INDEX)) { totalSkipDup++; continue; }
                existing.add(row.product_id);
                monthRows.push(row);
            }
        };
        collect(first.items);
        for (let pg = 2; pg <= pages; pg++) {
            await sleep(RATE_MS);
            try { const r = await fetchPage(m, (pg - 1) * HITS + 1); collect(r.items); } catch (e) { console.error(`[${m} p${pg}]`, e.message); }
        }

        if (monthRows.length && !DRY) {
            localInsertMany(monthRows);
            await d1Upsert(fz, monthRows);
        }
        totalAdded += monthRows.length;
        prog.completed_months.push(m); prog.added = totalAdded;
        if (!DRY) saveProgress(prog);
        console.log(`[${m}] FANZA総${total} → 新規${monthRows.length} (累計+${totalAdded} / 既存${totalExist} 重複${totalSkipDup} ブロック${totalSkipBlock})`);
        await sleep(RATE_MS);
        m = nextMonth(m);
    }
    localDb.close();
    console.log(`\n✅ 完了: 新規追加 ${totalAdded.toLocaleString()}件 / 既存${totalExist} 重複除外${totalSkipDup} ブロック除外${totalSkipBlock}`);
    console.log('次: キャッシュ再生成 → R2投入 → デプロイ');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
