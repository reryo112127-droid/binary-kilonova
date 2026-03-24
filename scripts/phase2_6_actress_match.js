/**
 * フェーズ2.6: 女優名検索による素人作品出演者特定
 * 
 * MGSの女優名検索を使い、DBで出演者不明の作品に女優名を紐づける。
 * MGSでは女優名で検索すると、クレジットされていない素人作品も表示される。
 * 
 * 使い方:
 *   node scripts/phase2_6_actress_match.js                  # フル実行
 *   node scripts/phase2_6_actress_match.js --max-actresses 3 # テスト
 *   node scripts/phase2_6_actress_match.js --restart         # 最初から
 *   node scripts/phase2_6_actress_match.js --apply           # JSONL → DB適用
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { fetchPage, politeWait } = require('../lib/fetcher');
const { parseSearchPage } = require('../lib/parser');

const ITEMS_PER_PAGE = 120;
const DATA_DIR = path.join(__dirname, '..', 'data');
const ACTRESSES_PATH = path.join(DATA_DIR, 'actresses_all.json');
const MATCH_JSONL = path.join(DATA_DIR, 'mgs_actress_matches.jsonl');
const PROGRESS_PATH = path.join(DATA_DIR, 'phase2_6_progress.json');
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1485815872688885892/78U4bkE7SNNTIMuW91ru_bJXH6D6hynnf88dYAnzkgq2hECA4gUSNa6hzq5DWquwRJYe';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Discordにメッセージを送信する
 */
async function sendDiscordMessage(content) {
    if (!DISCORD_WEBHOOK_URL) return;
    try {
        await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
    } catch (e) {
        console.error('Discord通知エラー:', e.message);
    }
}

/**
 * DBから全品番の出演者テキストを取得
 */
async function loadProductActressesMap() {
    const initSqlJs = require('sql.js');
    const DB_PATH = path.join(DATA_DIR, 'mgs.db');

    if (!fs.existsSync(DB_PATH)) {
        console.error('❌ DBが見つかりません');
        process.exit(1);
    }

    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_PATH));

    const result = db.exec("SELECT product_id, actresses FROM products");
    const map = new Map();
    if (result.length > 0) {
        for (const row of result[0].values) {
            map.set(row[0], row[1] || '');
        }
    }
    db.close();
    return map;
}

function loadProgress() {
    if (fs.existsSync(PROGRESS_PATH)) {
        return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
    }
    return { completed_actresses: [], total_matches: 0, total_new_products: 0 };
}

function saveProgress(progress) {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), 'utf-8');
}

function appendMatch(match) {
    fs.appendFileSync(MATCH_JSONL, JSON.stringify(match) + '\n', 'utf-8');
}

/**
 * 既に記録済みのマッチを読み込み（重複防止）
 */
function loadExistingMatches() {
    const matches = new Map(); // product_id -> Set of actress names
    if (!fs.existsSync(MATCH_JSONL)) return matches;
    const content = fs.readFileSync(MATCH_JSONL, 'utf-8');
    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
            const d = JSON.parse(line);
            if (!matches.has(d.product_id)) {
                matches.set(d.product_id, new Set());
            }
            matches.get(d.product_id).add(d.actress);
        } catch (e) { }
    }
    return matches;
}

/**
 * 女優の全検索結果から品番を収集
 */
async function searchActressProducts(actress) {
    const baseUrl = `https://www.mgstage.com/search/cSearch.php?${actress.search_param}&sort=new&list_cnt=${ITEMS_PER_PAGE}&type=top`;
    const productIds = [];
    let page = 1;
    let totalPages = null;

    while (true) {
        const url = `${baseUrl}&page=${page}`;
        const html = await fetchPage(url);
        const { products, totalCount } = parseSearchPage(html);

        if (!totalPages && totalCount > 0) {
            totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
        }
        if (products.length === 0) break;

        for (const p of products) {
            productIds.push(p.product_id);
        }

        page++;
        if (totalPages && page > totalPages) break;
        await politeWait();
    }

    return productIds;
}

