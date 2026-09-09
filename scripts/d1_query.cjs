/**
 * D1 に任意のSQLを1文投げて **rows_read / rows_written と結果**を表示する（枠調査用）。
 *
 * check_d1_queries.mjs が「どのクエリ形が枠を食ったか」を出すのに対し、こちらは
 * 「そのクエリが実際に何行読むか」を1発で測る・EXPLAIN QUERY PLAN を見るためのもの。
 * **EXPLAIN QUERY PLAN は0行しか読まないので、日次枠が切れている間でも実行できる**。
 * 逆に実データを返すクエリは枠を消費するので、全表走査を測るときは1回だけにすること
 * （SELECT COUNT(*) FROM products_fts のような一見軽い文が30万行読む）。
 *
 * 使い方:
 *   node scripts/d1_query.cjs <fanza0|fanza1|mgs|site> "<SQL>"
 *   node scripts/d1_query.cjs fanza0 "EXPLAIN QUERY PLAN SELECT ... "
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
const tok = process.env.CLOUDFLARE_D1_TOKEN;
const DBS = {
    fanza0: process.env.D1_FANZA_0_ID,
    fanza1: process.env.D1_FANZA_1_ID,
    mgs: process.env.D1_MGS_ID,
    site: process.env.D1_SITE_ID,
};

(async () => {
    const db = DBS[process.argv[2]];
    const sql = process.argv.slice(3).join(' ');
    if (!db || !sql) {
        console.error('使い方: node scripts/d1_query.cjs <fanza0|fanza1|mgs|site> "<SQL>"');
        process.exit(2);
    }
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/d1/database/${db}/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql }),
    });
    const j = await r.json();
    if (!j.success) { console.log(JSON.stringify(j.errors)); process.exit(1); }
    for (const res of j.result) {
        console.log('meta:', JSON.stringify(res.meta && {
            rows_read: res.meta.rows_read, rows_written: res.meta.rows_written, duration: res.meta.duration,
        }));
        for (const row of res.results) console.log(JSON.stringify(row));
    }
})();
