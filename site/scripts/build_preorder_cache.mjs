/**
 * 予約作品キャッシュ（home_preorder_cache.json / home_preorder_curated_cache.json）を
 * **DMM API から直接** 生成する。D1 も ローカルSQLite も使わない。
 *
 * なぜ独立した生成が要るか:
 *   - ローカル data/fanza.db・data/mgs.db は未来日付の作品を1件も持たない（スクレイプが
 *     発売済みしか入れない）。→ ローカル由来では予約は永久に0件。
 *   - generate-static-cache-local.mjs は FANZA の予約だけ D1 から取っていたが、
 *     **D1 の日次枠が切れると 0 件**になる。実際 2026-09-02 の日次バッチはそれで落ち、
 *     home_preorder_*.json が空(2バイト)のまま本番に出ていた。
 *   → 予約は「D1 が死んでいる日にこそ欲しい」データなので、D1 に依存しない経路で作る。
 *
 * 出力（site/data と site/public/data の両方）:
 *   home_preorder_cache.json          … 全メーカー・配信日DESC（最大300件）
 *   home_preorder_curated_cache.json  … ホーム用の厳選メーカーのみ（最大60件）
 *
 * 0件しか取れなかったときは既存ファイルを **上書きしない**（安全網を空で潰さないため）。
 *
 * 使い方: node scripts/build_preorder_cache.mjs [--days=120]
 * 必要な環境変数: DMM_API_ID / DMM_AFFILIATE_ID（リポジトリ直下 .env）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // site/
const REPO = path.resolve(ROOT, '..');

// ホーム用の厳選メーカー。顔ぶれは lib/ssrFetch.ts / generate-static-cache*.mjs の
// HOME_MAKERS と同じだが、判定は app/api/products の SALE_MAKERS_FANZA と同じ
// **exact / like の使い分け**にしてある。全部 LIKE にすると
//   「プレミアム」→ 桃太郎プレミアムベスト、「Hunter」→ LADY HUNTERS
// のような別メーカーを巻き込むため（実際に混入を確認した）。
//   exact: maker または label が完全一致
//   like : maker または label に含まれる（DB登録名が長いもの）
const HOME_MAKERS = [
    ['like', 'エスワン'],        // "エスワン ナンバーワンスタイル"
    ['exact', 'ムーディーズ'],
    ['exact', 'アイデアポケット'],
    ['exact', 'OPPAI'],
    ['exact', 'E-BODY'],
    ['exact', 'Fitch'],
    ['exact', 'マドンナ'],       // マドンナモンロー を除外
    ['exact', '本中'],
    ['like', 'ダスッ'],          // "ダスッ！"
    ['exact', 'kawaii'],
    ['exact', 'Hunter'],         // LADY HUNTERS（桃太郎映像出版）を除外
    ['exact', 'ワンズファクトリー'],
    ['exact', 'SODクリエイト'],
    ['exact', 'FALENO'],         // FALENO TUBE を除外
    ['exact', 'TAMEIKE'],
    ['like', 'million'],         // label: "million（ミリオン）"
    ['exact', 'プレミアム'],     // プレミアム熟女 / 桃太郎プレミアムベスト を除外
    ['exact', 'DAHLIA'],
];

// BEST/総集編の除外。lib/bestFilter.ts の BEST_TITLE_PATTERNS と同じ語。
const BEST_WORDS = ['BEST', 'ベスト', '総集編', 'コレクション', '福袋', '詰め合わせ', 'コンプリート', '枚組'];
const COMPILATION_MAX_MIN = 480;

const HITS = 100;
const MAX_ITEMS = 300;
const CURATED_MAX = 60;

function isBest(title, durationMin) {
    const t = String(title ?? '').toUpperCase();
    if (BEST_WORDS.some(w => t.includes(w.toUpperCase()))) return true;
    return Number.isFinite(durationMin) && durationMin > COMPILATION_MAX_MIN;
}

async function fetchPage(floor, gte, lte, offset) {
    const params = new URLSearchParams({
        api_id: process.env.DMM_API_ID,
        affiliate_id: process.env.DMM_AFFILIATE_ID,
        site: 'FANZA',
        service: 'digital',
        floor,
        hits: String(HITS),
        offset: String(offset),
        sort: 'date',
        gte_date: `${gte}T00:00:00`,
        lte_date: `${lte}T00:00:00`,
        output: 'json',
    });
    const res = await fetch(`https://api.dmm.com/affiliate/v3/ItemList?${params}`);
    if (!res.ok) throw new Error(`DMM API HTTP ${res.status}`);
    const data = await res.json();
    if (data.result?.status !== 200 && data.result?.status !== '200') {
        throw new Error(`DMM API error: ${JSON.stringify(data.result?.message ?? data.result)}`);
    }
    return { total: Number(data.result.total_count || 0), items: data.result.items || [] };
}

const names = (arr) => (arr || []).map(x => x.name).filter(Boolean).join(', ');

/** DMM API のアイテムを静的キャッシュのレコード形に変換する */
function convert(item) {
    const info = item.iteminfo || {};
    const list = item.prices?.list_price != null ? Number(item.prices.list_price) : null;
    const cur = item.prices?.price != null ? Number(String(item.prices.price).replace(/[^\d]/g, '')) : null;
    const discount = (list && cur && list > cur) ? Math.round((list - cur) / list * 100) : 0;
    let duration = null;
    if (item.volume) {
        const m = String(item.volume).match(/(\d+)/);
        if (m) duration = parseInt(m[1], 10);
    }
    const genres = names(info.genre);
    const title = item.title || '';
    return {
        product_id: item.content_id,
        title,
        actresses: names(info.actress),
        main_image_url: item.imageURL?.large || item.imageURL?.small || '',
        wish_count: 0,
        genres,
        maker: names(info.maker),
        label: names(info.label),
        sale_start_date: String(item.date || '').slice(0, 19),
        duration_min: duration,
        discount_pct: discount,
        list_price: list,
        current_price: cur,
        series_name: (info.series?.[0]?.name) ?? null,
        series_id: (info.series?.[0]?.id != null ? String(info.series[0].id) : null),
        vr_flag: (/【VR】/.test(title) || /VR専用|ハイクオリティVR/.test(genres)) ? 1 : 0,
        sale_end_date: item.campaign?.date_end ?? null,
        sample_video_url: item.sampleMovieURL?.size_720_480 || item.sampleMovieURL?.size_560_360 || null,
        source: 'fanza',
    };
}

