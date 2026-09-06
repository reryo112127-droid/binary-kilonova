/**
 * 投稿キュー自動充填: ジャンル別に作品を自動選定して x_post_decisions に approve 登録する。
 * これで承認作業なしに Bluesky 自動投稿 / X 自動投稿の供給が回り続ける。
 * 既にキューにある作品(product_idがPK)は INSERT OR IGNORE でスキップ=再投稿しない。
 *   node scripts/x_queue_fill.js            # 各ジャンル既定2件ずつ補充
 *   node scripts/x_queue_fill.js --per 3    # 各ジャンル3件
 *
 * 選定方針(2026-06):
 *  - X投稿はホーム予約掲載の「特定メーカー」(HOME_MAKERS)の作品に限定。
 *  - MGS動画の作品は FANZA に同一作品が無い「独占配信」のみ(cross_platform.json で判定)。
 */
require('dotenv').config({ path: './site/.env.local' });
const fs = require('fs');
const path = require('path');
const { d1, fanzaShards } = require('./lib/d1');
const { openLocal } = require('./lib/localsqlite.cjs');

// ============================================================
//  候補選定は **ローカル SQLite** から行う（2026-09-06）
//
//  以前は候補SELECTを直接D1へ投げていたが、各ソースが
//    genres LIKE '%...%' / floor='videoc' / actresses LIKE '%,%' + ORDER BY RANDOM()
//  というカタログ全走査で、1クエリあたり約6万行（FANZAは2シャードなので×2）。
//  本スクリプトは投稿実行のたび(sns_x_browser.bat)＋日次(sns_daily.bat)で
//  1日6〜7回走るため、実測で **D1日次読取枠500万行の約8割** をこれ1本で食っていた
//  （2026-09-06 の10h窓で 3.9M行 = 全体の47%）。
//
//  候補選定に必要なのはカタログの静的な属性（メーカー/ジャンル/女優/収録時間）だけで、
//  ローカルのマスターSQLiteに全部ある。→ D1読取は 0 行にできる。
//  D1は x_post_decisions(site) の読み書きと、FANZA候補の存在確認だけに使う。
//
//  ローカルDBが無い環境（CI等）では従来どおりD1へフォールバックする。
// ============================================================
const LOCAL_DB = {
    fanza: path.join(__dirname, '..', 'data', 'fanza.db'),
    mgs: path.join(__dirname, '..', 'data', 'mgs.db'),
};
const _localCache = {};
function localClient(which) {
    if (which in _localCache) return _localCache[which];
    let c = null;
    try { if (fs.existsSync(LOCAL_DB[which])) c = openLocal(LOCAL_DB[which]); }
    catch (e) { console.warn(`  ローカル${which}DBを開けません(${e.message})`); }
    if (!c) console.warn(`  ローカル${which}DBが無い → D1へフォールバック(読取枠を消費します)`);
    _localCache[which] = c;
    return c;
}

const PER = parseInt((process.argv.find(a => a.startsWith('--per')) || '').split(/[=\s]/)[1] || '2', 10) || 2;
const DRY = process.argv.includes('--dry-run'); // 選定だけ行い x_post_decisions には書かない
const today = new Date().toISOString().slice(0, 10);
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

// 配信5年以内の作品のみ投稿対象にする(古い作品を投稿しない)。
// sale_start_date は MGS='YYYY/MM/DD' / FANZA='YYYY-MM-DD' と桁区切りが異なるため、
// MGSは REPLACE で '-' 化してから文字列比較する。NULL日付は比較で除外される(=5年以内と確認できない)。
const fiveYearsAgoDate = new Date();
fiveYearsAgoDate.setFullYear(fiveYearsAgoDate.getFullYear() - 5);
const FIVE_YEARS_AGO = fiveYearsAgoDate.toISOString().slice(0, 10);

