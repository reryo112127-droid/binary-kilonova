/**
 * migrations/00xx_fts_fast_delete_*.sql（FTSトリガの張り替え）を対象 D1 へ適用する。
 *
 * apply_perf_indexes.mjs と分けてあるのは、あちらが SQL を `;` で単純分割していて
 * **CREATE TRIGGER の BEGIN … END; を途中で切ってしまう**ため。
 * ここでは BEGIN…END を1文として扱うスプリッタを使う。
 *
 * トリガの張り替えは DDL なので**行を1行も読まない**＝日次枠が切れている間でも実行できる。
 * 冪等（DROP TRIGGER IF EXISTS → CREATE）なので何度実行してもよい。
 *
 * 使い方: node scripts/apply_fts_triggers.mjs [--dry-run]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');

/** コメントを落としつつ、BEGIN…END; を1文としてまとめて分割する。 */
export function splitStatements(sql) {
    // **CRLF を落とすこと**。D1 は CR を含む CREATE TRIGGER … BEGIN … END を
    // `incomplete input: SQLITE_ERROR` で拒否する（git の autocrlf でチェックアウトすると
    // 同じファイルが突然通らなくなる。2026-09-09 に踏んだ）。
    const lines = sql.replace(/\r\n?/g, '\n').split('\n').filter(l => !l.trim().startsWith('--'));
    const stmts = [];
    let cur = '';
    let inBody = false;
    for (const line of lines) {
        cur += line + '\n';
        if (/\bBEGIN\b/i.test(line) && /^\s*(CREATE|BEGIN)/i.test(cur.trim())) inBody = true;
        if (inBody) {
            if (/^\s*END\s*;/i.test(line)) { stmts.push(cur.trim().replace(/;\s*$/, '')); cur = ''; inBody = false; }
            continue;
        }
        if (/;\s*$/.test(line.trim())) { stmts.push(cur.trim().replace(/;\s*$/, '')); cur = ''; }
    }
    if (cur.trim()) stmts.push(cur.trim().replace(/;\s*$/, ''));
    return stmts.filter(Boolean);
}

async function main() {
    const dotenv = (await import('dotenv')).default;
    dotenv.config({ path: path.join(REPO, '.env'), quiet: true });
    const dry = process.argv.includes('--dry-run');

    const migDir = path.join(ROOT, 'migrations');
    const files = fs.readdirSync(migDir).filter(f => /_fts_fast_delete_\w+\.sql$/.test(f)).sort();
    if (files.length === 0) throw new Error(`${migDir} に *_fts_fast_delete_*.sql がありません`);

    const { d1 } = (await import('../../scripts/lib/d1.js')).default;
    let failed = 0;
    for (const f of files) {
        const raw = fs.readFileSync(path.join(migDir, f), 'utf-8');
        const m = raw.match(/^\s*--\s*@targets:\s*(.+)$/m);
        const targets = m ? m[1].split(',').map(x => x.trim()).filter(Boolean) : [];
        if (targets.length === 0) { console.error(`  ✗ ${f}: @targets 宣言がありません`); failed++; continue; }
        const stmts = splitStatements(raw);
        console.log(`対象: ${f} → ${targets.join(', ')} (${stmts.length}文)`);
        for (const name of targets) {
            const db = d1(name);
            for (const stmt of stmts) {
                const label = stmt.replace(/\s+/g, ' ').slice(0, 60);
                if (dry) { console.log(`  · ${name}: ${label}`); continue; }
                try {
                    // scripts/lib/d1.js は旧Turso向けの products_au 管理文を no-op 化するので、
                    // 意図した張り替えであることを示すマーカーを付けて素通しさせる。
                    await db.execute(`${stmt}\n-- @fts-admin`);
                    console.log(`  ✓ ${name}: ${label}`);
                } catch (e) {
                    failed++;
                    console.error(`  ✗ ${name}: ${label}\n     ${e.message}`);
                }
            }
        }
    }
    // 張り替えは「成功したように見えて何も起きない」ことがある（d1.js の no-op ガード）。
    // sqlite_master を読み直して MATCH 版になっているか必ず確かめる（数十行の読取で済む）。
    if (!dry) {
        for (const name of ['fanza-0', 'fanza-1', 'mgs']) {
            try {
                const want = ['products_ad', 'products_au', 'products_bi'];
                const r = await d1(name).execute(
                    "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name IN ('products_au','products_ad','products_bi')");
                const seen = new Set();
                for (const row of (r.rows || r)) {
                    seen.add(String(row.name));
                    const ok = /products_fts MATCH/i.test(String(row.sql));
                    console.log(`  ${ok ? '✓' : '✗'} ${name}.${row.name}: ${ok ? 'MATCH版' : '**旧・全走査版のまま**'}`);
                    if (!ok) failed++;
                }
                for (const w of want.filter(x => !seen.has(x))) {
                    console.error(`  ✗ ${name}.${w}: **トリガが無い**（DROPだけ通ってCREATEが落ちた可能性）`);
                    failed++;
                }
            } catch (e) { console.error(`  ✗ ${name}: 確認できず (${e.message})`); failed++; }
        }
    }

    if (failed === 0) console.log('\n完了。products の1行UPDATEが全走査(19万行)にならないことを確認してください。');
    else process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
    main().catch(e => { console.error('失敗:', e.message); process.exitCode = 1; });
}
