/**
 * FTS5仮想テーブルをMGS・FANZAのTursoDBに作成するスクリプト
 * 使い方: node scripts/create-fts5.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function loadEnv() {
    const envPath = path.join(ROOT, '.env.local');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
}
loadEnv();

function toHttpsUrl(url) {
    return url.trim().replace(/^libsql:\/\//, 'https://');
}

const INDEX_SQLS = [
    `CREATE INDEX IF NOT EXISTS idx_release_date ON products(release_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_source       ON products(source)`,
    `CREATE INDEX IF NOT EXISTS idx_duration     ON products(duration_min)`,
    `CREATE INDEX IF NOT EXISTS idx_sale_start   ON products(sale_start_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_discount     ON products(discount_pct DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_wish         ON products(wish_count DESC)`,
];

const FTS5_SQLS = [
    `CREATE VIRTUAL TABLE IF NOT EXISTS products_fts
       USING fts5(product_id, title, actresses, genres,
                  content=products, content_rowid=rowid,
                  tokenize='trigram')`,
    `INSERT INTO products_fts(products_fts) VALUES('rebuild')`,
    `CREATE TRIGGER IF NOT EXISTS products_ai AFTER INSERT ON products BEGIN
       INSERT INTO products_fts(rowid, product_id, title, actresses, genres)
       VALUES (new.rowid, new.product_id, new.title, new.actresses, new.genres);
     END`,
    `CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE ON products BEGIN
       INSERT INTO products_fts(products_fts, rowid, product_id, title, actresses, genres)
       VALUES('delete', old.rowid, old.product_id, old.title, old.actresses, old.genres);
       INSERT INTO products_fts(rowid, product_id, title, actresses, genres)
       VALUES (new.rowid, new.product_id, new.title, new.actresses, new.genres);
     END`,
];

async function setupFts5(name, url, token) {
    console.log(`\n[${name}] 接続中: ${url}`);
    const db = createClient({ url: toHttpsUrl(url), authToken: token });

    // テーブル件数確認
    const count = await db.execute('SELECT COUNT(*) as n FROM products');
    console.log(`[${name}] products テーブル: ${count.rows[0].n} 件`);

    // インデックス作成
    console.log(`[${name}] --- インデックス ---`);
    for (const sql of INDEX_SQLS) {
        const label = sql.trim().replace(/\s+/g, ' ').slice(0, 70);
        process.stdout.write(`[${name}] ${label}... `);
        try {
            await db.execute(sql);
            console.log('✓');
        } catch (e) {
            console.log(`✗ ${e.message}`);
        }
    }

    // FTS5
    console.log(`[${name}] --- FTS5 ---`);
    for (const sql of FTS5_SQLS) {
        const label = sql.trim().split('\n')[0].slice(0, 60);
        process.stdout.write(`[${name}] ${label}... `);
        try {
            await db.execute(sql);
            console.log('✓');
        } catch (e) {
            console.log(`✗ ${e.message}`);
            // rebuild失敗は致命的なので停止
            if (sql.includes('rebuild')) throw e;
        }
    }

    // 動作確認
    try {
        const test = await db.execute({
            sql: `SELECT COUNT(*) as n FROM products_fts WHERE products_fts MATCH ?`,
            args: ['波多野結衣'],
        });
        console.log(`[${name}] 動作確認: "波多野結衣" → ${test.rows[0].n} 件 ✓`);
    } catch (e) {
        console.log(`[${name}] 動作確認失敗: ${e.message}`);
    }
}

const configs = [
    { name: 'FANZA', url: process.env.TURSO_FANZA_URL, token: process.env.TURSO_FANZA_TOKEN },
    { name: 'MGS',   url: process.env.TURSO_MGS_URL,   token: process.env.TURSO_MGS_TOKEN   },
];

for (const { name, url, token } of configs) {
    if (!url || !token) { console.log(`[${name}] 環境変数未設定 → スキップ`); continue; }
    await setupFts5(name, url, token);
}

console.log('\n完了！');
