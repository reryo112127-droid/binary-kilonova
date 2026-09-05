/**
 * Cloudflare 無料枠の消費量を確認する（D1 の行読取・書込 / Workers のリクエスト数）。
 *
 * SEOでURLを増やすときに効いてくる上限は2つある:
 *   - D1     : 500万行読取/日・10万行書込/日（**アカウント全体**・UTC 0時リセット）
 *   - Workers: 10万リクエスト/日（動的ルートは1クロール=1起動。静的アセットは数えない）
 * どちらも超えるとサイトが壊れる（実際 2026-09-02・09-04 に D1 の読取枠が切れた）ので、
 * 日次で見て 70% を超えたら手を打つ。
 *
 * 必要な環境変数（リポジトリ直下 .env）:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_ANALYTICS_TOKEN … 無ければ CLOUDFLARE_D1_TOKEN を使う
 *
 * ※ 既存の CLOUDFLARE_D1_TOKEN には Analytics 権限が無く `not authorized for that account`
 *   になる。ダッシュボード → My Profile → API Tokens → Create Token → Custom token で
 *   **Account / Account Analytics / Read** を付けたトークンを作り、
 *   CLOUDFLARE_ANALYTICS_TOKEN として .env に入れること。
 *
 * 使い方: node scripts/check_free_tier_usage.mjs [--days=3]
 * 終了コード: 0=正常 / 1=いずれかが90%超（バッチから叩いて警報に使える）
 */
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');

const LIMITS = {
    d1RowsRead: 5_000_000,
    d1RowsWritten: 100_000,
    workerRequests: 100_000,
};
const WARN = 0.70;
const CRIT = 0.90;

const GQL = 'https://api.cloudflare.com/client/v4/graphql';

function bar(ratio) {
    const n = Math.min(20, Math.round(ratio * 20));
    return '[' + '#'.repeat(n) + '.'.repeat(20 - n) + ']';
}

function line(label, used, limit) {
    const r = limit > 0 ? used / limit : 0;
    const mark = r >= CRIT ? '!! ' : r >= WARN ? '!  ' : '   ';
    return `${mark}${label.padEnd(22)} ${bar(r)} ${used.toLocaleString().padStart(11)} / ${limit.toLocaleString()} (${(r * 100).toFixed(1)}%)`;
}

async function query(token, body) {
    const res = await fetch(GQL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (json.errors?.length) {
        const msg = json.errors.map(e => e.message).join('; ');
        throw new Error(msg);
    }
    return json.data;
}

async function main() {
    const dotenv = (await import('dotenv')).default;
    dotenv.config({ path: path.join(REPO, '.env'), quiet: true });

    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN || process.env.CLOUDFLARE_D1_TOKEN;
    if (!account || !token) {
        console.error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_ANALYTICS_TOKEN が未設定です');
        process.exitCode = 2; return;
    }

    const daysArg = process.argv.find(a => a.startsWith('--days='));
    const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 3;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const until = new Date().toISOString();

    const gql = `query Usage($account: String!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: {accountTag: $account}) {
        d1AnalyticsAdaptiveGroups(limit: 200, filter: {datetime_geq: $since, datetime_leq: $until}, orderBy: [date_DESC]) {
          sum { rowsRead rowsWritten readQueries writeQueries }
          dimensions { date databaseId }
        }
        workersInvocationsAdaptive(limit: 200, filter: {datetime_geq: $since, datetime_leq: $until}) {
          sum { requests errors }
          dimensions { scriptName date }
        }
      } }
    }`;

    let data;
    try {
        data = await query(token, { query: gql, variables: { account, since, until } });
    } catch (e) {
        console.error(`\n取得に失敗しました: ${e.message}`);
        if (/not authorized/i.test(e.message)) {
            console.error('\n→ トークンに Analytics 権限がありません。');
            console.error('  Cloudflare ダッシュボード → My Profile → API Tokens → Create Token → Custom token');
            console.error('  Permissions: Account / Account Analytics / Read を付けて作成し、');
            console.error('  .env に CLOUDFLARE_ANALYTICS_TOKEN=... として保存してください。');
        }
        process.exitCode = 2; return;
    }

    const acc = data?.viewer?.accounts?.[0] ?? {};
    // 日付ごとに集計（D1はDB単位、Workersはスクリプト単位で返るので足し合わせる）
    const byDate = new Map();
    const at = (d) => {
        if (!byDate.has(d)) byDate.set(d, { rowsRead: 0, rowsWritten: 0, requests: 0, errors: 0 });
        return byDate.get(d);
    };
    for (const g of acc.d1AnalyticsAdaptiveGroups ?? []) {
        const e = at(g.dimensions.date);
        e.rowsRead += g.sum.rowsRead ?? 0;
        e.rowsWritten += g.sum.rowsWritten ?? 0;
    }
    for (const g of acc.workersInvocationsAdaptive ?? []) {
        const e = at(g.dimensions.date);
        e.requests += g.sum.requests ?? 0;
        e.errors += g.sum.errors ?? 0;
    }

    let worst = 0;
    const dates = [...byDate.keys()].sort().reverse();
    if (dates.length === 0) {
        console.log('データがありません（対象期間にトラフィックが無いか、権限不足）');
        process.exitCode = 2; return;
    }
    for (const d of dates) {
        const e = byDate.get(d);
        console.log(`\n── ${d} (UTC) ──`);
        console.log(line('D1 行読取/日', e.rowsRead, LIMITS.d1RowsRead));
        console.log(line('D1 行書込/日', e.rowsWritten, LIMITS.d1RowsWritten));
        console.log(line('Workers リクエスト/日', e.requests, LIMITS.workerRequests));
        if (e.errors) console.log(`   （うちエラー ${e.errors.toLocaleString()} 件）`);
        worst = Math.max(worst,
            e.rowsRead / LIMITS.d1RowsRead,
            e.rowsWritten / LIMITS.d1RowsWritten,
            e.requests / LIMITS.workerRequests);
    }

    console.log('');
    if (worst >= CRIT) {
        console.error(`危険: 無料枠の ${(worst * 100).toFixed(0)}% に達しています（枠切れ時は静的キャッシュへ縮退します）`);
        process.exitCode = 1; return;
    }
    if (worst >= WARN) console.warn(`注意: 無料枠の ${(worst * 100).toFixed(0)}% を使っています`);
    else console.log(`最大でも無料枠の ${(worst * 100).toFixed(0)}% です`);
}


main().catch(e => { console.error('失敗:', e.message); process.exitCode = 2; });
