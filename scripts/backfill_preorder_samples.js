/**
 * 予約作品のサンプル画像／サンプル動画 後追い取得バックフィル
 *
 * FANZAは未発売(予約)作品のパッケージ画像を now_printing(準備中)へ302し、サンプル画像・
 * サンプル動画も発売日前後になってから公開する。ところが取り込み側の fanza_daily_update.js は
 * 「明日以降に発売」の作品しか再取得しないため、発売日を過ぎた瞬間に対象から外れ、
 * **あとから公開されたサンプルが永久に取り込まれない**状態だった。
 *
 * このスクリプトは「予約中 〜 発売後 WINDOW_DAYS 日」の作品を対象に DMM API を定期的に
 * 引き直し、公開されたサンプルを D1 の product_samples テーブルへ保存する。
 * 揃った作品は以後スキップし、窓から出た作品は削除して容量を一定に保つ。
 *
 * 保存先:
 *   - product_samples(product_id, sample_images_json, sample_video_url, ...)  ← 画像の実体
 *   - products.sample_video_url … NULL のときだけ補完（既存の表示経路との互換）
 *   商品詳細API(app/api/product/[id]/route.ts)が product_samples を読んで sample_images を返す。
 *
 * 実行:
 *   node scripts/backfill_preorder_samples.js                 # 既定: 1回あたり最大800件を確認
 *   node scripts/backfill_preorder_samples.js --limit 200
 *   node scripts/backfill_preorder_samples.js --window 120    # 発売後120日まで対象
 *   node scripts/backfill_preorder_samples.js --recheck-days 3  # 充足済みでもN日経過で再確認
 *   node scripts/backfill_preorder_samples.js --dry-run       # 書き込みなし
 *   node scripts/backfill_preorder_samples.js --init          # product_samples を作るだけ
 *
 * 必要な環境変数: DMM_API_ID / DMM_AFFILIATE_ID / CLOUDFLARE_ACCOUNT_ID /
 *                 CLOUDFLARE_D1_TOKEN / D1_FANZA_0_ID / D1_FANZA_1_ID
 */

const path = require('path');
const fs = require('fs');
const { d1 } = require('./lib/d1');
const { FANZA_SHARDS, shardOf } = require('./lib/shard.cjs');

// ---- .env 読み込み（ローカル実行用。CI では Secrets が入っている）----
(function loadEnv() {
    const p = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
})();

const args = process.argv.slice(2);
const argNum = (flag, def) => {
    const i = args.indexOf(flag);
    const v = i >= 0 ? parseInt(args[i + 1], 10) : NaN;
    return Number.isFinite(v) ? v : def;
};
const LIMIT        = argNum('--limit', 800);        // 1回で DMM API に問い合わせる作品数の上限
const WINDOW_DAYS  = argNum('--window', 90);        // 発売後この日数まで追跡する
const RECHECK_DAYS = argNum('--recheck-days', 0);   // >0 なら充足済みでもN日経過で再確認
const VIDEO_CHASE_DAYS = argNum('--video-days', 30);// 画像だけ揃った作品の動画を追いかける期間(発売後)
const MAX_CHECKS   = argNum('--max-checks', 20);    // これ以上確認しても出てこない作品は諦める
const DRY_RUN      = args.includes('--dry-run');
const INIT_ONLY    = args.includes('--init');

const DMM_API_ID       = process.env.DMM_API_ID;
const DMM_AFFILIATE_ID = (process.env.DMM_AFFILIATE_ID || '').split(',')[0];
const FLOORS = ['videoa', 'videoc', 'anime', 'nikkatsu'];
const HITS_PER_REQUEST = 100;   // DMM API の cid[] 上限
const RATE_LIMIT_MS    = 400;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
// products.sale_start_date は 'YYYY-MM-DD hh:mm:ss' と 'YYYY/MM/DD' が混在する
const DATE_EXPR = "REPLACE(SUBSTR(sale_start_date,1,10),'/','-')";

