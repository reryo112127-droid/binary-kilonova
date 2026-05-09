/**
 * merge_avwiki_full.js
 *
 * avwiki_full.jsonl (scrape_avwiki_full.js の出力) を
 * avwiki_profiles.json (FANZAキー) にマージする。
 *
 * マッチング優先順:
 *   1. AVWIKI の name が FANZA キーと完全一致
 *   2. AVWIKI の aliases いずれかが FANZA キーと完全一致
 *   3. 正規化（スペース除去・全角→半角）後に再試行
 *
 * 使い方:
 *   node scripts/merge_avwiki_full.js          # 通常実行（avwiki_profiles.json を更新）
 *   node scripts/merge_avwiki_full.js --dry-run # 件数確認のみ（ファイル変更なし）
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR      = path.join(__dirname, '..', 'data');
const JSONL_FILE    = path.join(DATA_DIR, 'avwiki_full.jsonl');
const PROFILES_FILE = path.join(DATA_DIR, 'avwiki_profiles.json');
const UNMATCHED_FILE = path.join(DATA_DIR, 'avwiki_unmatched.json');

const DRY_RUN = process.argv.includes('--dry-run');

// ── 正規化: スペース除去・全角英数→半角 ──────────────────
function normalize(s) {
    if (!s) return '';
    return s
        .replace(/\s/g, '')
        .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .toLowerCase();
}

// ── ロード ────────────────────────────────────────────────
if (!fs.existsSync(JSONL_FILE)) {
    console.error('ERROR: avwiki_full.jsonl が見つかりません');
    process.exit(1);
}

const avwikiProfiles = fs.existsSync(PROFILES_FILE)
    ? JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'))
    : {};

const actressProfiles = (() => {
    const p = path.join(DATA_DIR, 'actress_profiles.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
})();

// FANZA名セット（正規化→元名マップ）
const fanzaNames    = new Set(Object.keys(actressProfiles).filter(k => !k.startsWith('NOT_FOUND_')));
const fanzaNormMap  = new Map(); // 正規化名 → 元のFANZA名
for (const name of fanzaNames) fanzaNormMap.set(normalize(name), name);

// ── マッチング ────────────────────────────────────────────
function findFanzaName(avwikiEntry) {
    const candidates = [avwikiEntry.name, ...(avwikiEntry.aliases || [])].filter(Boolean);

    // パス1: 完全一致
    for (const c of candidates) {
        if (fanzaNames.has(c)) return c;
    }
    // パス2: 正規化一致
    for (const c of candidates) {
        const norm = normalize(c);
        if (fanzaNormMap.has(norm)) return fanzaNormMap.get(norm);
    }
    return null;
}

// ── jsonl をパース ────────────────────────────────────────
const lines = fs.readFileSync(JSONL_FILE, 'utf-8')
    .split('\n')
    .filter(l => l.trim());

let added = 0, updated = 0, skipped = 0;
const unmatched = [];

for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.name && !(entry.aliases?.length)) { skipped++; continue; }

    const fanzaName = findFanzaName(entry);
    if (!fanzaName) {
        unmatched.push({ name: entry.name, aliases: entry.aliases, url: entry.url });
        skipped++;
        continue;
    }

    // 既存エントリとマージ（既存優先・新規フィールドのみ補完）
    const existing = avwikiProfiles[fanzaName];
    const merged = {
        url:        entry.url,
        scraped_at: entry.scraped_at,
        // 別名: 既存＋新規をユニーク結合
        ...((() => {
            const all = [...new Set([
                ...(existing?.aliases || []),
                ...(entry.aliases || []),
            ])];
            return all.length ? { aliases: all } : {};
        })()),
        // SNS: 既存優先
        ...(existing?.twitter || entry.twitter ? { twitter: existing?.twitter || entry.twitter } : {}),
        ...(existing?.instagram || entry.instagram ? { instagram: existing?.instagram || entry.instagram } : {}),
        // サイズ・誕生日: FANZAにない場合のみ補完
        ...(!actressProfiles[fanzaName]?.height   && entry.height   ? { height: entry.height }     : {}),
        ...(!actressProfiles[fanzaName]?.bust      && entry.bust     ? { bust: entry.bust }         : {}),
        ...(!actressProfiles[fanzaName]?.waist     && entry.waist    ? { waist: entry.waist }       : {}),
        ...(!actressProfiles[fanzaName]?.hip       && entry.hip      ? { hip: entry.hip }           : {}),
        ...(!actressProfiles[fanzaName]?.cup       && entry.cup      ? { cup: entry.cup }           : {}),
        ...(!actressProfiles[fanzaName]?.birthday  && entry.birthday ? { birthday: entry.birthday } : {}),
    };

    if (!existing) {
        added++;
    } else {
        updated++;
    }

    if (!DRY_RUN) avwikiProfiles[fanzaName] = merged;
}

// ── 保存 ─────────────────────────────────────────────────
if (!DRY_RUN) {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(avwikiProfiles, null, 2));
    fs.writeFileSync(UNMATCHED_FILE, JSON.stringify(unmatched, null, 2));
}

console.log('=== avwiki_full → avwiki_profiles マージ結果 ===');
console.log(`処理行数:   ${lines.length}`);
console.log(`新規追加:   ${added}`);
console.log(`既存更新:   ${updated}`);
console.log(`未一致:     ${unmatched.length}  → ${UNMATCHED_FILE}`);
console.log(`スキップ:   ${skipped - unmatched.length}  (名前なし)`);
if (DRY_RUN) console.log('\n[dry-run] ファイルは変更されていません');
else         console.log(`\n保存完了: ${PROFILES_FILE}`);
