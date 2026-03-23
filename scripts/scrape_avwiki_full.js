/**
 * scrape_avwiki_full.js
 *
 * av-wiki.net の全女優ページ（約9,400件）を1ヶ月かけてゆっくり収集する。
 *
 * フェーズ1: sitemapから全女優URLリストを取得 → data/avwiki_url_list.json
 * フェーズ2: 各URLを300秒(5分)間隔でスクレイプ → data/avwiki_full.jsonl
 *
 * 使い方:
 *   node scripts/scrape_avwiki_full.js              # 通常実行
 *   node scripts/scrape_avwiki_full.js --fetch-urls  # URLリスト取得のみ
 *   node scripts/scrape_avwiki_full.js --dry-run     # 最初の3件だけ試す
 *   node scripts/scrape_avwiki_full.js --interval 60 # インターバルを60秒に変更
 *
 * 進捗は data/avwiki_full_progress.json に保存（Ctrl+Cで中断→再実行で続き）
 */

const fs   = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const DATA_DIR      = path.join(__dirname, '..', 'data');
const URL_LIST_FILE = path.join(DATA_DIR, 'avwiki_url_list.json');
const OUTPUT_JSONL  = path.join(DATA_DIR, 'avwiki_full.jsonl');
const PROGRESS_FILE = path.join(DATA_DIR, 'avwiki_full_progress.json');

// ========== 引数 ==========
const args       = process.argv.slice(2);
const FETCH_ONLY = args.includes('--fetch-urls');
const DRY_RUN    = args.includes('--dry-run');
const intIdx     = args.indexOf('--interval');
const INTERVAL_MS = intIdx !== -1 ? parseInt(args[intIdx + 1], 10) * 1000 : 600_000; // デフォルト10分

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ========== HTTP取得 ==========
async function fetchHtml(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': UA,
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
                },
                signal: AbortSignal.timeout(30_000),
            });
            if (res.status === 429 || res.status === 503) {
                console.warn(`  [${res.status}] ${url} — 60秒待機`);
                await sleep(60_000);
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (e) {
            if (i === retries - 1) throw e;
            console.warn(`  [リトライ ${i + 1}] ${e.message}`);
            await sleep(10_000 * (i + 1));
        }
    }
}

// ========== フェーズ1: URLリスト収集 ==========
async function fetchAllUrls() {
    console.log('[フェーズ1] av-wiki.net sitemap から全女優URLを収集...\n');

    const allUrls = [];
    for (let i = 1; i <= 15; i++) {
        const url = i === 1
            ? 'https://av-wiki.net/post_tag-sitemap.xml'
            : `https://av-wiki.net/post_tag-sitemap${i}.xml`;

        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!res.ok) {
            console.log(`  sitemap${i}: 終端 (${res.status})`);
            break;
        }
        const text = await res.text();
        const urls = [...text.matchAll(/<loc>(.*?)<\/loc>/g)]
            .map(m => m[1])
            .filter(u => u.includes('/av-actress/'));

        allUrls.push(...urls);
        console.log(`  sitemap${i}: ${urls.length}件 (累計: ${allUrls.length}件)`);

        await sleep(3_000); // sitemapは3秒間隔
    }

    // 重複排除・ソート
    const unique = [...new Set(allUrls)].sort();
    fs.writeFileSync(URL_LIST_FILE, JSON.stringify(unique, null, 2));
    console.log(`\n✅ 合計 ${unique.length.toLocaleString()} URLを保存: ${URL_LIST_FILE}`);
    console.log(`   ${INTERVAL_MS / 1000}秒間隔で: ${(unique.length * INTERVAL_MS / 1000 / 86400).toFixed(1)}日`);
    return unique;
}

