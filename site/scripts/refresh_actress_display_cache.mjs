/**
 * actress_display_cache.json（女優ページ/女優APIが読むフルプロフィール）へ、
 * 日次更新される ../data/actress_profiles.json（FANZA ActressSearch 由来）を**追記マージ**する。
 *
 * 背景: 表示キャッシュの再生成は generate-weekly-cache.mjs の genActressDisplayCache() が担うが、
 * 供給源の D1 actress_profiles は移行時にほぼ空のまま(190行)なので事実上再生成できず、
 * 2026-06-04 の内容で止まっていた。その後に増えた女優はプロフィールが出ない。
 *
 * マージ方針（既存を壊さない）:
 *   - 既存エントリの非nullな値は温存する（avwiki由来の twitter/aliases/avwiki_url 等を消さない）
 *   - null/未設定のフィールドだけ FANZA プロフィールで埋める
 *   - 表示キャッシュに無い女優は新規追加する
 * 実行後は 64シャード(actress_display/<nn>.json)と別名インデックスを必ず作り直す。
 *
 * 使い方: node scripts/refresh_actress_display_cache.mjs
 *         （日次は generate-static-cache-local.mjs から refreshActressDisplayCache() で呼ばれる）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildActressDisplayShards } from './build_actress_display_shards.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const num = (v) => {
    const n = parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
};

/** 表示キャッシュのエントリ雛形（女優APIの ActressDisplayEntry と同じ形） */
const emptyEntry = (name) => ({
    name, fanza_id: null, ruby: null, height: null, bust: null, waist: null, hip: null, cup: null,
    birthday: null, blood_type: null, hobby: null, prefectures: null, image_url: null,
    twitter: null, instagram: null, tiktok: null, aliases: [], avwiki_url: null,
    agency_url: null, agency_source: null, augmented: false, retired: false,
});

export function refreshActressDisplayCache() {
    const displayPath = path.join(ROOT, 'public', 'data', 'actress_display_cache.json');
    const profilesPath = path.join(ROOT, '..', 'data', 'actress_profiles.json');
    if (!fs.existsSync(displayPath) || !fs.existsSync(profilesPath)) {
        throw new Error('actress_display_cache.json / actress_profiles.json が見つかりません');
    }

    const display = JSON.parse(fs.readFileSync(displayPath, 'utf-8'));
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf-8'));
    const before = Object.keys(display).length;

    let added = 0, filled = 0;
    for (const [rawName, p] of Object.entries(profiles)) {
        const name = String(rawName || '').trim();
        if (!name || name.startsWith('NOT_FOUND_')) continue;

        let entry = display[name];
        if (!entry) { entry = display[name] = emptyEntry(name); added++; }

        // null のフィールドだけ埋める（avwiki 由来の値を上書きしない）
        const fill = (key, value) => {
            if (value === null || value === undefined || value === '') return;
            if (entry[key] === null || entry[key] === undefined || entry[key] === '') { entry[key] = value; filled++; }
        };
        fill('fanza_id', p.id ?? null);
        fill('ruby', p.ruby ?? null);
        fill('height', num(p.height));
        fill('bust', num(p.bust));
        fill('waist', num(p.waist));
        fill('hip', num(p.hip));
        fill('cup', p.cup ? String(p.cup).trim().toUpperCase() : null);
        fill('birthday', p.birthday ? String(p.birthday).slice(0, 10) : null);
        fill('blood_type', p.blood_type ?? null);
        fill('hobby', p.hobby ?? null);
        fill('prefectures', p.prefectures ?? null);
        fill('image_url', p.image_url ?? null);
    }

    const after = Object.keys(display).length;
    if (after < before) throw new Error(`件数が減りました(${before}→${after})。書き出しを中止します`);

    const json = JSON.stringify(display, null, 0);
    // 一枚岩(24MB前後)はローカルNodeスクリプト用。デプロイ対象は public/.assetsignore で除外されている。
    fs.writeFileSync(displayPath, json);
    fs.writeFileSync(path.join(ROOT, 'data', 'actress_display_cache.json'), json);

    // ランタイムが読むのはシャード。必ず作り直して同期させる。
    const { shards, aliasIndex } = buildActressDisplayShards(display);
    for (const [key, obj] of Object.entries(shards)) {
        const rel = path.join('actress_display', `${key}.json`);
        for (const base of [path.join(ROOT, 'data'), path.join(ROOT, 'public', 'data')]) {
            const out = path.join(base, rel);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, JSON.stringify(obj));
        }
    }
    for (const base of [path.join(ROOT, 'data'), path.join(ROOT, 'public', 'data')]) {
        fs.writeFileSync(path.join(base, 'actress_display_alias_index.json'), JSON.stringify(aliasIndex));
    }

    console.log(`✓ actress_display_cache.json — ${after}人 (新規${added}人 / 欠損${filled}項目を補完) ＋ 64シャード再生成`);
    return display;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    refreshActressDisplayCache();
}
