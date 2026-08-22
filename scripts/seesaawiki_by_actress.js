/**
 * seesaawiki (このAV女優の名前教えてwiki) スクレイパー
 *
 * sitemap.xml から全9,665ページURLを取得し、各女優ページから
 * プロフィールとFANZA product_idマッピングを収集する。
 *
 * AVWikiより3.4倍多く（9,665件）、素人・videocコンテンツに特化。
 *
 * 使い方:
 *   node scripts/seesaawiki_by_actress.js              # 通常実行
 *   node scripts/seesaawiki_by_actress.js --restart    # 最初からやり直し
 *   node scripts/seesaawiki_by_actress.js --apply-only # 収集済みデータをDBに反映
 *   node scripts/seesaawiki_by_actress.js --max 100    # テスト (100件)
 *
 * 出力:
 *   data/seesaawiki_actress_map.jsonl   女優名→FANZA product_id マッピング
 *   data/seesaawiki_progress.json       進捗チェックポイント
 */

const fs      = require('fs');
const path    = require('path');
const cheerio = require('cheerio');
const iconv   = require('iconv-lite');
const { fanzaShards } = require('./lib/d1');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATA_DIR      = path.join(__dirname, '..', 'data');
const MAP_FILE      = path.join(DATA_DIR, 'seesaawiki_actress_map.jsonl');
const PROGRESS_FILE = path.join(DATA_DIR, 'seesaawiki_progress.json');
const SITEMAP_URL   = 'https://seesaawiki.jp/av_neme/sitemap.xml';

const RATE_LIMIT_MS = 2500;  // 2.5秒インターバル（別サイトなのでAVWikiと競合しない）

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---- 引数 ----
const args       = process.argv.slice(2);
const RESTART    = args.includes('--restart');
const APPLY_ONLY = args.includes('--apply-only');
const APPEND     = args.includes('--append'); // 既存の出演者に追記する(既定は空欄のみ補完)
const maxIdx     = args.indexOf('--max');
const MAX_PAGES  = maxIdx !== -1 ? parseInt(args[maxIdx + 1], 10) : Infinity;

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

    // ---- FANZA product_id抽出 ----
    const pids = new Set();
    $('a[href*="fanza"], a[href*="dmm.co.jp"]').each((i, el) => {
        const href = $(el).attr('href') || '';
        // id%3D{pid} パターン（URLエンコードされた ?id=）
        const m = href.match(/id%3D([a-z0-9]+)/i);
        if (m && m[1] && m[1].length >= 5 && m[1].length <= 20) {
            pids.add(m[1].toLowerCase());
        }
    });

    // ---- MGS product_id抽出 ----
    const mgsPids = new Set();
    $('a[href*="mgstage"]').each((i, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/product\/(\w+)\//);
        if (m && m[1]) mgsPids.add(m[1]);
    });

    return {
        url,
        actressName,
        profile,
        pids:    Array.from(pids),
        mgsPids: Array.from(mgsPids),
    };
}

