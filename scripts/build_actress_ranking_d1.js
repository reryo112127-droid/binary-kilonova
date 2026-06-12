/**
 * 女優ランキングキャッシュを D1(最新データ) から再生成する。
 * generate-static-cache-local.mjs はローカルSQLite(data/mgs.db 等)から作るため、
 * AVWIKI等でD1だけ修正された出演者名が古いまま残り「Ruru/かすみ」等の取り違えが起きる。
 * 本スクリプトを daily の -local の後に実行し、ランキング2本だけD1由来で上書きする。
 *
 *   node scripts/build_actress_ranking_d1.js
 *
 * 出力: site/data/ と site/public/data/ の
 *   actress_ranking_2026_cache.json / actress_ranking_default_cache.json
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'site', '.env.local') });
const fs = require('fs');
const { d1, fanzaShards } = require('./lib/d1');

const SITE = path.join(__dirname, '..', 'site');
const DATA = path.join(__dirname, '..', 'data');
const OUT_DIRS = [path.join(SITE, 'data'), path.join(SITE, 'public', 'data')];

// generate-static-cache(-local) と同一の手動補正
const ACTRESS_RENAME = { 'いちか': '松本いちか', 'ちな': '千咲ちな', 'かすみ': '月野かすみ' };
const ACTRESS_EXCLUDE = new Set(['あいな', 'りん', 'みちる', 'Ruru']);
const ACTRESS_IMAGE_OVERRIDE = { '松本いちか': 'https://pics.dmm.co.jp/mono/actjpgs/matumoto_itika.jpg' };

function poster(u) {
    if (!u) return '';
    if (u.includes('pb_e_')) return u.replace('pb_e_', 'pf_e_');
    if (u.includes('/digital/amateur/') && u.endsWith('jm.jpg')) return u.replace('jm.jpg', 'jp-001.jpg');
    if (u.includes('/digital/video/') && /p[ts]\.jpg$/.test(u)) return u.replace(/p[ts]\.jpg$/, 'pl.jpg');
    return u;
}
function loadJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return def; } }

// ホワイトリスト(FANZA実在女優) / 顔写真 / 同名別人判定用メーカー数
const known = new Set(Object.keys(loadJson(path.join(SITE, 'public', 'data', 'actress_display_cache.json'), {})));
const profilesRaw = loadJson(path.join(DATA, 'actress_profiles.json'), {});
const profileImg = new Map(), profileNames = new Set();
for (const k of Object.keys(profilesRaw)) {
    const pr = profilesRaw[k];
    if (!pr || !pr.name) continue;
    profileNames.add(pr.name);
    if (pr.image_url) profileImg.set(pr.name, pr.image_url);
}
const makerCount = loadJson(path.join(DATA, 'actress_makers.json'), {});

const ROLE_ATTR_RE = /カップ|アイドル|レイヤー|素人|ナンパ|人妻|熟女|美少女|お姉さん|奥様|奥さん|先生|店員|社員|職員|店長|彼女|新妻|若妻|ギャル|コスプレ|ナース|女医|教師|秘書|OL/;
function looksLikeDescription(name) {
    if (!name) return true;
    if (/\d+歳/.test(name)) return true;
    if (/\d{4}年\d+月/.test(name)) return true;
    if (/[【】()]/.test(name)) return true;
    if (name.length > 30) return true;
    if (/\s/.test(name.trim())) return true;
    return false;
}
function isValidActressName(name) {
    if (!name) return false;
    if (known.size > 0) return known.has(name);
    if (looksLikeDescription(name)) return false;
    if (/(さん|ちゃん|くん|君)$/.test(name)) return false;
    if (/[&＆・/／＋+]/.test(name)) return false;
    if (ROLE_ATTR_RE.test(name)) return false;
    return true;
}

function build(mgsRows, fanzaRows) {
    const map = new Map();
    const proc = (rows) => {
        for (const row of rows) {
            if (!row.actresses) continue;
            const names = String(row.actresses).split(/,|、/).map(s => s.trim()).filter(Boolean).filter(isValidActressName);
            const wc = Number(row.wish_count ?? 0);
            for (const name of names) {
                const e = map.get(name);
                if (e) { e.wishScore += wc; e.workCount++; }
                else map.set(name, { name, wishScore: wc, workCount: 1, sampleImage: poster(String(row.main_image_url ?? '')) });
            }
        }
    };
    proc(mgsRows); proc(fanzaRows);
    return Array.from(map.values())
        .filter(e => (profileNames.size === 0 || profileNames.has(e.name)) && !ACTRESS_EXCLUDE.has(e.name))
        .sort((a, b) => b.wishScore - a.wishScore);
}
// 出演メーカー数が閾値超の汎用名(同名別人混在)を除外し上位limitへ
function excludeAmbiguous(cands, limit, threshold = 20) {
    const out = [];
    for (const c of cands) { if (out.length >= limit) break; if ((makerCount[c.name] || 0) <= threshold) out.push(c); }
    return out;
}
function finalize(top) {
    const seen = new Set();
    return top.map(e => {
        const name = ACTRESS_RENAME[e.name] || e.name;
        return {
            name,
            score: e.wishScore,
            work_count: e.workCount,
            image_url: ACTRESS_IMAGE_OVERRIDE[name] || (profileImg.get(e.name) || '').replace(/^http:\/\//, 'https://') || null,
            sample_image: e.sampleImage,
        };
    }).filter(e => (seen.has(e.name) ? false : seen.add(e.name)));
}

async function gen(from, to) {
    const mgsSql = to
        ? `SELECT actresses, main_image_url, wish_count, product_id FROM products WHERE (duration_min IS NULL OR duration_min<600) AND REPLACE(sale_start_date,'/','-')>=? AND REPLACE(sale_start_date,'/','-')<=? ORDER BY wish_count DESC LIMIT 500`
        : `SELECT actresses, main_image_url, wish_count, product_id FROM products WHERE (duration_min IS NULL OR duration_min<600) AND REPLACE(sale_start_date,'/','-')>=? ORDER BY wish_count DESC LIMIT 500`;
    const fzSql = to
        ? `SELECT actresses, main_image_url, 0 AS wish_count, product_id FROM products WHERE sale_start_date>=? AND sale_start_date<=? ORDER BY sale_start_date DESC LIMIT 500`
        : `SELECT actresses, main_image_url, 0 AS wish_count, product_id FROM products WHERE sale_start_date>=? ORDER BY sale_start_date DESC LIMIT 500`;
    const margs = to ? [from, to] : [from];
    const [mgsRows, fzRows] = await Promise.all([
        d1('mgs').execute({ sql: mgsSql, args: margs }).then(r => r.rows).catch(e => { console.warn('MGS:', e.message); return []; }),
        fanzaShards().execute({ sql: fzSql, args: margs }).then(r => r.rows).catch(e => { console.warn('FANZA:', e.message); return []; }),
    ]);
    return finalize(excludeAmbiguous(build(mgsRows, fzRows), 50));
}

(async () => {
    const oneYearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    const r2026 = await gen('2026-01-01', '2026-12-31');
    const rDefault = await gen(oneYearAgo, null);
    if (r2026.length < 10 || rDefault.length < 10) throw new Error(`生成結果が少なすぎ(2026=${r2026.length}, default=${rDefault.length}) — D1接続を確認。既存キャッシュは上書きしません`);
    for (const dir of OUT_DIRS) {
        fs.writeFileSync(path.join(dir, 'actress_ranking_2026_cache.json'), JSON.stringify(r2026));
        fs.writeFileSync(path.join(dir, 'actress_ranking_default_cache.json'), JSON.stringify(rDefault));
    }
    const mi = r2026.find(x => x.name === '松本いちか');
    console.log(`✅ 女優ランキング(D1)再生成: 2026=${r2026.length}件 / default=${rDefault.length}件`);
    console.log(`   Ruru残=${r2026.some(x => x.name === 'Ruru')} 月野かすみ=${r2026.some(x => x.name === '月野かすみ')} 松本いちか.img=${mi ? mi.image_url.split('/').pop() : 'なし'}`);
})().catch(e => { console.error('❌ エラー:', e.message); process.exit(1); });
