/**
 * ローカル data/fanza.db(dedup済み) を FANZA_SHARDS 個のシャードに分割して D1 投入用 SQL を生成。
 * 各シャードは slim 検索スキーマ(0005)の列のみ。出力: d1_export/fanza_<shard>/products_NNN.sql
 * FTS は投入時にトリガが自動生成するため fts ファイルは出さない。
 *
 * 使い方: node scripts/export_fanza_shards.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { FANZA_SHARDS, shardOf } = require('./lib/shard.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BYTES_PER_INSERT = 80 * 1024;

const SLIM_COLS = ['product_id','title','actresses','maker','label','duration_min','genres',
    'sale_start_date','main_image_url','sample_video_url','affiliate_url','list_price','current_price',
    'discount_pct','sale_end_date','series_id','series_name','vr_flag'];

function sqlVal(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'bigint') return v.toString();
    return "'" + String(v).replace(/'/g, "''") + "'";
}

const db = new Database(path.join(ROOT, 'data', 'fanza.db'), { readonly: true });
const rows = db.prepare(`SELECT ${SLIM_COLS.map(c => `"${c}"`).join(',')} FROM products`).all();
db.close();

// シャードに振り分け
const shards = Array.from({ length: FANZA_SHARDS }, () => []);
for (const r of rows) shards[shardOf(r.product_id, FANZA_SHARDS)].push(r);

const colList = SLIM_COLS.join(', ');
const header = `INSERT OR REPLACE INTO products (${colList}) VALUES\n`;
for (let s = 0; s < FANZA_SHARDS; s++) {
    const outDir = path.join(ROOT, 'd1_export', `fanza_${s}`);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const srows = shards[s];
    const CHUNK_ROWS = 50000;
    let fileNo = 0;
    for (let start = 0; start < srows.length; start += CHUNK_ROWS) {
        fileNo++;
        const slice = srows.slice(start, start + CHUNK_ROWS);
        const lines = [];
        let buf = [], bufBytes = 0;
        const flush = () => { if (buf.length) { lines.push(header + buf.join(',\n') + ';'); buf = []; bufBytes = 0; } };
        for (const r of slice) {
            const tuple = '(' + SLIM_COLS.map(c => sqlVal(r[c])).join(', ') + ')';
            const tb = Buffer.byteLength(tuple, 'utf-8');
            if (bufBytes > 0 && bufBytes + tb > BYTES_PER_INSERT) flush();
            buf.push(tuple); bufBytes += tb + 2;
        }
        flush();
        fs.writeFileSync(path.join(outDir, `products_${String(fileNo).padStart(3, '0')}.sql`), lines.join('\n') + '\n', 'utf-8');
    }
    console.log(`shard ${s}: ${srows.length.toLocaleString()} 行 → ${fileNo} ファイル (${outDir})`);
}
console.log('完了');
