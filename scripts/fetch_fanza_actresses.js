/**
 * fetch_fanza_actresses.js
 *
 * DMM Affiliate API ActressSearch で全女優（約60,000人）を取得し
 * actress_profiles.json に hobby / prefectures / imageURL を追加する。
 *
 * 使い方:
 *   node scripts/fetch_fanza_actresses.js             # 全件取得・マージ（約12分）
 *   node scripts/fetch_fanza_actresses.js --dry-run   # 最初の200件のみ
 *   node scripts/fetch_fanza_actresses.js --recent 500 # 最新登録500件のみ（デイリー用・約6秒）
 *
 * 所要時間: 約600リクエスト × 1.2秒 = 約12分
 *           --recent 500 の場合: 5リクエスト × 1.2秒 = 約6秒
 */

const fs   = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DMM_API_ID      = process.env.DMM_API_ID;
const DMM_AFFILIATE_ID = 'desireav-990';

const DATA_DIR      = path.join(__dirname, '..', 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'actress_profiles.json');
const RAW_FILE      = path.join(DATA_DIR, 'fanza_actresses_raw.jsonl'); // 生データバックアップ

const HITS       = 100;
const RATE_MS    = 1200;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args      = process.argv.slice(2);
const DRY_RUN   = args.includes('--dry-run');
const recentIdx = args.indexOf('--recent');
const RECENT_N  = recentIdx !== -1 ? parseInt(args[recentIdx + 1], 10) : null; // nullなら全件

