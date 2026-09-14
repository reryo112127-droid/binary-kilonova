/**
 * seesaawiki (このAV女優の名前教えてwiki) スクレイパー
 *
 * sitemap.xml から全女優ページを取得し、各女優ページから
 * プロフィールと「その女優が出ている作品」（FANZA / MGS の品番）を収集する。
 * seesaawiki の強みは**素人名義・別名名義・名前なしで出ている作品の本人特定**で、
 * 正規API（FANZA/MGS）の出演者欄には「ひなこ 24歳 広告代理店」のような名義しか無い。
 *
 * v2（2026-09-14）で全面的に取り直した。v1 の問題:
 *   - MGS 品番を `/product/(\w+)/` で拾っていたため、URL(/product/product_detail/XXX/) の
 *     `product_detail` しか取れず、**MGS の本人特定が1件も使われていなかった**（3,995人ぶん）
 *   - FANZA 品番を `[a-z0-9]+` で拾っていたので `h_1133ubug00017` が `h` になり捨てられていた
 *   - ページ内の作品リンクを区別せず全部拾っていた。「ピックアップ作品」欄には本人が
 *     出ていない作品も並ぶので、**出演作品 > FANZA素人 / MGS動画 / 素人・別名名義・名前なし作品**
 *     だけを採る（ピックアップ・女優名検索・公式レーベルは外す）
 *
 * 使い方:
 *   node scripts/seesaawiki_by_actress.js                 # 収集（v2 の続きから）
 *   node scripts/seesaawiki_by_actress.js --restart       # v2 を最初からやり直し
 *   node scripts/seesaawiki_by_actress.js --max 100       # テスト (100件)
 *   node scripts/seesaawiki_by_actress.js --test-url <URL> [--out file]  # 1ページだけ解析して表示
 *   node scripts/seesaawiki_by_actress.js --apply-only    # 収集済みデータを D1 (FANZA/MGS) に反映
 *   node scripts/seesaawiki_by_actress.js --apply-local   # 同じ内容をローカル fanza.db / mgs.db に反映
 *     --max-updates N  1回の D1 反映の上限（既定 12000。FTS トリガ込みで約3書込/件）
 *     --dry-run        書き込まずに件数だけ数える
 *     --map <file>     反映に使うマップ（既定 v2）
 *
 * 出力:
 *   data/seesaawiki_actress_map_v2.jsonl   女優名→品番（採用した欄のみ）
 *   data/seesaawiki_progress_v2.json       進捗チェックポイント
 *   （v1 の data/seesaawiki_actress_map.jsonl はプロフィール補完用に読むだけで、もう書かない）
 */

const fs      = require('fs');
const path    = require('path');
const cheerio = require('cheerio');
const iconv   = require('iconv-lite');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATA_DIR      = path.join(__dirname, '..', 'data');
const MAP_FILE      = path.join(DATA_DIR, 'seesaawiki_actress_map_v2.jsonl');
const PROGRESS_FILE = path.join(DATA_DIR, 'seesaawiki_progress_v2.json');
const WHITELIST     = path.join(__dirname, '..', 'site', 'data', 'actress_whitelist.json');
const SITEMAP_URL   = 'https://seesaawiki.jp/av_neme/sitemap.xml';

const RATE_LIMIT_MS = 2500;  // 2.5秒インターバル（別サイトなのでAVWikiと競合しない）

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---- 引数 ----
const args        = process.argv.slice(2);
const argVal      = (k) => { const i = args.indexOf(k); return i !== -1 ? args[i + 1] : undefined; };
const RESTART     = args.includes('--restart');
const APPLY_ONLY  = args.includes('--apply-only');
const APPLY_LOCAL = args.includes('--apply-local');
const DRY_RUN     = args.includes('--dry-run');
const TEST_URL    = argVal('--test-url');
const MAX_PAGES   = argVal('--max') ? parseInt(argVal('--max'), 10) : Infinity;
const MAX_UPDATES = argVal('--max-updates') ? parseInt(argVal('--max-updates'), 10) : 12000;
const APPLY_MAP   = argVal('--map') ? path.resolve(argVal('--map')) : MAP_FILE;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ================================================================
//  HTTP取得（リトライ付き、EUC-JPデコード）
// ================================================================
async function fetchEucJp(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'ja' },
                signal: AbortSignal.timeout(30_000),
            });
            if (res.status === 429 || res.status === 503) {
                console.warn(`\n  [${res.status}] 60秒待機...`);
                await sleep(60_000);
                continue;
            }
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            return iconv.decode(Buffer.from(buf), 'EUC-JP');
        } catch (e) {
            if (i === retries - 1) throw e;
            await sleep(8_000 * (i + 1));
        }
    }
    return null;
}