/**
 * JSONL → SQLite DB適用
 */
async function applyToDb() {
    console.log('[適用] JSONL → SQLiteDB...\n');

    if (!fs.existsSync(MATCH_JSONL)) {
        console.error('❌ マッチデータJSONLがありません');
        process.exit(1);
    }

    const initSqlJs = require('sql.js');
    const DB_PATH = path.join(DATA_DIR, 'mgs.db');

    if (!fs.existsSync(DB_PATH)) {
        console.error('❌ DBが見つかりません');
        process.exit(1);
    }

    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_PATH));

    // まず全マッチをメモリに集約（品番→女優名のセット）
    const matchMap = new Map();
    const rl = readline.createInterface({
        input: fs.createReadStream(MATCH_JSONL), crlfDelay: Infinity,
    });

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const d = JSON.parse(line);
            if (!matchMap.has(d.product_id)) {
                matchMap.set(d.product_id, new Set());
            }
            matchMap.get(d.product_id).add(d.actress);
        } catch (e) { }
    }

    let applied = 0;
    db.run('BEGIN TRANSACTION');

    for (const [productId, actressSet] of matchMap) {
        // 既存の出演者情報を取得
        const existing = db.exec(`SELECT actresses FROM products WHERE product_id = '${productId}'`);
        let currentActresses = '';
        if (existing.length > 0 && existing[0].values[0][0]) {
            currentActresses = existing[0].values[0][0];
        }

        // 既存の女優名セット
        const existingSet = new Set(
            currentActresses ? currentActresses.split(', ').map(s => s.trim()).filter(Boolean) : []
        );

        // 新しい女優名を追加
        for (const actress of actressSet) {
            existingSet.add(actress);
        }

        const merged = Array.from(existingSet).join(', ');

        db.run(`
            UPDATE products SET
                actresses = ?,
                updated_at = datetime('now','localtime')
            WHERE product_id = ?
        `, [merged, productId]);
        applied++;

        if (applied % 5000 === 0) {
            db.run('COMMIT');
            process.stdout.write(`  ${applied.toLocaleString()}件適用済み\n`);
            db.run('BEGIN TRANSACTION');
        }
    }

    db.run('COMMIT');

    // 保存
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    db.close();

    console.log(`\n✅ ${applied.toLocaleString()}件の出演者情報をDBに適用`);
    console.log(`   DBサイズ: ${(fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1)} MB`);
}