// ============================================================
//  スキーマ（site/migrations/0007_product_samples.sql と同じ内容）
// ============================================================
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS product_samples (
    product_id         TEXT PRIMARY KEY,
    sample_images_json TEXT,
    sample_video_url   TEXT,
    sale_start_date    TEXT,
    image_count        INTEGER DEFAULT 0,
    checked_at         TEXT,
    check_count        INTEGER DEFAULT 0,
    filled_at          TEXT,
    updated_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_product_samples_pending ON product_samples(image_count, checked_at);
CREATE INDEX IF NOT EXISTS idx_product_samples_date ON product_samples(sale_start_date);
`;

async function ensureSchema(shards) {
    for (const [i, db] of shards.entries()) {
        for (const stmt of SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean)) {
            await db.execute(stmt);
        }
        console.log(`  [shard${i}] product_samples 準備OK`);
    }
}

// ============================================================
//  対象選定
//    A) 予約中(未来日) … 毎日確認する。発売直前にサンプルが公開されることが多い
//    B) 発売後 WINDOW_DAYS 日以内 … 「発売日を跨いで公開された」ぶんを拾う本命
//  いずれも「まだ画像が無い」= product_samples 未登録 or image_count=0 を優先。
// ============================================================
async function pickTargets(db, shardIdx) {
    const t = today();
    const from = daysAgo(WINDOW_DAYS);

    const pDate = DATE_EXPR.replace(/sale_start_date/g, 'p.sale_start_date');
    // 未充足の作品を、発売日が新しい順に拾う。予約中(未来日)を最優先にしたいので ORDER BY で先頭に寄せる。
    //   - 画像0枚                                  … 窓にいる間ずっと追いかける
    //   - 画像はあるが動画が無い(予約中 or 発売後VIDEO_CHASE_DAYS以内)
    //     … VR作品などは予約時に画像だけ公開され、動画が発売直前〜直後に付く
    // そもそもサンプル動画が存在しない作品を毎日引き続けても無駄なので、
    // 確認回数が MAX_CHECKS を超えたものは諦める。
    const pendingSql = `
        SELECT p.product_id, p.sale_start_date, p.floor,
               s.check_count AS check_count, s.checked_at AS checked_at
        FROM products p
        LEFT JOIN product_samples s ON s.product_id = p.product_id
        WHERE ${pDate} >= '${from}'
          AND (
                s.product_id IS NULL
                OR s.image_count = 0
                OR (s.sample_video_url IS NULL
                    AND (${pDate} > '${t}' OR ${pDate} >= '${daysAgo(VIDEO_CHASE_DAYS)}'))
              )
          AND COALESCE(s.check_count, 0) < ${MAX_CHECKS}
          AND (s.checked_at IS NULL OR SUBSTR(s.checked_at,1,10) < '${t}')
        ORDER BY (CASE WHEN ${pDate} > '${t}' THEN 0 ELSE 1 END),
                 COALESCE(s.check_count, 0) ASC,
                 ${pDate} DESC
        LIMIT ${LIMIT}`;
    const rows = (await db.execute(pendingSql)).rows;

    // 充足済みでも RECHECK_DAYS 経過していれば再確認（枚数が増える／動画が後から付く場合）
    let recheck = [];
    if (RECHECK_DAYS > 0 && rows.length < LIMIT) {
        const cutoff = daysAgo(RECHECK_DAYS);
        recheck = (await db.execute(`
            SELECT p.product_id, p.sale_start_date, p.floor, s.check_count AS check_count, s.checked_at AS checked_at
            FROM products p
            JOIN product_samples s ON s.product_id = p.product_id
            WHERE ${DATE_EXPR.replace(/sale_start_date/g, 'p.sale_start_date')} >= '${from}'
              AND s.image_count > 0
              AND (s.checked_at IS NULL OR SUBSTR(s.checked_at,1,10) < '${cutoff}')
            ORDER BY s.checked_at ASC
            LIMIT ${LIMIT - rows.length}`)).rows;
    }

    const all = [...rows, ...recheck];
    console.log(`  [shard${shardIdx}] 対象 ${all.length}件 (未取得 ${rows.length} / 再確認 ${recheck.length})`);
    return all;
}

// ============================================================
//  DMM API から cid[] でサンプルを取得
// ============================================================
async function fetchSamples(ids, floor) {
    const params = new URLSearchParams({
        api_id: DMM_API_ID, affiliate_id: DMM_AFFILIATE_ID,
        site: 'FANZA', service: 'digital', floor,
        hits: String(HITS_PER_REQUEST), output: 'json',
    });
    ids.forEach(id => params.append('cid[]', id));

    const res = await fetch(`https://api.dmm.com/affiliate/v3/ItemList?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.result?.status !== 200) return [];

    return (data.result.items || []).map(item => {
        const large = item.sampleImageURL?.sample_l?.image || [];
        const small = item.sampleImageURL?.sample_s?.image || [];
        const images = large.length > 0 ? large : small;
        const mv = item.sampleMovieURL || null;
        return {
            product_id: item.content_id,
            images,
            video: mv ? (mv.size_720_480 || mv.size_644_414 || mv.size_560_360 || mv.size_476_306 || null) : null,
        };
    });
}

