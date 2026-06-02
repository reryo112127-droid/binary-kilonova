/**
 * MGSとFANZA両方に存在する作品をFANZA DBから削除
 *
 * 対応パターン:
 *   FANZA product_id: mla005
 *   MGS product_id:   476MLA-005
 *   変換: FANZA id → 大文字化 + ハイフン挿入 → MGS形式で存在確認
 *
 * 実行方法:
 *   node scripts/_delete_fanza_duplicates.mjs          # ドライラン（削除なし）
 *   node scripts/_delete_fanza_duplicates.mjs --delete  # 実際に削除
 */

import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DRY_RUN = !process.argv.includes('--delete');
if (DRY_RUN) console.log('=== ドライラン（--delete を付けると実際に削除） ===\n');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const mgs   = createClient({ url: process.env.TURSO_MGS_URL,   authToken: process.env.TURSO_MGS_TOKEN });
const fanza = createClient({ url: process.env.TURSO_FANZA_URL, authToken: process.env.TURSO_FANZA_TOKEN });

// FANZA: MGSと同名メーカー（maker/labelが一致）の全product_idを取得
console.log('MGSのメーカー一覧を取得中...');
const mgsMakers = await mgs.execute(
    "SELECT DISTINCT maker FROM products WHERE maker IS NOT NULL AND maker != ''"
).then(r => new Set(r.rows.map(r => String(r.maker))));
console.log(`MGSメーカー数: ${mgsMakers.size}`);

console.log('FANZAの該当メーカー作品を取得中...');
// FANZAからMGSと同じmaker名の作品を全取得
const fanzaRows = await fanza.execute(
    "SELECT product_id, maker, label FROM products WHERE maker IS NOT NULL AND maker != ''"
).then(r => r.rows.filter(r => mgsMakers.has(String(r.maker)) || mgsMakers.has(String(r.label || ''))));
console.log(`FANZA側・MGSと同名メーカー作品数: ${fanzaRows.length}`);

// FANZAのproduct_idをMGS形式に変換して照合
// パターン: FANZAのID (例: mla005) → 正規表現で英字部分と数字部分を分離
// MGS形式: 476MLA-005 (メーカーコードはMGS側に問い合わせ)
// 汎用パターン: FANZA id を大文字化し、英字+数字の境界にハイフンを挿入した文字列がMGSに存在するか

// MGSの全product_idをセットで保持
console.log('MGSのproduct_id一覧を取得中...');
const mgsIds = await mgs.execute('SELECT product_id FROM products').then(r => new Set(r.rows.map(r => String(r.product_id).toUpperCase())));
console.log(`MGS作品数: ${mgsIds.size}`);

// FANZA IDをMGS形式に正規化して照合
function toMgsFormat(fanzaId) {
    // 例: mla005 → MLA-005, mla0005 → MLA-0005
    const m = fanzaId.match(/^([a-zA-Z]+)(\d+)$/);
    if (!m) return null;
    const [, letters, nums] = m;
    return letters.toUpperCase() + '-' + nums; // MLA-005
}

const toDelete = [];
const byMaker = {};

for (const row of fanzaRows) {
    const fanzaId = String(row.product_id);
    const mgsFormat = toMgsFormat(fanzaId);
    if (!mgsFormat) continue;

    // MGS IDが「???XXXXX-NNN」形式なので、末尾がMGS形式と一致するものを探す
    // 例: MLA-005 → MGS側で "476MLA-005" など、末尾が "-MLA-005" または "MLA-005" で終わるIDを検索
    const matchesMgs = mgsIds.has(mgsFormat) ||
        [...mgsIds].some(id => id.endsWith('-' + mgsFormat) || id.endsWith(mgsFormat));

    if (matchesMgs) {
        const maker = String(row.maker || row.label || '');
        byMaker[maker] = (byMaker[maker] || 0) + 1;
        toDelete.push(fanzaId);
    }
}

console.log(`\n重複作品数（FANZA削除対象）: ${toDelete.length}件`);
console.log('\nメーカー別:');
Object.entries(byMaker).sort((a,b) => b[1]-a[1]).forEach(([m,c]) => console.log(`  ${m}: ${c}件`));

if (toDelete.length > 0 && !DRY_RUN) {
    console.log('\n削除中...');
    const BATCH = 50;
    let deleted = 0;
    for (let i = 0; i < toDelete.length; i += BATCH) {
        const batch = toDelete.slice(i, i + BATCH);
        const placeholders = batch.map(() => '?').join(',');
        await fanza.execute({
            sql: `DELETE FROM products WHERE product_id IN (${placeholders})`,
            args: batch,
        });
        deleted += batch.length;
        process.stdout.write(`\r  ${deleted}/${toDelete.length}件 削除済み`);
    }
    console.log('\n\n完了！');
} else if (toDelete.length > 0) {
    console.log('\n（ドライラン: 実際には削除しません）');
    console.log('削除サンプル:', toDelete.slice(0, 10));
}

process.exit(0);
