/**
 * 静的JSONキャッシュ生成スクリプト（ローカルSQLite版）
 * Tursoが使えない場合にローカルのfanza.db / mgs.dbから生成する
 * 使い方: node scripts/generate-static-cache-local.mjs
 *
 * 生成ファイル (site/data/ + site/public/data/):
 *   products_new_cache.json          - 新着作品 (top60)
 *   products_popular_cache.json      - 人気作品 (top60)
 *   ranking_2026_cache.json          - 作品ランキング2026 (top100)
 *   ranking_default_cache.json       - 作品ランキング（直近1年、top100）
 *   actress_ranking_2026_cache.json  - 女優ランキング2026 (top50)
 *   actress_ranking_default_cache.json - 女優ランキング（直近1年、top50）
 *   home_preorder_cache.json         - 予約作品・全メーカー
 *   home_preorder_curated_cache.json - 予約作品・厳選メーカー（ホーム用）
 *   sale_cache.json                  - セール中作品
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openLocal } from '../../scripts/lib/localsqlite.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '..', 'data'); // binary-kilonova/data/

const MGS_DB   = path.join(DATA, 'mgs.db');
const FANZA_DB = path.join(DATA, 'fanza.db');

if (!fs.existsSync(MGS_DB))   { console.error('mgs.db が見つかりません: ' + MGS_DB);   process.exit(1); }
if (!fs.existsSync(FANZA_DB)) { console.error('fanza.db が見つかりません: ' + FANZA_DB); process.exit(1); }

const mgs   = openLocal(MGS_DB);
const fanza = openLocal(FANZA_DB);

// ── FANZAの「鮮度が要るデータ」はD1から読む ────────────────────────────
// FANZAの新作・価格・セールは GitHub Actions (scripts/fanza_daily_update.js) が **D1だけ**を
// 更新しており、ローカルの data/fanza.db には反映されない。そのため fanza.db は
//   ・sale_start_date が数日古い（新作にFANZA分が出てこない）
//   ・sale_end_date が全件NULL・discount_pct が凍結（セールが何週間も同じ並びのまま）
// という状態になる。実際 sale_cache.json は2026-07-01から56件が1件も変わっていなかった。
// → 新作/セールだけ D1 から取得する。1日1回の生成なのでD1無料枠への影響は無視できる。
// D1の環境変数が無い環境（オフライン等）ではローカルDBへ自動フォールバックする。
let fanzaFresh = fanza;
let fanzaFreshIsD1 = false;
try {
    const dotenv = (await import('dotenv')).default;
    dotenv.config({ path: path.join(ROOT, '..', '.env') });
    const { fanzaShards } = (await import('../../scripts/lib/d1.js')).default;
    fanzaFresh = fanzaShards();
    fanzaFreshIsD1 = true;
    console.log('[D1] FANZAの新作/セールはD1から取得します');
} catch (e) {
    console.warn(`[D1] FANZAのD1接続に失敗、ローカルfanza.dbを使用します（新作/セールが古い可能性）: ${e.message}`);
}

// D1のFANZAは2シャードに分割されており、SELECTは各シャードの結果を単純連結して返す。
// = ORDER BY / LIMIT がグローバルに効かない（「シャード0の上位N件→シャード1の上位N件」になる）。
// そのため取得後にJS側で必ず並べ直して切り詰める。
function sortAndCap(rows, keyFn, limit, desc = true) {
    if (!fanzaFreshIsD1) return rows.slice(0, limit);
    const sorted = [...rows].sort((a, b) => {
        const ka = keyFn(a), kb = keyFn(b);
        const c = ka < kb ? -1 : ka > kb ? 1 : 0;
        return desc ? -c : c;
    });
    return sorted.slice(0, limit);
}
const dateKey = r => String(r.sale_start_date ?? '').replace(/\//g, '-').slice(0, 10);

function poster(url) {
    if (!url) return '';
    if (url.includes('pb_e_')) return url.replace('pb_e_', 'pf_e_');
    if (url.includes('/digital/amateur/') && url.endsWith('jm.jpg')) return url.replace('jm.jpg', 'jp-001.jpg');
    return url;
}

// 役名/説明文判定（「ゆい 26歳 フリーター」等）
function looksLikeDescription(name) {
    if (!name) return true;
    if (/\d+歳/.test(name)) return true;
    if (/\d{4}年\d+月/.test(name)) return true;
    if (/[【】()]/.test(name)) return true;
    if (name.length > 30) return true;
    if (/\s/.test(name.trim())) return true;
    return false;
}

// known女優リスト（actress_display_cache.json）読み込み
let _knownActresses = null;
function getKnownActresses() {
    if (_knownActresses) return _knownActresses;
    _knownActresses = new Set();
    try {
        const p = path.join(ROOT, 'public', 'data', 'actress_display_cache.json');
        if (fs.existsSync(p)) {
            const m = JSON.parse(fs.readFileSync(p, 'utf-8'));
            for (const n of Object.keys(m)) _knownActresses.add(n);
        }
    } catch { /* ignore */ }
    return _knownActresses;
}

