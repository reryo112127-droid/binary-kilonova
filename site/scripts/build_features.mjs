/**
 * 特集ページ（/features・/feature/<slug>）のデータを静的JSONに焼く。
 *
 * 長尾LP（ジャンル/メーカー/シリーズ）は自動の一覧だけで、他のアフィリエイトサイトが検索を取っている
 * 「今月の◯◯ランキング」「セール中で評価が高い作品」「FANZAとMGSどっちが安い？」のような
 * 切り口のページが無かった。両PFの価格を持っているのはこのサイトの強みなので、それを前に出す。
 *
 * データ源はローカル SQLite（D1 は読まない）。出力: site/data/features.json と site/public/data/features.json
 *   { generatedAt, features: [{ slug, title, h1, description, intro, items: [...] }] }
 *
 * 使い方: node scripts/build_features.mjs   （generate-static-cache-local.mjs からも日次で呼ぶ）
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // site/
const REPO = path.resolve(ROOT, '..');

// lib/bestFilter.ts と同じ除外条件（総集編が上位を占めないように）
const BEST_PATTERNS = ['%BEST%', '%ベスト%', '%総集編%', '%コレクション%', '%福袋%', '%詰め合わせ%', '%コンプリート%', '%枚組%'];
const BEST_SQL = BEST_PATTERNS.map(() => 'title NOT LIKE ?').join(' AND ') + ' AND COALESCE(duration_min, 0) <= 480';

/** 月別の新作ランキングを作るジャンル（作品数が多く検索もある順） */
const MONTHLY_GENRES = ['巨乳', '人妻・主婦', '素人', '熟女', '美少女', '中出し', '痴女', 'スレンダー', '美乳', 'ハメ撮り', 'VR専用', 'ギャル'];

function poster(url) {
    if (!url) return '';
    if (url.includes('pb_e_')) return url.replace('pb_e_', 'pf_e_');
    if (url.includes('/digital/amateur/') && url.endsWith('jm.jpg')) return url.replace('jm.jpg', 'jp-001.jpg');
    return url;
}

const jst = (d = new Date()) => new Date(d.getTime() + 9 * 3600 * 1000);
const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => ymd(new Date(jst().getTime() - n * 86400000));
/** FANZA 'YYYY-MM-DD hh:mm:ss' / MGS 'YYYY/MM/DD' を 'YYYY-MM-DD' に */
const normDate = (v) => {
    const m = String(v ?? '').match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
};
const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;

/** 出演者欄の先頭2名（素人の「名前 22歳 職業」はそのまま） */
function castOf(raw) {
    return String(raw || '').split(/[,、]/).map(s => s.trim()).filter(s => s && !/^[＊*\-]+$/.test(s)).slice(0, 2).join('、');
}

function item(row, source, note) {
    const o = {
        product_id: row.product_id,
        title: row.title ?? '',
        actresses: castOf(row.actresses),
        main_image_url: poster(row.main_image_url ?? ''),
        maker: row.maker ?? '',
        sale_start_date: normDate(row.sale_start_date),
        source,
        note,
    };
    for (const k of ['duration_min', 'list_price', 'current_price', 'discount_pct', 'review_count', 'review_average', 'wish_count']) {
        const v = Number(row[k]);
        if (Number.isFinite(v) && v > 0) o[k] = k === 'review_average' ? Math.round(v * 100) / 100 : v;
    }
    return o;
}

/** MGS と FANZA を交互に並べる（同一作品は先に出た方だけ） */
function interleave(a, b, limit) {
    const out = [];
    const seen = new Set();
    for (let i = 0; out.length < limit && (i < a.length || i < b.length); i++) {
        for (const x of [a[i], b[i]]) {
            if (!x || out.length >= limit) continue;
            const k = String(x.title).slice(0, 30);
            if (seen.has(k)) continue;
            seen.add(k); out.push(x);
        }
    }
    return out;
}

function reviewNote(r) {
    return r.review_count ? `★${Number(r.review_average).toFixed(2)}（レビュー${r.review_count}件）` : '';
}