// ========== フェーズ2: ページパース ==========
function parseActressPage(html, pageUrl) {
    const $ = cheerio.load(html);
    const result = {
        url:        pageUrl,
        slug:       pageUrl.replace(/.*\/av-actress\/(.+?)\/?$/, '$1'),
        scraped_at: new Date().toISOString(),
    };

    // ページタイトル（女優名取得に使う）
    const titleText = $('title').text().trim();
    const h1Text    = $('h1').first().text().trim();
    result.page_title = h1Text || titleText.split('–')[0].trim();

    // .actress-data dl の dt → dd 全フィールド
    const fieldMap = {};
    $('.actress-data dl dt, .actress-profile dl dt').each((i, el) => {
        const label = $(el).text().trim().replace(/[：:]\s*$/, '');
        const $dd   = $(el).next('dd');
        fieldMap[label] = { text: $dd.text().trim(), $el: $dd };
    });

    // ─── AV女優名 ───
    const nameRaw = (fieldMap['AV女優名'] || {}).text || '';
    if (nameRaw) {
        // "AIKA（あいか）- aika" → { name: 'AIKA', ruby: 'あいか', romaji: 'aika' }
        const nameM = nameRaw.match(/^(.+?)（(.+?)）(?:\s*-\s*(.+))?$/);
        if (nameM) {
            result.name   = nameM[1].trim();
            result.ruby   = nameM[2].trim();
            result.romaji = nameM[3]?.trim() || null;
        } else {
            result.name = nameRaw.split(/[（\s-]/)[0].trim();
        }
    }

    // ─── 別名義 ───
    const aliasRaw = (fieldMap['別名義'] || fieldMap['旧名'] || fieldMap['旧芸名'] || fieldMap['別名'] || {}).text || '';
    if (aliasRaw && !['– – –', '---', '-', ''].includes(aliasRaw)) {
        const aliases = aliasRaw
            .split(/[,、・\n]/)
            .map(s => {
                const m = s.match(/^(.+?)（/);
                return (m ? m[1] : s).trim();
            })
            .filter(s => s && !['–', '-', '—', '　', '– – –'].includes(s));
        if (aliases.length > 0) result.aliases = aliases;
    }

    // ─── 生年月日 ───
    const bdRaw = (fieldMap['生年月日'] || {}).text || '';
    if (bdRaw && bdRaw !== '– – –' && bdRaw !== '-') {
        result.birthday_raw = bdRaw;
        // YYYY年MM月DD日 → YYYY-MM-DD
        const m = bdRaw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
        if (m) {
            result.birthday = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
        }
    }

    // ─── サイズ ───
    const sizeRaw = (fieldMap['サイズ'] || {}).text || '';
    if (sizeRaw && sizeRaw !== '– – –' && sizeRaw !== '-') {
        result.size_raw = sizeRaw;
        const hM  = sizeRaw.match(/T(\d{2,3})/i);
        const bM  = sizeRaw.match(/B(\d{2,3})/i);
        const wM  = sizeRaw.match(/W(\d{2,3})/i);
        const hipM = sizeRaw.match(/H(\d{2,3})/i);
        const cupM = sizeRaw.match(/([A-Z])カップ/);
        if (hM)   result.height = parseInt(hM[1]);
        if (bM)   result.bust   = parseInt(bM[1]);
        if (wM)   result.waist  = parseInt(wM[1]);
        if (hipM) result.hip    = parseInt(hipM[1]);
        if (cupM) result.cup    = cupM[1];
    }

    // ─── 血液型 ───
    const bloodRaw = (fieldMap['血液型'] || {}).text || '';
    if (bloodRaw && !['– – –', '-'].includes(bloodRaw)) {
        const bm = bloodRaw.match(/([ABO]B?)型/i);
        if (bm) result.blood_type = bm[1].toUpperCase();
    }

    // ─── 出身地 ───
    const birthPlace = (fieldMap['出身地'] || fieldMap['出身'] || {}).text || '';
    if (birthPlace && !['– – –', '-'].includes(birthPlace)) {
        result.birth_place = birthPlace;
    }

    // ─── 趣味・特技 ───
    const hobby = (fieldMap['趣味'] || fieldMap['趣味・特技'] || {}).text || '';
    if (hobby && !['– – –', '-'].includes(hobby)) result.hobby = hobby;

    // ─── デビュー ───
    const debut = (fieldMap['デビュー'] || fieldMap['デビュー年'] || {}).text || '';
    if (debut && !['– – –', '-'].includes(debut)) result.debut = debut;

    // ─── SNS ───
    const sns$ = (fieldMap['SNS'] || fieldMap['公式SNS'] || {}).$el;
    if (sns$) {
        sns$.find('a').each((i, a) => {
            const href = $(a).attr('href') || '';
            if (href.match(/(?:twitter\.com|x\.com)\//i)) {
                const m = href.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)/i);
                if (m && !['intent', 'search', 'share', 'i'].includes(m[1])) {
                    result.twitter = m[1];
                }
            }
            if (href.includes('instagram.com/')) {
                const m = href.match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
                if (m && m[1] !== 'p') result.instagram = m[1];
            }
            if (href.includes('tiktok.com/@')) {
                const m = href.match(/tiktok\.com\/@([A-Za-z0-9_.]+)/i);
                if (m) result.tiktok = m[1];
            }
        });
        // テキストからも補完
        const snsText = sns$.text();
        if (!result.twitter) {
            const m = snsText.match(/(?:Twitter|X)\s*[：:]\s*[@＠]([A-Za-z0-9_]+)/i);
            if (m) result.twitter = m[1];
        }
        if (!result.instagram) {
            const m = snsText.match(/Instagram\s*[：:]\s*[@＠]?([A-Za-z0-9_.]+)/i);
            if (m && !['–', '-', '未登録'].includes(m[1])) result.instagram = m[1];
        }
    }

    // ─── 豊胸・整形（ページ本文から検索） ───
    const bodyText = $('article, .entry-content, .post-content, main').text().replace(/\s+/g, ' ');
    if (bodyText.includes('豊胸')) {
        result.augmented = true;
        // 豊胸に関するコンテキスト文を抽出
        const idx = bodyText.indexOf('豊胸');
        result.augmented_context = bodyText.substring(Math.max(0, idx - 20), idx + 60).trim();
    } else if (bodyText.includes('天然')) {
        result.augmented = false;
    }

    // ─── 引退・活動状況 ───
    if (bodyText.includes('引退')) result.retired = true;

    // ─── 公式サイト ───
    const officialUrl = (fieldMap['公式サイト'] || fieldMap['オフィシャルサイト'] || {}).$el;
    if (officialUrl) {
        const link = officialUrl.find('a').first().attr('href');
        if (link) result.official_url = link;
    }

    return result;
}

