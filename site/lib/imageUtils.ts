/**
 * 作品のポスター画像URL（縦型）を返す
 * MGS: pb_e_ → pf_o1_（縦型パッケージ）
 * FANZA: pl.jpg はそのまま（横長のみ）
 */
export function getPosterImageUrl(url: string | undefined | null): string {
    if (!url) return '';
    // MGS: pb_e_XXX.jpg → pf_o1_XXX.jpg
    if (url.includes('pb_e_')) return url.replace('pb_e_', 'pf_o1_');
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
