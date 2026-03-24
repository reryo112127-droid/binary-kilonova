#!/usr/bin/env node
/**
 * avwiki_full.jsonl → avwiki_profiles.json 変換
 * スクレイプ結果をAPIが読める形式に変換してコミット対象ファイルを更新する
 */

const fs   = require('fs');
const path = require('path');

const JSONL_FILE    = path.join(__dirname, '../data/avwiki_full.jsonl');
const PROFILES_FILE = path.join(__dirname, '../data/avwiki_profiles.json');

if (!fs.existsSync(JSONL_FILE)) {
    console.error('avwiki_full.jsonl が見つかりません');
    process.exit(1);
}

const lines = fs.readFileSync(JSONL_FILE, 'utf-8').trim().split('\n').filter(Boolean);
console.log(`avwiki_full.jsonl: ${lines.length} 件読み込み`);

// 既存の profiles を読み込んでベースにする（過去のデータを保持）
let profiles = {};
if (fs.existsSync(PROFILES_FILE)) {
    try {
        profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));
        console.log(`avwiki_profiles.json: 既存 ${Object.keys(profiles).length} 件`);
    } catch {
        console.warn('avwiki_profiles.json の読み込みに失敗。新規作成します。');
    }
}

let updated = 0;
for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const name = entry.name;
    if (!name) continue;

    profiles[name] = {
        url:          entry.url          ?? null,
        scraped_at:   entry.scraped_at   ?? null,
        height:       entry.height       ?? null,
        bust:         entry.bust         ?? null,
        waist:        entry.waist        ?? null,
        hip:          entry.hip          ?? null,
        cup:          entry.cup          ?? null,
        birthday_raw: entry.birthday_raw ?? (entry.birthday ? entry.birthday.replace(/-/g, '/') : null),
        twitter:      entry.twitter      ?? null,
        instagram:    entry.instagram    ?? null,
        tiktok:       entry.tiktok       ?? null,
        aliases:      entry.aliases      ?? [],
    };

    // 別名義でも同じプロフィールを登録（名寄せのため）
    if (Array.isArray(entry.aliases)) {
        for (const alias of entry.aliases) {
            if (!profiles[alias]) {
                profiles[alias] = { ...profiles[name], name_canonical: name };
            }
        }
    }
    updated++;
}

fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2), 'utf-8');
console.log(`avwiki_profiles.json: ${Object.keys(profiles).length} 件に更新 (${updated} 件を反映)`);