// floor 別に分けて問い合わせる（cid[] は floor をまたげない）
async function fetchAllSamples(targets) {
    const byFloor = new Map();   // 既知 floor → product_id[]
    const unknown = [];          // floor が NULL/未知の作品（主要floorを順に試す）
    for (const r of targets) {
        const id = String(r.product_id);
        const f = r.floor;
        if (f && FLOORS.includes(f)) {
            if (!byFloor.has(f)) byFloor.set(f, []);
            byFloor.get(f).push(id);
        } else {
            unknown.push(id);
        }
    }

    const found = new Map();
    const askChunk = async (ids, floor) => {
        try {
            for (const s of await fetchSamples(ids, floor)) {
                if (!found.has(s.product_id)) found.set(s.product_id, s);
            }
        } catch (e) {
            console.warn(`    [警告] floor=${floor}: ${e.message}`);
        }
        await sleep(RATE_LIMIT_MS);
    };

    for (const [floor, ids] of byFloor) {
        for (let i = 0; i < ids.length; i += HITS_PER_REQUEST) {
            await askChunk(ids.slice(i, i + HITS_PER_REQUEST), floor);
        }
    }
    for (let i = 0; i < unknown.length; i += HITS_PER_REQUEST) {
        const chunk = unknown.slice(i, i + HITS_PER_REQUEST);
        for (const floor of FLOORS) {
            const rest = chunk.filter(id => !found.has(id));
            if (rest.length === 0) break;
            await askChunk(rest, floor);
        }
    }
    return found;
}

// ============================================================
//  D1 へ反映
// ============================================================
const esc = v => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

async function saveSamples(db, targets, found, shardIdx) {
    const now = new Date().toISOString();
    const stmts = [];
    let filled = 0, stillEmpty = 0, videoAdded = 0;

    for (const t of targets) {
        const id = String(t.product_id);
        const s = found.get(id);
        const images = s?.images ?? [];
        const video = s?.video ?? null;
        const n = images.length;
        if (n > 0) filled++; else stillEmpty++;

        stmts.push(`INSERT INTO product_samples
            (product_id, sample_images_json, sample_video_url, sale_start_date, image_count, checked_at, check_count, filled_at, updated_at)
            VALUES (${esc(id)}, ${n > 0 ? esc(JSON.stringify(images)) : 'NULL'}, ${esc(video)}, ${esc(t.sale_start_date)},
                    ${n}, ${esc(now)}, ${(Number(t.check_count) || 0) + 1}, ${n > 0 ? esc(now) : 'NULL'}, ${esc(now)})
            ON CONFLICT(product_id) DO UPDATE SET
                -- 一度取れた画像は空で上書きしない（APIが一時的に返さないことがある）
                sample_images_json = CASE WHEN ${n} > 0 THEN excluded.sample_images_json ELSE product_samples.sample_images_json END,
                image_count        = CASE WHEN ${n} > 0 THEN ${n} ELSE product_samples.image_count END,
                sample_video_url   = COALESCE(excluded.sample_video_url, product_samples.sample_video_url),
                sale_start_date    = excluded.sale_start_date,
                checked_at         = excluded.checked_at,
                check_count        = product_samples.check_count + 1,
                filled_at          = COALESCE(product_samples.filled_at, ${n > 0 ? esc(now) : 'NULL'}),
                updated_at         = excluded.updated_at`);

        // products 側は NULL のときだけ動画URLを補完（既存の表示経路との互換）
        if (video) {
            stmts.push(`UPDATE products SET sample_video_url = ${esc(video)}, updated_at = ${esc(now)}
                        WHERE product_id = ${esc(id)} AND (sample_video_url IS NULL OR sample_video_url = '')`);
            videoAdded++;
        }
    }

    if (DRY_RUN) {
        console.log(`  [shard${shardIdx}] [DRY RUN] 画像取得 ${filled}件 / まだ準備中 ${stillEmpty}件 / 動画URL ${videoAdded}件`);
        return { filled, stillEmpty, videoAdded };
    }

    // D1 REST は 1リクエストのSQLサイズに上限があるため小さめのバッチで送る
    const BATCH = 25;
    for (let i = 0; i < stmts.length; i += BATCH) {
        const chunk = stmts.slice(i, i + BATCH);
        try {
            await db.batch(chunk);
        } catch (e) {
            console.warn(`    [警告] バッチ書き込み失敗 (${i}): ${e.message} → 1文ずつ再試行`);
            for (const sql of chunk) {
                try { await db.execute(sql); } catch (e2) { console.warn(`      [スキップ] ${e2.message.slice(0, 120)}`); }
            }
        }
    }
    console.log(`  [shard${shardIdx}] 画像取得 ${filled}件 / まだ準備中 ${stillEmpty}件 / 動画補完 ${videoAdded}件`);
    return { filled, stillEmpty, videoAdded };
}