async function main() {
    const args = process.argv.slice(2);
    const maxIdx = args.indexOf('--max-actresses');
    const maxActresses = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : Infinity;
    const restart = args.includes('--restart');
    const applyOnly = args.includes('--apply');

    if (applyOnly) {
        await applyToDb();
        return;
    }

    if (restart) {
        if (fs.existsSync(MATCH_JSONL)) fs.unlinkSync(MATCH_JSONL);
        if (fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH);
    }

    if (!fs.existsSync(ACTRESSES_PATH)) {
        console.error('❌ 女優一覧がありません。先に get_actresses.js を実行してください。');
        process.exit(1);
    }
    const actresses = JSON.parse(fs.readFileSync(ACTRESSES_PATH, 'utf-8'));

    // DB内の全品番と現在の出演者情報を読み込み
    console.log('[準備] DBの品番と出演者データを読み込み中...');
    const dbActressesMap = await loadProductActressesMap();
    const existingMatches = loadExistingMatches();

    let progress = restart
        ? { completed_actresses: [], total_matches: 0, total_new_products: 0 }
        : loadProgress();

    const completedSet = new Set(progress.completed_actresses);
    const pending = actresses.filter(a => !completedSet.has(a.name));

    console.log('========================================');
    console.log('  MGS動画 フェーズ2.6: 女優名検索による出演者特定');
    console.log('========================================\n');
    console.log(`  女優数:         ${actresses.length.toLocaleString()}`);
    console.log(`  完了済み:       ${progress.completed_actresses.length.toLocaleString()}`);
    console.log(`  残り:           ${pending.length.toLocaleString()}`);
    console.log(`  対象データベース品番: ${dbActressesMap.size.toLocaleString()}`);
    console.log(`  推定所要時間:   ${(pending.length * 8 / 3600).toFixed(1)}時間\n`);

    let processed = 0;
    const startTime = Date.now();
    let lastNotifyTime = Date.now();

    try {
        await sendDiscordMessage(`🚀 **フェーズ2.6（女優名検索）開始**\n残り: ${pending.length.toLocaleString()}名\n推定所要時間: ${(pending.length * 8 / 3600).toFixed(1)}時間`);

        for (const actress of pending) {
            if (processed >= maxActresses) {
                console.log(`\n[テスト制限] ${maxActresses}名で終了`);
                break;
            }

            process.stdout.write(`\n[${progress.completed_actresses.length + 1}/${actresses.length}] ${actress.name} ... `);

            try {
                const productIds = await searchActressProducts(actress);
                let newMatches = 0;

                for (const pid of productIds) {
                    // DB内に存在する品番かチェック
                    if (dbActressesMap.has(pid)) {
                        const currentActresses = dbActressesMap.get(pid);

                        // DBの女優名に今回の検索女優が含まれていなければ新規マッチ
                        if (!currentActresses.includes(actress.name)) {
                            // 既存マッチと重複チェック
                            if (existingMatches.has(pid) && existingMatches.get(pid).has(actress.name)) {
                                continue;
                            }
                            appendMatch({
                                product_id: pid,
                                actress: actress.name,
                            });
                            newMatches++;
                            progress.total_matches++;

                            // 内部の重複防止マップも更新
                            if (!existingMatches.has(pid)) {
                                existingMatches.set(pid, new Set());
                            }
                            existingMatches.get(pid).add(actress.name);
                        }
                    }
                }

                console.log(`検索結果: ${productIds.length}件, 新規マッチ: ${newMatches}件`);
                if (newMatches > 0) {
                    progress.total_new_products += newMatches;
                }
            } catch (err) {
                console.log(`[エラー] ${err.message}`);
            }

            progress.completed_actresses.push(actress.name);
            saveProgress(progress);
            processed++;

            // 1時間ごとに通知
            const now = Date.now();
            if (now - lastNotifyTime >= 60 * 60 * 1000) {
                const elapsedH = ((now - startTime) / 1000 / 3600).toFixed(1);
                const progressMsg = `📊 **フェーズ2.6 途中経過** (${elapsedH}時間経過)\n` +
                    `✅ 処理済み: ${processed}名\n` +
                    `🔍 累計マッチ: ${progress.total_matches.toLocaleString()}件\n` +
                    `⏳ 残り: ${actresses.length - progress.completed_actresses.length}名`;
                await sendDiscordMessage(progressMsg);
                lastNotifyTime = now;
            }

            await politeWait();
        }
    } catch (error) {
        console.error(`\n[致命的エラー] ${error.message}`);
        saveProgress(progress);
    } finally {
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        console.log('\n========================================');
        console.log('  フェーズ2.6 サマリー');
        console.log('========================================');
        console.log(`  処理女優数:     ${processed}`);
        console.log(`  完了女優数:     ${progress.completed_actresses.length} / ${actresses.length}`);
        console.log(`  累計マッチ数:   ${progress.total_matches.toLocaleString()}`);
        console.log(`  経過時間:       ${elapsed}分`);
        console.log('========================================');
        console.log('\n💡 DB適用: node scripts/phase2_6_actress_match.js --apply\n');

        const endMsg = `✨ **フェーズ2.6 完了**\n` +
            `⏱ 処理時間: ${elapsed}分\n` +
            `✅ 完了女優数: ${progress.completed_actresses.length} / ${actresses.length}\n` +
            `🔍 累計マッチ: ${progress.total_matches.toLocaleString()}件`;
        await sendDiscordMessage(endMsg);
    }
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
