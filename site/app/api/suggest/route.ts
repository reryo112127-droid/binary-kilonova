import { NextRequest, NextResponse } from 'next/server';
import { readStaticCacheAsync } from '../../../lib/staticCache';

export const dynamic = 'force-dynamic';

type SuggestCache = {
    actresses: string[];
    makers: string[];
    labels: string[];
    genres: string[];
};

async function loadDataIfNeeded(): Promise<SuggestCache | null> {
    // suggest_cache.json はビルド時に生成される静的ファイル（Turso不要）
    const raw = await readStaticCacheAsync<SuggestCache>('suggest_cache.json');
    if (raw) return raw;
    return null;
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
