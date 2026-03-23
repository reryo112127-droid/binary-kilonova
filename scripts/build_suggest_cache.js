/**
 * サジェストキャッシュ生成スクリプト
 *
 * ローカルの mgs.db / fanza.db から
 * 女優・メーカー・レーベル・ジャンルのユニーク一覧を抽出し
 * data/suggest_cache.json に書き出す。
 *
 * 実行: node scripts/build_suggest_cache.js
 * （fanza_daily_update.js 実行後に自動呼び出しも推奨）
 */

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const MGS_DB     = path.join(DATA_DIR, 'mgs.db');
const FANZA_DB   = path.join(DATA_DIR, 'fanza.db');
const OUTPUT     = path.join(DATA_DIR, 'suggest_cache.json');

function extractFromDb(dbPath, label) {
    if (!fs.existsSync(dbPath)) {
        console.warn(`  [スキップ] ${label}: ファイルなし`);
        return { actresses: [], makers: [], labels: [], genres: [] };
    }

    const db = new Database(dbPath, { readonly: true });

    const actSet = new Set();
    const mkSet  = new Set();
    const lbSet  = new Set();
    const gnSet  = new Set();

    // makers / labels は単一値なので DISTINCT が使える
    db.prepare("SELECT DISTINCT maker FROM products WHERE maker IS NOT NULL AND maker != ''")
        .all().forEach(r => mkSet.add(r.maker.trim()));

    db.prepare("SELECT DISTINCT label FROM products WHERE label IS NOT NULL AND label != ''")
        .all().forEach(r => lbSet.add(r.label.trim()));

    // actresses / genres はカンマ区切り → 全行スキャンして分解
    const actRows = db.prepare("SELECT actresses FROM products WHERE actresses IS NOT NULL AND actresses != ''").all();
    for (const { actresses } of actRows) {
        actresses.split(/[,\n]/).map(s => s.trim()).filter(Boolean).forEach(a => actSet.add(a));
    }

    const gnRows = db.prepare("SELECT genres FROM products WHERE genres IS NOT NULL AND genres != ''").all();
    for (const { genres } of gnRows) {
        genres.split(/[,\n]/).map(s => s.trim()).filter(Boolean).forEach(g => gnSet.add(g));
    }

    db.close();

    console.log(`  ${label}: 女優 ${actSet.size.toLocaleString()} / メーカー ${mkSet.size} / レーベル ${lbSet.size} / ジャンル ${gnSet.size}`);

    return {
        actresses: Array.from(actSet),
        makers:    Array.from(mkSet),
        labels:    Array.from(lbSet),
        genres:    Array.from(gnSet),
    };
}

function main() {
    console.log('========================================');
    console.log('  サジェストキャッシュ生成');
    console.log('========================================\n');

    const start = Date.now();

    const mgs   = extractFromDb(MGS_DB,   'MGS');
    const fanza = extractFromDb(FANZA_DB, 'FANZA');

    // マージ（重複排除）
    const merged = {
        actresses: [...new Set([...mgs.actresses, ...fanza.actresses])].sort(),
        makers:    [...new Set([...mgs.makers,    ...fanza.makers])].sort(),
        labels:    [...new Set([...mgs.labels,    ...fanza.labels])].sort(),
        genres:    [...new Set([...mgs.genres,    ...fanza.genres])].sort(),
        generated_at: new Date().toISOString(),
    };

    fs.writeFileSync(OUTPUT, JSON.stringify(merged));

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const sizeKb  = (fs.statSync(OUTPUT).size / 1024).toFixed(0);

    console.log('\n  マージ後:');
    console.log(`    女優:    ${merged.actresses.length.toLocaleString()}`);
    console.log(`    メーカー: ${merged.makers.length.toLocaleString()}`);
    console.log(`    レーベル: ${merged.labels.length.toLocaleString()}`);
    console.log(`    ジャンル: ${merged.genres.length.toLocaleString()}`);
    console.log(`\n  ✅ 出力: ${OUTPUT} (${sizeKb} KB, ${elapsed}秒)`);
    console.log('========================================\n');
}

main();