// actress_profiles.json（DMM ActressSearch由来）: 顔写真image_url + FANZA実在確認に使う
let _profiles = null;
function getActressProfiles() {
    if (_profiles) return _profiles;
    _profiles = { img: new Map(), names: new Set() };
    try {
        const p = path.join(ROOT, '..', 'data', 'actress_profiles.json');
        if (fs.existsSync(p)) {
            const m = JSON.parse(fs.readFileSync(p, 'utf-8'));
            for (const k of Object.keys(m)) {
                const pr = m[k];
                if (!pr || !pr.name) continue;
                _profiles.names.add(pr.name);
                if (pr.image_url) _profiles.img.set(pr.name, pr.image_url);
            }
        }
    } catch { /* ignore */ }
    return _profiles;
}

const ROLE_ATTR_RE = /カップ|アイドル|レイヤー|素人|ナンパ|人妻|熟女|美少女|お姉さん|奥様|奥さん|先生|店員|社員|職員|店長|彼女|新妻|若妻|ギャル|コスプレ|ナース|女医|教師|秘書|OL/;

// 女優ランキングに採用してよい名前か（FANZA登録ホワイトリスト方式）
function isValidActressName(name) {
    if (!name) return false;
    const known = getKnownActresses();
    if (known.size > 0) return known.has(name);
    if (looksLikeDescription(name)) return false;
    if (/(さん|ちゃん|くん|君)$/.test(name)) return false;
    if (/[&＆・/／＋+]/.test(name)) return false;
    if (ROLE_ATTR_RE.test(name)) return false;
    return true;
}

const BEST = ['%BEST%','%ベスト%','%総集編%','%コレクション%','%Best%','%リマスター%','%AIリマスター%'];
const bestConds = BEST.map(() => 'title NOT LIKE ?').join(' AND ');
const bestArgs  = BEST;

const today = new Date().toISOString().slice(0, 10);
const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// FANZA の sale_start_date は 'YYYY-MM-DD HH:MM:SS'。日付比較に SUBSTR(...,1,10) を使うと
// **idx_sale_start が一切効かなくなる**（route.ts で 2026-09-05 に同じ罠を潰したが、
//  この生成スクリプトには残っていて、2026-09-06 実測で予約2クエリ × 2シャード = 約54万行/日を読んでいた）。
// 生の列のまま「翌日未満 / 翌日以上」で比較すれば意味は同じでインデックスが効く:
//   SUBSTR(d,1,10) >  X  ⟺  d >= 翌日(X)
//   SUBSTR(d,1,10) <= X  ⟺  d <  翌日(X)
//   SUBSTR(d,1,10) >= X  ⟺  d >= X
// NULL はどちらの形でも比較結果が NULL＝除外されるので挙動は変わらない。
// MGS は 'YYYY/MM/DD' で REPLACE 式そのものに関数インデックスがあるため REPLACE のままでよい。
const nextDay = (d) => new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
const tomorrow = nextDay(today);

// ── ホーム画面掲載メーカーリスト ────────────────────────────────────
// ['exact'|'like', value]  ※ generate-static-cache.mjs / route.ts と同一定義を維持
const HOME_MAKERS = [
    ['like',  'エスワン'],
    ['exact', 'ムーディーズ'],
    ['exact', 'アイデアポケット'],
    ['exact', 'OPPAI'],
    ['exact', 'E-BODY'],
    ['exact', 'Fitch'],
    ['exact', 'マドンナ'],
    ['exact', '本中'],
    ['like',  'ダスッ'],
    ['exact', 'kawaii'],
    ['exact', 'Hunter'],
    ['exact', 'ワンズファクトリー'],
    ['exact', 'SODクリエイト'],
    ['exact', 'FALENO'],
    ['exact', 'TAMEIKE'],
    ['like',  'million'],
    ['exact', 'プレミアム'],
    ['exact', 'DAHLIA'],
];

const mgsMakerCond = HOME_MAKERS.map(([t]) => t === 'exact' ? 'maker = ?' : 'maker LIKE ?').join(' OR ');
const mgsMakerArgs = HOME_MAKERS.map(([t, v]) => t === 'exact' ? v : `%${v}%`);
const fanzaMakerCond = HOME_MAKERS.map(([t]) =>
    t === 'exact' ? '(maker = ? OR label = ?)' : '(maker LIKE ? OR label LIKE ?)'
).join(' OR ');
const fanzaMakerArgs = HOME_MAKERS.flatMap(([t, v]) =>
    t === 'exact' ? [v, v] : [`%${v}%`, `%${v}%`]
);

