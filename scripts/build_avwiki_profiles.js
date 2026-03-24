#!/usr/bin/env node
/**
 * avwiki_full.jsonl → Turso actress_profiles テーブルに反映
 * スクレイプ結果をTursoに保存することでVercel再デプロイ不要で即時反映される
 */

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const JSONL_FILE = path.join(__dirname, '../data/avwiki_full.jsonl');
const BATCH = 100;

async function main() {
    if (!fs.existsSync(JSONL_FILE)) {
        console.error('avwiki_full.jsonl が見つかりません');
        process.exit(1);
    }

    const url   = process.env.TURSO_FANZA_URL;
    const token = process.env.TURSO_FANZA_TOKEN;
    if (!url || !token) {
        console.error('TURSO_FANZA_URL/TOKEN が未設定');
        process.exit(1);
    }

    const db = createClient({ url, authToken: token });

    const lines = fs.readFileSync(JSONL_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    console.log(`avwiki_full.jsonl: ${lines.length} 件読み込み`);

    const entries = [];
    for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.name) entries.push(entry);
    }

    let updated = 0;
    for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH);
        await db.batch(batch.map(entry => ({
            sql: `INSERT INTO actress_profiles (name,avwiki_url,height,bust,waist,hip,cup,twitter,instagram,tiktok,aliases,updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                  ON CONFLICT(name) DO UPDATE SET
                    avwiki_url = excluded.avwiki_url,
                    height     = COALESCE(actress_profiles.height,     excluded.height),
                    bust       = COALESCE(actress_profiles.bust,       excluded.bust),
                    waist      = COALESCE(actress_profiles.waist,      excluded.waist),
                    hip        = COALESCE(actress_profiles.hip,        excluded.hip),
                    cup        = COALESCE(actress_profiles.cup,        excluded.cup),
                    twitter    = COALESCE(actress_profiles.twitter,    excluded.twitter),
                    instagram  = COALESCE(actress_profiles.instagram,  excluded.instagram),
                    tiktok     = COALESCE(actress_profiles.tiktok,     excluded.tiktok),
                    aliases    = COALESCE(actress_profiles.aliases,    excluded.aliases),
                    updated_at = excluded.updated_at`,
            args: [
                entry.name,
                entry.url       ?? null,
                parseInt(entry.height) || null,
                parseInt(entry.bust)   || null,
                parseInt(entry.waist)  || null,
                parseInt(entry.hip)    || null,
                entry.cup       ?? null,
                entry.twitter   ?? null,
                entry.instagram ?? null,
                entry.tiktok    ?? null,
                entry.aliases?.length > 0 ? JSON.stringify(entry.aliases) : null,
                new Date().toISOString(),
            ],
        })), 'write');
        updated += batch.length;
        process.stdout.write(`  Turso更新: ${updated}/${entries.length}\r`);
    }

    // 別名義も actress_aliases に登録
    const aliasPairs = [];
    for (const entry of entries) {
        if (Array.isArray(entry.aliases)) {
            for (const alias of entry.aliases) {
                if (alias !== entry.name) aliasPairs.push([alias, entry.name]);
            }
        }
    }
    for (let i = 0; i < aliasPairs.length; i += BATCH) {
        const batch = aliasPairs.slice(i, i + BATCH);
        await db.batch(batch.map(([alias, canon]) => ({
            sql: `INSERT OR IGNORE INTO actress_aliases (alias, canonical_name) VALUES (?,?)`,
            args: [alias, canon],
        })), 'write');
    }

    db.close();
    console.log(`\nTurso更新完了: ${updated}件 / 別名義: ${aliasPairs.length}件`);
}

main().catch(e => { console.error(e); process.exit(1); });