// ================================================================
//  サイトマップから全URLを取得
// ================================================================
async function fetchSitemapUrls() {
    console.log('サイトマップ取得中...');
    const res = await fetch(SITEMAP_URL, { headers: { 'User-Agent': UA } });
    const xml = await res.text();
    const urls = (xml.match(/<loc>([^<]+)<\/loc>/g) || [])
        .map(m => m.replace(/<\/?loc>/g, ''))
        .filter(u => u.includes('/av_neme/d/'));  // 女優ページのみ
    console.log(`  ${urls.length.toLocaleString()} ページを取得`);
    return urls;
}

// ================================================================
//  URLからEUC-JP名をデコード（表示用）
// ================================================================
function decodeActressName(url) {
    try {
        const encoded = url.replace('https://seesaawiki.jp/av_neme/d/', '');
        const bytes = encoded.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        return iconv.decode(Buffer.from(bytes, 'binary'), 'EUC-JP');
    } catch { return url; }
}

// ================================================================
//  女優ページのパース
// ================================================================
// 採用しない小見出し（h4）。ピックアップ作品には本人が出ていない作品も並ぶ（2026-09-14 確認）。
const EXCLUDED_SECTIONS = /ピックアップ|女優名検索|公式レーベル/;

/**
 * FANZA の品番。リンクの形は3通りある（2026-09-14 実物で確認）:
 *   - 新: video.dmm.co.jp/av/content/?id=h_1594spro00142        → `%3Fid%3D`
 *   - 旧: www.dmm.co.jp/digital/videoc/-/detail/=/cid=ttjm145/  → `%2Fcid%3D`（前が '/'）
 *   - 画像: pics.dmm.co.jp/digital/amateur/ttjm145/ttjm145jm.jpg
 * h_1133ubug00017 のような '_' 入りも拾う。
 */