// FANZA拡張列（存在しない場合はNULLフォールバック）
const FANZA_EXT = `COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, sale_end_date`;
const FANZA_EXT_VR = `COALESCE(discount_pct,0) AS discount_pct, list_price, current_price,
    CASE WHEN typeof(series_name)='text' THEN series_name ELSE NULL END AS series_name,
    CASE WHEN typeof(series_id)='text' THEN series_id ELSE NULL END AS series_id,
    CASE WHEN typeof(vr_flag)='integer' THEN vr_flag ELSE 0 END AS vr_flag,
    sale_end_date`;

// ── 新着作品 ──────────────────────────────────────────────────────
async function genNewProducts() {
    console.log('[新着作品] 取得中...');
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, NULL AS sale_end_date
                  FROM products
                  WHERE sale_start_date IS NOT NULL
                    AND REPLACE(sale_start_date,'/','-') >= ?
                    AND REPLACE(sale_start_date,'/','-') <= ?
                    AND (duration_min IS NULL OR duration_min < 600)
                    AND ${bestConds}
                  ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT 300`,
            args: [twoWeeksAgo, today, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanzaFresh.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         ${FANZA_EXT}
                  FROM products
                  WHERE sale_start_date IS NOT NULL
                    AND sale_start_date >= ?
                    AND sale_start_date < ?
                    AND ${bestConds}
                  ORDER BY sale_start_date DESC LIMIT 300`,
            args: [twoWeeksAgo, tomorrow, ...bestArgs],
        }).then(r => sortAndCap(r.rows, dateKey, 300)).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);
    console.log(`[新着作品] MGS ${mgsRows.length}件 / FANZA ${fanzaRows.length}件（FANZA最新: ${fanzaRows[0] ? dateKey(fanzaRows[0]) : 'なし'}）`);

    const combined = [];
    const maxLen = Math.max(mgsRows.length, fanzaRows.length);
    for (let i = 0; i < maxLen; i++) {
        if (mgsRows[i])   combined.push({ ...mgsRows[i],   main_image_url: poster(mgsRows[i].main_image_url),   source: 'mgs' });
        if (fanzaRows[i]) combined.push({ ...fanzaRows[i], main_image_url: poster(fanzaRows[i].main_image_url), source: 'fanza' });
    }
    return combined;
}

// ── 人気作品 ──────────────────────────────────────────────────────
async function genPopularProducts() {
    console.log('[人気作品] 取得中...');
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, NULL AS sale_end_date
                  FROM products
                  WHERE (duration_min IS NULL OR duration_min < 600)
                    AND ${bestConds}
                  ORDER BY wish_count DESC LIMIT 200`,
            args: bestArgs,
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(review_count,0) AS review_count, COALESCE(review_average,0) AS review_average,
                         ${FANZA_EXT}
                  FROM products
                  WHERE ${bestConds}
                  ORDER BY COALESCE(review_count,0)*COALESCE(review_average,0) DESC, sale_start_date DESC LIMIT 200`,
            args: bestArgs,
        }).then(r => r.rows).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);

    // 統一人気度: MGSはお気に入り数、FANZAはレビュー数×評価と指標が異なりスケールも違うため、
    // 各プラットフォーム内で z-score（平均からの偏差/標準偏差）に標準化してから1本に混ぜる。
    // 「そのPF内でどれだけ突出して人気か」で公平に比較でき、強い作品同士が自然に上位で混在する。
    return mergeByZScore(
        mgsRows,   r => Number(r.wish_count) || 0,
        fanzaRows, r => (Number(r.review_count) || 0) * (Number(r.review_average) || 0)
    );
}

// 2つの行配列を、それぞれの指標を z-score 標準化した統一スコア降順で1本にマージする。
function mergeByZScore(mgsRows, mgsMetric, fanzaRows, fanzaMetric) {
    const zFn = (vals) => {
        const n = vals.length || 1;
        const mean = vals.reduce((a, b) => a + b, 0) / n;
        const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n) || 1;
        return (v) => (v - mean) / sd;
    };
    const zM = zFn(mgsRows.map(mgsMetric));
    const zF = zFn(fanzaRows.map(fanzaMetric));
    const combined = [
        ...mgsRows.map(r => ({ ...r, main_image_url: poster(r.main_image_url), source: 'mgs', _pop: zM(mgsMetric(r)) })),
        ...fanzaRows.map(r => ({ ...r, main_image_url: poster(r.main_image_url), source: 'fanza', _pop: zF(fanzaMetric(r)) })),
    ];
    combined.sort((a, b) => b._pop - a._pop);
    return combined.map(({ _pop, ...rest }) => rest);
}

// FANZA人気スコア(sort=rank由来, content_id→0..1)。作品ランキングの両PF公平化に使う(B成分)
const _fanzaPop = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'fanza_popularity.json'), 'utf-8')); } catch { return {}; } })();
// FANZA作品の統一人気度: 人気順(rank)を主、レビューを補助に混ぜる(0..1)
function fanzaPopMetric(r) {
    const rank = Number(_fanzaPop[String(r.product_id)] || 0);
    const rev = Math.min(1, ((Number(r.review_count) || 0) * (Number(r.review_average) || 0)) / 200);
    return 0.6 * rank + 0.4 * rev;
}

