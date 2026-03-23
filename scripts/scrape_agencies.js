/**
 * AV女優事務所公式サイト SNSスクレイパー
 *
 * 対象:
 *   - カプセルエージェンシー (capsule.bz)       — ~100名
 *   - ティーパワーズ      (t-powers.co.jp)     — ~380名
 *   - エイトマン          (8woman.jp)           — ~24名（単一ページ）
 *
 * 使い方:
 *   node scripts/scrape_agencies.js
 *   node scripts/scrape_agencies.js --agency capsule
 *   node scripts/scrape_agencies.js --agency tpowers
 *   node scripts/scrape_agencies.js --agency eightman
 */

const fs      = require('fs');
const path    = require('path');
const cheerio = require('cheerio');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'agency_profiles.json');

const DELAY = 1500; // ms between requests
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'ja,en-US;q=0.9',
};

async function fetchHtml(url) {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.text();
}

// SNS URLからプラットフォームとハンドルを抽出
function parseSnsHref(href) {
    if (!href) return null;
    const patterns = [
        { key: 'twitter',   re: /(?:twitter\.com|x\.com)\/(?:#!\/)?([A-Za-z0-9_]+)/i },
        { key: 'instagram', re: /instagram\.com\/([A-Za-z0-9_.]+)/i },
        { key: 'tiktok',    re: /tiktok\.com\/@([A-Za-z0-9_.]+)/i },
        { key: 'threads',   re: /threads\.net\/@([A-Za-z0-9_.]+)/i },
    ];
    const ignore = new Set(['intent', 'search', 'share', 'p', 'reel', 'stories', 'explore']);
    for (const { key, re } of patterns) {
        const m = href.match(re);
        if (m && !ignore.has(m[1].toLowerCase())) return { key, handle: m[1] };
    }
    return null;
}

// ─────────────────────────────────────────────────────────
// カプセルエージェンシー capsule.bz
// ─────────────────────────────────────────────────────────
async function scrapeCapsule() {
    console.log('\n[Capsule Agency] capsule.bz/model/');
    const listHtml = await fetchHtml('https://capsule.bz/model/');
    const $list = cheerio.load(listHtml);

    // プロフィールURLを収集
    const profileUrls = [];
    $list('a[href*="/model/"]').each((i, el) => {
        const href = $list(el).attr('href') || '';
        if (href.match(/\/model\/[^/]+\/$/)) {
            if (!profileUrls.includes(href)) profileUrls.push(href);
        }
    });
    console.log(`  ${profileUrls.length}名のプロフィールURL取得`);

    const results = {};

    for (let i = 0; i < profileUrls.length; i++) {
        const url = profileUrls[i];
        try {
            await sleep(DELAY);
            const html = await fetchHtml(url);
            const $    = cheerio.load(html);

            // 名前: h1 または title から
            let name = $('h1.name, .model-name h1, h1').first().text().trim();
            // alt="（名前）AV女優" パターン
            if (!name) {
                const alt = $('img[alt*="AV女優"]').first().attr('alt') || '';
                const m = alt.match(/[（(](.+?)[）)]/);
                if (m) name = m[1];
            }
            if (!name) {
                // URLスラグから仮名
                name = decodeURIComponent(url.replace(/.*\/model\//, '').replace(/\/$/, ''));
            }

            // 個人SNSは "OFFICIAL LINK" h3 直後の ul のみ（エージェンシー共通SNSを除外）
            const sns = {};
            const $officialUl = $('h3').filter((_, el) =>
                $(el).text().trim().toUpperCase().includes('OFFICIAL LINK')
            ).next('ul');
            ($officialUl.length ? $officialUl.find('a[href]') : $()).each((_, a) => {
                const href = $(a).attr('href') || '';
                const parsed = parseSnsHref(href);
                if (parsed) sns[parsed.key] = parsed.handle;
            });

            if (Object.keys(sns).length > 0) {
                results[name] = { source: 'capsule', url, ...sns };
                const snsParts = Object.entries(sns).map(([k,v]) => `${k}:@${v}`).join(' ');
                process.stdout.write(`  [${i+1}/${profileUrls.length}] ${name} → ${snsParts}\n`);
            } else {
                process.stdout.write(`  [${i+1}/${profileUrls.length}] ${name} → SNSなし\n`);
                results[name] = { source: 'capsule', url };
            }
        } catch (e) {
            console.error(`  ERR ${url}: ${e.message}`);
        }
    }

    return results;
}

// ─────────────────────────────────────────────────────────
// ティーパワーズ t-powers.co.jp
// ─────────────────────────────────────────────────────────
async function scrapeTPowers() {
    console.log('\n[T-Powers] t-powers.co.jp/talent/');

    // ページネーション対応: /talent/page/N/ を試みる
    const profileUrls = [];
    for (let page = 1; page <= 10; page++) {
        const listUrl = page === 1
            ? 'https://www.t-powers.co.jp/talent/'
            : `https://www.t-powers.co.jp/talent/page/${page}/`;
        try {
            const listHtml = await fetchHtml(listUrl);
            const $list = cheerio.load(listHtml);
            let found = 0;
            $list('a[href*="/talent/"]').each((i, el) => {
                const href = $list(el).attr('href') || '';
                if (href.match(/\/talent\/[^/]+\/$/)) {
                    const full = href.startsWith('http') ? href : `https://www.t-powers.co.jp${href}`;
                    if (!profileUrls.includes(full)) { profileUrls.push(full); found++; }
                }
            });
            if (found === 0) break; // これ以上ページなし
            await sleep(DELAY);
        } catch (e) {
            break;
        }
    }
    console.log(`  ${profileUrls.length}名のプロフィールURL取得`);

    const results = {};

    for (let i = 0; i < profileUrls.length; i++) {
        const url = profileUrls[i];
        try {
            await sleep(DELAY);
            const html = await fetchHtml(url);
            const $    = cheerio.load(html);

            // 名前: ページの2番目のh1（1番目はサイトヘッダー "TALENT タレント詳細"）
            const allH1 = $('h1').toArray();
            let name = allH1.length >= 2
                ? $(allH1[1]).text().trim()
                : $(allH1[0]).text().trim().replace(/TALENT[^]*/, '').trim();

            // SNS: .p-talent-detail__sns 内のリンク
            const sns = {};
            $('.p-talent-detail__sns a[href]').each((_, a) => {
                const href = $(a).attr('href') || '';
                const parsed = parseSnsHref(href);
                if (parsed) sns[parsed.key] = parsed.handle;
            });

            if (!name) name = `__tpowers_${i}`;

            if (Object.keys(sns).length > 0) {
                results[name] = { source: 'tpowers', url, ...sns };
                const snsParts = Object.entries(sns).map(([k,v]) => `${k}:@${v}`).join(' ');
                process.stdout.write(`  [${i+1}/${profileUrls.length}] ${name} → ${snsParts}\n`);
            } else {
                process.stdout.write(`  [${i+1}/${profileUrls.length}] ${name} → SNSなし\n`);
                results[name] = { source: 'tpowers', url };
            }
        } catch (e) {
            console.error(`  ERR ${url}: ${e.message}`);
        }
    }

    return results;
}

// ─────────────────────────────────────────────────────────
// エイトマン 8woman.jp (単一ページ)
// ─────────────────────────────────────────────────────────
async function scrapeEightman() {
    console.log('\n[Eight Man] 8woman.jp');
    const html = await fetchHtml('https://8woman.jp/');
    const $    = cheerio.load(html);

    const results = {};

    // 構造: div.galbox > div.sec_02_imgbox(SNS) + div.sec_02_namebox(名前)
    $('div.galbox').each((i, card) => {
        const name = $(card).find('p.sec_02_name1').text().trim();
        if (!name) return;

        const sns = {};
        $(card).find('.sec_02_iconbox a[href]').each((_, a) => {
            const href = $(a).attr('href') || '';
            const parsed = parseSnsHref(href);
            if (parsed) sns[parsed.key] = parsed.handle;
        });

        if (Object.keys(sns).length > 0) {
            results[name] = { source: 'eightman', url: 'https://8woman.jp/', ...sns };
            const snsParts = Object.entries(sns).map(([k,v]) => `${k}:@${v}`).join(' ');
            console.log(`  ${name} → ${snsParts}`);
        } else {
            results[name] = { source: 'eightman', url: 'https://8woman.jp/' };
            console.log(`  ${name} → SNSなし`);
        }
    });

    return results;
}

// ─────────────────────────────────────────────────────────
// 汎用: roster → profile 一覧スクレイパー
// ─────────────────────────────────────────────────────────
async function scrapeGeneric({ label, source, rosterUrl, profileLinkSelector, profileUrlBase,
    nameSelector, snsContainerSelector }) {
    console.log(`\n[${label}] ${rosterUrl}`);
    let profileUrls = [];

    // ページネーション対応（最大10ページ）
    for (let page = 1; page <= 10; page++) {
        const url = page === 1 ? rosterUrl : rosterUrl.replace(/\/?$/, '') + `/page/${page}/`;
        try {
            const html = await fetchHtml(url);
            const $    = cheerio.load(html);
            let found  = 0;
            $(profileLinkSelector).each((_, el) => {
                let href = $( el).attr('href') || '';
                if (!href) return;
                if (!href.startsWith('http')) {
                    // 絶対パス (/model/xxx) と相対パス (info.php?id=1) 両対応
                    href = href.startsWith('/')
                        ? profileUrlBase.replace(/\/+$/, '') + href
                        : profileUrlBase.replace(/\/+$/, '') + '/' + href;
                }
                if (!profileUrls.includes(href)) { profileUrls.push(href); found++; }
            });
            if (found === 0) break;
            await sleep(DELAY);
        } catch { break; }
    }
    console.log(`  ${profileUrls.length}名のプロフィールURL取得`);

    const results = {};
    for (let i = 0; i < profileUrls.length; i++) {
        const url = profileUrls[i];
        try {
            await sleep(DELAY);
            const html = await fetchHtml(url);
            const $    = cheerio.load(html);
            let name   = $(nameSelector).first().text().trim()
                .replace(/（[^）]*）/, '')          // フリガナ "天馬 ゆい（てんまゆい）" → "天馬 ゆい"
                .replace(/\s*[\/|]\s*.+$/, '')    // "希島あいり / Airi Kijima" → 日本語部分のみ
                .replace(/\s+[A-Za-z].+$/, '')    // "相月 菜緒 Nao Aizuki" → 日本語部分のみ
                .trim();

            const sns = {};
            const $scope = snsContainerSelector ? $(snsContainerSelector) : $('body');
            $scope.find('a[href]').each((_, a) => {
                const href = $(a).attr('href') || '';
                const parsed = parseSnsHref(href);
                if (parsed) sns[parsed.key] = parsed.handle;
            });

            if (!name) name = `__${source}_${i}`;
            results[name] = Object.keys(sns).length > 0
                ? { source, url, ...sns }
                : { source, url };
            const snsParts = Object.entries(sns).map(([k,v]) => `${k}:@${v}`).join(' ');
            process.stdout.write(`  [${i+1}/${profileUrls.length}] ${name} → ${snsParts || 'SNSなし'}\n`);
        } catch (e) {
            console.error(`  ERR ${url}: ${e.message}`);
        }
    }
    return results;
}

// ─────────────────────────────────────────────────────────
// ディアスグループ diaz-g.com (Nuxt SSR JSON)
// ─────────────────────────────────────────────────────────
async function scrapeDiaz() {
    console.log('\n[Dias Group] diaz-g.com');
    const html = await fetchHtml('https://diaz-g.com/');
    // window.__NUXT__ から state.model.models を抽出
    // window.__NUXT__=function(a,b,...){...}(args) 形式
    const m = html.match(/window\.__NUXT__\s*=\s*(function[\s\S]*?<\/script>)/);
    if (!m) { console.log('  NUXT stateが見つかりません'); return {}; }
    const results = {};
    try {
        // 関数形式 window.__NUXT__=function(a,b,...){return{...}}(args)
        // name_ja と sns フィールドは文字列リテラルのまま存在する
        const script = m[0];
        // slug + name_ja をペアで抽出
        const modelRe = /slug:"([^"]+)",name_en:"([^"]*)",name_ja:"([^"]+)"[^}]*?twitter:("([^"]*)"|[^,}]+)[^}]*?instagram:("([^"]*)"|[^,}]+)/g;
        let match;
        while ((match = modelRe.exec(script)) !== null) {
            const slug    = match[1];
            const nameJa  = match[3];
            const twRaw   = match[4] ? match[5] : '';
            const igRaw   = match[6] ? match[7] : '';
            const sns = {};
            if (twRaw) { const p = parseSnsHref(twRaw); if (p) sns.twitter = p.handle; }
            if (igRaw) { const p = parseSnsHref(igRaw); if (p) sns.instagram = p.handle; }
            results[nameJa] = { source: 'diaz', url: `https://diaz-g.com/${slug}`, ...sns };
            console.log(`  ${nameJa} → ${Object.entries(sns).map(([k,v])=>`${k}:@${v}`).join(' ') || 'SNSなし'}`);
        }
        // シンプルな name_ja + twitter だけのケースも補完
        if (Object.keys(results).length === 0) {
            const names = [...script.matchAll(/name_ja:"([^"]+)"/g)].map(x => x[1]);
            console.log(`  ${names.length}名 (SNS抽出試行)`);
            names.forEach(n => { results[n] = { source: 'diaz', url: 'https://diaz-g.com/' }; });
        }
        console.log(`  ${Object.keys(results).length}名のモデルデータ取得`);
    } catch (e) {
        console.error('  Diaz parse error:', e.message);
    }
    return results;
}

