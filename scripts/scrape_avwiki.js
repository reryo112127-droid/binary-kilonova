/**
 * av-wiki.net 女優情報スクレイパー
 *
 * FANZAにないSNS（X/Instagram）・別名義を補完
 *
 * 使い方:
 *   node scripts/scrape_avwiki.js              # フル実行
 *   node scripts/scrape_avwiki.js --max 10     # テスト (10名)
 *   node scripts/scrape_avwiki.js --restart    # 最初から
 */

const fs   = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const DATA_DIR      = path.join(__dirname, '..', 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'actress_profiles.json');
const AVWIKI_FILE   = path.join(DATA_DIR, 'avwiki_profiles.json');
const PROGRESS_FILE = path.join(DATA_DIR, 'avwiki_progress.json');

const RATE_LIMIT_MS = 2000;   // 2秒インターバル（礼儀正しくクロール）
const SEARCH_DELAY  = 800;    // 検索→詳細ページ間

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ───────────────────────────────────────────────────────
// データロード
// ───────────────────────────────────────────────────────
const fanzaProfiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));
const actressNames  = Object.keys(fanzaProfiles).filter(k => !k.startsWith('NOT_FOUND_'));

let avwikiData = {};
if (fs.existsSync(AVWIKI_FILE)) {
    avwikiData = JSON.parse(fs.readFileSync(AVWIKI_FILE, 'utf-8'));
}

let progress = { completed: [], found: 0, with_sns: 0, with_aliases: 0 };
if (fs.existsSync(PROGRESS_FILE)) {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
}
const completedSet = new Set(progress.completed);

// ───────────────────────────────────────────────────────
// HTTP取得
// ───────────────────────────────────────────────────────
async function fetchHtml(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
            'Cache-Control': 'no-cache',
        }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.text();
}

// ───────────────────────────────────────────────────────
// 検索ページから /av-actress/ URLを探す
// ───────────────────────────────────────────────────────
async function findActressUrl(name) {
    const url  = `https://av-wiki.net/?s=${encodeURIComponent(name)}`;
    const html = await fetchHtml(url);
    const $    = cheerio.load(html);

    let found = null;
    // 1) 直接 /av-actress/ リンク
    $('a[href*="/av-actress/"]').each((i, el) => {
        if (!found) found = $(el).attr('href');
    });
    // 2) 記事タイトルから推測（検索結果のタイトルに女優名が含まれる場合）
    if (!found) {
        $('a').each((i, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text();
            if (href.includes('av-wiki.net') && href.includes('/') && text.includes(name)) {
                // 一般的な記事ページはスキップ（品番パターン）
                if (!/\/[a-z]+-\d+\/$/.test(href)) found = href;
            }
        });
    }
    return found;
}