// 窓から出た作品は削除して容量を一定に保つ（全作品ぶん持つと約400MBで無料枠を圧迫する）
async function pruneOldRows(db, shardIdx) {
    if (DRY_RUN) return 0;
    const cutoff = daysAgo(WINDOW_DAYS + 30); // 少し猶予を持たせる
    const r = await db.execute(
        `DELETE FROM product_samples WHERE ${DATE_EXPR} < '${cutoff}'`
    );
    const n = r.rowsAffected || 0;
    if (n) console.log(`  [shard${shardIdx}] 窓外の ${n}件を削除 (発売日 < ${cutoff})`);
    return n;
}

// ============================================================
//  メイン
// ============================================================
async function main() {
    if (!DMM_API_ID || !DMM_AFFILIATE_ID) {
        console.error('❌ DMM_API_ID / DMM_AFFILIATE_ID が未設定');
        process.exit(1);
    }

    const shards = [];
    for (let i = 0; i < FANZA_SHARDS; i++) shards.push(d1(`fanza-${i}`));

    console.log('========================================');
    console.log('  予約作品サンプル 後追い取得');
    console.log('========================================');
    console.log(`  対象窓: 予約中 〜 発売後${WINDOW_DAYS}日 / 1回あたり最大${LIMIT}件(シャードごと)`);
    console.log(`  動画の追跡: 発売後${VIDEO_CHASE_DAYS}日まで / 確認上限 ${MAX_CHECKS}回`);
    if (RECHECK_DAYS > 0) console.log(`  再確認: 充足済みでも${RECHECK_DAYS}日経過で再取得`);
    if (DRY_RUN) console.log('  [DRY RUN] 書き込みなし');

    await ensureSchema(shards);
    if (INIT_ONLY) { console.log('\n[--init] スキーマ作成のみで終了'); return; }

    const total = { filled: 0, stillEmpty: 0, videoAdded: 0, checked: 0 };

    for (const [i, db] of shards.entries()) {
        const targets = await pickTargets(db, i);
        if (targets.length === 0) { await pruneOldRows(db, i); continue; }

        const found = await fetchAllSamples(targets);
        const r = await saveSamples(db, targets, found, i);
        total.filled += r.filled;
        total.stillEmpty += r.stillEmpty;
        total.videoAdded += r.videoAdded;
        total.checked += targets.length;

        await pruneOldRows(db, i);
    }

    console.log('\n----------------------------------------');
    console.log(`  確認 ${total.checked}件 / サンプル画像を取得 ${total.filled}件 / まだ準備中 ${total.stillEmpty}件`);
    console.log(`  サンプル動画を補完 ${total.videoAdded}件`);
    console.log('----------------------------------------');
}

main().catch(e => { console.error('❌', e); process.exit(1); });
