/**
 * site/data/actress_profiles.json（＋public/data）を作り直す。
 *
 * 背景: この静的キャッシュは 2026-03-22 以降どのスクリプトからも再生成されておらず、
 * 3,280人・cup 1,235人・image_url 0件まで痩せていた。そのため
 *   - /cup/<letter> LP と詳細検索の cup/height/age フィルタが実質1,200人ぶんしか効かない
 *   - /product/[id] の OGP 女優画像が常に null
 * という状態だった。供給源はどちらもローカルに揃っている:
 *   - ../data/actress_profiles.json      … FANZA ActressSearch 由来（日次 fetch_fanza_actresses.js が更新）
 *   - public/data/actress_display_cache.json … avwiki 由来を含む表示用フルプロフィール
 * この2つをマージして「フィルタに必要な最小フィールドだけ」を書き出す。
 *
 * ランタイムの読み取り箇所（フィールドを増やすときは CPU/メモリ影響に注意）:
 *   app/api/products/route.ts        … cup / height / birthday
 *   app/api/ranking/actress/route.ts … cup / height / birthday
 * 画像は 60,103人ぶんが actress_display/<nn>.json シャードにあるのでそちらを引く
 * （1ファイル0.4MB以下。ここに image_url を足すと全ページで1.6MBのJSON.parseが走る）。
 *
 * 使い方: node scripts/build_actress_profiles_cache.mjs
 *         （日次は generate-static-cache-local.mjs から buildActressProfilesCache() で呼ばれる）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (p, fallback = null) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
};

/** "160" / 160 / null → 160 | undefined（ランタイムは数値比較する） */
const toHeight = (v) => {
    const n = parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) && n >= 100 && n <= 220 ? n : undefined;
};
/** "A"〜"Q" 以外（"" や "不明"）は捨てる */
const toCup = (v) => {
    const s = String(v ?? '').trim().toUpperCase();
    return /^[A-Q]$/.test(s) ? s : undefined;
};
/** "1997-12-03T00:00:00Z" → "1997-12-03" */
const toBirthday = (v) => {
    const s = String(v ?? '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
};

export function buildActressProfilesCache() {
    const fanzaProfiles = readJson(path.join(ROOT, '..', 'data', 'actress_profiles.json'), {}) || {};
    const displayCache = readJson(path.join(ROOT, 'public', 'data', 'actress_display_cache.json'), {}) || {};

    const out = {};
    const put = (name, src) => {
        const key = String(name || '').trim();
        // NOT_FOUND_* は fetch_fanza_actresses.js が「FANZAに居ない」印として書く番兵。索引には不要。
        if (!key || key.startsWith('NOT_FOUND_')) return;
        const cup = toCup(src.cup), height = toHeight(src.height), birthday = toBirthday(src.birthday);
        if (!cup && !height && !birthday) return;
        const cur = out[key] || (out[key] = {});
        if (cup && !cur.cup) cur.cup = cup;
        if (height && !cur.height) cur.height = height;
        if (birthday && !cur.birthday) cur.birthday = birthday;
    };

    // FANZA公式プロフィールを優先し、欠けている値を display キャッシュ（avwiki 由来を含む）で補う
    for (const [name, p] of Object.entries(fanzaProfiles)) put(name, p || {});
    for (const [name, p] of Object.entries(displayCache)) put(name, p || {});

    // 供給源が読めなかったときに、本番のフィルタ用データを空同然で上書きしないためのガード
    if (Object.keys(out).length < 1000) {
        throw new Error(`actress_profiles.json: ${Object.keys(out).length}人しか作れませんでした（供給源の読み込み失敗の疑い）。既存ファイルは変更しません。`);
    }

    const json = JSON.stringify(out, null, 0);
    for (const dir of [path.join(ROOT, 'data'), path.join(ROOT, 'public', 'data')]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'actress_profiles.json'), json);
    }

    const n = (f) => Object.values(out).filter(v => v[f]).length;
    console.log(`✓ actress_profiles.json — ${Object.keys(out).length}人 / ${(Buffer.byteLength(json) / 1048576).toFixed(2)}MB`
        + ` (cup:${n('cup')} height:${n('height')} birthday:${n('birthday')})`);
    return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    buildActressProfilesCache();
}
