/**
 * 週次静的キャッシュ生成スクリプト（低頻度更新データ）
 * 使い方: node scripts/generate-weekly-cache.mjs
 *
 * 生成ファイル:
 *   data/sitemap_cache.json   - サイトマップ用URL一覧（全作品ID＋写真あり全女優名。IDのみ ~8MB）
 *   data/makers_cache.json    - メーカー一覧（300件）
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { d1, fanzaShards } from '../../scripts/lib/d1.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function loadEnv() {
    const envPath = path.join(ROOT, '.env.local');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
}

loadEnv();

if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_D1_TOKEN
    || !process.env.D1_MGS_ID || !process.env.D1_FANZA_0_ID) {
    console.error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_D1_TOKEN / D1_MGS_ID / D1_FANZA_ID が未設定です');
    process.exit(1);
}

const mgs   = d1('mgs');
const fanza = fanzaShards();

function poster(url) {
    if (!url) return '';
    if (url.includes('pb_e_')) return url.replace('pb_e_', 'pf_e_');
    if (url.includes('/digital/amateur/') && url.endsWith('jm.jpg')) return url.replace('jm.jpg', 'jp-001.jpg');
    return url;
}

// 任意クライアントの baseSql を LIMIT/OFFSET でページングして全行取得。
// fanzaShards.execute は OFFSET がシャード毎に効くため、呼び出し側で .shards を個別に渡すこと。
async function fetchAllPaged(client, baseSql, PAGE = 25000) {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
        const r = await client.execute({ sql: `${baseSql} LIMIT ${PAGE} OFFSET ${offset}` }).catch(() => ({ rows: [] }));
        const rows = r.rows || [];
        out.push(...rows);
        if (rows.length < PAGE) break;
    }
    return out;
}

// ── サイトマップ用URLキャッシュ ────────────────────────────────────
// 全作品ID＋全(写真あり)女優名を申告対象に。IDのみなので ~8MB で 25MiB/ファイル上限内。
// app/sitemap.xml/route.ts がこのキャッシュを 45k/チャンクに分割して出力する。
async function genSitemapCache() {
    console.log('[サイトマップキャッシュ] 取得中...');
    // ── クロール量(=Cloudflare Workers起動数, 無料10万/日)を売れ筋に集中させて無料枠内に収める。
    //    索引対象 = 「18メーカー」＋「人気作(MGS wish_count>=500 / FANZA review_count>=10)」。
    //    FANZAメーカーは長年の大量カタログ(56k)があるため新着3年に絞る。女優はこの作品群から導出。
    //    ※ この定義は product/[id] の noindex 判定(sitemap_cache.products に無い=noindex)と一致させること。
    const HOME_MAKERS = ['エスワン', 'ムーディーズ', 'アイデアポケット', 'OPPAI', 'E-BODY', 'Fitch',
        'マドンナ', '本中', 'ダスッ', 'kawaii', 'Hunter', 'ワンズファクトリー',
        'SODクリエイト', 'FALENO', 'TAMEIKE', 'million', 'プレミアム', 'DAHLIA'];
    const makerLit = HOME_MAKERS.map(m => `(maker LIKE '%${m}%' OR label LIKE '%${m}%')`).join(' OR ');
    const d3 = new Date(); d3.setFullYear(d3.getFullYear() - 3);
    const date3 = d3.toISOString().slice(0, 10);
    const NP = '(duration_min IS NULL OR duration_min != 1)';

    const seen = new Set();
    const products = [];
    const lastmods = [];   // products と同じ並び。子サイトマップの <lastmod> に使う
    const names = new Set();
    // 女優名のクリーニング(actressTags/actressFilter と同方針): 1文字超・30文字以下・年齢/括弧/プレースホルダを除外
    const cleanName = (s) => !!s && s.length > 1 && s.length <= 30 && !/\d+歳|[（()【】\[\]]/.test(s) && s !== '----';
    // 発売日を <lastmod> に使う(内容が変わらないURLの再クロールをGoogleが間引く=Worker起動の節約)。
    // 未来日(予約作品)は「まだ更新されていない」ことにならないよう今日でクランプする。
    const today = new Date().toISOString().slice(0, 10);
    const toLastmod = (v) => {
        const d = String(v ?? '').replace(/\//g, '-').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
        return d > today ? today : d;
    };
    const ingest = (rows) => {
        for (const r of rows) {
            const p = String(r.product_id);
            if (p && !seen.has(p)) { seen.add(p); products.push(p); lastmods.push(toLastmod(r.sale_start_date)); }
            if (r.actresses) for (const n of String(r.actresses).split(/[,、/／]+/)) { const t = n.trim(); if (cleanName(t)) names.add(t); }
        }
    };
    // MGS: 18メーカー OR wish_count>=500
    ingest(await fetchAllPaged(mgs, `SELECT product_id, actresses, sale_start_date FROM products WHERE ${NP} AND ((${makerLit}) OR wish_count >= 500) ORDER BY wish_count DESC`));
    // FANZA: (18メーカー かつ 直近3年) OR review_count>=10（各シャード個別）
    const fanzaSql = `SELECT product_id, actresses, sale_start_date FROM products WHERE ${NP} AND (((${makerLit}) AND SUBSTR(sale_start_date,1,10) >= '${date3}') OR COALESCE(review_count,0) >= 10) ORDER BY SUBSTR(sale_start_date,1,10) DESC`;
    for (const shard of fanza.shards) ingest(await fetchAllPaged(shard, fanzaSql));

    // 実在女優ホワイトリスト(lib/actressFilter.ts と同じ data/actress_whitelist.json)で絞り、
    // タイトル断片/役名/通称(「20時間戦う女」「@なつ」等)の混入＝薄いゴミページを排除する。
    // URLは products に実在する文字列のまま出す(actress ページがその文字列で作品を引けるため)。
    const norm = (s) => String(s || '').trim().replace(/\s+/g, '');
    let whitelist = new Set();
    try {
        const wl = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'actress_whitelist.json'), 'utf-8'));
        whitelist = new Set(wl.map(norm));
    } catch (e) { console.warn('  ⚠ actress_whitelist.json 読込失敗(全女優を採用):', e.message); }
    const actresses = (whitelist.size
        ? [...names].filter(n => whitelist.has(norm(n)))
        : [...names]).sort();

    console.log(`  作品 ${products.length}件 / 女優 ${actresses.length}件(導出${names.size}→WL照合)`);
    return { actresses, products, lastmods };
}

// ── メーカー一覧（floor付き） ──────────────────────────────────────
async function genMakersList() {
    console.log('[メーカー一覧] 取得中...');
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT maker, COUNT(*) as cnt, MAX(main_image_url) as sample_image
                  FROM products WHERE maker IS NOT NULL AND LENGTH(TRIM(maker)) > 1
                    AND (duration_min IS NULL OR duration_min < 600)
                  GROUP BY maker HAVING cnt >= 3 ORDER BY cnt DESC LIMIT 600`,
            args: [],
        }).then(r => r.rows).catch(() => []),
        // MAX(main_image_url) を除去: カバリングインデックス(maker,floor)で高速化
        // sample_imageはmaker一覧カードで未使用のため省略
        fanza.execute({
            sql: `SELECT maker, COUNT(*) as cnt,
                         SUM(CASE WHEN floor = 'videoc' THEN 1 ELSE 0 END) as videoc_cnt
                  FROM products WHERE maker IS NOT NULL AND LENGTH(TRIM(maker)) > 1
                  GROUP BY maker HAVING cnt >= 3 ORDER BY cnt DESC LIMIT 600`,
            args: [],
        }).then(r => r.rows).catch((e) => { console.error('[FANZA maker query error]', e.message); return []; }),
    ]);

    const map = new Map();
    for (const row of mgsRows) {
        const name = String(row.maker ?? '').trim();
        if (!name) continue;
        map.set(name, { name, count: Number(row.cnt ?? 0), sample_image: poster(String(row.sample_image ?? '')), sources: ['mgs'], floor: 'videoa' });
    }
    for (const row of fanzaRows) {
        const name = String(row.maker ?? '').trim();
        if (!name) continue;
        const cnt = Number(row.cnt ?? 0);
        const videocCnt = Number(row.videoc_cnt ?? 0);
        const floor = videocCnt > cnt / 2 ? 'videoc' : 'videoa';
        const e = map.get(name);
        if (e) { e.count += cnt; e.sources.push('fanza'); if (floor === 'videoc') e.floor = 'videoc'; }
        else map.set(name, { name, count: cnt, sample_image: poster(String(row.sample_image ?? '')), sources: ['fanza'], floor });
    }

    // MGSソース限定メーカーを件数上位300件 + MGS専用全件で構成
    const all = Array.from(map.values()).sort((a, b) => b.count - a.count);
    const top300 = all.slice(0, 300);
    const top300Names = new Set(top300.map(m => m.name));
    // MGS専用で上位300に入らなかったものを追加（cnt>=3保証済み）
    const mgsOnly = all.filter(m => m.sources.length === 1 && m.sources[0] === 'mgs' && !top300Names.has(m.name));
    const makerList = [...top300, ...mgsOnly].sort((a, b) => b.count - a.count);

    // ── レーベル(label)追加: メーカー一覧に無いブランドを補完 ──
    console.log('[メーカー一覧] レーベル取得中...');
    const existingNames = new Set(makerList.map(m => m.name));
    const [mgsLabels, fanzaLabels] = await Promise.all([
        mgs.execute({
            sql: `SELECT label, COUNT(*) as cnt FROM products
                  WHERE label IS NOT NULL AND LENGTH(TRIM(label)) > 1 AND label != '----'
                    AND (duration_min IS NULL OR duration_min < 600)
                  GROUP BY label HAVING cnt >= 3 ORDER BY cnt DESC LIMIT 1500`,
            args: [],
        }).then(r => r.rows).catch(() => []),
        fanza.execute({
            sql: `SELECT label, COUNT(*) as cnt,
                         SUM(CASE WHEN floor = 'videoc' THEN 1 ELSE 0 END) as videoc_cnt
                  FROM products
                  WHERE label IS NOT NULL AND LENGTH(TRIM(label)) > 1 AND label != '----'
                  GROUP BY label HAVING cnt >= 3 ORDER BY cnt DESC LIMIT 4000`,
            args: [],
        }).then(r => r.rows).catch((e) => { console.error('[FANZA label query error]', e.message); return []; }),
    ]);

    const labelMap = new Map();
    for (const row of mgsLabels) {
        const name = String(row.label ?? '').trim();
        if (!name || existingNames.has(name)) continue;
        const e = labelMap.get(name);
        if (e) { e.count += Number(row.cnt ?? 0); }
        else labelMap.set(name, { name, count: Number(row.cnt ?? 0), sample_image: '', sources: ['mgs'], floor: 'videoa', is_label: true });
    }
    for (const row of fanzaLabels) {
        const name = String(row.label ?? '').trim();
        if (!name || existingNames.has(name)) continue;
        const cnt = Number(row.cnt ?? 0);
        const floor = Number(row.videoc_cnt ?? 0) > cnt / 2 ? 'videoc' : 'videoa';
        const e = labelMap.get(name);
        if (e) { e.count += cnt; if (!e.sources.includes('fanza')) e.sources.push('fanza'); if (floor === 'videoc') e.floor = 'videoc'; }
        else labelMap.set(name, { name, count: cnt, sample_image: '', sources: ['fanza'], floor, is_label: true });
    }

    const labelList = Array.from(labelMap.values()).sort((a, b) => b.count - a.count);
    console.log(`[メーカー一覧] メーカー ${makerList.length}件 + レーベル ${labelList.length}件`);
    return [...makerList, ...labelList].sort((a, b) => b.count - a.count);
}

// ── ジャンル一覧（LP/サイトマップ用） ───────────────────────────
// genres_cache.json: [{name,count}] 作品100件以上のジャンルのみ(薄いLPを避ける)
async function genGenresCache() {
    console.log('[ジャンル一覧] 取得中...');
    const counts = new Map();
    // 検索需要の無い技術/フォーマット/販売形態タグはLP化しない(薄い・無価値ページ回避)
    const BLOCK = new Set([
        'ハイビジョン', 'フルハイビジョン(FHD)', '4K', '8K', '独占配信', '配信専用', 'デジモ',
        'アウトレット', '数量限定', 'セット商品', 'ダウンロード版限定', 'DMM限定', 'FANZA限定',
        '4時間以上作品', '16時間以上作品', '20時間以上作品', 'ベスト・総集編', '昔の作品',
    ]);
    const bad = (g) => !g || g.length < 2 || g.length > 20 || /\d{4}年|\d+歳|[【】\[\]]/.test(g) || g === '----' || BLOCK.has(g);
    const accumulate = (rows) => {
        for (const r of rows) {
            const cnt = Number(r.cnt || 0);
            for (const g of String(r.genres || '').split(/[,、]+/)) { const t = g.trim(); if (!bad(t)) counts.set(t, (counts.get(t) || 0) + cnt); }
        }
    };
    const SQL = `SELECT genres, COUNT(*) cnt FROM products WHERE genres IS NOT NULL AND genres != '' AND (duration_min IS NULL OR duration_min != 1) GROUP BY genres ORDER BY genres`;
    accumulate(await fetchAllPaged(mgs, SQL));
    for (const shard of fanza.shards) accumulate(await fetchAllPaged(shard, SQL));
    const list = [...counts.entries()].filter(([, c]) => c >= 100).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    console.log(`  ジャンル ${list.length}件(count>=100)`);
    return list;
}

// ── シリーズ一覧（LP/サイトマップ用） ───────────────────────────
// series_cache.json: [{name,count}] FANZA series_name、作品5件以上
async function genSeriesCache() {
    console.log('[シリーズ一覧] 取得中...');
    const counts = new Map();
    // HAVING はシャード跨ぎで漏れるため付けず、マージ後に >=5 で絞る
    const SQL = `SELECT series_name, COUNT(*) cnt FROM products WHERE series_name IS NOT NULL AND series_name != '' AND series_name != '----' GROUP BY series_name ORDER BY series_name`;
    for (const shard of fanza.shards) {
        for (const r of await fetchAllPaged(shard, SQL)) {
            const n = String(r.series_name || '').trim();
            if (n && n.length <= 40) counts.set(n, (counts.get(n) || 0) + Number(r.cnt || 0));
        }
    }
    const list = [...counts.entries()].filter(([, c]) => c >= 5).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    console.log(`  シリーズ ${list.length}件(count>=5)`);
    return list;
}

// ── 女優表示用フルプロフィールキャッシュ ─────────────────────────
// actress_display_cache.json: 女優APIのTursoクエリをゼロにするための静的JSON
async function genActressDisplayCache() {
    console.log('[女優表示キャッシュ] 取得中...');
    const rows = await fanza.execute(
        `SELECT name, fanza_id, ruby, height, bust, waist, hip, cup,
                birthday, blood_type, hobby, prefectures,
                image_url, twitter, instagram, tiktok,
                aliases, avwiki_url, agency_url, agency_source,
                augmented, retired
         FROM actress_profiles
         ORDER BY name`
    ).then(r => r.rows).catch(() => []);

    // Record<name, profile> 形式で返す（O(1)ルックアップ用）
    const map = {};
    for (const row of rows) {
        const name = String(row.name ?? '').trim();
        if (!name) continue;
        let aliases = [];
        try { aliases = row.aliases ? JSON.parse(String(row.aliases)) : []; } catch { /* ignore */ }
        map[name] = {
            name,
            fanza_id:     row.fanza_id   ?? null,
            ruby:         row.ruby       ?? null,
            height:       row.height     ?? null,
            bust:         row.bust       ?? null,
            waist:        row.waist      ?? null,
            hip:          row.hip        ?? null,
            cup:          row.cup        ?? null,
            birthday:     row.birthday   ?? null,
            blood_type:   row.blood_type ?? null,
            hobby:        row.hobby      ?? null,
            prefectures:  row.prefectures ?? null,
            image_url:    row.image_url  ?? null,
            twitter:      row.twitter    ?? null,
            instagram:    row.instagram  ?? null,
            tiktok:       row.tiktok     ?? null,
            aliases,
            avwiki_url:   row.avwiki_url  ?? null,
            agency_url:   row.agency_url  ?? null,
            agency_source:row.agency_source ?? null,
            augmented:    row.augmented === 1,
            retired:      row.retired === 1,
        };
    }
    return map;
}