// ───────────────────────────────────────────────────────
// 女優ページのパース
// ───────────────────────────────────────────────────────
function parseActressPage(html, url) {
    const $      = cheerio.load(html);
    const result = { url, scraped_at: new Date().toISOString() };

    // .actress-data dl の dt → dd ペアで全プロフィールフィールドを取得
    const fieldMap = {};
    $('.actress-data dl dt').each((i, el) => {
        const label = $(el).text().trim().replace(/[：:]\s*$/, '').replace(/\s*<span.*$/, '');
        const $dd = $(el).next('dd');
        fieldMap[label] = { text: $dd.text().trim(), $el: $dd };
    });

    // ─── 別名義 ───
    const aliasRaw = (fieldMap['別名義'] || fieldMap['旧名'] || fieldMap['旧芸名'] || {}).text || '';
    if (aliasRaw && aliasRaw !== '– – –' && aliasRaw !== '---' && aliasRaw !== '-') {
        // 「橋本ありな（はしもとありな）」「旧名A、旧名B」などを分割
        const aliases = aliasRaw
            .split(/[,、・\n]/)
            .map(s => {
                const m = s.match(/^(.+?)（/);
                return (m ? m[1] : s).trim();
            })
            .filter(s => s && !['–', '-', '—', '　'].includes(s));
        if (aliases.length > 0) result.aliases = aliases;
    }

    // ─── サイズ ───
    const sizeRaw = (fieldMap['サイズ'] || {}).text || '';
    if (sizeRaw) {
        result.size_raw = sizeRaw;
        const heightM = sizeRaw.match(/T(\d{2,3})/i);
        const bustM   = sizeRaw.match(/B(\d{2,3})/i);
        const waistM  = sizeRaw.match(/W(\d{2,3})/i);
        const hipM    = sizeRaw.match(/H(\d{2,3})/i);
        // カップ: "B88(Gカップ)" or "T166-B84-W56-H83(Cカップ)" or "Gカップ"
        const cupM    = sizeRaw.match(/([A-Z])カップ/);
        if (heightM) result.height = parseInt(heightM[1]);
        if (bustM)   result.bust   = parseInt(bustM[1]);
        if (waistM)  result.waist  = parseInt(waistM[1]);
        if (hipM)    result.hip    = parseInt(hipM[1]);
        if (cupM)    result.cup    = cupM[1];
    }

    // ─── 生年月日 ───
    const bdRaw = (fieldMap['生年月日'] || {}).text || '';
    if (bdRaw) result.birthday_raw = bdRaw;

    // ─── SNS ───
    const sns$ = (fieldMap['SNS'] || {}).$el;
    if (sns$) {
        sns$.find('a').each((i, a) => {
            const href = $(a).attr('href') || '';
            const text = $(a).text().trim();
            // Twitter/X
            if (href.match(/(?:twitter\.com|x\.com)\//i)) {
                const m = href.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)/i);
                if (m && m[1] !== 'intent' && m[1] !== 'search') result.twitter = m[1];
            }
            // Instagram
            if (href.includes('instagram.com/')) {
                const m = href.match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
                if (m && m[1] !== 'p') result.instagram = m[1];
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
            if (m && m[1] !== '-' && m[1] !== '未登録') result.instagram = m[1];
        }
    }

    return result;
}

// ───────────────────────────────────────────────────────
// 保存
// ───────────────────────────────────────────────────────
function save() {
    fs.writeFileSync(AVWIKI_FILE, JSON.stringify(avwikiData, null, 2));
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ───────────────────────────────────────────────────────
// メイン
// ───────────────────────────────────────────────────────
async function main() {
    const args       = process.argv.slice(2);
    const maxIdx     = args.indexOf('--max');
    const maxN       = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : Infinity;
    const isRestart  = args.includes('--restart');

    if (isRestart) {
        avwikiData = {};
        progress   = { completed: [], found: 0, with_sns: 0, with_aliases: 0 };
        completedSet.clear();
        console.log('リスタート: 既存データをクリアしました');
    }

    const pending = actressNames.filter(name => !completedSet.has(name));

    console.log('═══════════════════════════════════════════');
    console.log('  av-wiki.net 女優情報スクレイパー');
    console.log('═══════════════════════════════════════════');
    console.log(`  対象女優数:   ${actressNames.length.toLocaleString()}名`);
    console.log(`  完了済み:     ${completedSet.size.toLocaleString()}名`);
    console.log(`  残り:         ${pending.length.toLocaleString()}名`);
    console.log(`  推定時間:     ${((pending.length * RATE_LIMIT_MS) / 1000 / 3600).toFixed(1)}時間`);
    console.log('═══════════════════════════════════════════\n');

    let processed = 0;

    for (const name of pending) {
        if (processed >= maxN) {
            console.log(`\n[制限] ${maxN}名で終了`);
            break;
        }

        const idx = completedSet.size + 1;
        process.stdout.write(`[${idx}/${actressNames.length}] ${name} ... `);

        try {
            // Step 1: 検索
            const actressUrl = await findActressUrl(name);
            if (!actressUrl) {
                process.stdout.write('NOT FOUND\n');
                avwikiData[name] = { not_found: true };
            } else {
                await sleep(SEARCH_DELAY);

                // Step 2: 女優ページ取得・パース
                const html = await fetchHtml(actressUrl);
                const data = parseActressPage(html, actressUrl);
                avwikiData[name] = data;

                const hasSNS     = !!(data.twitter || data.instagram);
                const hasAliases = !!(data.aliases && data.aliases.length > 0);
                if (hasSNS)     progress.with_sns++;
                if (hasAliases) progress.with_aliases++;
                progress.found++;

                const snsPart   = hasSNS     ? ` SNS:${[data.twitter ? `X(@${data.twitter})` : '', data.instagram ? `IG(@${data.instagram})` : ''].filter(Boolean).join('/')}` : '';
                const aliasPart = hasAliases ? ` 別名:${data.aliases.join(',')}` : '';
                const cupPart   = data.cup   ? ` ${data.cup}カップ` : '';
                process.stdout.write(`OK${cupPart}${snsPart}${aliasPart}\n`);
            }
        } catch (e) {
            process.stdout.write(`ERR: ${e.message}\n`);
            avwikiData[name] = { error: e.message };
        }

        completedSet.add(name);
        progress.completed.push(name);
        processed++;

        // 20件ごとにセーブ
        if (processed % 20 === 0) {
            save();
            const snsPct = ((progress.with_sns / (progress.found || 1)) * 100).toFixed(0);
            console.log(`  💾 保存 | 発見率: ${((progress.found / completedSet.size) * 100).toFixed(0)}% | SNS付: ${snsPct}%`);
        }

        await sleep(RATE_LIMIT_MS);
    }

    save();
    console.log('\n═══════════════════════════════════════════');
    console.log('  完了サマリー');
    console.log('═══════════════════════════════════════════');
    console.log(`  処理数:       ${processed}名`);
    console.log(`  ページ発見:   ${progress.found}名`);
    console.log(`  SNS取得:      ${progress.with_sns}名`);
    console.log(`  別名義取得:   ${progress.with_aliases}名`);
    console.log('═══════════════════════════════════════════\n');
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
