/**
 * 「Xでフォロー」リンクを、見ているページの内容に合ったアカウントへ出し分ける。
 *
 * X はジャンル別に6アカウントで投稿している。サイトから来た人が、いま見ている作品と同じ系統の
 * 新着を追えるように、作品ページ・セール・ジャンルLP・特集でリンク先を切り替える（既定は新作）。
 * ハンドルは scripts/x_whoami.js が投稿用 Cookie で読み取った値（data/x_handles.json, 2026-10-08）。
 * 変わったら x_whoami.js を流し直してここを更新する。
 */
export type XGenre = 'new' | 'sale' | 'vr' | 'collab' | 'anon' | 'lady';

const X_ACCOUNTS: Record<XGenre, { handle: string; label: string }> = {
    new:    { handle: 'shinsakushirase', label: '新作情報' },
    sale:   { handle: 'salenoshirase',   label: 'セール情報' },
    vr:     { handle: 'oshiraseVR',      label: 'VR作品の情報' },
    collab: { handle: 'avencyclopedia',  label: '共演作の情報' },
    anon:   { handle: 'unKnownoshirase', label: '素人作品の情報' },
    lady:   { handle: 'VRnooshirase',    label: '人妻・熟女作品の情報' },
};

/** 共通フッターに入る既定（新作）のリンク。injectLayout の SITE_FOOTER から使う。 */
export function xFollowHtml(genre: XGenre = 'new'): string {
    const a = X_ACCOUNTS[genre];
    return `<a id="x-follow-link" class="inline-flex items-center gap-1.5 rounded-full bg-black text-white px-4 py-2 text-xs font-bold hover:opacity-80" `
        + `href="https://x.com/${a.handle}" target="_blank" rel="noopener">`
        + `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`
        + `${a.label}をXでフォロー（@${a.handle}）</a>`;
}

/** ページ内の「Xでフォロー」リンクを指定ジャンルのアカウントに差し替える。 */
export function setXFollow(html: string, genre: XGenre): string {
    if (genre === 'new') return html;
    return html.replace(/<a id="x-follow-link"[\s\S]*?<\/a>/g, () => xFollowHtml(genre));
}

/** ジャンル名（LPのスラッグ・作品の genres）から担当アカウントを決める。 */
export function xGenreOfGenres(genres: string): XGenre | null {
    if (/VR/.test(genres)) return 'vr';
    if (/素人/.test(genres)) return 'anon';
    if (/人妻|熟女|お母さん/.test(genres)) return 'lady';
    return null;
}

/** 作品ページ用: VR → セール中 → 素人 → 人妻・熟女 → 複数出演 → 新作 の順で決める。 */
export function xGenreOfProduct(p: Record<string, unknown>, castCount: number): XGenre {
    const genres = String(p.genres || '');
    if (/VR/.test(genres)) return 'vr';
    if (Number(p.discount_pct) > 0) return 'sale';
    const g = xGenreOfGenres(genres);
    if (g) return g;
    if (castCount >= 2) return 'collab';
    return 'new';
}

/** 特集ページ用（slug から） */
export function xGenreOfFeature(slug: string): XGenre {
    if (slug === 'sale-high-rated' || slug === 'cheaper-fanza-or-mgs' || slug === 'long-and-cheap') return 'sale';
    if (slug.startsWith('new-')) return xGenreOfGenres(slug) ?? 'new';
    return 'new';
}