// D1 の actress_profiles は移行時にほぼ空のまま(2026-08 時点で190行)。上の genActressDisplayCache を
// そのまま採用すると、60,103人ぶんの表示キャッシュ＋64シャードを190人で上書きして本番へデプロイし、
// 女優ページのプロフィール・別名解決が毎週日曜に壊れる(翌日のPC日次デプロイで復旧)。
// リポジトリにコミット済みのコピーの方が厚ければ、そちらを採用する。
function keepRicherActressCache(fresh) {
    const freshCount = Object.keys(fresh || {}).length;
    for (const p of [path.join(ROOT, 'public', 'data', 'actress_display_cache.json'),
                     path.join(ROOT, 'data', 'actress_display_cache.json')]) {
        try {
            if (!fs.existsSync(p)) continue;
            const existing = JSON.parse(fs.readFileSync(p, 'utf-8'));
            const existingCount = Object.keys(existing || {}).length;
            if (existingCount > freshCount) {
                console.warn(`⚠ 女優表示キャッシュ: D1から${freshCount}人しか取れないため既存の${existingCount}人を維持 (${path.basename(path.dirname(p))}/)`);
                return existing;
            }
        } catch { /* 壊れたコピーは無視して次を見る */ }
    }
    return fresh;
}

// 女優別商品リスト共通処理: 重複除去・BEST除外・新着順ソート・最小フィールド化
// 検索カード(search.html/search-other.html)が使うフィールドのみ残してサイズ削減
const BEST_RE = /BEST|ベスト|総集編|コレクション|best/i;
function mergeBestExcludeSort(mgsRows, fanzaRows, limit) {
    const seen = new Set();
    return [...mgsRows, ...fanzaRows].filter(r => {
        const pid = String(r.product_id);
        if (seen.has(pid)) return false;
        seen.add(pid);
        if (BEST_RE.test(String(r.title ?? ''))) return false; // BEST/総集編除外
        return true;
    }).sort((a, b) => {
        const da = String(a.sale_start_date ?? '').replace(/\//g, '-').slice(0, 10);
        const db = String(b.sale_start_date ?? '').replace(/\//g, '-').slice(0, 10);
        return db.localeCompare(da);
    }).slice(0, limit).map(r => ({
        product_id:     r.product_id,
        title:          r.title,
        actresses:      r.actresses,
        main_image_url: r.main_image_url,
        genres:         r.genres,
        maker:          r.maker,
        source:         r.source,
    }));
}

// ── 人気女優 上位200人の商品リスト静的JSON ─────────────────────────
// actress_top_products.json: 女優検索ページのTursoクエリを完全ゼロに
async function genTopActressProducts() {
    console.log('[人気女優商品リスト] 取得中...');

    // MGSのwish_count上位から女優名を抽出（上位200人）
    const mgsActressRows = await mgs.execute({
        sql: `SELECT actresses, SUM(wish_count) as total_wish
              FROM products
              WHERE actresses IS NOT NULL AND actresses != '' AND actresses != '----'
                AND (duration_min IS NULL OR duration_min < 600)
              GROUP BY actresses
              ORDER BY total_wish DESC
              LIMIT 1000`,
        args: [],
    }).then(r => r.rows).catch(() => []);

    // 女優名ごとに集計（カンマ区切りを展開）
    const actressWish = new Map();
    for (const row of mgsActressRows) {
        const names = String(row.actresses ?? '').split(/,|、/).map(s => s.trim()).filter(s => s && s !== '----');
        const w = Number(row.total_wish ?? 0);
        for (const n of names) {
            actressWish.set(n, (actressWish.get(n) || 0) + w);
        }
    }
    const top200 = [...actressWish.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 200)
        .map(([name]) => name);

    console.log(`  上位200女優を特定 (サンプル: ${top200.slice(0,5).join(', ')})`);

    // 各女優の商品を取得（検索カードに必要な最小フィールドのみ）
    const SQL = `SELECT product_id, title, actresses, main_image_url, genres, maker, sale_start_date`;

    const result = {};
    const BATCH = 20; // 同時リクエスト数を制限

    for (let i = 0; i < top200.length; i += BATCH) {
        const batch = top200.slice(i, i + BATCH);
        await Promise.all(batch.map(async (actressName) => {
            const escaped = actressName.replace(/"/g, '""');
            const ftsMatch = `actresses : "${escaped}"`;
            const [mgsRows, fanzaRows] = await Promise.all([
                mgs.execute({
                    sql: `${SQL}
                          FROM products
                          WHERE product_id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?)
                            AND (duration_min IS NULL OR duration_min < 600)
                          ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT 30`,
                    args: [ftsMatch],
                }).then(r => r.rows.map(row => ({ ...row, source: 'mgs' }))).catch(() => []),
                fanza.execute({
                    sql: `${SQL}
                          FROM products
                          WHERE product_id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?)
                          ORDER BY sale_start_date DESC LIMIT 30`,
                    args: [ftsMatch],
                }).then(r => r.rows.map(row => ({ ...row, source: 'fanza' }))).catch(() => []),
            ]);

            const combined = mergeBestExcludeSort(mgsRows, fanzaRows, 21); // 21件: 20表示+1
            if (combined.length > 0) result[actressName] = combined;
        }));
        if (i + BATCH < top200.length) await new Promise(r => setTimeout(r, 100));
    }

    return result;
}

// ── 拡張女優商品リスト（20作品以上 ＋ ホームメーカー出演者）────────
// actress_extended_products.json
async function genExtendedActressProducts(existingNames) {
    console.log('[拡張女優商品リスト] 対象女優を特定中...');

    // ホームメーカー条件（SALE_MAKERS_FANZAと同一）
    const HOME_MAKER_SQL = `(
        maker LIKE '%エスワン%' OR label LIKE '%エスワン%' OR
        maker = 'ムーディーズ' OR label = 'ムーディーズ' OR
        maker = 'アイデアポケット' OR label = 'アイデアポケット' OR
        maker = 'OPPAI' OR label = 'OPPAI' OR
        maker = 'E-BODY' OR label = 'E-BODY' OR
        maker = 'Fitch' OR label = 'Fitch' OR
        maker = 'マドンナ' OR label = 'マドンナ' OR
        maker = '本中' OR label = '本中' OR
        maker LIKE '%ダスッ%' OR label LIKE '%ダスッ%' OR
        maker = 'kawaii' OR label = 'kawaii' OR
        maker = 'Hunter' OR label = 'Hunter' OR
        maker = 'ワンズファクトリー' OR label = 'ワンズファクトリー' OR
        maker = 'SODクリエイト' OR label = 'SODクリエイト' OR
        maker = 'FALENO' OR label = 'FALENO' OR
        maker = 'TAMEIKE' OR label = 'TAMEIKE' OR
        maker LIKE '%million%' OR label LIKE '%million%' OR
        maker = 'プレミアム' OR label = 'プレミアム' OR
        maker = 'DAHLIA' OR label = 'DAHLIA'
    )`;

    // 3クエリを並列取得
    const [fanza20Rows, mgs20Rows, fanzaMakerRows] = await Promise.all([
        // FANZA: 20作品以上のパターン
        fanza.execute({
            sql: `SELECT actresses, COUNT(*) as cnt FROM products
                  WHERE actresses IS NOT NULL AND actresses != '' AND actresses != '----'
                  GROUP BY actresses HAVING cnt >= 20 ORDER BY cnt DESC`,
            args: [],
        }).then(r => r.rows).catch(() => []),
        // MGS: 20作品以上のパターン
        mgs.execute({
            sql: `SELECT actresses, COUNT(*) as cnt FROM products
                  WHERE actresses IS NOT NULL AND actresses != '' AND actresses != '----'
                    AND (duration_min IS NULL OR duration_min < 600)
                  GROUP BY actresses HAVING cnt >= 20 ORDER BY cnt DESC`,
            args: [],
        }).then(r => r.rows).catch(() => []),
        // FANZA: ホームメーカー出演パターン（全件）
        fanza.execute({
            sql: `SELECT actresses, COUNT(*) as cnt FROM products
                  WHERE actresses IS NOT NULL AND actresses != '' AND actresses != '----'
                    AND ${HOME_MAKER_SQL}
                  GROUP BY actresses HAVING cnt >= 3 ORDER BY cnt DESC`,
            args: [],
        }).then(r => r.rows).catch(() => []),
    ]);

    // 個人名ごとに出演作品数を集計
    const individualCounts = new Map();
    const splitNames = (rows) => {
        for (const row of rows) {
            const cnt = Number(row.cnt ?? 1);
            const names = String(row.actresses ?? '').split(/,|、/).map(s => s.trim()).filter(s => s && s !== '----');
            for (const n of names) {
                individualCounts.set(n, (individualCounts.get(n) || 0) + cnt);
            }
        }
    };
    splitNames(fanza20Rows);
    splitNames(mgs20Rows);
    splitNames(fanzaMakerRows);

    // 対象: 個人作品数20以上 OR ホームメーカーに3作以上出演
    // → ここでは全ての集計済み名前が対象（20作以上パターン OR メーカーパターンに含まれる名前）
    const excluded = new Set(existingNames);
    const candidates = [...individualCounts.entries()]
        .filter(([name]) => !excluded.has(name) && name.length >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2500)  // 最大2500人（25MBアセット上限に合わせ10作品×2500人≈23MB）
        .map(([name]) => name);

    console.log(`  対象 ${candidates.length}人 (サンプル: ${candidates.slice(0,5).join(', ')})`);

    // 各女優の商品を取得（検索カードに必要な最小フィールドのみ）
    const SQL = `SELECT product_id, title, actresses, main_image_url, genres, maker, sale_start_date`;

    const result = {};
    const BATCH = 15;

    for (let i = 0; i < candidates.length; i += BATCH) {
        const batch = candidates.slice(i, i + BATCH);
        await Promise.all(batch.map(async (actressName) => {
            const escaped = actressName.replace(/"/g, '""');
            const ftsMatch = `actresses : "${escaped}"`;
            const [mgsRows, fanzaRows] = await Promise.all([
                mgs.execute({
                    sql: `${SQL} FROM products
                          WHERE product_id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?)
                            AND (duration_min IS NULL OR duration_min < 600)
                          ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT 20`,
                    args: [ftsMatch],
                }).then(r => r.rows.map(row => ({ ...row, source: 'mgs' }))).catch(() => []),
                fanza.execute({
                    sql: `${SQL} FROM products
                          WHERE product_id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?)
                          ORDER BY sale_start_date DESC LIMIT 20`,
                    args: [ftsMatch],
                }).then(r => r.rows.map(row => ({ ...row, source: 'fanza' }))).catch(() => []),
            ]);

            const combined = mergeBestExcludeSort(mgsRows, fanzaRows, 11); // 11件: 10表示+1
            if (combined.length > 0) result[actressName] = combined;
        }));
        if (i + BATCH < candidates.length) await new Promise(r => setTimeout(r, 150));
        if (i % 300 === 0 && i > 0) console.log(`  進捗: ${i}/${candidates.length}人`);
    }

    return result;
}

// ── メイン ────────────────────────────────────────────────────────
async function main() {
    const dataDir = path.join(ROOT, 'data');
    // sitemap_cache.json だけを素早く再生成する(週次フルランや動作確認用)
    const sitemapOnly = process.argv.includes('--sitemap-only');
    // LP用キャッシュ(genres/series)だけを再生成する
    const lpCachesOnly = process.argv.includes('--lp-caches');

    const write = (filename, data) => {
        const p = path.join(dataDir, filename);
        const pubP = path.join(ROOT, 'public', 'data', filename);
        const json = JSON.stringify(data, null, 0);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, json);
        fs.mkdirSync(path.dirname(pubP), { recursive: true });
        fs.writeFileSync(pubP, json);
        const count = Array.isArray(data) ? data.length : Object.keys(data).length;
        console.log(`✓ ${filename} (${count}件)`);
    };

    const wait = ms => new Promise(r => setTimeout(r, ms));

    if (lpCachesOnly) {
        write('makers_cache.json', await genMakersList()); await wait(200);
        write('genres_cache.json', await genGenresCache()); await wait(200);
        write('series_cache.json', await genSeriesCache());
        console.log('\n[--lp-caches] 完了！'); process.exit(0);
    }

    const { actresses, products, lastmods } = await genSitemapCache();
    const sitemapPath    = path.join(dataDir, 'sitemap_cache.json');
    const sitemapPubPath = path.join(ROOT, 'public', 'data', 'sitemap_cache.json');
    // sitemap_cache.json は product/[id] の noindex 判定(isIndexableProduct)が毎リクエスト読むホットパス。
    // 発売日は子サイトマップ(1日1回・エッジキャッシュ有り)しか使わないので別ファイルに分けて
    // ホットパスの JSON.parse を太らせない。
    const sitemapJson = JSON.stringify({ actresses, products }, null, 0);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(sitemapPath, sitemapJson);
    fs.mkdirSync(path.dirname(sitemapPubPath), { recursive: true });
    fs.writeFileSync(sitemapPubPath, sitemapJson);
    console.log(`✓ sitemap_cache.json (女優:${actresses.length}件, 作品:${products.length}件)`);

    const lastmodJson = JSON.stringify({ products: lastmods }, null, 0);
    for (const p of [path.join(dataDir, 'sitemap_lastmod.json'), path.join(ROOT, 'public', 'data', 'sitemap_lastmod.json')]) {
        fs.writeFileSync(p, lastmodJson);
    }
    console.log(`✓ sitemap_lastmod.json (${lastmods.filter(Boolean).length}/${lastmods.length}件に発売日)`);

    if (sitemapOnly) { console.log('\n[--sitemap-only] 完了！'); process.exit(0); }
    await wait(200);

    const makersList         = await genMakersList();          await wait(200);
    const genresList         = await genGenresCache();         await wait(200);
    const seriesList         = await genSeriesCache();         await wait(200);
    const actressMap         = keepRicherActressCache(await genActressDisplayCache()); await wait(200);
    const topActressProducts = await genTopActressProducts();  await wait(200);
    const extActressProducts = await genExtendedActressProducts(Object.keys(topActressProducts));

    write('makers_cache.json', makersList);
    write('genres_cache.json', genresList);
    write('series_cache.json', seriesList);
    write('actress_display_cache.json', actressMap);
    // 女優APIが読むのは分割版（一枚岩24MBはisolateメモリを圧迫し、25MBのアセット上限にも近い）。
    // 一枚岩はNodeスクリプト用に残しつつ、必ずシャードを作り直して同期させる。
    {
        const { buildActressDisplayShards } = await import('./build_actress_display_shards.mjs');
        const { shards, aliasIndex } = buildActressDisplayShards(actressMap);
        for (const [key, obj] of Object.entries(shards)) write(path.join('actress_display', `${key}.json`), obj);
        write('actress_display_alias_index.json', aliasIndex);
    }
    write('actress_top_products.json', topActressProducts);
    write('actress_extended_products.json', extActressProducts);

    console.log('\n完了！');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