// ホーム予約掲載の特定メーカー(generate-static-cache-local.mjs の HOME_MAKERS と一致させる)
const HOME_MAKERS = [
    ['like', 'エスワン'], ['exact', 'ムーディーズ'], ['exact', 'アイデアポケット'], ['exact', 'OPPAI'],
    ['exact', 'E-BODY'], ['exact', 'Fitch'], ['exact', 'マドンナ'], ['exact', '本中'], ['like', 'ダスッ'],
    ['exact', 'kawaii'], ['exact', 'Hunter'], ['exact', 'ワンズファクトリー'], ['exact', 'SODクリエイト'],
    ['exact', 'FALENO'], ['exact', 'TAMEIKE'], ['like', 'million'], ['exact', 'プレミアム'], ['exact', 'DAHLIA'],
];
// MGSは HOME_MAKERS(FANZAのプレミアムブランド名)とメーカー名がほとんど重ならないため、
// これで絞ると SODクリエイト/FALENO 程度しか当たらずMGS候補が枯渇していた。
// 実測: メーカー縛りを免除している anon だけ3,802件、new=138 / lady=45 / collab=35 という偏り。
// → MGSにはMGS自身の主要ブランド(作品数上位)のホワイトリストを使う。
// 独占判定(cross_platform.json)は従来どおり掛かるのでFANZAと重複する作品は入らない。
const MGS_MAKERS = [
    ['exact', 'シロウトTV'], ['exact', 'SODクリエイト'], ['exact', 'DOC'], ['like', 'プレステージ'],
    ['exact', 'ナンパTV'], ['exact', 'ラグジュTV'], ['exact', 'NEXT'], ['exact', 'プラネットプラス'],
    ['exact', 'アロマ企画'], ['exact', 'h.m.p'], ['exact', 'FALENO'], ['exact', 'マジック'],
    ['exact', 'MAXING'], ['exact', 'WAAP'], ['exact', 'ムーディーズ'], ['exact', 'エスワン'],
];
// MGS: maker列のみ / FANZA: maker列 OR label列
const MGS_MAKER_COND = '(' + MGS_MAKERS.map(([t]) => t === 'exact' ? 'maker = ?' : 'maker LIKE ?').join(' OR ') + ')';
const MGS_MAKER_ARGS = MGS_MAKERS.map(([t, v]) => t === 'exact' ? v : `%${v}%`);
const FZ_MAKER_COND = '(' + HOME_MAKERS.map(([t]) => t === 'exact' ? '(maker = ? OR label = ?)' : '(maker LIKE ? OR label LIKE ?)').join(' OR ') + ')';
const FZ_MAKER_ARGS = HOME_MAKERS.flatMap(([t, v]) => t === 'exact' ? [v, v] : [`%${v}%`, `%${v}%`]);

// 共演(真の共演)とアンソロジー/総集編(多数女優の寄せ集め)の判別。
// アンソロジーは「女優5人以上 or 4時間以上 or 総集編系タイトル」。それらを除外する条件。
const NOT_ANTHOLOGY = `actresses NOT LIKE '%,%,%,%,%' AND (duration_min IS NULL OR duration_min < 240)`
    + ` AND title NOT LIKE '%総集編%' AND title NOT LIKE '%アンソロジー%' AND title NOT LIKE '%オムニバス%'`
    + ` AND title NOT LIKE '%ベスト%' AND title NOT LIKE '%BEST%' AND title NOT LIKE '%コレクション%'`
    + ` AND genres NOT LIKE '%総集編%' AND genres NOT LIKE '%アンソロジー%'`;

// VR作品の判別。VR以外のジャンルに混入するとサンプル動画を平面MP4化できず毎回スキップされ、
// キュー先頭に居座って担当アカウントを塞ぐため、non-VRジャンルからは除外する。
// VR品番(dsvr/fcvr/juvr 等の '...vr...')はSQLite LIKEが大小無視なので '%vr%' で拾える。
const NOT_VR = `title NOT LIKE '%VR%' AND genres NOT LIKE '%VR%' AND product_id NOT LIKE '%vr%'`;

// cross_platform.json: キーに含まれるMGS品番=FANZAに対作品あり=独占ではない
let crossMap = {};
try { crossMap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'site', 'public', 'data', 'cross_platform.json'), 'utf-8')); } catch { /* 無ければ全て独占扱い */ }

