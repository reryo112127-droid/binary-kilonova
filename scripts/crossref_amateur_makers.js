/**
 * MGS素人系メーカーとFANZAのクロス参照で女優名を特定
 *
 * 変換ルール:
 *   MGS 229SCUTE-1549 → FANZA scute1549
 *   MGS 230ORECZ-448  → FANZA orecz448
 *
 * FANZAのactrssフィールドは「本名, 2026年2月, メーカー名, 役名...」形式なので
 * 日付より前のエントリを本物の女優名として抽出する
 */

const { createClient } = require('@libsql/client');
require('dotenv').config({ path: 'site/.env.local' });

const mgs   = createClient({ url: process.env.TURSO_MGS_URL,   authToken: process.env.TURSO_MGS_TOKEN });
const fanza = createClient({ url: process.env.TURSO_FANZA_URL, authToken: process.env.TURSO_FANZA_TOKEN });

// MGS品番 → FANZAの品番に変換
// 229SCUTE-1549 → scute1549
// 230ORECZ-448  → orecz448
function toFanzaPid(mgsPid) {
    // 先頭の数字を除去、ハイフンも除去、小文字化
    const m = mgsPid.match(/^\d+([A-Z]+)-(\d+)$/);
    if (!m) return null;
    const series = m[1].toLowerCase(); // SCUTE → scute
    const num    = String(parseInt(m[2], 10)); // 0448 → 448, 1549 → 1549
    return series + num;
}

// FANZAのactrssフィールドから本物の女優名を抽出
// "南日菜乃, 2026年2月, S-CUTE(FANZA素人), ひなの, ..." → ["南日菜乃"]
// "秋元さちか #雪代美鳳, 2026年2月, ..."  → ["秋元さちか", "雪代美鳳"]
const NOISE_PATTERNS = [
    /\d+年\d+月/,                 // 日付
    /FANZA素人/,
    /^S-CUTE$/,
    /^S-Cute$/,
    /俺の素人/,
    /ハメドリ/,
    /^[A-Z]{2,}$/,               // 全大文字の英語略称 (TAE, MIHO など)
];

function extractActresses(actressStr) {
    if (!actressStr) return null;

    const entries = actressStr.split(',').map(s => s.trim()).filter(Boolean);
    const real = [];

    for (const entry of entries) {
        // 日付エントリが来たらそこで終了
        if (/\d+年\d+月/.test(entry)) break;

        // # 区切りをさらに分割（"秋元さちか #雪代美鳳" → 2名）
        const parts = entry.split('#').map(s => s.trim()).filter(Boolean);

        for (const part of parts) {
            // ノイズパターンに引っかかったらスキップ
            if (NOISE_PATTERNS.some(p => p.test(part))) continue;
            // 2文字未満はスキップ
            if (part.length < 2) continue;
            real.push(part);
        }
    }

    return real.length > 0 ? real.join(', ') : null;
}

// 対象シリーズ（MGS品番の先頭数字除いたシリーズコード）
const TARGET_SERIES = new Set(['scute', 'orecz']);

async function main() {
    console.log('MGSから未特定作品を取得中...');

    // 対象メーカーのMGS未特定作品を全取得
    const mgsResult = await mgs.execute(
        `SELECT product_id FROM products
         WHERE (actresses IS NULL OR actresses = '')
         AND (maker IN ('S-CUTE', '俺の素人-Z-')
              OR maker LIKE '%S-CUTE%' OR maker LIKE '%俺の素人-Z-%')`
    );

    const targets = mgsResult.rows
        .map(r => r.product_id)
        .filter(pid => {
            const fp = toFanzaPid(pid);
            if (!fp) return false;
            return TARGET_SERIES.has(fp.replace(/\d+$/, '').toLowerCase()) ||
                   TARGET_SERIES.has(fp.match(/^[a-z]+/)?.[0]);
        });

    console.log(`対象MGS作品数: ${targets.length}`);

    // FANZA側をまとめて取得（バッチ処理）
    const BATCH = 200;
    let matched = 0;
    let updates = [];

    for (let i = 0; i < targets.length; i += BATCH) {
        const batch = targets.slice(i, i + BATCH);
        const fanzaPids = batch.map(toFanzaPid).filter(Boolean);

        if (fanzaPids.length === 0) continue;

        const placeholders = fanzaPids.map(() => '?').join(',');
        const fanzaResult = await fanza.execute({
            sql: `SELECT product_id, actresses FROM products WHERE product_id IN (${placeholders})`,
            args: fanzaPids,
        });

        // FANZA品番 → 女優名のマップを作成
        const fanzaMap = new Map();
        for (const row of fanzaResult.rows) {
            const actresses = extractActresses(row.actresses);
            if (actresses) fanzaMap.set(row.product_id, actresses);
        }

        // MGS品番と照合
        for (const mgsPid of batch) {
            const fanzaPid = toFanzaPid(mgsPid);
            if (!fanzaPid) continue;
            const actresses = fanzaMap.get(fanzaPid);
            if (actresses) {
                updates.push({ mgsPid, fanzaPid, actresses });
                matched++;
            }
        }

        if ((i / BATCH) % 5 === 0) {
            process.stdout.write(`\r  処理中: ${Math.min(i + BATCH, targets.length)}/${targets.length} (マッチ: ${matched})`);
        }
    }

    console.log(`\nマッチ数: ${matched}`);

    if (updates.length === 0) {
        console.log('更新なし');
        return;
    }

    // サンプル表示
    console.log('\n=== サンプル（先頭10件） ===');
    updates.slice(0, 10).forEach(u =>
        console.log(`  ${u.mgsPid} → [FANZA: ${u.fanzaPid}] → ${u.actresses}`)
    );

    // MGS Tursoに更新
    console.log(`\nTursoに${updates.length}件更新中...`);
    let done = 0;
    for (const u of updates) {
        await mgs.execute({
            sql: 'UPDATE products SET actresses=? WHERE product_id=?',
            args: [u.actresses, u.mgsPid],
        });
        done++;
        if (done % 100 === 0) process.stdout.write(`\r  ${done}/${updates.length}`);
    }
    console.log(`\n完了: ${done}件更新`);
}

main()
    .catch(e => console.error('ERROR:', e.message))
    .finally(() => { mgs.close(); fanza.close(); });