export function buildFeatures() {
    const Database = require('better-sqlite3');
    const fz = new Database(path.join(REPO, 'data', 'fanza.db'), { readonly: true });
    const mg = new Database(path.join(REPO, 'data', 'mgs.db'), { readonly: true });
    const today = ymd(jst());
    const thisYear = today.slice(0, 4);
    const month = `${Number(today.slice(5, 7))}月`;
    const features = [];
    const add = (f) => { if (f.items.length >= 5) features.push(f); else console.warn(`  - ${f.slug}: ${f.items.length}件のため掲載しない`); };

    // FANZA の日付は 'YYYY-MM-DD ...'、MGS は 'YYYY/MM/DD'。文字列比較で済むよう両方の形を用意
    const fzSince = (n) => daysAgo(n);
    const mgSince = (n) => daysAgo(n).replace(/-/g, '/');
    const fzToday = today + ' 23:59:59';
    const mgToday = today.replace(/-/g, '/');

    // ── 1. セール中で評価が高い作品 ──────────────────────────────
    {
        const rows = fz.prepare(`SELECT * FROM products
            WHERE discount_pct > 0 AND current_price > 0 AND review_count >= 10 AND review_average >= 4.3
              AND (sale_end_date IS NULL OR sale_end_date >= ?) AND ${BEST_SQL}
            ORDER BY review_count * review_average DESC LIMIT 30`).all(today, ...BEST_PATTERNS);
        add({
            slug: 'sale-high-rated', title: 'セール中で評価が高いAV作品',
            h1: `セール中で評価が高いAV作品（${today.replace(/-/g, '/')}更新）`,
            description: 'いま値下げ中の作品から、FANZAのレビューが★4.3以上・10件以上の評価が確かなものだけを集めました。割引率と通常価格も一覧で比べられます。',
            intro: `値下げ中の作品は多くても、安いだけで選ぶと外れを引きがちです。ここでは「レビューが10件以上あり平均★4.3以上」の作品だけに絞り、レビューの多い順に並べました。いま${rows.length}作品が該当しています。セール期間は配信サイト側で変わることがあるので、購入前に価格を確認してください。`,
            items: rows.map(r => item(r, 'fanza', `${r.discount_pct}%オフで${yen(r.current_price)}（通常${yen(r.list_price)}）・${reviewNote(r)}${r.sale_end_date ? `・${normDate(r.sale_end_date).slice(5).replace('-', '/')}まで` : ''}`)),
        });
    }

    // ── 2. FANZA と MGS で値段が違う作品 ────────────────────────
    {
        const cp = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'cross_platform.json'), 'utf8'));
        // MGS の比較には「ダウンロード買い切り」価格（scripts/build_mgs_buy_price.js が詳細ページから収集）だけを使う。
        // mgs.db の current_price は視聴(ストリーミング)の最安値で、FANZA のダウンロード価格と条件が違う
        // （例: 882JERA-001 は mgs.db 500円＝視聴価格）。比べると「MGSの方が880円安い」のような誤った表示になる。
        let mgsPrice = {};
        try { mgsPrice = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'mgs_buy_price.json'), 'utf8')); } catch { /* 無ければ特集ごと出さない */ }
        const getM = mg.prepare('SELECT * FROM products WHERE product_id = ?');
        const getF = fz.prepare('SELECT * FROM products WHERE product_id = ?');
        const pairs = [];
        for (const [mid, fid] of Object.entries(cp)) {
            if (!mid.includes('-')) continue;               // MGS 品番（ハイフン有）→ FANZA 品番 の向きだけ
            const mp = Number(mgsPrice[mid]?.current) || 0;
            if (!mp) continue;
            const f = getF.get(fid);
            if (!f || !(f.current_price > 0)) continue;
            const m = getM.get(mid);
            if (!m || !mp) continue;
            const diff = Math.abs(mp - f.current_price);
            if (diff < 100) continue;
            pairs.push({ f, m, mp, diff, pop: (f.review_count || 0) * (f.review_average || 0) });
        }
        pairs.sort((a, b) => b.pop - a.pop);
        const top = pairs.slice(0, 30);
        add({
            slug: 'cheaper-fanza-or-mgs', title: 'FANZAとMGSで値段が違う人気AV作品',
            h1: 'FANZAとMGSで値段が違う人気AV作品（どっちが安い？）',
            description: 'FANZAとMGS動画の両方で配信されている人気作品のうち、2つのサイトで価格が100円以上違うものの一覧です。どちらで買うと安いかが一目で分かります。',
            intro: `同じ作品でも、FANZAとMGS動画では値段やセールの時期が違うことがあります。両方で配信されている作品のうち、ダウンロード購入の価格が100円以上違う作品を${top.length}作品まとめました。価格は掲載時点のもので、画質の選択肢やセールの有無で変わることがあります。`,
            items: top.map(({ f, m, mp, diff }) => {
                const cheaper = mp < f.current_price ? 'MGS' : 'FANZA';
                // 価格行は安い方の値段だけにする（FANZA の定価・割引率を混ぜると「¥295 ¥590 30%OFF」のような嘘になる）
                const it = item(f, 'fanza', `FANZA ${yen(f.current_price)} ／ MGS ${yen(mp)} → ${cheaper}の方が${yen(diff)}安い`);
                delete it.list_price; delete it.discount_pct;
                return { ...it, current_price: Math.min(mp, f.current_price), pair_id: m.product_id, fanza_price: f.current_price, mgs_price: mp };
            }),
        });
    }

    // ── 3. 1分あたりが安い長時間作品 ─────────────────────────────
    {
        const rows = fz.prepare(`SELECT * FROM products
            WHERE duration_min >= 180 AND current_price > 0 AND review_count >= 5 AND review_average >= 4.0
              AND sale_start_date >= ? AND ${BEST_SQL}
            ORDER BY CAST(current_price AS REAL) / duration_min ASC LIMIT 30`).all(`${Number(thisYear) - 1}-01-01`, ...BEST_PATTERNS);
        add({
            slug: 'long-and-cheap', title: '1分あたりが安い長時間AV作品',
            h1: '1分あたりの値段が安い長時間AV作品',
            description: '3時間以上の作品から、レビュー★4以上で「1分あたりの値段」が安い順に並べました。総集編は除いています。',
            intro: '長い作品ほど得とは限りませんが、評価の確かな作品を長く楽しめるならコスパは高くなります。ここでは昨年以降に配信された3時間以上の作品のうち、レビュー★4.0以上（5件以上）のものを「価格 ÷ 収録時間」の安い順に並べました。ベスト盤・総集編は除いています。',
            items: rows.map(r => item(r, 'fanza', `${r.duration_min}分で${yen(r.current_price)}（1分あたり${(r.current_price / r.duration_min).toFixed(1)}円）・${reviewNote(r)}`)),
        });
    }

    // ── 4. 今年の高評価作品 ──────────────────────────────────────
    {
        const rows = fz.prepare(`SELECT * FROM products
            WHERE sale_start_date >= ? AND sale_start_date <= ? AND review_count >= 5 AND ${BEST_SQL}
            ORDER BY review_count * review_average DESC LIMIT 30`).all(`${thisYear}-01-01`, fzToday, ...BEST_PATTERNS);
        add({
            slug: `best-of-${thisYear}`, title: `${thisYear}年に配信された高評価AV作品`,
            h1: `${thisYear}年に配信された高評価AV作品ベスト30`,
            description: `${thisYear}年に配信が始まった作品から、FANZAのレビューの件数と★の高さで上位30作品を選びました。`,
            intro: `${thisYear}年1月以降に配信が始まった作品を、FANZAのレビュー件数×平均★で並べました。レビューが集まるには時間がかかるため、年の後半に出た作品は少し不利になります。最新の動きは<a class="text-primary underline" href="/ranking/2026">${thisYear}年ランキング</a>もあわせてどうぞ。`,
            items: rows.map(r => item(r, 'fanza', reviewNote(r))),
        });
    }

    // ── 5. 最近のデビュー作 ──────────────────────────────────────
    {
        const f = fz.prepare(`SELECT * FROM products WHERE genres LIKE '%デビュー作品%' AND sale_start_date >= ? AND sale_start_date <= ? AND ${BEST_SQL}
            ORDER BY COALESCE(review_count,0) * COALESCE(review_average,0) DESC, sale_start_date DESC LIMIT 20`).all(fzSince(120), fzToday, ...BEST_PATTERNS);
        const m = mg.prepare(`SELECT * FROM products WHERE genres LIKE '%デビュー作品%' AND sale_start_date >= ? AND sale_start_date <= ? AND ${BEST_SQL}
            ORDER BY COALESCE(wish_count,0) DESC, sale_start_date DESC LIMIT 20`).all(mgSince(120), mgToday, ...BEST_PATTERNS);
        const items = interleave(
            m.map(r => item(r, 'mgs', r.wish_count ? `MGSでお気に入り${Number(r.wish_count).toLocaleString('ja-JP')}件` : `MGS動画で${normDate(r.sale_start_date).slice(5).replace('-', '/')}配信`)),
            f.map(r => item(r, 'fanza', reviewNote(r) || 'FANZAで配信中')), 30);
        add({
            slug: 'recent-debut', title: '最近デビューした新人AV女優のデビュー作',
            h1: '最近デビューした新人のデビュー作まとめ',
            description: 'この4か月ほどで配信されたデビュー作を、FANZAのレビューの多さとMGSの新着順でまとめました。',
            intro: 'デビュー作はその後の作品より初々しさが出やすく、気に入った新人を早めに見つけるのにも向いています。直近約4か月に配信された「デビュー作品」を、FANZAはレビューの多さ、MGSは配信日の新しい順で並べ、交互に載せています。',
            items,
        });
    }

    // ── 6. ジャンル別・直近30日の新作人気 ───────────────────────
    for (const g of MONTHLY_GENRES) {
        const like = `%${g}%`;
        const f = fz.prepare(`SELECT * FROM products WHERE genres LIKE ? AND sale_start_date >= ? AND sale_start_date <= ? AND ${BEST_SQL}
            ORDER BY COALESCE(review_count,0) * COALESCE(review_average,0) DESC, sale_start_date DESC LIMIT 15`).all(like, fzSince(30), fzToday, ...BEST_PATTERNS);
        const m = g === 'VR専用' ? [] : mg.prepare(`SELECT * FROM products WHERE genres LIKE ? AND sale_start_date >= ? AND sale_start_date <= ? AND ${BEST_SQL}
            ORDER BY COALESCE(wish_count,0) DESC, sale_start_date DESC LIMIT 15`).all(like, mgSince(30), mgToday, ...BEST_PATTERNS);
        const label = g === 'VR専用' ? 'VR' : g;
        add({
            slug: `new-${g}`, title: `${month}の${label}新作 人気ランキング`,
            h1: `最近30日の${label}新作 人気ランキング（${today.replace(/-/g, '/')}更新）`,
            description: `直近30日に配信された「${label}」ジャンルの新作を、FANZAのレビューの多さとMGSの新着順でまとめました。毎日更新しています。`,
            intro: `「${label}」の新作は毎月たくさん出るので、まずは人気の集まっている作品から押さえるのが近道です。直近30日に配信された作品を、FANZAはレビューの多さ、MGSは配信日の新しい順で並べ、交互に載せています（配信直後はレビューが少ないため、日がたつと順位が入れ替わります）。もっと探すなら<a class="text-primary underline" href="/genre/${encodeURIComponent(g)}">${label}の作品一覧</a>へ。`,
            items: interleave(
                m.map(r => item(r, 'mgs', r.wish_count ? `MGSでお気に入り${Number(r.wish_count).toLocaleString('ja-JP')}件` : `MGS動画で${normDate(r.sale_start_date).slice(5).replace('-', '/')}配信`)),
                f.map(r => item(r, 'fanza', reviewNote(r) || `${normDate(r.sale_start_date).slice(5).replace('-', '/')}配信`)), 20),
        });
    }

    fz.close(); mg.close();
    const out = { generatedAt: new Date().toISOString(), features };
    for (const dir of [path.join(ROOT, 'data'), path.join(ROOT, 'public', 'data')]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'features.json'), JSON.stringify(out));
    }
    console.log(`✓ features.json (${features.length}特集 / ${features.reduce((n, f) => n + f.items.length, 0)}作品)`);
    return out;
}

if (process.argv[1]?.endsWith('build_features.mjs')) buildFeatures();
