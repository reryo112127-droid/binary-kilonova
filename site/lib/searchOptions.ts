import { getMgsClient, getFanzaClient } from './turso';

export type OptionItem = { name: string; count: number };
export type SearchOptions = { makers: OptionItem[]; genres: OptionItem[]; actresses: OptionItem[] };

export interface ContextualFilter {
    actress?: string;
    maker?: string;
    label?: string;
    genre?: string;
    q?: string;
    source?: string; // 'mgs' | 'fanza' | ''
}

let cache: SearchOptions | null = null;
let cacheAt = 0;
const CACHE_TTL = 5 * 60 * 1000;

const EXCLUDE_GENRES = new Set(['ゲイ', 'TS・男の娘', 'ニューハーフ']);

export async function getSearchOptions(): Promise<SearchOptions> {
    const now = Date.now();
    if (cache && now - cacheAt < CACHE_TTL) return cache;

    const mgsClient = getMgsClient();
    const fanzaClient = getFanzaClient();
    const SAMPLE = 15000;

    const [mgsMakerRows, fanzaMakerRows, mgsGenreRows, fanzaGenreRows, mgsActressRows, fanzaActressRows] =
        await Promise.all([
            mgsClient
                ? mgsClient.execute("SELECT maker, COUNT(*) as cnt FROM products WHERE maker IS NOT NULL AND maker != '' GROUP BY maker ORDER BY cnt DESC LIMIT 300").then(r => r.rows).catch(() => [])
                : [],
            fanzaClient
                ? fanzaClient.execute("SELECT CASE WHEN label IS NOT NULL AND label != '' AND label != '----' THEN label ELSE maker END as maker, COUNT(*) as cnt FROM products WHERE maker IS NOT NULL AND maker != '' GROUP BY maker ORDER BY cnt DESC LIMIT 300").then(r => r.rows).catch(() => [])
                : [],
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

    const makerMap = new Map<string, number>();
    for (const row of [...mgsMakerRows, ...fanzaMakerRows]) {
        const name = String((row as Record<string, unknown>).maker ?? '').trim();
        if (name) makerMap.set(name, (makerMap.get(name) ?? 0) + Number((row as Record<string, unknown>).cnt ?? 0));
    }
    const makers = Array.from(makerMap.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

    const genreMap = new Map<string, number>();
    for (const row of [...mgsGenreRows, ...fanzaGenreRows]) {
        const g = String((row as Record<string, unknown>).genres ?? '');
        for (const genre of g.split(',').map(s => s.trim()).filter(Boolean)) {
            if (!EXCLUDE_GENRES.has(genre)) genreMap.set(genre, (genreMap.get(genre) ?? 0) + 1);
        }
    }
    const genres = Array.from(genreMap.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

    const actressMap = new Map<string, number>();
    for (const row of [...mgsActressRows, ...fanzaActressRows]) {
        const a = String((row as Record<string, unknown>).actresses ?? '');
        for (const actress of a.split(',').map(s => s.trim()).filter(Boolean)) {
            actressMap.set(actress, (actressMap.get(actress) ?? 0) + 1);
        }
    }
    const actresses = Array.from(actressMap.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

    cache = { makers, genres, actresses };
    cacheAt = now;
    return cache;
}

/**
 * 現在の検索コンテキストに絞ったオプションを返す。
 * 例: actress で絞り込み中なら、その女優の作品にあるメーカー・ジャンル・共演女優のみ。
 */
export async function getContextualSearchOptions(filter: ContextualFilter): Promise<SearchOptions> {
    const mgsClient = getMgsClient();
    const fanzaClient = getFanzaClient();
    const LIMIT = 3000;

    // SQL条件とargsを構築
    function buildWhere(f: ContextualFilter): { where: string; args: string[] } {
        const conds: string[] = [];
        const args: string[] = [];
        if (f.actress) {
            conds.push("actresses LIKE ?");
            args.push(`%${f.actress}%`);
        }
        if (f.maker) {
            conds.push("(maker = ? OR label = ?)");
            args.push(f.maker, f.maker);
        } else if (f.label) {
            conds.push("label = ?");
            args.push(f.label);
        }
        if (f.genre) {
            for (const g of f.genre.split(',').map(s => s.trim()).filter(Boolean)) {
                conds.push("genres LIKE ?");
                args.push(`%${g}%`);
            }
        }
        if (f.q) {
            conds.push("(title LIKE ? OR actresses LIKE ?)");
            args.push(`%${f.q}%`, `%${f.q}%`);
        }
        return {
            where: conds.length ? `WHERE ${conds.join(' AND ')}` : '',
            args,
        };
    }

    const { where, args } = buildWhere(filter);
    const sql = `SELECT maker, label, genres, actresses FROM products ${where} LIMIT ${LIMIT}`;

    const useMgs   = !filter.source || filter.source === 'mgs';
    const useFanza = !filter.source || filter.source === 'fanza';

    const [mgsRows, fanzaRows] = await Promise.all([
        (useMgs && mgsClient)
            ? mgsClient.execute({ sql, args }).then(r => r.rows).catch(() => [])
            : [],
        (useFanza && fanzaClient)
            ? fanzaClient.execute({ sql, args }).then(r => r.rows).catch(() => [])
            : [],
    ]);

    const allRows = [...mgsRows, ...fanzaRows] as Record<string, unknown>[];

    const makerMap   = new Map<string, number>();
    const genreMap   = new Map<string, number>();
    const actressMap = new Map<string, number>();

    for (const row of allRows) {
        // メーカー（label優先）
        const lbl = String(row.label ?? '').trim();
        const mkr = String(row.maker ?? '').trim();
        const makerName = (lbl && lbl !== '----') ? lbl : mkr;
        if (makerName) makerMap.set(makerName, (makerMap.get(makerName) ?? 0) + 1);

        // ジャンル
        const g = String(row.genres ?? '');
        for (const genre of g.split(',').map(s => s.trim()).filter(Boolean)) {
            if (!EXCLUDE_GENRES.has(genre)) genreMap.set(genre, (genreMap.get(genre) ?? 0) + 1);
        }

        // 共演女優（絞り込み女優自身は除く）
        const a = String(row.actresses ?? '');
        for (const actress of a.split(',').map(s => s.trim()).filter(Boolean)) {
            if (filter.actress && actress === filter.actress) continue;
            actressMap.set(actress, (actressMap.get(actress) ?? 0) + 1);
        }
    }

    return {
        makers:   Array.from(makerMap.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
        genres:   Array.from(genreMap.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
        actresses: Array.from(actressMap.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    };
}
