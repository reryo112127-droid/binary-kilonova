/**
 * HTTPフェッチャーモジュール
 * 紳士的なクローラー設定でMGS動画のページを取得
 */
const https = require('https');

// === 設定 ===
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
];

const RETRY_DELAY_MS = 60000;      // リトライ時の待機: 60秒
const MAX_RETRIES = 3;             // 最大リトライ回数
const TIMEOUT_MS = 30000;          // タイムアウト: 30秒
const MIN_SLEEP_MS = 3000;         // 最小スリープ: 3秒
const MAX_SLEEP_MS = 5000;         // 最大スリープ: 5秒

/**
 * ランダムなUser-Agentを取得
 */
function getRandomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * 指定msのスリープ
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 3〜5秒のランダムスリープ（紳士的待機）
 */
async function politeWait() {
    const ms = MIN_SLEEP_MS + Math.random() * (MAX_SLEEP_MS - MIN_SLEEP_MS);
    const sec = (ms / 1000).toFixed(1);
    process.stdout.write(`  [待機] ${sec}秒...`);
    await sleep(ms);
    process.stdout.write(' OK\n');
}

/**
 * URLからHTMLを取得（リトライ機能付き）
 * @param {string} url - 取得するURL
 * @param {number} retryCount - 現在のリトライ回数（内部用）
 * @returns {Promise<string>} HTML文字列
 */
async function fetchPage(url, retryCount = 0) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            headers: {
                'User-Agent': getRandomUA(),
                'Cookie': 'adc=1; coc=1',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
                'Accept-Encoding': 'identity',
                'Connection': 'keep-alive',
                'Referer': 'https://www.mgstage.com/',
            },
            timeout: TIMEOUT_MS,
        };

        const req = https.get(options, (res) => {
            // リダイレクト対応
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirectUrl = new URL(res.headers.location, url).toString();
                console.log(`  [リダイレクト] ${res.statusCode} → ${redirectUrl}`);
                res.resume();
                return resolve(fetchPage(redirectUrl, retryCount));
            }

            // リトライ対象のエラー
            if (res.statusCode === 429 || res.statusCode >= 500) {
                res.resume();
                if (retryCount < MAX_RETRIES) {
                    console.log(`  [リトライ] HTTP ${res.statusCode} - ${RETRY_DELAY_MS / 1000}秒後に再試行 (${retryCount + 1}/${MAX_RETRIES})`);
                    return sleep(RETRY_DELAY_MS).then(() => resolve(fetchPage(url, retryCount + 1)));
                }
                return reject(new Error(`HTTP ${res.statusCode} after ${MAX_RETRIES} retries`));
            }

            // 正常以外のレスポンス
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }

            let data = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve(data));
            res.on('error', reject);
        });

        req.on('timeout', () => {
            req.destroy();
            if (retryCount < MAX_RETRIES) {
                console.log(`  [タイムアウト] ${RETRY_DELAY_MS / 1000}秒後に再試行 (${retryCount + 1}/${MAX_RETRIES})`);
                sleep(RETRY_DELAY_MS).then(() => resolve(fetchPage(url, retryCount + 1)));
            } else {
                reject(new Error(`Timeout after ${MAX_RETRIES} retries`));
            }
        });

        req.on('error', (e) => {
            if (retryCount < MAX_RETRIES) {
                console.log(`  [エラー] ${e.message} - ${RETRY_DELAY_MS / 1000}秒後に再試行 (${retryCount + 1}/${MAX_RETRIES})`);
                sleep(RETRY_DELAY_MS).then(() => resolve(fetchPage(url, retryCount + 1)));
            } else {
                reject(e);
            }
        });
    });
}

/**
 * MGS動画の検索一覧ページURLを生成
 */
function buildSearchUrl(page, listCount = 120) {
    return `https://www.mgstage.com/search/cSearch.php?search_word=&sort=new&list_cnt=${listCount}&page=${page}`;
}

/**
 * MGS動画の作品詳細ページURLを生成
 */
function buildDetailUrl(productId) {
    return `https://www.mgstage.com/product/product_detail/${productId}/`;
}

module.exports = {
    fetchPage,
    politeWait,
    sleep,
    buildSearchUrl,
    buildDetailUrl,
};
