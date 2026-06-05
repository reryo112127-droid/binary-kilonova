/**
 * ローカル data/mgs.db・data/fanza.db の products を D1 投入用 SQL に書き出す。
 *
 * 出力（d1_export/<mgs|fanza>/）:
 *   products_NNN.sql       … products テーブルのデータ（INSERT OR REPLACE、複数行バッチ）
 *   products_fts_NNN.sql   … products_fts のデータ（FTS列のみ）
 *
 * 各ファイルは既定 50,000 行ごとに分割。D1 無料枠は「書き込み 10万行/日」のため、
 * 1日あたり products+fts で 2 ファイル程度を目安に投入する（下部の推奨スケジュール参照）。
 *
 * 使い方:
 *   node scripts/export_catalog_to_d1.mjs                # 既定 50000 行/ファイル
 *   node scripts/export_catalog_to_d1.mjs --chunk 90000  # 行数指定
 *
 * 投入（schema → products → fts の順。fts は 0004 を先に実行しておくこと）:
 *   wrangler d1 execute avrankings-mgs --remote --file=migrations/0002_catalog_mgs.sql
 *   for f in d1_export/mgs/products_*.sql;     do wrangler d1 execute --file avrankings-mgs --remote --file="$f"; done
 *   wrangler d1 execute avrankings-mgs --remote --file=migrations/0004_catalog_fts.sql
 *   for f in d1_export/mgs/products_fts_*.sql; do wrangler d1 execute --file avrankings-mgs --remote --file="$f"; done
 *   （fanza も同様）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const chunkIdx = args.indexOf('--chunk');
const CHUNK_ROWS = chunkIdx >= 0 ? parseInt(args[chunkIdx + 1], 10) : 50000;
const BYTES_PER_INSERT = 80 * 1024;  // 1 INSERT 文あたりのバイト上限（D1 のSQL文上限~100KB対策）

const FTS_COLS = ['product_id', 'title', 'actresses', 'genres', 'label', 'maker'];

const TARGETS = [
    { name: 'mgs',   db: path.join(ROOT, 'data', 'mgs.db') },
    { name: 'fanza', db: path.join(ROOT, 'data', 'fanza.db') },
];

function sqlVal(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'bigint') return v.toString();
    if (Buffer.isBuffer(v)) return "X'" + v.toString('hex') + "'";
    return "'" + String(v).replace(/'/g, "''") + "'";
}

function writeChunkedInserts(outDir, prefix, table, columns, rows) {
    let fileNo = 0;
    let totalFiles = 0;
    for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
        fileNo++;
        const slice = rows.slice(start, start + CHUNK_ROWS);
        const colList = columns.join(', ');
        const header = `INSERT OR REPLACE INTO ${table} (${colList}) VALUES\n`;
        const lines = [`-- ${table}: rows ${start + 1}..${start + slice.length}`];
        // D1 の SQL 文上限(約100KB)を超えないよう、1 INSERT を ~80KB のバイト予算で区切る
        // （sample_images_json で行幅が変動するため行数ではなくバイト数で制御）。
        let buf = [];
        let bufBytes = 0;
        const flush = () => {
            if (buf.length === 0) return;
            lines.push(header + buf.join(',\n') + ';');
            buf = [];
            bufBytes = 0;
        };
        for (const r of slice) {
            const tuple = '(' + columns.map(c => sqlVal(r[c])).join(', ') + ')';
            const tupleBytes = Buffer.byteLength(tuple, 'utf-8');
            // 1行で予算超過する場合は単独 INSERT（それでも上限内に収まる想定: 最大行 ~10KB）
            if (bufBytes > 0 && bufBytes + tupleBytes > BYTES_PER_INSERT) flush();
            buf.push(tuple);
            bufBytes += tupleBytes + 2;
        }
        flush();
        const file = path.join(outDir, `${prefix}_${String(fileNo).padStart(3, '0')}.sql`);
        fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
        totalFiles++;
    }
    return totalFiles;
}

let grandRows = 0;
for (const t of TARGETS) {
    if (!fs.existsSync(t.db)) {
        console.warn(`⚠️  ${t.db} が無いためスキップ`);
        continue;
    }
    const outDir = path.join(ROOT, 'd1_export', t.name);
    fs.mkdirSync(outDir, { recursive: true });

    const db = new Database(t.db, { readonly: true });
    const cols = db.prepare('PRAGMA table_info(products)').all().map(r => r.name);
    const rows = db.prepare('SELECT * FROM products').all();
    db.close();

    const pFiles = writeChunkedInserts(outDir, 'products', 'products', cols, rows);
    // FTS 用は FTS 列のみ（FTS テーブルに無い列は除外）
    const ftsRows = rows.map(r => {
        const o = {};
        for (const c of FTS_COLS) o[c] = r[c] ?? null;
        return o;
    });
    const fFiles = writeChunkedInserts(outDir, 'products_fts', 'products_fts', FTS_COLS, ftsRows);

    grandRows += rows.length * 2; // products + fts
    console.log(`[${t.name}] products ${rows.length} 行 → ${pFiles} ファイル / fts ${rows.length} 行 → ${fFiles} ファイル  (${outDir})`);
}

const days = Math.ceil(grandRows / 100000);
console.log(`\n書き込み総行数（products+fts）: ${grandRows.toLocaleString()} 行`);
console.log(`D1 無料枠（10万行/日）での目安投入日数: 約 ${days} 日`);
console.log(`→ 1日あたり 50,000行ファイルを 2本ずつ投入すれば上限内に収まる。`);
console.log(`※ wrangler d1 execute --file の計上仕様はダッシュボードで確認のこと。1本ずつ投入して D1 メトリクスを見ながら進める。`);