function fanzaIdOf(href) {
    const m = href.match(/(?:[?&/]|%3F|%26|%2F)c?id(?:=|%3D)([a-z0-9_]+)/i)
        || href.match(/pics\.dmm\.co\.jp\/(?:digital|mono)\/(?:amateur|video|videoc)\/([a-z0-9_]+)\//i);
    const id = m ? m[1].toLowerCase() : '';
    return id.length >= 4 && id.length <= 30 ? id : '';
}
/** MGS の品番（/product/product_detail/300MIUM-1329/） */
function mgsIdOf(href) {
    const m = href.match(/product_detail(?:\/|%2F)([A-Za-z0-9_-]+)/i);
    return m ? m[1].toUpperCase() : '';
}

function parsePage(html, url) {
    const $ = cheerio.load(html);

    // ---- 女優名 ----
    const actressName = decodeActressName(url);

    // ---- プロフィール ----
    const mainText = $('#main').text().replace(/\s+/g, ' ').trim();
    const profile = {};

    const nameM    = mainText.match(/名前[（(]女優名[）)][：:]\s*([^\s（(（]+)/);
    const aliasM   = mainText.match(/旧名義[&＆]別名[：:]\s*([^\n]+?)(?:\s{2}|生年月日)/);
    const bdM      = mainText.match(/生年月日[：:]\s*([\d年月日]+)/);
    const sizeM    = mainText.match(/身長とサイズ[：:]\s*([^\n]+?)(?:\s{2}|SNS|出演)/);
    const snsM     = mainText.match(/SNS[：:]\s*@?([A-Za-z0-9_]+)/);

    if (nameM)  profile.name    = nameM[1].trim();
    if (aliasM && aliasM[1].trim()) profile.alias = aliasM[1].trim();
    if (bdM)    profile.birthday = bdM[1].trim();
    if (sizeM)  profile.size    = sizeM[1].trim();
    if (snsM)   profile.twitter = snsM[1].trim();

    // ---- 作品（h3「出演作品」の下の、採用する h4 小見出しのリンクだけ）----
    const pids = new Set(), mgsPids = new Set();
    const sections = {};
    let h3 = '', h4 = '';
    $('#main').find('*').each((_, el) => {
        const $el = $(el);
        if ($el.is('h2, h3')) { h3 = $el.text().trim(); h4 = ''; return; }
        if ($el.is('h4')) { h4 = $el.text().trim(); return; }
        if (!$el.is('a')) return;
        if (!h3.includes('出演作品') || !h4 || EXCLUDED_SECTIONS.test(h4)) return;
        const href = $el.attr('href') || '';
        let id = '';
        if (/mgstage/i.test(href)) { id = mgsIdOf(href); if (id) mgsPids.add(id); }
        else if (/fanza|dmm\.co\.jp/i.test(href)) { id = fanzaIdOf(href); if (id) pids.add(id); }
        if (id) sections[h4.slice(0, 20)] = (sections[h4.slice(0, 20)] || 0) + 1;
    });

    return {
        v: 2,
        url,
        actressName,
        profile,
        pids:    Array.from(pids),
        mgsPids: Array.from(mgsPids),
        sections,
    };
}

// ================================================================
//  収集済みデータを DB に反映（D1 / ローカル共通のロジック）
// ================================================================
const normName = (s) => String(s || '').trim().replace(/\s+/g, '');
const aliasesOf = (p) => String(p?.alias ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .split(/[・／/、,，]/).map(s => s.trim()).filter(s => s.length > 1);

function loadEntries() {
    if (!fs.existsSync(APPLY_MAP)) {
        console.log('マッピングファイルが存在しません:', APPLY_MAP);
        return [];
    }
    // 同じ女優の行が追記されることがあるので、女優名ごとに **最後の行だけ** を採用する。
    const byName = new Map();
    for (const l of fs.readFileSync(APPLY_MAP, 'utf-8').split('\n')) {
        if (!l.trim()) continue;
        try { const e = JSON.parse(l); if (e && e.actressName) byName.set(e.actressName, e); } catch { /* 壊れた行は無視 */ }
    }
    // 実在女優だけ（seesaawiki には「俺の素人」「マルチーズ」のようなレーベル名のページもある）
    let whitelist = null;
    try { whitelist = new Set(JSON.parse(fs.readFileSync(WHITELIST, 'utf-8')).map(normName)); }
    catch { console.warn('  ⚠ actress_whitelist.json が読めないので実在女優の絞り込みをしない'); }
    const out = [];
    let skipped = 0;
    for (const e of byName.values()) {
        if (/\d{4}年\d+月/.test(e.actressName)) continue;          // 月別ページ
        if (whitelist && !whitelist.has(normName(e.actressName))) { skipped++; continue; }
        if (!(e.pids || []).length && !(e.mgsPids || []).length) continue;
        out.push(e);
    }
    console.log(`  女優 ${byName.size.toLocaleString()}人 → 反映対象 ${out.length.toLocaleString()}人（女優以外のページ ${skipped}件を除外）`);
    return out;
}

/**
 * 1作品の出演者欄をどう変えるか。null = 変えない。
 * 空欄なら女優名を入れ、既に出演者がいればこの女優（または別名）が居ないときだけ末尾に足す。
 * 元の名義（「ひなこ 24歳 広告代理店」）は消さない。
 */
function nextCast(current, name, aliases) {
    const cur = String(current || '').trim();
    if (!cur || cur === '----') return name;
    const names = cur.split(/[,、]/).map(n => n.trim()).filter(Boolean);
    const present = names.some(n => n === name || n.startsWith(name + '（') || n.startsWith(name + '('))
        || aliases.some(a => names.some(n => n === a || n.includes(a)));
    return present ? null : `${cur}, ${name}`;
}

async function applyToD1() {
    const { fanzaShards, d1 } = require('./lib/d1');
    const targets = [
        { label: 'FANZA', db: fanzaShards(), key: 'pids' },
        { label: 'MGS',   db: d1('mgs'),     key: 'mgsPids' },
    ];
    console.log(`\n[D1反映] ${path.basename(APPLY_MAP)} → FANZA / MGS（上限 ${MAX_UPDATES}件${DRY_RUN ? '・dry-run' : ''}）`);
    const entries = loadEntries();
    const stat = { checked: 0, filled: 0, appended: 0, present: 0, errors: 0 };
    let budget = MAX_UPDATES;
    outer:
    for (const { label, db, key } of targets) {
        for (const e of entries) {
            const ids = [...new Set(e[key] || [])];
            const aliases = aliasesOf(e.profile);
            // D1 のバインド変数は 1クエリ100個まで。余裕を取って50件ずつ。
            for (let i = 0; i < ids.length; i += 50) {
                const chunk = ids.slice(i, i + 50);
                try {
                    const r = await db.execute({
                        sql: `SELECT product_id, actresses FROM products WHERE product_id IN (${chunk.map(() => '?').join(',')})`,
                        args: chunk,
                    });
                    const updates = [];
                    for (const row of (r.rows || r)) {
                        stat.checked++;
                        const nv = nextCast(row.actresses, e.actressName, aliases);
                        if (nv === null) { stat.present++; continue; }
                        const empty = !String(row.actresses || '').trim() || String(row.actresses).trim() === '----';
                        updates.push({ pid: row.product_id, nv, old: row.actresses ?? null, empty });
                    }
                    if (!updates.length) continue;
                    const batch = updates.slice(0, budget);
                    if (!DRY_RUN) {
                        await db.batch(batch.map(u => ({
                            // 読んだときの値のままのときだけ書く（別ジョブが先に書き換えていたら触らない）
                            sql: 'UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ? AND actresses IS ?',
                            args: [u.nv, new Date().toISOString(), u.pid, u.old],
                        })), 'write');
                    }
                    for (const u of batch) u.empty ? stat.filled++ : stat.appended++;
                    budget -= batch.length;
                    if (budget <= 0) { console.log(`\n  上限 ${MAX_UPDATES}件に達したので中断（次回の実行で続きから）`); break outer; }
                } catch (err) {
                    stat.errors++;
                    if (stat.errors <= 5) console.warn(`\n  [${label} エラー] ${e.actressName}: ${err.message}`);
                    if (stat.errors >= 50) { console.warn('\n  エラーが多いので中断（D1 枠切れの可能性）'); break outer; }
                }
            }
            process.stdout.write(`\r  [${label}] 確認 ${stat.checked.toLocaleString()} / 空欄補完 ${stat.filled} / 追記 ${stat.appended}`);
        }
        console.log('');
    }
    console.log(`  完了: 確認 ${stat.checked.toLocaleString()}件 / 空欄補完 ${stat.filled}件 / 追記 ${stat.appended}件 / 既に掲載 ${stat.present}件 / エラー ${stat.errors}件`);
    for (const { db } of targets) try { db.close?.(); } catch { }
}

function applyToLocal() {
    const Database = require('better-sqlite3');
    const dbs = [
        { label: 'FANZA', file: path.join(DATA_DIR, 'fanza.db'), key: 'pids' },
        { label: 'MGS',   file: path.join(DATA_DIR, 'mgs.db'),   key: 'mgsPids' },
    ];
    console.log(`\n[ローカル反映] ${path.basename(APPLY_MAP)} → data/fanza.db / data/mgs.db${DRY_RUN ? '（dry-run）' : ''}`);
    const entries = loadEntries();
    for (const { label, file, key } of dbs) {
        if (!fs.existsSync(file)) { console.log(`  ${label}: ${file} が無いのでスキップ`); continue; }
        const db = new Database(file);
        const get = db.prepare('SELECT actresses FROM products WHERE product_id = ?');
        const up = db.prepare("UPDATE products SET actresses = ?, updated_at = datetime('now','localtime') WHERE product_id = ?");
        const stat = { checked: 0, filled: 0, appended: 0 };
        const run = db.transaction(() => {
            for (const e of entries) {
                const aliases = aliasesOf(e.profile);
                for (const id of new Set(e[key] || [])) {
                    const row = get.get(id);
                    if (!row) continue;
                    stat.checked++;
                    const nv = nextCast(row.actresses, e.actressName, aliases);
                    if (nv === null) continue;
                    const empty = !String(row.actresses || '').trim() || String(row.actresses).trim() === '----';
                    if (!DRY_RUN) up.run(nv, id);
                    empty ? stat.filled++ : stat.appended++;
                }
            }
        });
        run();
        db.close();
        console.log(`  ${label}: 確認 ${stat.checked.toLocaleString()}件 / 空欄補完 ${stat.filled}件 / 追記 ${stat.appended}件`);
    }
}

// ================================================================
//  メイン
// ================================================================
async function main() {
    console.log('========================================');
    console.log('  Seesaawiki 女優スクレイパー (v2)');
    console.log('========================================');

    if (TEST_URL) {
        const html = await fetchEucJp(TEST_URL);
        const r = parsePage(html, TEST_URL);
        console.log(JSON.stringify({ actressName: r.actressName, profile: r.profile, sections: r.sections,
            pids: r.pids.length, mgsPids: r.mgsPids.length, pidSample: r.pids.slice(0, 8), mgsSample: r.mgsPids.slice(0, 8) }, null, 1));
        const out = argVal('--out');
        if (out) fs.appendFileSync(out, JSON.stringify({ ...r, scrapedAt: new Date().toISOString() }) + '\n');
        return;
    }
    if (APPLY_ONLY) { await applyToD1(); return; }
    if (APPLY_LOCAL) { applyToLocal(); return; }

    // 進捗ロード
    let progress = { done: 0, found: 0, notFound: 0, totalPids: 0, totalMgsPids: 0, completed: {} };
    if (!RESTART && fs.existsSync(PROGRESS_FILE)) {
        progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    }
    // completed は URL→true の再開マップ。完走時も boolean で潰さない（finished に分離）
    if (!progress.completed || typeof progress.completed !== 'object') progress.completed = {};
    const completedSet = new Set(Object.keys(progress.completed));

    // サイトマップから全URL取得
    const allUrls = await fetchSitemapUrls();
    const targets = allUrls
        .filter(u => !completedSet.has(u))
        .slice(0, MAX_PAGES);

    console.log(`  処理対象: ${targets.length.toLocaleString()}件 (スキップ: ${completedSet.size.toLocaleString()}件)`);
    console.log('');

    const mapStream = fs.createWriteStream(MAP_FILE, { flags: RESTART ? 'w' : 'a' });
    const startTime = Date.now();

    for (let i = 0; i < targets.length; i++) {
        const url = targets[i];
        const name = decodeActressName(url);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const pct = ((i / targets.length) * 100).toFixed(1);

        process.stdout.write(`[${i + 1}/${targets.length}] ${name} (${pct}%, ${elapsed}s)`);

        try {
            const html = await fetchEucJp(url);
            if (!html) {
                process.stdout.write(' → 404\n');
                progress.notFound++;
            } else {
                const result = parsePage(html, url);
                if (result.pids.length > 0 || result.mgsPids.length > 0 || Object.keys(result.profile).length > 0) {
                    mapStream.write(JSON.stringify({
                        ...result,
                        scrapedAt: new Date().toISOString(),
                    }) + '\n');
                    progress.found++;
                    progress.totalPids += result.pids.length;
                    progress.totalMgsPids = (progress.totalMgsPids || 0) + result.mgsPids.length;
                    process.stdout.write(` → FANZA ${result.pids.length} / MGS ${result.mgsPids.length}\n`);
                } else {
                    process.stdout.write(` → 作品なし\n`);
                    progress.notFound++;
                }
            }
            progress.completed[url] = true;
            progress.done++;
        } catch (e) {
            process.stdout.write(` → エラー: ${e.message}\n`);
        }

        // チェックポイント（20件ごと）
        if ((i + 1) % 20 === 0) {
            fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
            const eta = ((targets.length - i - 1) * RATE_LIMIT_MS / 1000 / 60).toFixed(0);
            process.stdout.write(`  [進捗] ${i+1}/${targets.length} 発見:${progress.found} FANZA:${progress.totalPids.toLocaleString()} MGS:${(progress.totalMgsPids || 0).toLocaleString()} 残り≒${eta}分\n`);
        }

        await sleep(RATE_LIMIT_MS);
    }

    mapStream.end();
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ ...progress, finished: targets.length === 0 || progress.done >= allUrls.length }, null, 2));

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log('\n========================================');
    console.log(`  ✅ 完了 (${elapsed}分)`);
    console.log(`  処理: ${progress.done.toLocaleString()}件`);
    console.log(`  作品あり: ${progress.found.toLocaleString()}件`);
    console.log(`  品番: FANZA ${progress.totalPids.toLocaleString()} / MGS ${(progress.totalMgsPids || 0).toLocaleString()}`);
    console.log('========================================');
    console.log('\nDBに反映するには:');
    console.log('  node scripts/seesaawiki_by_actress.js --apply-only   # D1');
    console.log('  node scripts/seesaawiki_by_actress.js --apply-local  # ローカル');
}

module.exports = { parsePage, nextCast, aliasesOf, fanzaIdOf, mgsIdOf };

if (require.main === module) {
    main().catch(err => {
        console.error('\n致命的エラー:', err);
        process.exit(1);
    });
}
