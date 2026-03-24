import { NextRequest, NextResponse } from 'next/server';
import { getFanzaClient } from '../../../lib/turso';

export const dynamic = 'force-dynamic';

type SuggestCache = {
    actresses: string[];
    makers: string[];
    labels: string[];
    genres: string[];
};

// インメモリキャッシュ（最大5分）
let cachedData: SuggestCache | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadDataIfNeeded(): Promise<SuggestCache | null> {
    const now = Date.now();
    if (cachedData && now - cacheLoadedAt < CACHE_TTL_MS) return cachedData;

    const db = getFanzaClient();
    if (!db) {
        console.warn('[Suggest API] Turso接続情報がありません');
        return cachedData; // 古いキャッシュをフォールバック
    }

    try {
        const row = await db.execute("SELECT data FROM suggest_cache WHERE key = 'main'")
            .then(r => r.rows[0]).catch(() => null);
        if (!row?.data) {
            console.warn('[Suggest API] suggest_cache テーブルにデータがありません');
            return cachedData;
        }
        const raw = JSON.parse(String(row.data)) as SuggestCache & { generated_at?: string };
        cachedData = {
            actresses: raw.actresses || [],
            makers:    raw.makers    || [],
            labels:    raw.labels    || [],
            genres:    raw.genres    || [],
        };
        cacheLoadedAt = now;
        console.log(`[Suggest API] キャッシュ読み込み完了: 女優${cachedData.actresses.length} / メーカー${cachedData.makers.length}`);
    } catch (e) {
        console.error('[Suggest API] キャッシュ読み込みエラー:', e);
    }
    return cachedData;
}

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q');

    if (!q || q.trim().length === 0) {
        return NextResponse.json({ actresses: [], makers: [], labels: [], genres: [] });
    }

    const data = await loadDataIfNeeded();

    if (!data) {
        return NextResponse.json({ error: 'Data not loaded' }, { status: 500 });
    }

    const keyword = q.trim().toLowerCase();
    const isMatch = (item: string) => item.toLowerCase().includes(keyword);

    const matchedActresses = data.actresses.filter(isMatch);
    const matchedMakers = data.makers.filter(isMatch);
    const matchedLabels = data.labels.filter(isMatch);
    const matchedGenres = data.genres.filter(isMatch);

    let remaining = 5;
    const resItems = { actresses: [] as string[], makers: [] as string[], labels: [] as string[], genres: [] as string[] };

    const takeEntries = (arr: string[], key: keyof typeof resItems) => {
        const chunk = arr.slice(0, remaining);
        resItems[key] = chunk;
        remaining -= chunk.length;
    };

    takeEntries(matchedActresses, 'actresses');
    if (remaining > 0) takeEntries(matchedMakers, 'makers');
    if (remaining > 0) takeEntries(matchedLabels, 'labels');
    if (remaining > 0) takeEntries(matchedGenres, 'genres');

    return NextResponse.json(resItems);
}
