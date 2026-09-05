/**
 * 「BEST/総集編を除く」フィルタの共通定義。
 *
 * 以前は各APIが個別に `title NOT LIKE '%BEST%' …` ＋ **`duration_min <= 200`** を組み立てていた。
 * この「200分を超えたら総集編とみなす」ルールが過剰で、HUNTB・マジックミラー便・企画ものなど
 * 200〜400分の**通常作品を大量に隠していた**:
 *   - 成瀬葵: 54件 → 33件（消えた21件はすべて尺だけが理由。BESTタイトルは0件）
 *   - メーカー「オフサイド」: FANZAと同じ76件をD1に持っているのに、200分超46件が消えて30件表示
 *   - 三上悠亜: 329件 → 126件
 * さらに、この条件を付ける経路（検索バー・詳細検索・LP）と付けない経路（女優ページ）が混在し、
 * 同じ女優でも入口によって件数が食い違っていた。
 *
 * 実データ（直近90日のFANZA 6,695件）で見直した結果:
 *   200分超 935件 / 400分超 219件 / 480分超 163件
 *   480分(8時間)を超える作品は「49本番」「80連発」「31名」など明確な総集編だけだった。
 *   オフサイドの作品は400分超が0件＝閾値を上げれば通常作品は隠れない。
 * → 閾値を 480分 に緩和し、総集編に特有の語（福袋/詰め合わせ/コンプリート/枚組）を追加した。
 *
 * 入口ごとの食い違いを消すため、この条件は次の全経路で同じものを使う:
 *   - /api/products（検索バー・詳細検索・LP・一覧）
 *   - /api/ranking（MGS/FANZA 両方）
 *   - lib/ssrFetch（ホーム・ランキングのSSR）
 *   - /actress/[name]（excludeBest=1 を送る）
 *   - scripts/generate-weekly-cache.mjs の actress_top/extended_products.json
 *     （/api/products の女優クエリはこの静的キャッシュに当たることがあるため同じ条件で作る）
 */

/** これを超える尺は単体作品ではなく総集編／福袋とみなす（8時間） */
export const COMPILATION_MAX_MIN = 480;

/** タイトルで総集編と判別するパターン（SQLite の LIKE はASCII大小を区別しない） */
export const BEST_TITLE_PATTERNS = [
    '%BEST%', '%ベスト%', '%総集編%', '%コレクション%',
    '%福袋%', '%詰め合わせ%', '%コンプリート%', '%枚組%',
];

/**
 * BEST/総集編かどうかの JS 判定（静的キャッシュ上のフィルタ用）。
 * SQL 版 bestExclusionSql と同じパターン・同じ閾値を使う。
 */
export function isBestOrCompilation(title: unknown, durationMin?: unknown): boolean {
    const t = String(title ?? '').toUpperCase();
    for (const p of BEST_TITLE_PATTERNS) {
        const word = p.replace(/%/g, '').toUpperCase();
        if (word && t.includes(word)) return true;
    }
    const d = Number(durationMin);
    return Number.isFinite(d) && d > COMPILATION_MAX_MIN;
}

/**
 * BEST/総集編除外の WHERE 条件を組み立てる。
 * @param opts.skipDuration 予約作品など尺が未確定のときは true（尺条件を付けない）
 */
export function bestExclusionSql(opts: { skipDuration?: boolean } = {}): { conds: string[]; args: string[] } {
    const conds: string[] = [];
    const args: string[] = [];
    for (const p of BEST_TITLE_PATTERNS) {
        conds.push('title NOT LIKE ?');
        args.push(p);
    }
    if (!opts.skipDuration) {
        conds.push(`(duration_min IS NULL OR duration_min <= ${COMPILATION_MAX_MIN})`);
    }
    return { conds, args };
}
