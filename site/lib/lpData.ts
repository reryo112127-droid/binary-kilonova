// 長尾LP用のスラッグ検証・一覧データ(週次生成の静的キャッシュをASSETSから読む)。
// genres_cache.json / series_cache.json / makers_cache.json は generate-weekly-cache.mjs が生成。
import { readStaticCacheAsync as readStaticCache } from './staticCache';

export type NamedCount = { name: string; count: number };
export type MakerEntry = { name: string; count: number; floor?: string; sources?: string[]; is_label?: boolean };

// カップは固定集合(actress_profiles.json 経由で /api/products?cup= が解決)
export const CUPS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'];

export async function loadGenres(): Promise<NamedCount[]> {
    return (await readStaticCache<NamedCount[]>('genres_cache.json')) || [];
}
export async function loadSeries(): Promise<NamedCount[]> {
    return (await readStaticCache<NamedCount[]>('series_cache.json')) || [];
}
export async function loadMakers(): Promise<MakerEntry[]> {
    return (await readStaticCache<MakerEntry[]>('makers_cache.json')) || [];
}

export async function findGenre(name: string): Promise<NamedCount | null> {
    return (await loadGenres()).find(g => g.name === name) || null;
}
export async function findSeries(name: string): Promise<NamedCount | null> {
    return (await loadSeries()).find(s => s.name === name) || null;
}
export async function findMaker(name: string): Promise<MakerEntry | null> {
    return (await loadMakers()).find(m => m.name === name) || null;
}
export function isValidCup(letter: string): boolean {
    return CUPS.includes(String(letter || '').toUpperCase());
}
