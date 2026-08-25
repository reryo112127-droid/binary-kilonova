/**
 * 女優ページ(SSR)用のプロフィール取得と描画。
 *
 * 供給源は /api/actress/[name] と同じ actress_display/<nn>.json シャード(1ファイル0.4MB以下)。
 * 60,103人ぶんの身長/スリーサイズ/カップ/誕生日/出身地/別名を持つので、これを生HTMLに出すことで
 * 「作品カードだけの薄いページ」を実データのあるページにする(索引率・長尾クエリ対策)。
 * 集約ファイル(actress_profiles.json)はフィルタ用に痩せさせてあるのでここでは使わない。
 */
import { readStaticCacheAsync as readStaticCache } from './staticCache';
import { actressShardFile } from './actressShard';

export type ActressProfile = {
    name?: string | null;
    ruby?: string | null;
    height?: number | string | null;
    bust?: number | string | null;
    waist?: number | string | null;
    hip?: number | string | null;
    cup?: string | null;
    birthday?: string | null;
    blood_type?: string | null;
    hobby?: string | null;
    prefectures?: string | null;
    image_url?: string | null;
    aliases?: string[] | null;
    retired?: boolean | null;
};

type ShardMap = Record<string, ActressProfile>;

/** 名前(別名可)からプロフィールを引く。見つからなければ null。 */
export async function fetchActressProfile(name: string): Promise<ActressProfile | null> {
    const noSpace = name.replace(/\s+/g, '');
    try {
        const primary = await readStaticCache<ShardMap>(actressShardFile(name));
        const direct = primary?.[name];
        if (direct) return direct;

        if (noSpace !== name) {
            const secondary = await readStaticCache<ShardMap>(actressShardFile(noSpace));
            const hit = secondary?.[noSpace];
            if (hit) return hit;
        }

        // 別名 → 正規名(0.13MBの逆引きインデックス)
        const aliasIndex = await readStaticCache<Record<string, string>>('actress_display_alias_index.json');
        const canonical = aliasIndex?.[name] ?? aliasIndex?.[noSpace];
        if (canonical) return (await readStaticCache<ShardMap>(actressShardFile(canonical)))?.[canonical] ?? null;
    } catch { /* プロフィールは無くてもページは成立する */ }
    return null;
}

const num = (v: unknown): number | null => {
    const n = parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
};

export function calcAge(birthday: string): number | null {
    const d = new Date(birthday);
    if (Number.isNaN(d.getTime())) return null;
    const t = new Date();
    let a = t.getFullYear() - d.getFullYear();
    if (t.getMonth() < d.getMonth() || (t.getMonth() === d.getMonth() && t.getDate() < d.getDate())) a--;
    return a >= 0 && a < 100 ? a : null;
};

/** 表示できる項目を [ラベル, 値] で返す(空はすべて落とす) */
export function profileRows(p: ActressProfile | null): [string, string][] {
    if (!p) return [];
    const rows: [string, string][] = [];
    const height = num(p.height), bust = num(p.bust), waist = num(p.waist), hip = num(p.hip);
    if (height) rows.push(['身長', `${height}cm`]);
    if (bust && waist && hip) rows.push(['スリーサイズ', `B${bust} / W${waist} / H${hip}`]);
    if (p.cup && /^[A-Za-z]$/.test(String(p.cup).trim())) rows.push(['カップ', `${String(p.cup).trim().toUpperCase()}カップ`]);
    if (p.birthday) {
        const age = calcAge(p.birthday);
        rows.push(['生年月日', `${p.birthday}${age !== null ? `（${age}歳）` : ''}`]);
    }
    if (p.blood_type) rows.push(['血液型', `${String(p.blood_type).replace(/型$/, '')}型`]);
    if (p.prefectures) rows.push(['出身', String(p.prefectures)]);
    if (p.hobby) rows.push(['趣味', String(p.hobby)]);
    return rows;
}

/** description に足す短い属性文（例: 「T160・Dカップ・東京都出身。」）。無ければ空文字。 */
export function profileSummary(p: ActressProfile | null): string {
    if (!p) return '';
    const parts: string[] = [];
    const height = num(p.height);
    if (height) parts.push(`T${height}`);
    if (p.cup && /^[A-Za-z]$/.test(String(p.cup).trim())) parts.push(`${String(p.cup).trim().toUpperCase()}カップ`);
    if (p.prefectures) parts.push(`${String(p.prefectures)}出身`);
    return parts.length ? `${parts.join('・')}。` : '';
}

/** 可視プロフィール表(索引テキスト)。プロフィールが無ければ空文字。 */
export function profileHtml(name: string, p: ActressProfile | null, esc: (s: string) => string): string {
    const rows = profileRows(p);
    const aliases = (p?.aliases ?? []).filter(a => a && a !== name).slice(0, 6);
    if (!rows.length && !aliases.length) return '';

    const cells = rows.map(([k, v]) =>
        `<div class="flex gap-2 py-1"><dt class="w-20 shrink-0 text-slate-400">${esc(k)}</dt>`
        + `<dd class="font-medium text-slate-700 dark:text-slate-200">${esc(v)}</dd></div>`).join('');
    const aliasHtml = aliases.length
        ? `<div class="flex gap-2 py-1"><dt class="w-20 shrink-0 text-slate-400">別名</dt><dd class="font-medium text-slate-700 dark:text-slate-200">`
          + aliases.map(a => `<a class="underline decoration-dotted hover:text-primary" href="/actress/${encodeURIComponent(a)}">${esc(a)}</a>`).join('、')
          + `</dd></div>`
        : '';

    return `<section class="px-4 pt-3"><h2 class="text-sm font-bold mb-1 text-slate-700 dark:text-slate-300">${esc(name)}のプロフィール</h2>`
        + `<dl class="text-xs leading-relaxed">${cells}${aliasHtml}</dl></section>`;
}