// 各ソース: where(メーカー条件を除く本体)/order/whereArgs/limit/platform。SQLは組み立て時にメーカー条件を差し込む。
const GENRES = [
    { genre: 'new', sources: [
        // MGS独占の特定メーカー(少数)を優先。日付窓は設けず新しい順
        { platform: 'mgs', where: `actresses IS NOT NULL AND TRIM(actresses)<>'' AND (duration_min IS NULL OR duration_min<600)`,
          order: `ORDER BY REPLACE(sale_start_date,'/','-') DESC, RANDOM()`, whereArgs: () => [], limit: PER * 8 },
        // 不足分はFANZA特定メーカーの新作でカバー
        { platform: 'fanza', where: `actresses IS NOT NULL AND TRIM(actresses)<>'' AND sale_start_date >= ?`,
          order: `ORDER BY sale_start_date DESC, RANDOM()`, whereArgs: () => [ago(90)], limit: PER * 8,
          fresh: freshFanzaNew },
    ] },
    { genre: 'sale', sources: [
        { platform: 'fanza', where: `COALESCE(discount_pct,0) >= 30 AND actresses IS NOT NULL AND TRIM(actresses)<>''`,
          order: `ORDER BY discount_pct DESC, RANDOM()`, whereArgs: () => [], limit: PER * 8 },
        // MGSの割引作品。※現状 MGS D1 の discount_pct は全件0(価格がD1へ同期されていない)ため
        //   このソースは0件を返す。ローカルmgs.dbには224件あるので、同期が入れば自動的に投稿対象になる。
        { platform: 'mgs', where: `COALESCE(discount_pct,0) >= 30 AND actresses IS NOT NULL AND TRIM(actresses)<>''`,
          order: `ORDER BY discount_pct DESC, RANDOM()`, whereArgs: () => [], limit: PER * 8 },
    ] },
    { genre: 'vr', sources: [
        { platform: 'fanza', where: `genres LIKE '%VR専用%' AND actresses IS NOT NULL AND TRIM(actresses)<>'' AND REPLACE(sale_start_date,'/','-') <= ?`,
          order: `ORDER BY REPLACE(sale_start_date,'/','-') DESC, RANDOM()`, whereArgs: () => [today], limit: PER * 8 },
    ] },
    { genre: 'anon', sources: [
        { platform: 'fanza', where: `floor='videoc' AND actresses IS NOT NULL AND TRIM(actresses)<>''`,
          order: `ORDER BY REPLACE(sale_start_date,'/','-') DESC, RANDOM()`, whereArgs: () => [], limit: PER * 8 },
        { platform: 'mgs', where: `(genres LIKE '%素人%' OR maker LIKE '%素人%' OR maker LIKE '%ナンパ%') AND actresses IS NOT NULL AND TRIM(actresses)<>''`,
          order: `ORDER BY RANDOM()`, whereArgs: () => [], limit: PER * 8 },
    ] },
    { genre: 'lady', sources: [
        { platform: 'mgs', where: `(genres LIKE '%人妻%' OR genres LIKE '%熟女%') AND actresses IS NOT NULL AND TRIM(actresses)<>''`,
          order: `ORDER BY RANDOM()`, whereArgs: () => [], limit: PER * 8 },
        // 不足分はFANZA特定メーカー(マドンナ/プレミアム/TAMEIKE等の熟女)でカバー
        { platform: 'fanza', where: `(genres LIKE '%熟女%' OR genres LIKE '%人妻%') AND actresses IS NOT NULL AND TRIM(actresses)<>''`,
          order: `ORDER BY RANDOM()`, whereArgs: () => [], limit: PER * 8 },
    ] },
    { genre: 'collab', sources: [
        // 共演=2〜4人の本編。アンソロジー/総集編(5人以上・4時間以上・総集編系)は全ジャンル共通でSQL組み立て時に除外
        { platform: 'mgs', where: `actresses LIKE '%,%' AND TRIM(actresses)<>''`,
          order: `ORDER BY RANDOM()`, whereArgs: () => [], limit: PER * 8 },
        { platform: 'fanza', where: `actresses LIKE '%,%' AND TRIM(actresses)<>''`,
          order: `ORDER BY RANDOM()`, whereArgs: () => [], limit: PER * 8 },
    ] },
];

