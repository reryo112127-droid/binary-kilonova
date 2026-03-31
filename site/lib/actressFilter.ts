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

// 説明文形式かどうかを判定（女優名ではなくナンパ系の役名/説明文）
function looksLikeDescription(name: string): boolean {
    // 年齢パターン: 「23歳」「20歳」など
    if (/\d+歳/.test(name)) return true;
    // 括弧パターン: 【...】や（...）が含まれる
    if (/[【】（）\(\)]/.test(name)) return true;
    // 極端に長い名前（30文字超）は役名/説明文の可能性が高い
    if (name.length > 30) return true;
    return false;
}

export function filterActresses(actressesStr: string | null, genres: string | null, maker: string | null): string | null {
    if (!actressesStr) return null;

    const entries = actressesStr.split(/,|、/).map(s => s.trim()).filter(Boolean);

    // いずれかのエントリが説明文形式なら、素人作品とみなしてknown女優フィルターを適用
    const hasDescriptionEntry = entries.some(e => looksLikeDescription(e));
    const isAmateur = isAmateurWork(genres || '', maker || '') || hasDescriptionEntry;

    if (isAmateur) {
        const knownSet = getKnownActresses();
        const validActresses = entries.filter(a => knownSet.has(a));

        if (validActresses.length === 0) {
            return null;
        }
        return validActresses.join(', ');
    }

    // 素人作品以外（メーカー品）は、そのまま表示する
    return actressesStr;
}
