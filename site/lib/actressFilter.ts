// 素人作品かどうかの判定や、女優名フィルタリングを行うユーティリティ
// NOTE: fs/path は Cloudflare Workers で使用不可のため動的 require + try-catch で囲む

let knownActresses: Set<string> | null = null;

function getKnownActresses(): Set<string> {
    if (knownActresses) return knownActresses;
    knownActresses = new Set<string>();
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs') as typeof import('fs');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const path = require('path') as typeof import('path');
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
        // Cloudflare Workers など fs が使えない環境では空セットで続行
        if (process.env.NODE_ENV !== 'production') {
            console.error('Failed to load known actresses', e);
        }
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
    // 括弧パターン: 【...】や ASCII () — ※全角（）は女優の別名表記（例: Nia（伊東める））に使われるため除外
    if (/[【】\(\)]/.test(name)) return true;
    // 極端に長い名前（30文字超）は役名/説明文の可能性が高い
    if (name.length > 30) return true;
    // スペースを含む → 「名前 職業」「名前 年齢 説明」形式（AV女優名にスペースは通常入らない）
    if (/\s/.test(name.trim())) return true;
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
        const processed = entries.map(entry => {
            // known女優はそのまま
            if (knownSet.has(entry)) return entry;
            // 説明文形式（役名・年齢・職業など）→ 特定できないためnull
            if (looksLikeDescription(entry)) return null;
            // クリーンな名前（説明なし）はそのまま表示
            return entry;
        }).filter((a): a is string => !!a);

        if (processed.length === 0) return null;
        return processed.join(', ');
    }

    // 素人作品以外（メーカー品）は、そのまま表示する
    return actressesStr;
}