// ========== 進捗管理 ==========
function loadProgress() {
    if (fs.existsSync(PROGRESS_FILE)) {
        return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    }
    return { completed: new Set(), found: 0, with_sns: 0, with_aliases: 0, with_birthday: 0, with_augmented: 0, errors: 0 };
}

function saveProgress(p) {
    const toSave = { ...p, completed: [...p.completed] };
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(toSave, null, 2));
}

function loadProgressFromFile() {
    if (!fs.existsSync(PROGRESS_FILE)) {
        return { completed: new Set(), found: 0, with_sns: 0, with_aliases: 0, with_birthday: 0, with_augmented: 0, errors: 0 };
    }
    const raw = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    raw.completed = new Set(raw.completed || []);
    return raw;
}

// ========== フェーズ2: スクレイプ ==========
async function scrapeAll(urls, progress) {
    // 日本語エンコードのタグアーカイブページはスキップ（プロフィールデータなし）
    const profileUrls = urls.filter(u => !u.includes('%'));
    const skipped = urls.length - profileUrls.length;
    if (skipped > 0) {
        console.log(`  [フィルタ] 日本語スラグ(タグアーカイブ) ${skipped.toLocaleString()}件をスキップ`);
    }

    // 既存の avwiki_profiles.json で完了済みのURLを除外
    const existingProfiles = (() => {
        const p = path.join(DATA_DIR, 'avwiki_profiles.json');
        if (!fs.existsSync(p)) return new Set();
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return new Set(Object.values(data).filter(v => v.url).map(v => v.url));
    })();
    if (existingProfiles.size > 0) {
        console.log(`  [既存] avwiki_profiles.json から ${existingProfiles.size.toLocaleString()}件のURL除外`);
    }

    const pending = profileUrls.filter(u => !progress.completed.has(u) && !existingProfiles.has(u));
    const total   = profileUrls.length;

    const intervalSec = INTERVAL_MS / 1000;
    const estimateDays = (pending.length * INTERVAL_MS / 1000 / 86400).toFixed(1);

    console.log('\n[フェーズ2] 女優ページスクレイプ開始');
    console.log(`  対象: ${total.toLocaleString()}ページ`);
    console.log(`  完了: ${progress.completed.size.toLocaleString()}ページ`);
    console.log(`  残り: ${pending.length.toLocaleString()}ページ`);
    console.log(`  間隔: ${intervalSec}秒(${(intervalSec/60).toFixed(0)}分) / 推定: ${estimateDays}日`);
    if (DRY_RUN) console.log('  [DRY RUN] 最初の3件のみ処理');
    console.log('');

    const outputStream = fs.createWriteStream(OUTPUT_JSONL, { flags: 'a' });

    let processed = 0;
    const limit = DRY_RUN ? 3 : Infinity;

    for (const url of pending) {
        if (processed >= limit) break;

        const idx = progress.completed.size + 1;
        const pct = ((idx / total) * 100).toFixed(1);
        process.stdout.write(`[${idx}/${total} ${pct}%] ${url.replace('https://av-wiki.net/av-actress/','')} ... `);

        try {
            const html = await fetchHtml(url);
            const data = parseActressPage(html, url);

            // not_found チェック（404ページ等）
            if (!data.name && !data.page_title) {
                process.stdout.write('SKIP (no data)\n');
                progress.completed.add(url);
                continue;
            }

            outputStream.write(JSON.stringify(data) + '\n');
            progress.found++;
            if (data.twitter || data.instagram || data.tiktok) progress.with_sns++;
            if (data.aliases?.length)  progress.with_aliases++;
            if (data.birthday)         progress.with_birthday++;
            if (data.augmented === true) progress.with_augmented++;

            const parts = [];
            if (data.name) parts.push(data.name);
            if (data.birthday) parts.push(data.birthday);
            if (data.cup) parts.push(`${data.cup}cup`);
            if (data.twitter) parts.push(`@${data.twitter}`);
            if (data.augmented === true) parts.push('豊胸');
            process.stdout.write(`OK [${parts.join(' ')}]\n`);

        } catch (e) {
            process.stdout.write(`ERR: ${e.message}\n`);
            progress.errors++;
        }

        progress.completed.add(url);
        processed++;

        // 100件ごとに進捗保存
        if (processed % 100 === 0) {
            saveProgress(progress);
            const snsPct = ((progress.with_sns / (progress.found || 1)) * 100).toFixed(0);
            console.log(`\n  💾 進捗保存 | 発見: ${progress.found} | SNS: ${progress.with_sns}(${snsPct}%) | 別名: ${progress.with_aliases} | 豊胸: ${progress.with_augmented} | エラー: ${progress.errors}\n`);
        }

        if (processed < pending.length && !DRY_RUN) {
            // 次のリクエストまで待機（±10%のランダムジッター）
            const jitter = Math.floor(INTERVAL_MS * 0.1 * (Math.random() * 2 - 1));
            await sleep(INTERVAL_MS + jitter);
        }
    }

    outputStream.end();
    saveProgress(progress);

    console.log('\n══════════════════════════════════════');
    console.log('  スクレイプ完了（またはCtrl+Cで中断）');
    console.log('══════════════════════════════════════');
    console.log(`  処理数:     ${processed.toLocaleString()}ページ`);
    console.log(`  累計完了:   ${progress.completed.size.toLocaleString()}ページ`);
    console.log(`  女優発見:   ${progress.found.toLocaleString()}名`);
    console.log(`  SNSあり:    ${progress.with_sns.toLocaleString()}名`);
    console.log(`  別名あり:   ${progress.with_aliases.toLocaleString()}名`);
    console.log(`  生年月日:   ${progress.with_birthday.toLocaleString()}名`);
    console.log(`  豊胸情報:   ${progress.with_augmented.toLocaleString()}名`);
    console.log(`  エラー:     ${progress.errors.toLocaleString()}件`);
    console.log('══════════════════════════════════════\n');
    console.log('次: node scripts/import_avwiki_full.js で女優DBに反映\n');
}