// ── 作品ランキング (2026) ─────────────────────────────────────────
async function genRanking2026() {
    console.log('[作品ランキング2026] 取得中...');
    const FROM = '2026-01-01', TO = '2026-12-31';
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, NULL AS sale_end_date
                  FROM products
                  WHERE (duration_min IS NULL OR duration_min < 600)
                    AND REPLACE(sale_start_date,'/','-') >= ? AND REPLACE(sale_start_date,'/','-') <= ?
                    AND ${bestConds}
                  ORDER BY wish_count DESC LIMIT 200`,
            args: [FROM, TO, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(review_count,0) AS review_count, COALESCE(review_average,0) AS review_average,
                         ${FANZA_EXT}
                  FROM products
                  WHERE sale_start_date >= ? AND sale_start_date <= ?
                    AND ${bestConds}
                  ORDER BY COALESCE(review_count,0)*COALESCE(review_average,0) DESC, sale_start_date DESC LIMIT 200`,
            args: [FROM, TO, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);

    // 両PF公平: MGS=お気に入り / FANZA=人気順(rank)+レビュー を各PF内でz-score化し統一スコア降順で混ぜる
    return mergeByZScore(
        mgsRows,   r => Number(r.wish_count) || 0,
        fanzaRows, fanzaPopMetric
    ).slice(0, 100);
}

// ── 作品ランキング（日付範囲なし・デフォルト） ──────────────────
async function genRankingDefault() {
    console.log('[作品ランキング デフォルト] 取得中...');
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price, NULL AS sale_end_date
                  FROM products
                  WHERE (duration_min IS NULL OR duration_min < 600)
                    AND REPLACE(sale_start_date,'/','-') >= ?
                    AND ${bestConds}
                  ORDER BY wish_count DESC LIMIT 200`,
            args: [oneYearAgo, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        fanza.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         COALESCE(review_count,0) AS review_count, COALESCE(review_average,0) AS review_average,
                         ${FANZA_EXT}
                  FROM products
                  WHERE sale_start_date >= ?
                    AND ${bestConds}
                  ORDER BY COALESCE(review_count,0) DESC, sale_start_date DESC LIMIT 300`,
            args: [oneYearAgo, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);

    // 両PF公平: MGS=お気に入り / FANZA=人気順(rank)+レビュー を各PF内でz-score化し統一スコア降順で混ぜる
    return mergeByZScore(
        mgsRows,   r => Number(r.wish_count) || 0,
        fanzaRows, fanzaPopMetric
    ).slice(0, 100);
}

// ── 女優ランキング (2026) ─────────────────────────────────────────
async function genActressRanking2026() {
    console.log('[女優ランキング2026] 取得中...');
    const FROM = '2026-01-01', TO = '2026-12-31';

    const [mgsRows, fanzaRows, profileRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT actresses, main_image_url, wish_count, genres, maker, product_id
                  FROM products
                  WHERE (duration_min IS NULL OR duration_min < 600)
                    AND REPLACE(sale_start_date,'/','-') >= ? AND REPLACE(sale_start_date,'/','-') <= ?
                  ORDER BY wish_count DESC LIMIT 500`,
            args: [FROM, TO],
        }).then(r => r.rows).catch(() => []),
        fanza.execute({
            sql: `SELECT actresses, main_image_url, 0 AS wish_count, genres, maker, product_id
                  FROM products WHERE sale_start_date >= ? AND sale_start_date <= ?
                  ORDER BY sale_start_date DESC LIMIT 500`,
            args: [FROM, TO],
        }).then(r => r.rows).catch(() => []),
        fanza.execute(
            `SELECT name, image_url FROM actress_profiles WHERE image_url IS NOT NULL LIMIT 3000`
        ).then(r => r.rows).catch(() => []),
    ]);

    // 候補を多めに作り、出演メーカー数が多い同名別人混在の汎用名を除外して上位50名に絞る
    return renameRanking(await excludeAmbiguousNames(buildActressRanking(mgsRows, fanzaRows, profileRows, 200), 50));
}

// ── 女優ランキング（デフォルト・直近1年） ──────────────────────
async function genActressRankingDefault() {
    console.log('[女優ランキング デフォルト] 取得中...');

    const [mgsRows, fanzaRows, profileRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT actresses, main_image_url, wish_count, genres, maker, product_id
                  FROM products
                  WHERE (duration_min IS NULL OR duration_min < 600)
                    AND REPLACE(sale_start_date,'/','-') >= ?
                  ORDER BY wish_count DESC LIMIT 500`,
            args: [oneYearAgo],
        }).then(r => r.rows).catch(() => []),
        fanza.execute({
            sql: `SELECT actresses, main_image_url, 0 AS wish_count, genres, maker, product_id
                  FROM products WHERE sale_start_date >= ?
                  ORDER BY sale_start_date DESC LIMIT 500`,
            args: [oneYearAgo],
        }).then(r => r.rows).catch(() => []),
        fanza.execute(
            `SELECT name, image_url FROM actress_profiles WHERE image_url IS NOT NULL LIMIT 3000`
        ).then(r => r.rows).catch(() => []),
    ]);

    // 候補を多めに作り、出演メーカー数が多い同名別人混在の汎用名を除外して上位50名に絞る
    return renameRanking(await excludeAmbiguousNames(buildActressRanking(mgsRows, fanzaRows, profileRows, 200), 50));
}

