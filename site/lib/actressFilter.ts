// 素人作品かどうかの判定や、女優名フィルタリングを行うユーティリティ
// 実在女優のホワイトリストはビルド時に静的importしてバンドルに含める
// （Cloudflare Workers では fs が使えないため。生成: scripts/build_actress_whitelist.js）
import whitelistNames from '../data/actress_whitelist.json';

// 名前正規化（前後trim + 内部空白除去）。whitelist側も同じ正規化で生成済み。
function normName(s: string): string {
    return String(s || '').trim().replace(/\s+/g, '');
}

let knownActresses: Set<string> | null = null;
function getKnownActresses(): Set<string> {
    if (knownActresses) return knownActresses;
    knownActresses = new Set<string>(whitelistNames as string[]);
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
    // 年月パターン: 「2024年1月」など（seesaawiki月別ページの誤スクレイプ対策）
    if (/\d{4}年\d+月/.test(name)) return true;
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

    // 別名「澤村レイコ（高坂保奈美、高坂ますみ）」内のカンマで分割しないよう、括弧内を一時退避してから分割
    const protectedStr = actressesStr.replace(/（[^）]*）/g, m => m.replace(/[,、]/g, ' '));
    // ＊＊＊（avwikiの出演者不明プレースホルダ）は除去
    const entries = protectedStr.split(/[,、]/).map(s => s.trim()).filter(Boolean)
        .filter(e => !/^[＊*]+$/.test(e));
    if (entries.length === 0) return null;

    // いずれかのエントリが説明文形式なら、素人作品とみなしてknown女優フィルターを適用
    const hasDescriptionEntry = entries.some(e => looksLikeDescription(e));
    const isAmateur = isAmateurWork(genres || '', maker || '') || hasDescriptionEntry;

    if (isAmateur) {
        // 素人作品は役名/通称が混入しやすいため、実在女優ホワイトリストに載っている名前のみ採用。
        // （avwikiで特定された名前もホワイトリストに含めてあるので残る）
        const knownSet = getKnownActresses();
        const processed = entries
            .map(entry => entry.replace(/（[^）]*）|\([^)]*\)/g, '')) // 別名/年号の括弧を外して照合（「矢野ありさ（2016）」等）
            .filter(entry => knownSet.has(normName(entry)));

        if (processed.length === 0) return null;
        return [...new Set(processed)].join(', ');
    }

    // 素人作品以外（メーカー品）は、そのまま表示する（＊が無ければ原文、有れば＊除去済みで再構成）
    if (!/[＊*]/.test(actressesStr)) return actressesStr;
    return entries.join(', ');
}