// ================================================================
//  収集済みデータをTurso DBに反映
// ================================================================
async function applyToDb() {
    if (!fs.existsSync(MAP_FILE)) {
        console.log('マッピングファイルが存在しません:', MAP_FILE);
        return;
    }

    // Turso廃止(2026-06)後もこのスクリプトだけ @libsql/client を require したままで
    // `Cannot find module '@libsql/client'` で起動すらできない状態だった。D1へ移行する。
    const fanza = fanzaShards();

    console.log('\n[DB反映] seesaawiki_actress_map.jsonl → Cloudflare D1 (FANZA)...');
    console.log(APPEND ? '  モード: 追記(既存の出演者に足す)' : '  モード: 空欄のみ補完(既存の出演者は書き換えない)');
    // 再取得すると同じ女優の行が追記されるため、女優名ごとに **最後の行だけ** を採用する。
    const rawLines = fs.readFileSync(MAP_FILE, 'utf-8').split('\n').filter(Boolean);
    const byName = new Map();
    for (const l of rawLines) {
        try { const e = JSON.parse(l); if (e && e.actressName) byName.set(e.actressName, e); } catch { /* 壊れた行は無視 */ }
    }
    const lines = [...byName.values()];
    console.log(`  ${rawLines.length.toLocaleString()}行 → 女優 ${lines.length.toLocaleString()}人(重複排除後)`);
    let totalUpdated = 0, totalProcessed = 0, skippedFilled = 0;

    for (const entry of lines) {
        const { actressName, pids } = entry;
        if (!actressName || !pids || pids.length === 0) continue;
        // 日付パターン（「2024年1月」等のseesaawiki月別ページ）はスキップ
        if (/\d{4}年\d+月/.test(actressName)) continue;

        // D1 のバインド変数は 1クエリ100個まで。IN句をちょうど100で組むと上限に張り付くので余裕を取る。
        const CHUNK = 50;
        for (let i = 0; i < pids.length; i += CHUNK) {
            const chunk = pids.slice(i, i + CHUNK);
            const ph = chunk.map(() => '?').join(',');
            try {
                const existing = await fanza.execute({
                    sql: `SELECT product_id, actresses FROM products WHERE product_id IN (${ph})`,
                    args: chunk,
                });
                const updates = [];
                for (const row of (existing.rows || existing)) {
                    const current = String(row.actresses || '').trim();
                    const isEmpty = !current || current === '----';
                    if (isEmpty) {
                        updates.push({ pid: row.product_id, newVal: actressName });
                    } else if (APPEND) {
                        const names = current.split(',').map(n => n.trim());
                        if (!names.includes(actressName)) updates.push({ pid: row.product_id, newVal: `${current}, ${actressName}` });
                    } else {
                        // 既に出演者が入っている作品は触らない。seesaawikiはコミュニティ編集で
                        // 別名・誤記も混ざるため、正規APIで取れている情報を上書き/汚染しない。
                        skippedFilled++;
                    }
                }
                if (updates.length > 0) {
                    await fanza.batch(
                        updates.map(({ pid, newVal }) => ({
                            // 空欄補完モードでは WHERE にも空条件を付ける。SELECT後に別ジョブ
                            // (avwiki backfill等)が先に埋めた場合でも、それを上書きしない。
                            sql: `UPDATE products SET actresses = ?, updated_at = ? WHERE product_id = ?`
                                 + (APPEND ? '' : " AND (actresses IS NULL OR TRIM(actresses)='' OR TRIM(actresses)='----')"),
                            args: [newVal, new Date().toISOString(), pid],
                        })),
                        'write'
                    );
                    totalUpdated += updates.length;
                }
                totalProcessed += chunk.length;
            } catch (e) {
                console.warn(`\n  [エラー] ${actressName}: ${e.message}`);
            }
        }
        process.stdout.write(`\r  ${totalProcessed.toLocaleString()}件確認 / ${totalUpdated.toLocaleString()}件更新`);
    }

    console.log(`\n  完了: ${totalUpdated.toLocaleString()}件更新 / 既に出演者ありで見送り: ${skippedFilled.toLocaleString()}件`);
    fanza.close();
}

// ================================================================
//  メイン
// ================================================================
async function main() {
    console.log('========================================');
    console.log('  Seesaawiki 女優スクレイパー');
    console.log('========================================');

    if (APPLY_ONLY) {
        await applyToDb();
        return;
    }

    // 進捗ロード
    let progress = { done: 0, found: 0, notFound: 0, totalPids: 0, completed: {} };
    if (!RESTART && fs.existsSync(PROGRESS_FILE)) {
        progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    }
    // 旧バージョンが completed を boolean で保存している場合があるので型を確認する
    const completedMap = (progress.completed && typeof progress.completed === 'object') ? progress.completed : {};
    if (typeof progress.completed !== 'object') progress.completed = {};
    const completedSet = new Set(Object.keys(completedMap));

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
                if (result.pids.length > 0 || result.mgsPids.length > 0) {
                    mapStream.write(JSON.stringify({
                        ...result,
                        scrapedAt: new Date().toISOString(),
                    }) + '\n');
                    progress.found++;
                    progress.totalPids += result.pids.length;
                    process.stdout.write(` → ${result.pids.length}作品\n`);
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
            process.stdout.write(`  [進捗] ${i+1}/${targets.length} 発見:${progress.found} 作品:${progress.totalPids.toLocaleString()} 残り≒${eta}分\n`);
        }

        await sleep(RATE_LIMIT_MS);
    }

    mapStream.end();
    // 【重要】以前はここで completed(=URL→trueの再開マップ)を boolean の true で
    // 上書きしており、**完走するたびに再開情報が消えて次回は全9,834ページを再取得**
    // していた。完了フラグは finished に分離し、completed はマップのまま保存する。
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ ...progress, finished: true }, null, 2));

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log('\n========================================');
    console.log(`  ✅ 完了 (${elapsed}分)`);
    console.log(`  処理: ${progress.done.toLocaleString()}件`);
    console.log(`  作品あり: ${progress.found.toLocaleString()}件`);
    console.log(`  作品マッピング: ${progress.totalPids.toLocaleString()}件`);
    console.log('========================================');
    console.log('\nDBに反映するには:');
    console.log('  node scripts/seesaawiki_by_actress.js --apply-only');
}

main().catch(err => {
    console.error('\n致命的エラー:', err);
    process.exit(1);
});
