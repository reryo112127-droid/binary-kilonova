/**
 * パッケージ画像の裸露出チェックスクリプト（肌色ピクセル率検出・APIコスト0円）
 *
 * 使い方:
 *   node scripts/prefilter-nude.mjs              # 未チェック分を全処理
 *   node scripts/prefilter-nude.mjs --limit 500  # 最大500件
 *   node scripts/prefilter-nude.mjs --recheck    # 全件再チェック
 *   node scripts/prefilter-nude.mjs --dry        # DB更新なしで確認のみ
 *
 * x_safe: 1=安全 / 0=NG(露出あり) / NULL=未チェック
 *
 * 判定基準:
 *   肌色ピクセル率 > 40% → NG（パッケージ画像に大量の肌が露出）
 *   肌色ピクセル率 > 28% かつ 画像が明るい → NG（裸に近い状態）
 */

import { Jimp } from 'jimp';
import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const args    = process.argv.slice(2);
const LIMIT   = parseInt(args[args.indexOf('--limit') + 1] || '0', 10) || 999999;
const RECHECK = args.includes('--recheck');
const DRY     = args.includes('--dry');
const CONCURRENCY = 20;

// MGS DB（読み取り専用）
const mgs  = createClient({ url: process.env.TURSO_MGS_URL,  authToken: process.env.TURSO_MGS_TOKEN });
// Site DB（書き込み先：FTS5トリガーなし）
const site = createClient({ url: process.env.TURSO_SITE_URL, authToken: process.env.TURSO_SITE_TOKEN });

// product_safetyテーブル作成（なければ）
await site.execute(`CREATE TABLE IF NOT EXISTS product_safety (
    product_id TEXT PRIMARY KEY,
    x_safe     INTEGER NOT NULL DEFAULT 1,
    checked_at TEXT DEFAULT (datetime('now'))
)`);
console.log('product_safetyテーブル確認済み\n');

// 対象作品を取得（RECHECKなら全件、通常はproduct_safetyに未登録のもの）
let rows;
if (RECHECK) {
    rows = await mgs.execute({
        sql: `SELECT product_id, main_image_url FROM products
              WHERE main_image_url IS NOT NULL AND main_image_url != ''
              ORDER BY sale_start_date DESC LIMIT ?`,
        args: [LIMIT],
    }).then(r => r.rows);
} else {
    const checked = await site.execute('SELECT product_id FROM product_safety').then(r => new Set(r.rows.map(r => String(r.product_id))));
    const allRows = await mgs.execute({
        sql: `SELECT product_id, main_image_url FROM products
              WHERE main_image_url IS NOT NULL AND main_image_url != ''
              ORDER BY sale_start_date DESC LIMIT ?`,
        args: [Math.min(LIMIT * 10, 200000)],
    }).then(r => r.rows);
    rows = allRows.filter(r => !checked.has(String(r.product_id))).slice(0, LIMIT);
}

console.log(`対象: ${rows.length}件 | 並列: ${CONCURRENCY} | ${RECHECK ? '全件再チェック' : '未チェックのみ'}${DRY ? ' [DRY RUN]' : ''}\n`);

// RGB → HSL変換
function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0)
          : max === g ? (b - r) / d + 2
          :             (r - g) / d + 4;
    return [h / 6, s, l];
}

// 肌色判定
function isSkinPixel(r, g, b) {
    const [h, s, l] = rgbToHsl(r, g, b);
    return h >= 0.0 && h <= 0.12   // 赤〜オレンジ系
        && s >= 0.15 && s <= 0.9
        && l >= 0.25 && l <= 0.85;
}

async function checkImage(imageUrl) {
    // サムネイル(pb_e_)を使用（小さく高速）
    const thumbUrl = imageUrl.includes('pf_e_') ? imageUrl.replace('pf_e_', 'pb_e_') : imageUrl;

    const res = await fetch(thumbUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    const img = await Jimp.fromBuffer(buf);

    // 小さくリサイズして高速化
    img.resize({ w: 120, h: 160 });
    const { data, width, height } = img.bitmap;
    const total = width * height;

    let skinCount = 0;
    let brightnessSum = 0;
    for (let i = 0; i < total; i++) {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
        if (isSkinPixel(r, g, b)) skinCount++;
        brightnessSum += (r + g + b) / (3 * 255);
    }

    const skinRatio  = skinCount / total;
    const brightness = brightnessSum / total;

    // NG条件: 肌色40%超 OR (肌色28%超かつ画像が明るめ)
    const isNg = skinRatio > 0.40 || (skinRatio > 0.28 && brightness > 0.55);
    return { safe: !isNg, skinRatio, brightness };
}

let done = 0, safe = 0, ng = 0, errors = 0;
const start = Date.now();

// 並列処理
async function processOne(row) {
    const pid = String(row.product_id);
    const url = String(row.main_image_url);
    try {
        const result = await checkImage(url);
        if (result === null) { errors++; return; }

        const xSafe = result.safe ? 1 : 0;
        if (!DRY) {
            await site.execute({
                sql: `INSERT OR REPLACE INTO product_safety (product_id, x_safe, checked_at) VALUES (?, ?, datetime('now'))`,
                args: [pid, xSafe],
            });
        }
        if (xSafe) safe++; else ng++;
    } catch (e) {
        if (errors < 3) console.error('\nエラー詳細:', pid, e.message);
        errors++;
        if (!DRY) await site.execute({ sql: `INSERT OR REPLACE INTO product_safety (product_id, x_safe) VALUES (?, 1)`, args: [pid] }).catch(() => {});
    }
    done++;
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    const eta = Math.round((Date.now() - start) / done * (rows.length - done) / 1000);
    process.stdout.write(`\r[${done}/${rows.length}] 安全:${safe} NG:${ng} エラー:${errors} | ${elapsed}s経過 残り~${eta}s  `);
}

// CONCURRENCY件ずつ並列実行
for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(row => processOne(row)));
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\n\n完了！ 安全:${safe}件 / NG:${ng}件 / エラー:${errors}件 (計${rows.length}件)`);
console.log(`所要時間: ${elapsed}秒 (${(rows.length / parseFloat(elapsed)).toFixed(1)}枚/秒)`);
if (ng > 0) console.log(`\nNG率: ${(ng / rows.length * 100).toFixed(1)}%`);
process.exit(0);
