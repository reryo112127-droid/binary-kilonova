/**
 * migrations/*_perf_indexes.sql（0008, 0009, …）を FANZA の両シャードへ適用する。
 *
 * D1 の行読取枠を食っていた series_name / review_count のインデックス欠落を埋める。
 * **CREATE INDEX はテーブル全体を読む**ので、日次枠が切れている間は実行できない
 * （`exceeded ... daily row read limit` で失敗する）。枠は UTC 0時＝日本時間9時にリセット。
 *
 * 使い方: node scripts/apply_perf_indexes.mjs
 *   実行前に現在の枠消費を確認したいときは npm run usage
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');

async function main() {
    const dotenv = (await import('dotenv')).default;
    dotenv.config({ path: path.join(REPO, '.env'), quiet: true });

    // 性能インデックスの migration を全部拾う（*_perf_indexes.sql）。
    // 新しいものを足したら適用し直すだけでよいように、ファイル名を固定しない。
    // CREATE INDEX IF NOT EXISTS なので適用済みのものを再実行しても安全（かつほぼ0行）。
    const migDir = path.join(ROOT, 'migrations');
    const files = fs.readdirSync(migDir).filter(f => /_perf_indexes\.sql$/.test(f)).sort();
    if (files.length === 0) throw new Error(`${migDir} に *_perf_indexes.sql がありません`);
    const statements = files.flatMap(f => fs.readFileSync(path.join(migDir, f), 'utf-8')
        // コメント行を落として CREATE INDEX 文だけ取り出す
        .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
        .split(';').map(s => s.trim()).filter(Boolean));
    console.log(`対象: ${files.join(', ')}`);
    console.log(`適用する文: ${statements.length}件`);

    const { d1 } = (await import('../../scripts/lib/d1.js')).default;
    // series_name / review_count 列は FANZA にしか無いので FANZA シャードだけ
    const targets = ['fanza-0', 'fanza-1'];

    let failed = 0;
    for (const name of targets) {
        const db = d1(name);
        for (const stmt of statements) {
            const label = stmt.replace(/\s+/g, ' ').slice(0, 70);
            try {
                const t0 = Date.now();
                await db.execute(stmt);
                console.log(`  ✓ ${name}: ${label} (${Date.now() - t0}ms)`);
            } catch (e) {
                failed++;
                console.error(`  ✗ ${name}: ${label}\n     ${e.message}`);
                if (/daily row read limit|exceeded/i.test(e.message)) {
                    console.error('\n→ D1 の日次読取枠が切れています。CREATE INDEX はテーブルを読むので、');
                    console.error('  枠がリセットされる UTC 0時（日本時間 9:00）以降に実行し直してください。');
                    process.exitCode = 1;
                    return;
                }
            }
        }
    }

    if (failed === 0) console.log('\n完了。npm run usage で翌日の行読取が下がっているか確認してください。');
    else process.exitCode = 1;
}

main().catch(e => { console.error('失敗:', e.message); process.exitCode = 1; });
