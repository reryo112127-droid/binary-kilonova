/**
 * actress_display_cache.json(約24MB・6万人) を女優名ハッシュで64分割する。
 *
 * 理由: 女優API `/api/actress/[name]` はこの1ファイルを ASSETS から丸ごと取得して
 * JSON.parse し、isolate内(`staticCache.ts` の _mem)に常駐させていた。Workersのisolateは
 * メモリ128MBなので、24MBのJSONをパースしたオブジェクトが居座るのは危険（同時に19MBの
 * actress_extended_products.json も載る可能性がある）。加えて **Cloudflareのアセット上限は
 * 1ファイル25MB** で、24.3MBは限界ぎりぎり＝女優が増えるとデプロイが失敗する。
 *
 * 出力（data/ と public/data/ の両方）:
 *   actress_display/<nn>.json        … nn = 00..3f のシャード（各400KB前後）
 *   actress_display_alias_index.json … 別名 → 正規名（別名の逆引きに全件走査が要るため）
 *
 * 元の actress_display_cache.json は残す（build_actress_whitelist.js 等のNodeスクリプトが
 * ローカルファイルとして読むため）。デプロイ対象からは public/.assetsignore で除外する。
 *
 * 使い方: node scripts/build_actress_display_shards.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHARD_COUNT = 64;

/** FNV-1a 32bit。site/lib/actressShard.ts と必ず同じ実装にすること。 */
export function actressShardKey(name) {
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) {
        h ^= name.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % SHARD_COUNT).toString(16).padStart(2, '0');
}

export function buildActressDisplayShards(displayCache) {
    const shards = {};
    for (let i = 0; i < SHARD_COUNT; i++) shards[i.toString(16).padStart(2, '0')] = {};
    const aliasIndex = {};

    for (const [canonical, entry] of Object.entries(displayCache)) {
        shards[actressShardKey(canonical)][canonical] = entry;
        for (const alias of entry?.aliases ?? []) {
            // 同じ別名が複数の正規名に紐づく場合は先勝ち（元の実装も最初に見つけた1件を採用）
            if (alias && alias !== canonical && !(alias in aliasIndex)) aliasIndex[alias] = canonical;
        }
    }
    return { shards, aliasIndex };
}

// ── seesaawiki(av_neme) の女優情報で欠けを埋める（2026-09-14）──────────────
// 表示キャッシュの供給元（DMM ActressSearch＋AVWIKI）に無い 生年月日/身長/スリーサイズ/カップ/
// 別名/X を、seesaawiki の収集結果(data/seesaawiki_actress_map.jsonl)から**空欄だけ**補う。
// 既存の値は上書きしない（公式APIを優先し、コミュニティ編集は補助に留める）。
// 実測: seesaawiki 6,414人のうち サイトに無い生年月日 2,292 / 身長 2,111 / カップ 1,963 / 別名 1,426 / X 2,132。
const SEESAA_MAP = path.join(ROOT, '..', 'data', 'seesaawiki_actress_map.jsonl');
const validName = (s) => !!s && s.length > 1 && s.length <= 30 && !/\d+歳|[（()【】\[\]<>@:：]/.test(s) && s !== '----';
const inRange = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? v : null);

export function parseSeesaaProfile(p) {
    const out = {};
    const bd = String(p?.birthday ?? '').match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
    if (bd && +bd[1] >= 1950 && +bd[1] <= 2010) out.birthday = `${bd[1]}-${bd[2].padStart(2, '0')}-${bd[3].padStart(2, '0')}`;
    const size = String(p?.size ?? '');
    const num = (re) => { const m = size.match(re); return m ? parseInt(m[1], 10) : NaN; };
    out.height = inRange(num(/T\s*(\d{3})/), 130, 195);
    out.bust = inRange(num(/B\s*(\d{2,3})/), 60, 130);
    out.waist = inRange(num(/W\s*(\d{2})/), 40, 80);
    out.hip = inRange(num(/H\s*(\d{2,3})/), 60, 130);
    const cup = size.match(/[（(]\s*([A-Q])\s*(?:カップ)?\s*[)）]/) || size.match(/([A-Q])カップ/);
    if (cup) out.cup = cup[1];
    const tw = String(p?.twitter ?? '').replace(/^@/, '') || (size.match(/(?:Twitter|SNS)\s*[:：]\s*@([A-Za-z0-9_]{1,15})/i) || [])[1] || '';
    if (/^[A-Za-z0-9_]{1,15}$/.test(tw)) out.twitter = tw;
    // 「七栄ここ（ななえここ）・奈菜原心美（ななはらここみ）」→ 読みの括弧を落として区切る
    out.aliases = String(p?.alias ?? '')
        .replace(/[（(][^）)]*[）)]/g, '')
        .split(/[・／/、,，]/)
        .map(s => s.trim())
        .filter(validName);
    return out;
}