// 女優ランキングの手動補正（曖昧な短縮名の正式名化・誤検出の除外）。再生成しても維持される。
const ACTRESS_RENAME = { 'いちか': '松本いちか', 'ちな': '千咲ちな', 'かすみ': '月野かすみ' }; // 表示名差し替え
const ACTRESS_EXCLUDE = new Set(['あいな', 'りん', 'みちる', 'Ruru']);   // ランキングから除外
// 改名後の名前→正しい顔写真URLの上書き（元名の画像が別人/欠落のとき）
const ACTRESS_IMAGE_OVERRIDE = { '松本いちか': 'https://pics.dmm.co.jp/mono/actjpgs/matumoto_itika.jpg' };
// 改名・画像上書きを適用し、同名衝突は先勝ち（高スコア優先）で重複排除
function renameRanking(list) {
    const seen = new Set();
    return list.map(e => {
        const name = ACTRESS_RENAME[e.name] || e.name;
        return { ...e, name, image_url: ACTRESS_IMAGE_OVERRIDE[name] || e.image_url };
    }).filter(e => (seen.has(e.name) ? false : seen.add(e.name)));
}

function buildActressRanking(mgsRows, fanzaRows, profileRows, topN) {
    const actressMap = new Map();
    const processRows = (rows) => {
        for (const row of rows) {
            if (!row.actresses) continue;
            const names = String(row.actresses).split(/,|、/).map(s => s.trim()).filter(Boolean).filter(isValidActressName);
            const wishCount = Number(row.wish_count ?? 0);
            for (const name of names) {
                const e = actressMap.get(name);
                if (e) { e.wishScore += wishCount; e.workCount++; }
                else   { actressMap.set(name, { name, wishScore: wishCount, workCount: 1, sampleImage: poster(String(row.main_image_url ?? '')) }); }
            }
        }
    };
    processRows(mgsRows);
    processRows(fanzaRows);

    // 顔写真＆実在確認は actress_profiles.json（DMM ActressSearch由来）から。
    const { img: profileImg, names: profileNames } = getActressProfiles();

    return Array.from(actressMap.values())
        // FANZAに名前が完全一致で実在する女優のみ採用（実在しない/誤抽出を除外）＋手動除外
        .filter(e => (profileNames.size === 0 || profileNames.has(e.name)) && !ACTRESS_EXCLUDE.has(e.name))
        .sort((a, b) => b.wishScore - a.wishScore)
        .slice(0, topN)
        .map(e => ({
            name: e.name,
            score: e.wishScore,
            work_count: e.workCount,
            image_url: (profileImg.get(e.name) || '').replace(/^http:\/\//, 'https://') || null,
            sample_image: e.sampleImage,
        }));
}

// 女優名 → 出演メーカー数（data/actress_makers.json、scripts/build_actress_makers.js がD1から構築）。
// ローカルDBは出演者が古いため、D1集計済みのファイルを使う。
let _nameMakerCount = null;
function getNameMakerCount() {
    if (_nameMakerCount) return _nameMakerCount;
    _nameMakerCount = {};
    try {
        const p = path.join(ROOT, '..', 'data', 'actress_makers.json');
        if (fs.existsSync(p)) _nameMakerCount = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch { /* ignore */ }
    return _nameMakerCount;
}

// 出演メーカー数が閾値を超える名前は「同名別人が混在する汎用名（ちな/いちか等）」として除外。
// 本物の女優は出演メーカーが少ない（涼森れむ=3、鈴村あいり=7）。
function excludeAmbiguousNames(candidates, limit, threshold = 20) {
    const counts = getNameMakerCount();
    const out = [];
    for (const c of candidates) {
        if (out.length >= limit) break;
        if ((counts[c.name] || 0) <= threshold) out.push(c);
    }
    return out;
}

// ── 予約作品・全メーカー ──────────────────────────────────────────
async function genPreorderProducts() {
    console.log('[予約作品 全メーカー] 取得中...');
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         0 AS discount_pct, NULL AS list_price, NULL AS current_price,
                         NULL AS series_name, NULL AS series_id, 0 AS vr_flag, NULL AS sale_end_date
                  FROM products
                  WHERE REPLACE(sale_start_date,'/','-') > ?
                    AND (duration_min IS NULL OR duration_min < 600)
                    AND ${bestConds}
                  ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT 300`,
            args: [today, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        // 予約(未来日付)はローカルfanza.dbには存在しない(最新が数日前で止まるため常に0件)。D1から取る。
        fanzaFresh.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         ${FANZA_EXT_VR}
                  FROM products
                  WHERE sale_start_date >= ?
                    AND ${bestConds}
                  ORDER BY sale_start_date DESC LIMIT 300`,
            args: [tomorrow, ...bestArgs],
        }).then(r => sortAndCap(r.rows, dateKey, 300)).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);

    const combined = [];
    const maxLen = Math.max(mgsRows.length, fanzaRows.length);
    for (let i = 0; i < maxLen; i++) {
        if (mgsRows[i])   combined.push({ ...mgsRows[i],   main_image_url: poster(mgsRows[i].main_image_url),   source: 'mgs' });
        if (fanzaRows[i]) combined.push({ ...fanzaRows[i], main_image_url: poster(fanzaRows[i].main_image_url), source: 'fanza' });
    }
    return combined;
}

