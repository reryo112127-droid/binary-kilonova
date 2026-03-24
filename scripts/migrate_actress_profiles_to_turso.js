#!/usr/bin/env node
/**
 * 女優プロフィール Turso 移行スクリプト（一回限り）
 *
 * JSON ファイル → FANZA Turso の actress_profiles / actress_aliases テーブルに移行
 *
 * 実行:
 *   TURSO_FANZA_URL=... TURSO_FANZA_TOKEN=... node scripts/migrate_actress_profiles_to_turso.js
 */

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATA = path.join(__dirname, '..', 'data');
const BATCH = 200;

function load(file) {
    const p = path.join(DATA, file);
    if (!fs.existsSync(p)) { console.warn(`  skip: ${file} not found`); return null; }
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

async function main() {
    const url   = process.env.TURSO_FANZA_URL;
    const token = process.env.TURSO_FANZA_TOKEN;
    if (!url || !token) { console.error('TURSO_FANZA_URL/TOKEN が未設定'); process.exit(1); }

    const db = createClient({ url, authToken: token });

    // ---- スキーマ作成 ----
    await db.batch([
        { sql: `CREATE TABLE IF NOT EXISTS actress_profiles (
            name        TEXT PRIMARY KEY,
            fanza_id    TEXT,
            ruby        TEXT,
            height      INTEGER,
            bust        INTEGER,
            waist       INTEGER,
            hip         INTEGER,
            cup         TEXT,
            birthday    TEXT,
            blood_type  TEXT,
            hobby       TEXT,
            prefectures TEXT,
            image_url   TEXT,
            twitter     TEXT,
            instagram   TEXT,
            tiktok      TEXT,
            aliases     TEXT,
            avwiki_url  TEXT,
            agency_url  TEXT,
            agency_source TEXT,
            augmented   INTEGER DEFAULT 0,
            updated_at  TEXT
        )`, args: [] },
        { sql: `CREATE TABLE IF NOT EXISTS actress_aliases (
            alias          TEXT PRIMARY KEY,
            canonical_name TEXT NOT NULL
        )`, args: [] },
        { sql: `CREATE INDEX IF NOT EXISTS idx_ap_fanza_id ON actress_profiles(fanza_id)`, args: [] },
    ], 'write');
    console.log('テーブル作成完了');

    // ---- データ読み込み ----
    const fanzaProfiles  = load('actress_profiles.json')  ?? {};
    const avwikiProfiles = load('avwiki_profiles.json')   ?? {};
    const agencyProfiles = load('agency_profiles.json')   ?? {};
    const aliasesData    = load('actress_aliases.json')   ?? [];
    const augmented      = new Set(load('augmented_actresses.json') ?? []);

    // alias → canonical_name マップ
    const aliasToCanon = new Map();
    for (const group of aliasesData) {
        const canon = group[0];
        for (const alias of group) aliasToCanon.set(alias, canon);
    }

    // 全女優名を収集
    const allNames = new Set([
        ...Object.keys(fanzaProfiles).filter(k => !k.startsWith('NOT_FOUND_')),
        ...Object.keys(avwikiProfiles).filter(k => !avwikiProfiles[k]?.not_found && !avwikiProfiles[k]?.error),
    ]);

    // エイリアスの canonical_name も追加
    for (const [, canon] of aliasToCanon) allNames.add(canon);

    console.log(`対象女優数: ${allNames.size}`);

    // ---- actress_profiles upsert ----
    const names = [...allNames];
    let inserted = 0;
    for (let i = 0; i < names.length; i += BATCH) {
        const batch = names.slice(i, i + BATCH);
        await db.batch(batch.map(name => {
            const f = fanzaProfiles[name];
            const a = avwikiProfiles[name];
            const g = agencyProfiles[name] ?? agencyProfiles[name?.replace(/\s+/g, '')];

            // SNS: agency > avwiki > fanza (fanzaはSNS持たない)
            const twitter   = g?.twitter   ?? a?.twitter   ?? null;
            const instagram = g?.instagram ?? a?.instagram ?? null;
            const tiktok    = g?.tiktok    ?? a?.tiktok    ?? null;

            // 別名義
            const aliasSet = new Set();
            const group = aliasesData.find(gr => gr.includes(name));
            if (group) group.forEach(n => { if (n !== name) aliasSet.add(n); });
            if (a?.aliases) a.aliases.forEach(n => { if (n !== name) aliasSet.add(n); });

            return {
                sql: `INSERT OR REPLACE INTO actress_profiles
                    (name,fanza_id,ruby,height,bust,waist,hip,cup,birthday,blood_type,
                     hobby,prefectures,image_url,twitter,instagram,tiktok,
                     aliases,avwiki_url,agency_url,agency_source,augmented,updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                args: [
                    name,
                    f?.id          ?? null,
                    f?.ruby        ?? null,
                    parseInt(f?.height ?? a?.height) || null,
                    parseInt(f?.bust   ?? a?.bust)   || null,
                    parseInt(f?.waist  ?? a?.waist)  || null,
                    parseInt(f?.hip    ?? a?.hip)    || null,
                    f?.cup ?? a?.cup ?? null,
                    f?.birthday ?? null,
                    f?.blood_type ?? null,
                    f?.hobby ?? null,
                    f?.prefectures ?? null,
                    f?.image_url ?? null,
                    twitter,
                    instagram,
                    tiktok,
                    aliasSet.size > 0 ? JSON.stringify([...aliasSet]) : null,
                    a?.url ?? null,
                    g?.url ?? null,
                    g?.source ?? null,
                    augmented.has(name) ? 1 : 0,
                    new Date().toISOString(),
                ],
            };
        }), 'write');
        inserted += batch.length;
        process.stdout.write(`  actress_profiles: ${inserted}/${names.length}\r`);
    }
    console.log(`\n  actress_profiles: ${inserted} 件挿入完了`);

    // ---- actress_aliases upsert ----
    const aliasPairs = [...aliasToCanon.entries()].filter(([a, c]) => a !== c);
    let aliasInserted = 0;
    for (let i = 0; i < aliasPairs.length; i += BATCH) {
        const batch = aliasPairs.slice(i, i + BATCH);
        await db.batch(batch.map(([alias, canon]) => ({
            sql: `INSERT OR REPLACE INTO actress_aliases (alias, canonical_name) VALUES (?,?)`,
            args: [alias, canon],
        })), 'write');
        aliasInserted += batch.length;
    }
    console.log(`  actress_aliases: ${aliasInserted} 件挿入完了`);

    db.close();
    console.log('\n移行完了！');
}

main().catch(e => { console.error(e); process.exit(1); });
