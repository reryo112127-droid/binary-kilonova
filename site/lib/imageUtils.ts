/**
 * 作品のポスター画像URL（縦型）を返す
 * MGS: pb_e_ → pf_e_（縦型パッケージ表面 421×600）
 * FANZA: pl.jpg はそのまま使用（CSS aspect-ratio + object-cover でセンタークロップ）
 */
export function getPosterImageUrl(url: string | undefined | null): string {
    if (!url) return '';
    // MGS: pb_e_XXX.jpg → pf_e_XXX.jpg（縦型高画質 421×600）
    if (url.includes('pb_e_')) return url.replace('pb_e_', 'pf_e_');
    // FANZA: pl.jpg（800×538）をそのまま返す。CSS側で縦型コンテナにクロップ
    return url;
}

/**
 * 作品のパッケージ画像URL（横長）を返す
 * 両DBとも main_image_url がそのまま横長パッケージ
 */
export function getPackageImageUrl(url: string | undefined | null): string {
    return url ?? '';
}

/**
 * ソース判定
 */
export function isMgsUrl(url: string | undefined | null): boolean {
    return !!url && url.includes('mgstage.com');
}
