// 素人作品かどうかの判定や、女優名フィルタリングを行うユーティリティ

import fs from 'fs';
import path from 'path';

let knownActresses: Set<string> | null = null;

function getKnownActresses(): Set<string> {
    if (knownActresses) return knownActresses;
    knownActresses = new Set<string>();
    try {
        const filePath = path.join(process.cwd(), 'data', 'actresses_all.json');
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            data.forEach((a: any) => knownActresses!.add(a.name));
        }

        const aliasPath = path.join(process.cwd(), 'data', 'actress_aliases.json');
        if (fs.existsSync(aliasPath)) {
            const aliases = JSON.parse(fs.readFileSync(aliasPath, 'utf-8'));
            aliases.forEach((group: string[]) => {
                group.forEach(name => knownActresses!.add(name));
            });
        }
    } catch (e) {
        console.error('Failed to load known actresses', e);
    }
    return knownActresses;
}

export function isAmateurWork(genres: string, maker: string): boolean {
    if (!genres && !maker) return false;
    const g = genres || '';
    const m = maker || '';
    // 素人作品と判定されるキーワード（汎用）
    if (g.includes('素人') || g.includes('アマチュア') || g.includes('ナンパ') || g.includes('ハメ撮り')) return true;
    if (m.includes('素人') || m.includes('LUXURY TV') || m.includes('プレステージプレミアム')) return true;
    return false;
}

export function filterActresses(actressesStr: string | null, genres: string | null, maker: string | null): string | null {
    if (!actressesStr) return null;

    const isAmateur = isAmateurWork(genres || '', maker || '');

    // 素人作品の場合のみ、DBに登録された名前が「役名か実女優か」をチェック
    if (isAmateur) {
        const knownSet = getKnownActresses();
        // 複数人の場合はカンマ区切りなどを分割
        const ds = actressesStr.split(/,|、/).map(s => s.trim()).filter(Boolean);
        const validActresses = ds.filter(a => knownSet.has(a));

        if (validActresses.length === 0) {
            // 素人作品で、かつ辞書に載っている女優がいなければ役名とみなして消す
            return null;
        }
        return validActresses.join(', ');
    }

    // 素人作品以外（メーカー品）は、あえてそのまま表示する
    return actressesStr;
}
