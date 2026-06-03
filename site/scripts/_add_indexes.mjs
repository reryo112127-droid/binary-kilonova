/**
 * FANZAとMGS DBにインデックスを追加してフルスキャンを防ぐ
 * 実行: node scripts/_add_indexes.mjs
 */
import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const mgs   = createClient({ url: process.env.TURSO_MGS_URL,   authToken: process.env.TURSO_MGS_TOKEN });
const fanza = createClient({ url: process.env.TURSO_FANZA_URL, authToken: process.env.TURSO_FANZA_TOKEN });

async function showExisting(client, name) {
    const rows = await client.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='products' ORDER BY name").then(r => r.rows);
    console.log(`\n${name} 既存インデックス (${rows.length}件):`);
    rows.forEach(r => console.log('  -', r.name));
}

async function addIndex(client, name, sql) {
    try {
        await client.execute(sql);
        console.log(`  ✓ ${name}`);
    } catch (e) {
        if (e.message?.includes('already exists')) {
            console.log(`  = ${name} (既存)`);
        } else {
            console.log(`  ✗ ${name}: ${e.message}`);
        }
    }
}

// ── 既存確認 ──────────────────────────────────────────────
await showExisting(mgs,   'MGS');
await showExisting(fanza, 'FANZA');

// ── MGS インデックス追加 ──────────────────────────────────
console.log('\nMGS インデックス追加中...');
const mgsIndexes = [
    ['idx_mgs_sale_date',     "CREATE INDEX IF NOT EXISTS idx_mgs_sale_date     ON products(sale_start_date DESC)"],
    ['idx_mgs_wish_count',    "CREATE INDEX IF NOT EXISTS idx_mgs_wish_count    ON products(wish_count DESC)"],
    ['idx_mgs_discount',      "CREATE INDEX IF NOT EXISTS idx_mgs_discount      ON products(discount_pct DESC)"],
    ['idx_mgs_maker',         "CREATE INDEX IF NOT EXISTS idx_mgs_maker         ON products(maker)"],
    ['idx_mgs_label',         "CREATE INDEX IF NOT EXISTS idx_mgs_label         ON products(label)"],
    ['idx_mgs_actresses',     "CREATE INDEX IF NOT EXISTS idx_mgs_actresses     ON products(actresses)"],
    // 複合インデックス（新着クエリで最も効く）
    ['idx_mgs_date_pid',      "CREATE INDEX IF NOT EXISTS idx_mgs_date_pid      ON products(sale_start_date DESC, product_id)"],
    ['idx_mgs_wish_pid',      "CREATE INDEX IF NOT EXISTS idx_mgs_wish_pid      ON products(wish_count DESC, product_id)"],
    ['idx_mgs_maker_date',    "CREATE INDEX IF NOT EXISTS idx_mgs_maker_date    ON products(maker, sale_start_date DESC)"],
    ['idx_mgs_discount_date', "CREATE INDEX IF NOT EXISTS idx_mgs_discount_date ON products(discount_pct DESC, sale_start_date DESC)"],
];
for (const [name, sql] of mgsIndexes) {
    await addIndex(mgs, name, sql);
}

// ── FANZA インデックス追加 ────────────────────────────────
console.log('\nFANZA インデックス追加中...');
const fanzaIndexes = [
    ['idx_fanza_sale_date',     "CREATE INDEX IF NOT EXISTS idx_fanza_sale_date     ON products(sale_start_date DESC)"],
    ['idx_fanza_discount',      "CREATE INDEX IF NOT EXISTS idx_fanza_discount      ON products(discount_pct DESC)"],
    ['idx_fanza_maker',         "CREATE INDEX IF NOT EXISTS idx_fanza_maker         ON products(maker)"],
    ['idx_fanza_label',         "CREATE INDEX IF NOT EXISTS idx_fanza_label         ON products(label)"],
    ['idx_fanza_floor',         "CREATE INDEX IF NOT EXISTS idx_fanza_floor         ON products(floor)"],
    ['idx_fanza_actresses',     "CREATE INDEX IF NOT EXISTS idx_fanza_actresses     ON products(actresses)"],
    ['idx_fanza_vr',            "CREATE INDEX IF NOT EXISTS idx_fanza_vr            ON products(vr_flag)"],
    // 複合インデックス（最もよく使われるクエリパターン）
    ['idx_fanza_date_pid',      "CREATE INDEX IF NOT EXISTS idx_fanza_date_pid      ON products(sale_start_date DESC, product_id)"],
    ['idx_fanza_discount_date', "CREATE INDEX IF NOT EXISTS idx_fanza_discount_date ON products(discount_pct DESC, sale_start_date DESC)"],
    ['idx_fanza_maker_date',    "CREATE INDEX IF NOT EXISTS idx_fanza_maker_date    ON products(maker, sale_start_date DESC)"],
    ['idx_fanza_label_date',    "CREATE INDEX IF NOT EXISTS idx_fanza_label_date    ON products(label, sale_start_date DESC)"],
    ['idx_fanza_floor_date',    "CREATE INDEX IF NOT EXISTS idx_fanza_floor_date    ON products(floor, sale_start_date DESC)"],
    ['idx_fanza_floor_disc',    "CREATE INDEX IF NOT EXISTS idx_fanza_floor_disc    ON products(floor, discount_pct DESC)"],
];
for (const [name, sql] of fanzaIndexes) {
    await addIndex(fanza, name, sql);
}

console.log('\n完了！次回クエリからインデックスが有効になります。');
process.exit(0);