// ─────────────────────────────────────────────────────────
// メイン
// ─────────────────────────────────────────────────────────
const AGENCIES = {
    capsule:  scrapeCapsule,
    tpowers:  scrapeTPowers,
    eightman: scrapeEightman,
    mines: () => scrapeGeneric({
        label: 'Mines Pro', source: 'mines',
        rosterUrl: 'https://mines-pro.jp/model/',
        profileLinkSelector: 'a[href*="/model/"]',
        profileUrlBase: 'https://mines-pro.jp',
        nameSelector: 'h1',
        snsContainerSelector: 'ul.snsList',   // 個人SNS; div.twitterBox は事務所アカウント
    }),
    ellapro: () => scrapeGeneric({
        label: 'Ella Pro', source: 'ellapro',
        rosterUrl: 'https://ellapro-official.com/talent/',
        profileLinkSelector: 'a[href*="/talent/"]',
        profileUrlBase: 'https://ellapro-official.com',
        nameSelector: 'h1, .p-page-header__title',
        snsContainerSelector: null,
    }),
    krone: () => scrapeGeneric({
        label: 'Krone', source: 'krone',
        rosterUrl: 'https://krone-web.jp/model/',
        profileLinkSelector: 'a[href*="info.php"]',
        profileUrlBase: 'https://krone-web.jp/model',
        nameSelector: 'h3.sub_title3',  // "天馬 ゆい（てんまゆい）"
        snsContainerSelector: null,
    }),
    bambi: async () => {
        console.log('\n[Bambi] bambi.ne.jp/models.html');
        const listHtml = await fetchHtml('https://bambi.ne.jp/models.html');
        const $list = cheerio.load(listHtml);
        const profileUrls = [];
        $list('a[href*="model.php"]').each((_, el) => {
            let href = $list(el).attr('href') || '';
            if (!href.startsWith('http')) href = 'https://bambi.ne.jp/' + href.replace(/^\//, '');
            if (!profileUrls.includes(href)) profileUrls.push(href);
        });
        console.log(`  ${profileUrls.length}名のプロフィールURL取得`);
        const results = {};
        for (let i = 0; i < profileUrls.length; i++) {
            const url = profileUrls[i];
            try {
                await sleep(DELAY);
                const html = await fetchHtml(url);
                const $    = cheerio.load(html);
                // 名前: dt="名前" の次の dd（フリガナ除去）
                let name = '';
                $('dt').each((_, el) => {
                    if ($(el).text().trim() === '名前') {
                        name = $(el).next('dd').text().trim().replace(/（[^）]*）/, '').trim();
                    }
                });
                // SNS: dd.sns-grid 内（事務所アカウントは li 内なので除外）
                const sns = {};
                $('dd.sns-grid a[href]').each((_, a) => {
                    const href = $(a).attr('href') || '';
                    const parsed = parseSnsHref(href);
                    if (parsed) sns[parsed.key] = parsed.handle;
                });
                if (!name) name = `__bambi_${i}`;
                results[name] = Object.keys(sns).length > 0 ? { source: 'bambi', url, ...sns } : { source: 'bambi', url };
                const snsParts = Object.entries(sns).map(([k,v]) => `${k}:@${v}`).join(' ');
                process.stdout.write(`  [${i+1}/${profileUrls.length}] ${name} → ${snsParts || 'SNSなし'}\n`);
            } catch (e) { console.error(`  ERR ${url}: ${e.message}`); }
        }
        return results;
    },
    linx: () => scrapeGeneric({
        label: 'LINX', source: 'linx',
        rosterUrl: 'https://linx.live/model/',
        profileLinkSelector: 'a[href*="/model/"]',
        profileUrlBase: 'https://linx.live',
        nameSelector: 'h1',
        snsContainerSelector: null,
    }),
    duo: () => scrapeGeneric({
        label: 'Duo Entertainment', source: 'duo',
        rosterUrl: 'https://www.duo-official.com/models/',
        profileLinkSelector: 'a[href*="/models/"]',
        profileUrlBase: 'https://www.duo-official.com',
        nameSelector: 'h3',
        snsContainerSelector: '.p-social-nav',
    }),
    diaz: scrapeDiaz,
};

async function main() {
    const args   = process.argv.slice(2);
    const agency = args[args.indexOf('--agency') + 1] || 'all';

    // 既存データをロード（マージ用）
    let existing = {};
    if (fs.existsSync(OUTPUT_FILE)) {
        existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
    }

    const allResults = { ...existing };

    const toRun = agency === 'all' ? Object.keys(AGENCIES) : [agency];

    for (const key of toRun) {
        if (!AGENCIES[key]) { console.log(`Unknown agency: ${key}`); continue; }
        try {
            const r = await AGENCIES[key]();
            Object.assign(allResults, r);
            fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allResults, null, 2));
            console.log(`  → 保存完了 (${key}: ${Object.keys(r).length}名)`);
        } catch (e) {
            console.error(`  ${key} 失敗:`, e.message);
        }
    }

    const withSns = Object.values(allResults).filter(v => v.twitter || v.instagram).length;
    console.log('\n═══════════════════════════════════════════');
    console.log(`  合計: ${Object.keys(allResults).length}名`);
    console.log(`  SNS付: ${withSns}名`);
    console.log('═══════════════════════════════════════════\n');
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