// D1 に実在する product_id か（主キー1点引き = 1行読取）。
// 存在確認の結果はrun中キャッシュする。D1が落ちている場合は「確認できない＝通す」にはせず、
// エラー時のみ true を返して従来どおり投入する（投稿側が改めて商品を引くので実害は投稿1件のスキップ）。
const _existsCache = new Map();
async function existsInD1(pid, isMgs) {
    if (_existsCache.has(pid)) return _existsCache.get(pid);
    let ok = true;
    try {
        const client = isMgs ? d1('mgs') : fanzaShards();
        const r = await client.execute({ sql: `SELECT product_id FROM products WHERE product_id = ? LIMIT 1`, args: [pid] });
        ok = r.rows.length > 0;
    } catch (e) { ok = true; /* D1不調時は従来動作 */ }
    _existsCache.set(pid, ok);
    return ok;
}

// ローカル fanza.db は日次FANZA取り込みが遅れると数週間古くなる（2026-09-06 実測で最新配信日 2026-08-02）。
// 'new' ジャンルだけは鮮度が意味を持つので、毎日再生成される静的キャッシュから
// 「特定メーカーのFANZA新作」を先頭に足す。D1は読まない。
function freshFanzaNew() {
    let items = [];
    try { items = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'site', 'data', 'products_new_cache.json'), 'utf-8')); }
    catch { return []; }
    if (!Array.isArray(items)) return [];
    const since = ago(90);
    const badTitle = /総集編|アンソロジー|オムニバス|ベスト|BEST|コレクション|VR/i;
    return items.filter(it => {
        if ((it.source || '') !== 'fanza') return false;
        if (!it.product_id || !it.actresses || !String(it.actresses).trim()) return false;
        const d = String(it.sale_start_date || '').split('/').join('-').slice(0, 10);
        if (!d || d < since) return false;
        const t = String(it.title || '');
        if (badTitle.test(t)) return false;
        if (/vr/i.test(String(it.product_id))) return false;
        if (badTitle.test(String(it.genres || ''))) return false;
        // 出演5人以上（アンソロジー相当）は除外
        if (String(it.actresses).split(',').length >= 5) return false;
        // ホーム掲載の特定メーカーだけ（静的キャッシュに label は無いので maker のみで判定）
        const mk = String(it.maker || '');
        return HOME_MAKERS.some(([type, v]) => type === 'exact' ? mk === v : mk.includes(v));
    }).map(it => ({ product_id: it.product_id }));
}