// ── 予約作品・厳選メーカー（ホーム画面用） ──────────────────────
async function genHomePreorderCurated() {
    console.log('[予約作品 厳選メーカー] 取得中...');
    const [mgsRows, fanzaRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         0 AS discount_pct, NULL AS list_price, NULL AS current_price,
                         NULL AS series_name, NULL AS series_id, 0 AS vr_flag, NULL AS sale_end_date
                  FROM products
                  WHERE REPLACE(sale_start_date,'/','-') > ?
                    AND (duration_min IS NULL OR duration_min < 600)
                    AND (${mgsMakerCond})
                    AND ${bestConds}
                  ORDER BY REPLACE(sale_start_date,'/','-') DESC LIMIT 60`,
            args: [today, ...mgsMakerArgs, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS error:', e.message); return []; }),
        // 予約はD1から（ローカルfanza.dbは未来日付を持たない）
        fanzaFresh.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         ${FANZA_EXT_VR}
                  FROM products
                  WHERE sale_start_date >= ?
                    AND (${fanzaMakerCond})
                    AND ${bestConds}
                  ORDER BY sale_start_date DESC LIMIT 60`,
            args: [tomorrow, ...fanzaMakerArgs, ...bestArgs],
        }).then(r => sortAndCap(r.rows, dateKey, 60)).catch(e => { console.error('FANZA error:', e.message); return []; }),
    ]);

    const combined = [];
    const maxLen = Math.max(mgsRows.length, fanzaRows.length);
    for (let i = 0; i < maxLen; i++) {
        if (mgsRows[i])   combined.push({ ...mgsRows[i],   main_image_url: poster(mgsRows[i].main_image_url),   source: 'mgs' });
        if (fanzaRows[i]) combined.push({ ...fanzaRows[i], main_image_url: poster(fanzaRows[i].main_image_url), source: 'fanza' });
    }
    return combined;
}

