#!/usr/bin/env node
/**
 * av-wiki.net から「出演者不明の作品」だけを狙って出演者を回収する。
 *
 * 従来の scrape_avwiki_products.js は事前に作った15,000件のURLリストを順に巡回する方式で、
 * (1) リストが 2026-03-23 で凍結、(2) --fetch-urls がどのスケジュールからも呼ばれない、
 * ため av-wiki.net の全187,014ページに対し 8% しか触れていなかった。
 * 全部巡回すると 187,014 × 15秒 ≒ 780時間 で現実的でない。
 *
 * そこで方式を逆にする:
 *   1. サイトマップ(188本)から **全ページのスラグ集合** を作る … 188リクエストだけ
 *   2. 自DBの「出演者が空の作品」の品番を avwiki のスラグ形式へ変換
 *      (例: 107SDMM-231 → sdmm-231 / h_1133ubug00017 → ubug-17)
 *   3. **集合に存在するものだけ** を実際に取得する
 * これで「avwikiに載っていない作品」へのリクエストがゼロになり、必要最小限で完全回収できる。
 *
 * 使い方:
 *   node scripts/avwiki_backfill_actresses.js --refresh-sitemap  # スラグ集合を更新(週1想定)
 *   node scripts/avwiki_backfill_actresses.js --dry-run          # 回収可能件数を数えるだけ
 *   node scripts/avwiki_backfill_actresses.js --limit 2000       # 実際に回収(既定2000件/回)
 *   node scripts/avwiki_backfill_actresses.js --only mgs         # 片側だけ
 *
 * 無料枠: D1書き込みは「更新できた件数 × 約2行(FTSトリガ込み)」だけ。--limit で上限を持つ。
 * 進捗: data/avwiki_backfill_checked.json (調べ済み品番。次回はスキップ)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { d1, fanzaShards } = require('./lib/d1');

const DATA = path.join(__dirname, '..', 'data');
const SLUG_FILE = path.join(DATA, 'avwiki_sitemap_slugs.json');
const CHECKED_FILE = path.join(DATA, 'avwiki_backfill_checked.json');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const REFRESH = has('--refresh-sitemap');
const DRY = has('--dry-run');
const LIMIT = parseInt(val('--limit', '2000'), 10);
const ONLY = String(val('--only', '')).toLowerCase();
const INTERVAL = parseInt(val('--interval', '1500'), 10);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { try { const r = await fetch(u, { headers: { 'User-Agent': UA } }); return r.ok ? await r.text() : null; } catch { return null; } };

// ---- サイトマップから全スラグを集める ----
async function refreshSitemap() {
    const idx = await get('https://av-wiki.net/sitemap.xml');
    if (!idx) throw new Error('sitemap.xml を取得できません');
    const subs = [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]).filter(u => /post-sitemap/.test(u));
    console.log(`post-sitemap: ${subs.length}本`);
    const slugs = new Set();
    for (let i = 0; i < subs.length; i++) {
        const xml = await get(subs[i]);
        if (xml) {
            for (const m of xml.matchAll(/<loc>https:\/\/av-wiki\.net\/([^<\/]+)\/?<\/loc>/g)) {
                slugs.add(decodeURIComponent(m[1]).replace(/\/$/, '').toLowerCase());
            }
        }
        if ((i + 1) % 20 === 0) process.stdout.write(`  ${i + 1}/${subs.length} (${slugs.size.toLocaleString()}スラグ)\r`);
        await sleep(300);
    }
    fs.writeFileSync(SLUG_FILE, JSON.stringify([...slugs]));
    console.log(`\n✅ スラグ集合を保存: ${slugs.size.toLocaleString()}件 → ${SLUG_FILE}`);
    return slugs;
}

// ---- 品番 → avwiki スラグ候補 ----
function slugCandidates(pid) {
    const out = new Set();
    const lower = String(pid).toLowerCase();
    out.add(lower);
    const core = lower.replace(/^h_\d+/, '').replace(/^\d+/, '');
    const m = core.match(/^([a-z]+)-?0*(\d+)$/);
    if (m) { out.add(`${m[1]}-${parseInt(m[2], 10)}`); out.add(`${m[1]}-${m[2]}`); }
    return [...out];
}

function parseActresses(html) {
    const $ = cheerio.load(html);
    let found = null;
    $('dl dt').each((i, el) => {
        if ($(el).text().trim().replace(/[：:]\s*$/, '') !== 'AV女優名') return;
        const names = [];
        $(el).next('dd').find('a').each((j, a) => {
            const t = $(a).text().trim();
            // 「＊＊＊」は avwiki の『出演者不明』プレースホルダ。名前として保存すると
            // 出演者ありに見えて以後の補完対象から外れてしまうので必ず捨てる。
            if (t && t !== '不明' && t !== '–' && !/^[＊*\s]+$/.test(t)) names.push(t);
        });
        if (names.length) found = names;
    });
    return found;
}

// ページに載っている FANZA品番 / MGS品番 を取り出す（本人確認用）
function parseIds(html) {
    const $ = cheerio.load(html);
    const f = {};
    $('dl dt').each((i, el) => { f[$(el).text().trim().replace(/[：:]\s*$/, '')] = $(el).next('dd').text().trim(); });
    return { fanza: (f['FANZA品番'] || '').toLowerCase(), mgs: (f['MGS品番'] || '').toUpperCase() };
}

// 品番の芯（英字＋先頭0を除いた数字）に正規化して比較する。
// 例: scute00718 / scute718 / 229SCUTE-718 → すべて "scute718"
function coreId(id) {
    let s = String(id || '').toLowerCase().replace(/^h_\d+/, '').replace(/^\d+/, '').replace(/[^a-z0-9]/g, '');
    const m = s.match(/^([a-z]+)0*(\d+)$/);
    return m ? m[1] + m[2] : s;
}

// スラグ一致だけで書き込むと、メーカー違いで品番プレフィクスが衝突したときに
// **別作品の女優名を書いてしまう**。ページ側の FANZA品番/MGS品番 と芯が一致するときだけ採用する。
function idMatches(pid, html) {
    const ids = parseIds(html);
    const want = coreId(pid);
    if (!want) return false;
    return (ids.fanza && coreId(ids.fanza) === want) || (ids.mgs && coreId(ids.mgs) === want);
}

async function main() {
    let slugs;
    if (REFRESH || !fs.existsSync(SLUG_FILE)) slugs = await refreshSitemap();
    else { slugs = new Set(JSON.parse(fs.readFileSync(SLUG_FILE, 'utf-8'))); console.log(`スラグ集合: ${slugs.size.toLocaleString()}件 (--refresh-sitemap で更新)`); }
    if (REFRESH && DRY) return;

    const checked = new Set(fs.existsSync(CHECKED_FILE) ? JSON.parse(fs.readFileSync(CHECKED_FILE, 'utf-8')) : []);
    const NO = "(actresses IS NULL OR TRIM(actresses)='' OR TRIM(actresses)='----')";

    const targets = [];
    for (const pf of ['mgs', 'fanza']) {
        if (ONLY && ONLY !== pf) continue;
        const db = pf === 'mgs' ? d1('mgs') : fanzaShards();
        const r = await db.execute({ sql: `SELECT product_id FROM products WHERE ${NO}`, args: [] });
        for (const row of (r.rows || r)) {
            const pid = String(row.product_id);
            if (checked.has(pid)) continue;
            const hit = slugCandidates(pid).find(s => slugs.has(s));
            if (hit) targets.push({ pf, pid, slug: hit });
        }
    }
    console.log(`\n出演者不明のうち avwiki にページが存在する作品: ${targets.length.toLocaleString()}件 (調査済みを除く)`);
    if (DRY) {
        const byPf = {}; for (const t of targets) byPf[t.pf] = (byPf[t.pf] || 0) + 1;
        console.log('  内訳:', JSON.stringify(byPf));
        console.log('  例:', targets.slice(0, 5).map(t => `${t.pid}→/${t.slug}/`).join(', '));
        return;
    }

    const todo = targets.slice(0, LIMIT);
    console.log(`今回取得: ${todo.length.toLocaleString()}件 (間隔${INTERVAL}ms、推定${(todo.length * INTERVAL / 60000).toFixed(0)}分)\n`);
    let filled = 0, noData = 0, mismatch = 0;
    const now = new Date().toISOString();
    for (const t of todo) {
        const html = await get(`https://av-wiki.net/${t.slug}/`);
        await sleep(INTERVAL);
        checked.add(t.pid);
        const acts = html ? parseActresses(html) : null;
        if (!acts) { noData++; continue; }
        if (!idMatches(t.pid, html)) { mismatch++; continue; }   // 別作品への誤爆を防ぐ
        const str = acts.join(', ');
        const db = t.pf === 'mgs' ? d1('mgs') : fanzaShards();
        try {
            await db.execute({
                sql: `UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ? AND ${NO}`,
                args: [str, now, t.pid],
            });
            filled++;
            if (filled % 25 === 0 || filled < 6) console.log(`  [${filled}] ${t.pf.toUpperCase()} ${t.pid} → ${str}`);
        } catch (e) { console.warn(`  [更新失敗] ${t.pid}: ${e.message}`); }
        if (filled % 50 === 0) fs.writeFileSync(CHECKED_FILE, JSON.stringify([...checked]));
    }
    fs.writeFileSync(CHECKED_FILE, JSON.stringify([...checked]));
    console.log(`\n✅ 出演者を補完: ${filled.toLocaleString()}件 / ページはあるが出演者記載なし: ${noData.toLocaleString()}件`);
    console.log(`   残り: 次回以降に持ち越し(--limit で1回あたりの件数を調整)`);
}

main().catch(e => { console.error(e); process.exit(1); });
