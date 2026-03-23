import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

type SuggestCache = {
    actresses: string[];
    makers: string[];
    labels: string[];
    genres: string[];
};

// インメモリキャッシュ（サーバー起動中は維持）
let cachedData: SuggestCache | null = null;

function loadDataIfNeeded() {
    if (cachedData) return;

    const cachePath = path.join(process.cwd(), 'data', 'suggest_cache.json');
    if (!fs.existsSync(cachePath)) {
        console.warn('[Suggest API] suggest_cache.json が見つかりません。build_suggest_cache.js を実行してください。');
        return;
    }

    try {
        const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as SuggestCache & { generated_at?: string };
        cachedData = {
            actresses: raw.actresses || [],
            makers:    raw.makers    || [],
            labels:    raw.labels    || [],
            genres:    raw.genres    || [],
        };
        console.log(`[Suggest API] キャッシュ読み込み完了: 女優${cachedData.actresses.length} / メーカー${cachedData.makers.length}`);
    } catch (e) {
        console.error('[Suggest API] キャッシュ読み込みエラー:', e);
    }
}

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q');

    if (!q || q.trim().length === 0) {
        return NextResponse.json({ actresses: [], makers: [], labels: [], genres: [] });
    }

    loadDataIfNeeded();

    if (!cachedData) {
        return NextResponse.json({ error: 'Data not loaded' }, { status: 500 });
    }

    const keyword = q.trim().toLowerCase();
    const isMatch = (item: string) => item.toLowerCase().includes(keyword);

    const matchedActresses = cachedData.actresses.filter(isMatch);
    const matchedMakers = cachedData.makers.filter(isMatch);
    const matchedLabels = cachedData.labels.filter(isMatch);
    const matchedGenres = cachedData.genres.filter(isMatch);

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