// ── セール作品（割引率降順） ──────────────────────────────────────
async function genSaleProducts() {
    console.log('[セール作品] 取得中...');
    const [fanzaRows, mgsRows] = await Promise.all([
        fanzaFresh.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, 0 AS wish_count, genres, maker, sale_start_date,
                         ${FANZA_EXT_VR}
                  FROM products
                  WHERE discount_pct >= 1
                    AND (sale_end_date IS NULL OR SUBSTR(REPLACE(sale_end_date,'/','-'),1,10) >= ?)
                    AND (${fanzaMakerCond})
                    AND ${bestConds}
                  ORDER BY discount_pct DESC, sale_start_date DESC LIMIT 120`,
            args: [today, ...fanzaMakerArgs, ...bestArgs],
        }).then(r => sortAndCap(r.rows, x => Number(x.discount_pct ?? 0), 120)).catch(e => { console.error('FANZA sale error:', e.message); return []; }),
        mgs.execute({
            sql: `SELECT product_id, title, actresses, main_image_url, wish_count, genres, maker, sale_start_date,
                         COALESCE(discount_pct,0) AS discount_pct, list_price, current_price,
                         NULL AS series_name, NULL AS series_id, 0 AS vr_flag, sale_end_date
                  FROM products
                  WHERE discount_pct >= 1
                    AND (sale_end_date IS NULL OR SUBSTR(REPLACE(sale_end_date,'/','-'),1,10) >= ?)
                    AND (duration_min IS NULL OR duration_min < 600)
                    AND ${bestConds}
                  ORDER BY discount_pct DESC, REPLACE(sale_start_date,'/','-') DESC LIMIT 60`,
            args: [today, ...bestArgs],
        }).then(r => r.rows).catch(e => { console.error('MGS sale error:', e.message); return []; }),
    ]);

    const combined = [
        ...fanzaRows.map(r => ({ ...r, main_image_url: poster(r.main_image_url), source: 'fanza' })),
        ...mgsRows.map(r  => ({ ...r, main_image_url: poster(r.main_image_url),  source: 'mgs'   })),
    ];
    combined.sort((a, b) => Number(b.discount_pct) - Number(a.discount_pct));
    console.log(`[セール作品] FANZA ${fanzaRows.length}件 / MGS ${mgsRows.length}件`);
    return combined;
}

// ── メーカー一覧 ──────────────────────────────────────────────────
async function genMakersList() {
    console.log('[メーカー一覧] 取得中...');
    const [mgsRows, fanzaRows, fanzaVideocRows] = await Promise.all([
        mgs.execute({
            sql: `SELECT maker, COUNT(*) as cnt, MAX(main_image_url) as sample_image
                  FROM products
                  WHERE maker IS NOT NULL AND LENGTH(TRIM(maker)) > 1
                    AND (duration_min IS NULL OR duration_min < 600)
                  GROUP BY maker HAVING cnt >= 3
                  ORDER BY cnt DESC LIMIT 2000`,
            args: [],
        }).then(r => r.rows).catch(() => []),
        fanza.execute({
            sql: `SELECT maker, COUNT(*) as cnt, MAX(main_image_url) as sample_image,
                         SUM(CASE WHEN floor = 'videoc' THEN 1 ELSE 0 END) as videoc_cnt
                  FROM products
                  WHERE maker IS NOT NULL AND LENGTH(TRIM(maker)) > 1
                  GROUP BY maker HAVING cnt >= 3
                  ORDER BY cnt DESC LIMIT 3000`,
            args: [],
        }).then(r => r.rows).catch(() => []),
        // 素人(videoc)主体のメーカーは作品数が小さく上位400に入らず一覧から漏れるため、専用に取得して必ず含める。
        // videoaも持つ大手(SOD等)を誤分類しないよう「videocが過半数」のメーカーに限定。
        fanza.execute({
            sql: `SELECT maker, COUNT(*) as cnt, MAX(main_image_url) as sample_image,
                         SUM(CASE WHEN floor = 'videoc' THEN 1 ELSE 0 END) as videoc_cnt
                  FROM products
                  WHERE maker IS NOT NULL AND LENGTH(TRIM(maker)) > 1
                  GROUP BY maker
                  HAVING videoc_cnt >= 3 AND videoc_cnt > cnt / 2
                  ORDER BY cnt DESC LIMIT 1000`,
            args: [],
        }).then(r => r.rows).catch(() => []),
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
    // 素人(videoc)メーカーを必ず取り込む（上位400に入らない小規模シリーズも含める）
    for (const row of fanzaVideocRows) {
        const name = String(row.maker ?? '').trim();
        if (!name) continue;
        const e = map.get(name);
        if (e) { e.floor = 'videoc'; if (!e.sources.includes('fanza')) e.sources.push('fanza'); }
        else map.set(name, { name, count: Number(row.cnt ?? 0), sample_image: poster(String(row.sample_image ?? '')), sources: ['fanza'], floor: 'videoc' });
    }
    // 作品が3件以上ある全メーカーを掲載（上限なし）。
    // /makersページは platform×五十音×検索でフィルタ描画するため件数増でも軽量。
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

// ── メイン ────────────────────────────────────────────────────────
// 品番を共通コア(label+番号)に正規化。MGS「MAAN-1174」「230ORECZ-562」と
// FANZA「h_1711maan01174」「orecz562」を同一キー(maan1174/orecz562)にする。
function coreId(id) {
    let s = String(id || '').toLowerCase();
    s = s.replace(/^h_\d+/, '').replace(/^\d+/, '').replace(/[^a-z0-9]/g, '');
    const m = s.match(/^([a-z]+)0*(\d+)$/);
    return m ? m[1] + m[2] : s;
}
// MGSとFANZAに同一作品が両方ある場合、先頭(=MGS優先)を残して重複カードを除去。
function dedupeWorks(arr) {
    if (!Array.isArray(arr)) return arr;
    const seen = new Set();
    return arr.filter(p => {
        const k = coreId(p && p.product_id);
        if (!k) return true;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

// メーカー一覧は「週次(D1・全カタログ)」と「日次(ローカルSQLite)」の両方が同じファイルを書く。
// ローカルDBはFANZA日次更新がD1のみ書くため数週間遅れ、件数も少ない（実測 3,149 → 1,491 に半減して
// いた）。makers_cache.json に無いメーカーの /maker/[name] は404になるので、日次実行のたびに
// 1,600件超のLPが週の大半で404になっていた。既存(週次)の一覧を土台に、日次で件数だけ更新し
// 新規メーカーを追加する＝件数が減らないマージにする。
function mergeMakers(fresh, pubDir) {
    let existing = [];
    try {
        existing = JSON.parse(fs.readFileSync(path.join(pubDir, 'makers_cache.json'), 'utf-8'));
    } catch { /* 初回は既存なし */ }
    if (!Array.isArray(existing) || existing.length === 0) return fresh;

    const byName = new Map(existing.map(m => [m.name, { ...m }]));
    for (const m of fresh) {
        const cur = byName.get(m.name);
        if (!cur) { byName.set(m.name, m); continue; }
        // 件数・サンプル画像は新しい方を採用（floor/sources は既存を温存）
        cur.count = m.count ?? cur.count;
        if (m.sample_image) cur.sample_image = m.sample_image;
        if (m.floor) cur.floor = m.floor;
        if (Array.isArray(m.sources) && m.sources.length) {
            cur.sources = [...new Set([...(cur.sources || []), ...m.sources])];
        }
    }
    const merged = [...byName.values()].sort((a, b) => (b.count || 0) - (a.count || 0));
    if (merged.length > fresh.length) {
        console.log(`  ↳ メーカー一覧: ローカルDB ${fresh.length}件 → 既存とマージして ${merged.length}件を維持`);
    }
    return merged;
}

async function main() {
    const dataDir = path.join(ROOT, 'data');
    const pubDir  = path.join(ROOT, 'public', 'data');
    fs.mkdirSync(pubDir, { recursive: true });

    // D1 の日次枠切れ等で生成が 0 件になったとき、**既存の有効なキャッシュを空で潰さない**。
    // 実際 2026-09-02 の実行では FANZA(D1)が枠切れで落ち、home_preorder_*.json が [] で
    // 上書きされて残った。静的キャッシュは D1 が死んだときの最後の砦なので、
    // 「D1が死んだ日に安全網まで消える」のが最悪の壊れ方になる。
    // 件数が減るだけ（セール終了など）は正常なので、空になったときだけ守る。
    const write = (filename, data) => {
        const count = Array.isArray(data) ? data.length : Object.keys(data).length;
        if (count === 0) {
            const cur = path.join(dataDir, filename);
            let prev = 0;
            try {
                const old = JSON.parse(fs.readFileSync(cur, 'utf-8'));
                prev = Array.isArray(old) ? old.length : Object.keys(old).length;
            } catch { /* 既存が無い/壊れている → 書いてよい */ }
            if (prev > 0) {
                console.warn(`! ${filename} が0件になったため上書きをスキップ（既存 ${prev}件 を維持）`);
                return;
            }
        }
        fs.writeFileSync(path.join(dataDir, filename), JSON.stringify(data, null, 0));
        fs.writeFileSync(path.join(pubDir, filename),  JSON.stringify(data, null, 0));
        console.log(`✓ ${filename} (${count}件)`);
    };

    // 順次実行（@libsql/client file:// はシリアルが安全）
    // 作品系キャッシュは MGS と FANZA に同一作品が両方あると2枚カードが出るため dedupeWorks で1枚に統一
    write('products_new_cache.json',              dedupeWorks(await genNewProducts()));
    write('products_popular_cache.json',          dedupeWorks(await genPopularProducts()));
    write('ranking_2026_cache.json',              dedupeWorks(await genRanking2026()));
    write('ranking_default_cache.json',           dedupeWorks(await genRankingDefault()));
    write('actress_ranking_2026_cache.json',      await genActressRanking2026());
    write('actress_ranking_default_cache.json',   await genActressRankingDefault());
    write('home_preorder_cache.json',             dedupeWorks(await genPreorderProducts()));
    write('home_preorder_curated_cache.json',     dedupeWorks(await genHomePreorderCurated()));
    write('sale_cache.json',                      dedupeWorks(await genSaleProducts()));
    write('makers_cache.json',                    mergeMakers(await genMakersList(), pubDir));

    // 女優表示キャッシュ(+64シャード)へ日次のFANZAプロフィールを追記マージ。
    // 本来の生成元(D1 actress_profiles)がほぼ空で再生成できず 2026-06-04 で止まっていたため。
    try {
        const { refreshActressDisplayCache } = await import('./refresh_actress_display_cache.mjs');
        refreshActressDisplayCache();
    } catch (e) {
        console.warn(`⚠ actress_display_cache.json の更新をスキップ: ${e.message}`);
    }

    // cup/height/age フィルタ(/cup LP・詳細検索)が読む actress_profiles.json を作り直す。
    // 以前はどこからも再生成されず 2026-03-22 のまま痩せていた（cup 1,235人・画像0件）。
    // 生成に失敗しても他のキャッシュのデプロイは止めない（既存ファイルがそのまま残る）。
    try {
        const { buildActressProfilesCache } = await import('./build_actress_profiles_cache.mjs');
        buildActressProfilesCache();
    } catch (e) {
        console.warn(`⚠ actress_profiles.json の再生成をスキップ: ${e.message}`);
    }

    console.log('\n完了！次のコマンドでデプロイしてください:');
    console.log('  npm run deploy:cf');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