// ========== API取得 ==========
async function fetchPage(offset, sort) {
    const params = new URLSearchParams({
        api_id:       DMM_API_ID,
        affiliate_id: DMM_AFFILIATE_ID,
        hits:         HITS.toString(),
        offset:       offset.toString(),
        output:       'json',
    });
    // --recent モード: 最新登録順で取得
    if (sort) params.set('sort', sort);
    const res = await fetch(`https://api.dmm.com/affiliate/v3/ActressSearch?${params}`, {
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    if (String(d.result?.status) !== '200') throw new Error(`API status ${d.result?.status}`);
    return { total: d.result.total_count, actresses: d.result.actress || [] };
}

// ========== メイン ==========
async function main() {
    console.log('══════════════════════════════════════════');
    console.log('  FANZA ActressSearch 全女優取得');
    console.log('══════════════════════════════════════════');
    if (DRY_RUN)   console.log('  [DRY RUN] 最初の200件のみ');
    if (RECENT_N)  console.log(`  [RECENT]  最新登録 ${RECENT_N}件のみ（デイリーモード）`);
    console.log('');

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    // 既存プロフィール読み込み
    let profiles = {};
    if (fs.existsSync(PROFILES_FILE)) {
        profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));
        console.log(`[既存] actress_profiles.json: ${Object.keys(profiles).length.toLocaleString()}件`);
    }

    // 生データ出力ストリーム（--recent モードは追記、通常は上書き）
    const rawStream = fs.createWriteStream(RAW_FILE, { flags: RECENT_N ? 'a' : 'w' });

    // 1ページ目で総数確認
    // 最新登録順。ActressSearch が受け付ける sort は name/-name, bust, waist, hip,
    // height, birthday, id といった実在の列だけで、**-designation は 400 を返す**。
    // そのため --recent（日次モード）は毎日「致命的エラー: HTTP 400」で落ちており、
    // 女優プロフィールは日曜の全件取得でしか更新されていなかった（2026-09-05 発見）。
    // id は登録順に採番されるので -id が「最新登録順」になる（実測 -id の先頭 id=1114638 / 既定 1011185）。
    const sort  = RECENT_N ? '-id' : undefined;
    const first = await fetchPage(1, sort);
    const total = DRY_RUN ? 200 : (RECENT_N ? Math.min(RECENT_N, first.total) : first.total);
    const totalPages = Math.ceil(total / HITS);

    console.log(`[API] 総女優数: ${first.total.toLocaleString()}人`);
    console.log(`[API] 取得予定: ${total.toLocaleString()}人 / ${totalPages}リクエスト`);
    console.log(`[API] 推定時間: ${(totalPages * RATE_MS / 1000 / 60).toFixed(1)}分\n`);

    let fetched    = 0;
    let newAdded   = 0;
    let updated    = 0;
    const now = new Date().toISOString();

    const processActresses = (actresses) => {
        for (const a of actresses) {
            rawStream.write(JSON.stringify(a) + '\n');

            const name = a.name;
            if (!name) continue;

            const entry = {
                id:          a.id,
                name:        a.name,
                ruby:        a.ruby || null,
                height:      a.height ? parseInt(a.height) : null,
                bust:        a.bust   ? parseInt(a.bust)   : null,
                cup:         a.cup    || null,
                waist:       a.waist  ? parseInt(a.waist)  : null,
                hip:         a.hip    ? parseInt(a.hip)    : null,
                birthday:    a.birthday    || null,
                blood_type:  a.blood_type  || null,
                hobby:       a.hobby       || null,
                prefectures: a.prefectures || null,
                image_url:   a.imageURL?.large || null,
                updated_at:  now,
            };

            // null値は除去
            Object.keys(entry).forEach(k => { if (entry[k] === null) delete entry[k]; });

            if (!profiles[name]) {
                profiles[name] = entry;
                newAdded++;
            } else {
                // 既存エントリにhoby/prefectures/image_urlを追加・更新
                let changed = false;
                for (const key of ['hobby', 'prefectures', 'image_url', 'blood_type', 'height', 'bust', 'cup', 'waist', 'hip', 'birthday', 'ruby', 'id']) {
                    if (entry[key] && !profiles[name][key]) {
                        profiles[name][key] = entry[key];
                        changed = true;
                    }
                }
                if (changed) {
                    profiles[name].updated_at = now;
                    updated++;
                }
            }

            fetched++;
        }
    };

    // 1ページ目のデータを処理
    processActresses(first.actresses);
    process.stdout.write(`  offset=1 (${fetched}/${total})\r`);

    // 残りのページを取得
    for (let offset = HITS + 1; offset <= total; offset += HITS) {
        await sleep(RATE_MS);
        try {
            const { actresses } = await fetchPage(offset, sort);
            if (actresses.length === 0) break;
            processActresses(actresses);
            process.stdout.write(`  offset=${offset} (${fetched.toLocaleString()}/${total.toLocaleString()}) 新規:${newAdded} 更新:${updated}\r`);
        } catch (e) {
            console.warn(`\n  [ERR] offset=${offset}: ${e.message} — リトライ`);
            await sleep(5_000);
            offset -= HITS; // 再試行
        }
    }

    rawStream.end();
    console.log(`\n\n[完了] 取得: ${fetched.toLocaleString()}人 | 新規追加: ${newAdded.toLocaleString()} | 既存更新: ${updated.toLocaleString()}`);

    // 保存
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
    const totalCount = Object.keys(profiles).length;
    console.log(`[保存] actress_profiles.json: ${totalCount.toLocaleString()}件`);
    console.log(`[保存] 生データ: ${RAW_FILE}`);

    // 統計
    const vals = Object.values(profiles).filter(v => !v.not_found);
    const withHobby  = vals.filter(v => v.hobby).length;
    const withPref   = vals.filter(v => v.prefectures).length;
    const withImage  = vals.filter(v => v.image_url).length;
    const withBlood  = vals.filter(v => v.blood_type).length;
    console.log(`\n  趣味あり:   ${withHobby.toLocaleString()} (${(withHobby/vals.length*100).toFixed(1)}%)`);
    console.log(`  出身地あり: ${withPref.toLocaleString()} (${(withPref/vals.length*100).toFixed(1)}%)`);
    console.log(`  写真あり:   ${withImage.toLocaleString()} (${(withImage/vals.length*100).toFixed(1)}%)`);
    console.log(`  血液型あり: ${withBlood.toLocaleString()} (${(withBlood/vals.length*100).toFixed(1)}%)`);
}

main().catch(err => {
    console.error('致命的エラー:', err);
    process.exit(1);
});