(async () => {
    const site = d1('site');
    // 既にキューに居る作品は INSERT OR IGNORE が弾く（product_id が UNIQUE）ので、
    // 以前やっていた x_post_decisions の全ダンプ（LIMIT 5000 OFFSET を回す）は不要。
    // 全ダンプはキュー件数ぶんの行読取を毎回発生させていた（実測 1日あたり約7万行）。
    // 実際に入ったかは rowsAffected===0 で判定し、同一run内の重複選定は seen で防ぐ。
    const seen = new Set();
    console.log('キュー充填開始: 特定メーカー', HOME_MAKERS.length, 'ブランド・MGSは独占のみ');

    let added = 0;
    let quotaOut = false;
    for (const g of GENRES) {
        if (quotaOut) break;
        let n = 0;
        // ソースは順番に消化して n>=PER で打ち切るため、先頭プラットフォームが枠を全部食うと
        // 2番目(多くはMGS)が毎回0件になる。まず各ソースに均等枠を配り、余ったら2周目で埋める。
        const share = Math.ceil(PER / g.sources.length);
        const perSource = new Map();
        for (const pass of [1, 2]) {
        if (quotaOut) break;
        for (const src of g.sources) {
            if (n >= PER || quotaOut) break;
            // 1周目は均等枠まで、2周目は残り全部(片方が枯渇していても総数PERは満たす)
            const cap = pass === 1 ? Math.min(PER, (perSource.get(src) ?? 0) + share) : PER;
            if ((perSource.get(src) ?? 0) >= cap) continue;
            const isMgs = src.platform === 'mgs';
            // anon(素人)/vr はHOME_MAKERS(プレミアム18ブランド)に該当しない=メーカー条件を掛けると常に0件になるため除外。
            // 素人は floor='videoc'/素人ジャンル、VRは genres='VR専用'(KMPVR等のVR専業メーカー中心)で定義され、特定メーカー縛りの対象外。
            const skipMaker = g.genre === 'anon' || g.genre === 'vr';
            const makerCond = skipMaker ? '1=1' : (isMgs ? MGS_MAKER_COND : FZ_MAKER_COND);
            const makerArgs = skipMaker ? [] : (isMgs ? MGS_MAKER_ARGS : FZ_MAKER_ARGS);
            // 候補選定はローカルSQLite優先（D1読取0行）。無い環境だけD1へ落ちる。
            const client = localClient(src.platform) || (isMgs ? d1('mgs') : fanzaShards());
            // 配信5年以内に限定(MGSは '/' を '-' に正規化して比較)
            const dateCol = isMgs ? `REPLACE(sale_start_date,'/','-')` : `sale_start_date`;
            const dateCond = `${dateCol} >= ?`;
            // VRジャンル以外はVR作品を除外(VRジャンルはそのまま)
            const vrCond = g.genre === 'vr' ? '1=1' : NOT_VR;
            // 総集編/アンソロジーは全ジャンル共通で除外
            const sql = `SELECT product_id FROM products WHERE ${src.where} AND ${makerCond} AND ${dateCond} AND ${vrCond} AND ${NOT_ANTHOLOGY} ${src.order} LIMIT ?`;
            const args = [...src.whereArgs(), ...makerArgs, FIVE_YEARS_AGO, src.limit];
            let rows = [];
            try { rows = (await client.execute({ sql, args })).rows; }
            catch (e) { console.warn(`  ${g.genre}(${src.platform}) 選定エラー:`, e.message); continue; }
            // 鮮度が要るソースは静的キャッシュ由来の新作を先に消化する
            if (src.fresh) rows = [...src.fresh(), ...rows];
            for (const row of rows) {
                if (n >= PER || (perSource.get(src) ?? 0) >= cap) break;
                const pid = String(row.product_id);
                if (seen.has(pid)) continue;
                seen.add(pid);
                if (isMgs && crossMap[pid]) continue; // FANZAに対作品あり=独占ではない→MGSは除外
                // ローカルDB由来の候補は D1 に無いことがある
                // （FANZA videoc の MGS重複3,176件は D1 からだけ削除済み／取り込み差分）。
                // 投稿先の商品ページは D1 が供給元なので、入れる前に主キー1点引きで確認する（1行読取）。
                if (!(await existsInD1(pid, isMgs))) continue;
                if (DRY) { added++; n++; perSource.set(src, (perSource.get(src) ?? 0) + 1); console.log(`  ? [${g.genre}/${src.platform}] ${pid}`); continue; }
                // 枠切れ中は INSERT も UNIQUE 索引を読むので落ちる。1件ずつ握って
                // 「今日はもう入らない」と分かった時点で静かに終わる（以前は例外で異常終了していた）。
                let ins;
                try {
                    ins = await site.execute({
                        sql: `INSERT OR IGNORE INTO x_post_decisions (product_id, decision, new_genre, post_type, decided_at) VALUES (?, 'approve', ?, 'package', datetime('now'))`,
                        args: [pid, g.genre],
                    });
                } catch (e) {
                    if (/daily row read limit|exceeded/i.test(e.message)) {
                        console.warn('  D1の日次枠が切れているためキュー投入を中断（枠はUTC0時＝JST9:00にリセット）');
                        quotaOut = true;
                        break;
                    }
                    console.warn(`  ${pid} 投入エラー:`, e.message);
                    continue;
                }
                if (!ins.rowsAffected) continue; // 既にキュー済み＝新規追加ではない
                added++; n++;
                perSource.set(src, (perSource.get(src) ?? 0) + 1);
                console.log(`  + [${g.genre}/${src.platform}] ${pid}`);
            }
        }
        }
    }
    console.log(`✅ ${added}件をキューに追加`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
