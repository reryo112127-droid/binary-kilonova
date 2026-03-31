import { NextResponse } from 'next/server';
import { getMgsClient, getFanzaClient } from '../../../../lib/turso';

export const dynamic = 'force-dynamic';

type Item = { name: string; count: number };
type Cache = { makers: Item[]; genres: Item[]; actresses: Item[] };

let cache: Cache | null = null;
let cacheAt = 0;
const CACHE_TTL = 5 * 60 * 1000;

export async function GET() {
    const now = Date.now();
    if (cache && now - cacheAt < CACHE_TTL) {
        return NextResponse.json(cache);
    }

    const mgsClient = getMgsClient();
    const fanzaClient = getFanzaClient();

    // ─── メーカー: GROUP BY でカウント ───────────────────────
    const [mgsMakerRows, fanzaMakerRows] = await Promise.all([
        mgsClient
            ? mgsClient.execute(
                "SELECT maker, COUNT(*) as cnt FROM products WHERE maker IS NOT NULL AND maker != '' GROUP BY maker ORDER BY cnt DESC LIMIT 300"
              ).then(r => r.rows).catch(() => [])
            : [],
        fanzaClient
            ? fanzaClient.execute(
                "SELECT CASE WHEN label IS NOT NULL AND label != '' AND label != '----' THEN label ELSE maker END as maker, COUNT(*) as cnt FROM products WHERE maker IS NOT NULL AND maker != '' GROUP BY maker ORDER BY cnt DESC LIMIT 300"
              ).then(r => r.rows).catch(() => [])
            : [],
    ]);

    const makerMap = new Map<string, number>();
    for (const row of mgsMakerRows) {
        const name = String(row.maker ?? '').trim();
        if (name) makerMap.set(name, (makerMap.get(name) ?? 0) + Number(row.cnt ?? 0));
    }
    for (const row of fanzaMakerRows) {
        const name = String(row.maker ?? '').trim();
        if (name) makerMap.set(name, (makerMap.get(name) ?? 0) + Number(row.cnt ?? 0));
    }
    const makers = Array.from(makerMap.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }));

    // ─── ジャンル・出演者: 文字列取得→JS分割 ─────────────────
    const SAMPLE = 15000;
    const [mgsGenreRows, fanzaGenreRows, mgsActressRows, fanzaActressRows] = await Promise.all([
        mgsClient
            ? mgsClient.execute(`SELECT genres FROM products WHERE genres IS NOT NULL LIMIT ${SAMPLE}`).then(r => r.rows).catch(() => [])
            : [],
        fanzaClient
            ? fanzaClient.execute(`SELECT genres FROM products WHERE genres IS NOT NULL LIMIT ${SAMPLE}`).then(r => r.rows).catch(() => [])
            : [],
        mgsClient
            ? mgsClient.execute(`SELECT actresses FROM products WHERE actresses IS NOT NULL LIMIT ${SAMPLE}`).then(r => r.rows).catch(() => [])
            : [],
        fanzaClient
            ? fanzaClient.execute(`SELECT actresses FROM products WHERE actresses IS NOT NULL LIMIT ${SAMPLE}`).then(r => r.rows).catch(() => [])
            : [],
    ]);

    const EXCLUDE_GENRES = new Set(['ゲイ', 'TS・男の娘', 'ニューハーフ']);

    const genreMap = new Map<string, number>();
    for (const row of [...mgsGenreRows, ...fanzaGenreRows]) {
        const g = String(row.genres ?? '');
        for (const genre of g.split(',').map(s => s.trim()).filter(Boolean)) {
            if (!EXCLUDE_GENRES.has(genre)) genreMap.set(genre, (genreMap.get(genre) ?? 0) + 1);
        }
    }
    const genres = Array.from(genreMap.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }));

    const actressMap = new Map<string, number>();
    for (const row of [...mgsActressRows, ...fanzaActressRows]) {
        const a = String(row.actresses ?? '');
        for (const actress of a.split(',').map(s => s.trim()).filter(Boolean)) {
            actressMap.set(actress, (actressMap.get(actress) ?? 0) + 1);
        }
    }
    const actresses = Array.from(actressMap.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }));

    cache = { makers, genres, actresses };
    cacheAt = now;

    return NextResponse.json(cache);
}
