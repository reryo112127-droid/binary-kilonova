/**
 * D1 の行読取をクエリ単位で内訳表示する（「誰が枠を食ったか」の特定用）。
 *
 * check_free_tier_usage.mjs は「日次の合計」しか出さないので、枠切れの原因追及には
 * こちらを使う。d1QueriesAdaptiveGroups は直近24h程度しか保持していない点に注意。
 * （`queryCount` というフィールドは無い。件数は group の `count`）
 *
 * 使い方: node scripts/check_d1_queries.mjs [--hours=24] [--top=25]
 */
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');
const GQL = 'https://api.cloudflare.com/client/v4/graphql';

const DB_NAMES = {
    [process.env.D1_SITE_ID || '_site']: 'site',
    [process.env.D1_MGS_ID || '_mgs']: 'mgs',
    [process.env.D1_FANZA_0_ID || '_f0']: 'fanza-0',
    [process.env.D1_FANZA_1_ID || '_f1']: 'fanza-1',
};

async function main() {
    const dotenv = (await import('dotenv')).default;
    dotenv.config({ path: path.join(REPO, '.env'), quiet: true });
    for (const [env, name] of [['D1_SITE_ID', 'site'], ['D1_MGS_ID', 'mgs'], ['D1_FANZA_0_ID', 'fanza-0'], ['D1_FANZA_1_ID', 'fanza-1']]) {
        if (process.env[env]) DB_NAMES[process.env[env]] = name;
    }

    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN || process.env.CLOUDFLARE_D1_TOKEN;
    if (!account || !token) { console.error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_ANALYTICS_TOKEN が未設定'); process.exitCode = 2; return; }

    const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? parseInt(a.split('=')[1], 10) : d; };
    const hours = arg('hours', 24);
    const top = arg('top', 25);
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    const until = new Date().toISOString();

    const gql = `query Q($account: String!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: {accountTag: $account}) {
        d1QueriesAdaptiveGroups(limit: 1000, filter: {datetime_geq: $since, datetime_leq: $until}, orderBy: [sum_rowsRead_DESC]) {
          count
          sum { rowsRead rowsReturned }
          dimensions { query databaseId }
        }
      } }
    }`;
    const res = await fetch(GQL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: gql, variables: { account, since, until } }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.errors?.length) { console.error('取得失敗:', json.errors.map(e => e.message).join('; ')); process.exitCode = 2; return; }

    const groups = json?.data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? [];
    const total = groups.reduce((s, g) => s + (g.sum.rowsRead ?? 0), 0);
    console.log(`\n直近 ${hours}h の D1 行読取: ${total.toLocaleString()} 行 / ${groups.length} クエリ種\n`);
    console.log('  行読取      回数    1回あたり  DB        クエリ');
    console.log('  ' + '-'.repeat(110));
    for (const g of groups.slice(0, top)) {
        const rows = g.sum.rowsRead ?? 0;
        const n = g.count ?? 0;
        const per = n ? Math.round(rows / n) : 0;
        const db = DB_NAMES[g.dimensions.databaseId] || g.dimensions.databaseId.slice(0, 8);
        // SELECT句は全クエリほぼ同一で見分けがつかないので FROM 以降（WHERE/ORDER BY）を出す
        const raw = (g.dimensions.query || '').replace(/\s+/g, ' ');
        const fi = raw.indexOf(' FROM ');
        const q = (fi >= 0 ? raw.slice(fi + 1) : raw).slice(0, process.argv.includes("--full") ? 4000 : 200);
        console.log(`  ${rows.toLocaleString().padStart(11)} ${String(n).padStart(7)} ${per.toLocaleString().padStart(11)}  ${db.padEnd(8)}  ${q}`);
    }
    console.log('');
}
main().catch(e => { console.error('失敗:', e.message); process.exitCode = 2; });