function matchesHomeMaker(rec) {
    const maker = String(rec.maker ?? '');
    const label = String(rec.label ?? '');
    return HOME_MAKERS.some(([type, v]) => type === 'exact'
        ? (maker === v || label === v)
        : (maker.includes(v) || label.includes(v)));
}

/** 0件のときは既存を残す（D1枠切れの日に安全網を空で潰さないため） */
function writeBoth(filename, data) {
    const dataPath = path.join(ROOT, 'data', filename);
    const pubPath = path.join(ROOT, 'public', 'data', filename);
    if (data.length === 0) {
        let prev = 0;
        try { prev = JSON.parse(fs.readFileSync(dataPath, 'utf-8')).length || 0; } catch { /* 無ければ書く */ }
        if (prev > 0) {
            console.warn(`! ${filename} が0件のため上書きをスキップ（既存 ${prev}件 を維持）`);
            return;
        }
    }
    const json = JSON.stringify(data, null, 0);
    fs.mkdirSync(path.dirname(pubPath), { recursive: true });
    fs.writeFileSync(dataPath, json);
    fs.writeFileSync(pubPath, json);
    console.log(`✓ ${filename} (${data.length}件)`);
}

async function main() {
    const dotenv = (await import('dotenv')).default;
    dotenv.config({ path: path.join(REPO, '.env'), quiet: true });
    if (!process.env.DMM_API_ID || !process.env.DMM_AFFILIATE_ID) {
        console.warn('! DMM_API_ID / DMM_AFFILIATE_ID が未設定のため予約キャッシュはスキップ（既存を維持）');
        return;
    }

    const daysArg = process.argv.find(a => a.startsWith('--days='));
    const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 120;
    const gte = new Date(Date.now() + 86400000).toISOString().slice(0, 10);       // 明日以降＝未発売
    const lte = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    console.log(`[予約作品] DMM API から取得: ${gte} 〜 ${lte}`);

    const seen = new Set();
    const records = [];
    // videoc(素人)は予約がほぼ無いが、出たときのために一緒に見る
    for (const floor of ['videoa', 'videoc']) {
        let offset = 1, total = Infinity;
        while (records.length < MAX_ITEMS * 2 && offset <= total) {
            let page;
            try {
                page = await fetchPage(floor, gte, lte, offset);
            } catch (e) {
                console.warn(`  [警告] floor=${floor} offset=${offset}: ${e.message}`);
                break;
            }
            total = page.total;
            if (page.items.length === 0) break;
            for (const item of page.items) {
                const rec = convert(item);
                if (!rec.product_id || seen.has(rec.product_id)) continue;
                if (isBest(rec.title, rec.duration_min)) continue;
                if (/LadyHunter/i.test(rec.label ?? '')) continue;   // 既存の除外条件に合わせる
                seen.add(rec.product_id);
                records.push(rec);
            }
            offset += HITS;
        }
        console.log(`  floor=${floor}: 総件数 ${total === Infinity ? 0 : total} / 収集 ${records.length}`);
    }

    // 配信日DESC（＝配信が遠い順。ホームの並びに合わせる。/pre-order は表示側でASCに直す）
    records.sort((a, b) => String(b.sale_start_date).localeCompare(String(a.sale_start_date)));

    const all = records.slice(0, MAX_ITEMS);
    const curated = records.filter(matchesHomeMaker).slice(0, CURATED_MAX);
    console.log(`[予約作品] 全メーカー ${all.length}件 / 厳選メーカー ${curated.length}件`);

    writeBoth('home_preorder_cache.json', all);
    writeBoth('home_preorder_curated_cache.json', curated);
}

// デプロイ手順に組み込むため、失敗しても後続(ビルド/デプロイ)は止めない。
// 0件時は上書きしない安全弁があるので、失敗＝既存キャッシュのまま出る。
main().catch(e => { console.warn('! 予約キャッシュ生成に失敗（既存を維持）:', e.message); });