function mergeSeesaawiki(displayCache) {
    if (!fs.existsSync(SEESAA_MAP)) { console.warn('! seesaawiki_actress_map.jsonl が無いので補完をスキップ'); return; }
    const stat = { people: 0, created: 0, birthday: 0, height: 0, sizes: 0, cup: 0, aliases: 0, twitter: 0 };
    for (const line of fs.readFileSync(SEESAA_MAP, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const name = String(j.actressName ?? '').trim();
        if (!validName(name) || !j.profile) continue;
        const s = parseSeesaaProfile(j.profile);
        let e = displayCache[name];
        if (!e) {
            // DMM/AVWIKI に居ない女優。実データが1つでもあるときだけ作る（空のエントリは作らない）
            if (!s.birthday && !s.height && !s.cup && !s.twitter && !s.aliases.length) continue;
            e = displayCache[name] = { name, fanza_id: null, ruby: null, height: null, bust: null, waist: null, hip: null,
                cup: null, birthday: null, blood_type: null, hobby: null, prefectures: null, image_url: null,
                twitter: null, instagram: null, tiktok: null, aliases: [], avwiki_url: null, agency_url: null,
                agency_source: null, augmented: null, retired: null };
            stat.created++;
        }
        stat.people++;
        if (!e.birthday && s.birthday) { e.birthday = s.birthday; stat.birthday++; }
        if (!e.height && s.height) { e.height = s.height; stat.height++; }
        if (!(e.bust && e.waist && e.hip) && s.bust && s.waist && s.hip) { e.bust = s.bust; e.waist = s.waist; e.hip = s.hip; stat.sizes++; }
        if (!e.cup && s.cup) { e.cup = s.cup; stat.cup++; }
        if (!e.twitter && s.twitter) { e.twitter = s.twitter; stat.twitter++; }
        const have = new Set(e.aliases ?? []);
        const add = s.aliases.filter(a => a !== name && !have.has(a));
        if (add.length) { e.aliases = [...(e.aliases ?? []), ...add]; stat.aliases++; }
    }
    console.log(`✓ seesaawiki 補完: 照合${stat.people}人（新規${stat.created}人）/ 生年月日+${stat.birthday} 身長+${stat.height} `
        + `スリーサイズ+${stat.sizes} カップ+${stat.cup} 別名+${stat.aliases} X+${stat.twitter}`);
}

function writeBoth(relPath, json) {
    for (const base of [path.join(ROOT, 'data'), path.join(ROOT, 'public', 'data')]) {
        const p = path.join(base, relPath);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, json);
    }
}

function main() {
    const src = path.join(ROOT, 'public', 'data', 'actress_display_cache.json');
    if (!fs.existsSync(src)) {
        console.error(`✗ ${src} が見つかりません`);
        process.exit(1);
    }
    const displayCache = JSON.parse(fs.readFileSync(src, 'utf-8'));
    // 元の actress_display_cache.json は書き換えない（シャードにだけ反映する）
    mergeSeesaawiki(displayCache);
    const { shards, aliasIndex } = buildActressDisplayShards(displayCache);

    let total = 0, maxBytes = 0;
    for (const [key, obj] of Object.entries(shards)) {
        const json = JSON.stringify(obj);
        writeBoth(path.join('actress_display', `${key}.json`), json);
        total += Object.keys(obj).length;
        maxBytes = Math.max(maxBytes, Buffer.byteLength(json));
    }
    const aliasJson = JSON.stringify(aliasIndex);
    writeBoth('actress_display_alias_index.json', aliasJson);

    console.log(`✓ actress_display/*.json — ${SHARD_COUNT}シャード / ${total}人 / 最大 ${(maxBytes / 1024 / 1024).toFixed(2)}MB`);
    console.log(`✓ actress_display_alias_index.json — ${Object.keys(aliasIndex).length}件 / ${(Buffer.byteLength(aliasJson) / 1024 / 1024).toFixed(2)}MB`);
    if (total !== Object.keys(displayCache).length) {
        console.error(`✗ 件数不一致: 元 ${Object.keys(displayCache).length} → シャード合計 ${total}`);
        process.exit(1);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