// ========== メイン ==========
async function main() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    console.log('══════════════════════════════════════');
    console.log('  av-wiki.net 全女優スクレイパー');
    console.log('══════════════════════════════════════');
    console.log(`  間隔: ${INTERVAL_MS / 1000}秒 (${(INTERVAL_MS / 60000).toFixed(1)}分)`);
    console.log('');

    // URLリスト取得
    let urls;
    if (!fs.existsSync(URL_LIST_FILE) || FETCH_ONLY) {
        urls = await fetchAllUrls();
        if (FETCH_ONLY) return;
    } else {
        urls = JSON.parse(fs.readFileSync(URL_LIST_FILE, 'utf-8'));
        console.log(`[URLリスト] 既存: ${urls.length.toLocaleString()}件 (${URL_LIST_FILE})`);
    }

    // 進捗ロード
    const progress = loadProgressFromFile();
    console.log(`[進捗] 完了: ${progress.completed.size.toLocaleString()} / ${urls.length.toLocaleString()}`);

    // Ctrl+C で安全に中断
    process.on('SIGINT', () => {
        console.log('\n\n[中断] 進捗を保存して終了...');
        saveProgress(progress);
        console.log(`  完了: ${progress.completed.size.toLocaleString()}ページ / 発見: ${progress.found}名`);
        process.exit(0);
    });

    await scrapeAll(urls, progress);
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
