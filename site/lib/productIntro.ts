/**
 * 作品ページの「作品の見どころ」欄（サーバ側で生HTMLに出す独自の文章）。
 *
 * 作品ページは画像・タイトル・ボタンだけで本文がほぼ無く、Search Console で
 * 「クロール済み・未登録」が4,548件あった（2026-09-13）。D1 の同じ1行に入っている
 * 価格・レビュー・お気に入り数と、静的キャッシュの女優プロフィール・出演作・シリーズを
 * 組み合わせて、作品ごとに中身の違う文章を作る。追加の D1 読み取りは無い。
 *
 * 言い回しは品番のハッシュで選ぶ（同じ作品は毎回同じ文、作品間では揃わない）。
 */
import type { ActressProfile } from './actressProfile';
import { calcAge } from './actressProfile';

export type IntroInput = {
    id: string;
    product: Record<string, unknown>;
    /** 表示用に絞った実在女優（先頭が主演） */
    cast: string[];
    /** 主演女優のプロフィール（無ければ null） */
    leadProfile: ActressProfile | null;
    /** 主演女優の掲載作品（静的LPキャッシュ。上限60件・人気順） */
    leadWorks: { product_id: string }[] | null;
    /** 同じシリーズの掲載作品（上限60件・配信日の新しい順） */
    seriesWorks: { product_id: string }[] | null;
    /** 収録上限（これと同数なら「以上」と書く） */
    lpMax: number;
};

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function hash(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}
const pick = <T,>(arr: T[], seed: number, salt: number): T => arr[(seed + salt * 7919) % arr.length];

const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
};

/** '2024/01/05' / '2018-11-30 10:00:53' → '2024年1月5日' */
function jpDate(v: unknown): string {
    const m = String(v ?? '').match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : '';
}
function ymd(v: unknown): string {
    const m = String(v ?? '').match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}
function todayJst(): string {
    return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * ジャンル → 「こんな人におすすめ」の一言。
 * 掲載しないジャンル（未成年を連想させるもの・近親・盗撮など）はわざと入れていない。
 */
const GENRE_FOR: Record<string, string> = {
    '巨乳': '大きな胸の女優が好きな人',
    '美乳': '形のきれいな胸に惹かれる人',
    '貧乳・微乳': 'スレンダーで控えめな胸が好みの人',
    '美少女': '透明感のある可愛い系が好きな人',
    'スレンダー': '細身のスタイルが好みの人',
    '人妻・主婦': '大人の色気がある人妻ものが好きな人',
    '人妻': '大人の色気がある人妻ものが好きな人',
    '熟女': '落ち着いた年上女性の魅力を味わいたい人',
    'お姉さん': '年上のお姉さんに甘えたい人',
    'お母さん': '包容力のある年上女性が好きな人',
    '痴女': '女性にリードされたい人',
    'M男': '女性に責められるシチュエーションが好きな人',
    'ギャル': '明るくノリのいいギャルが好きな人',
    'OL': 'オフィスもののシチュエーションが好きな人',
    '女子大生': '等身大の大学生ものが好きな人',
    'キャバ嬢・風俗嬢': '夜のお店のシチュエーションが好きな人',
    '女教師': '先生ものの設定が好きな人',
    '看護婦・ナース': 'ナース服や病院ものが好きな人',
    'コスプレ': 'コスチュームものが好きな人',
    '制服': '制服姿にときめく人',
    '水着': '水着姿をじっくり見たい人',
    'パンスト・タイツ': 'パンスト・タイツに目がない人',
    '脚フェチ': '美脚を堪能したい人',
    '尻フェチ': 'お尻のラインに惹かれる人',
    '巨尻': '肉感的なお尻が好きな人',
    '美尻': '形のいいお尻が好きな人',
    'ぽっちゃり': 'むっちりした体型が好みの人',
    '中出し': '中出しシーンを重視する人',
    '潮吹き': '潮吹きシーンを見たい人',
    'アクメ・オーガズム': '女優が本気で感じる姿を見たい人',
    '騎乗位': '騎乗位のシーンが好きな人',
    'フェラ': 'フェラシーンを重視する人',
    'パイズリ': 'パイズリが好きな人',
    '手コキ': '手コキが好きな人',
    'キス・接吻': '濃厚なキスが見たい人',
    '淫語': '言葉責めにぞくっとする人',
    '主観': '自分がその場にいる感覚で見たい人',
    'VR専用': 'VRゴーグルで没入感を楽しみたい人',
    'ハイクオリティVR': '画質にこだわってVRを見たい人',
    '8KVR': '最高画質のVRを体験したい人',
    'ハメ撮り': '生々しいハメ撮りの臨場感が好きな人',
    '素人': '素人らしいリアルな反応が好きな人',
    'ナンパ': 'ナンパものの駆け引きが好きな人',
    'ドキュメンタリー': '素顔が見えるドキュメンタリー仕立てが好きな人',
    'ドラマ': 'ストーリーのある作品をじっくり見たい人',
    '寝取り・寝取られ・NTR': 'NTRの背徳感が好きな人',
    '不倫': '不倫ものの背徳感が好きな人',
    '3P・4P': '複数人のプレイが見たい人',
    '乱交': '大人数の乱交シーンが好きな人',
    'レズビアン': '女性同士の絡みが好きな人',
    '淫乱・ハード系': '激しめのプレイが好きな人',
    'イラマチオ': 'ハードなイラマチオが好きな人',
    '顔射': '顔射シーンを重視する人',
    'ぶっかけ': 'ぶっかけシーンが好きな人',
    'ごっくん': 'ごっくんシーンが好きな人',
    'SM': 'SMの主従関係に惹かれる人',
    '縛り・緊縛': '緊縛の美しさが好きな人',
    '拘束': '拘束プレイが好きな人',
    '羞恥': '恥じらう表情が好きな人',
    '辱め': '辱めのシチュエーションが好きな人',
    '野外・露出': '野外・露出のスリルが好きな人',
    'マッサージ・リフレ': 'マッサージものの設定が好きな人',
    'エステ': 'エステものの設定が好きな人',
    'ローション・オイル': 'ローション・オイルのぬるぬる感が好きな人',
    '電マ': '電マ責めが好きな人',
    'おもちゃ': 'おもちゃ責めが好きな人',
    'オナニー': '女優のオナニーシーンが見たい人',
    'パイパン': 'パイパンが好きな人',
    'アナル': 'アナルプレイが好きな人',
    'デカチン・巨根': '巨根ものが好きな人',
    '童貞': '筆おろしのシチュエーションが好きな人',
    'デビュー作品': '新人のデビュー作を追いかけたい人',
    'アイドル・芸能人': '芸能経験のある女優が好きな人',
};

/** 文章に使わないジャンル（形式・売り方の分類で中身を表さないもの） */
const SKIP_GENRE = new Set(['単体作品', '企画', '妄想族', 'その他フェチ', 'ミニ系', '職業色々', 'イメージビデオ', 'サンプル動画', 'ベスト・総集編']);
/** 画質・配信形態・販促の分類（MGS は「配信専用」「フルハイビジョン(FHD)」などを genres に入れている） */
const SKIP_GENRE_RE = /配信|ハイビジョン|FHD|HD|4K|独占|セール|期間限定|特典|DVD|Blu-?ray|アウトレット|ポイント/i;

export function buildIntroHtml(inp: IntroInput, isMobile: boolean): string {
    const { id, product: p, cast, leadProfile, leadWorks, seriesWorks, lpMax } = inp;
    const seed = hash(id.toLowerCase());
    const maker = String(p.maker || '').trim();
    // MGS の label は 'prestigepremium' のような英小文字のIDのことがあるので、それは出さない
    const rawLabel = String(p.label || '').trim();
    const label = /^[a-z0-9_]+$/.test(rawLabel) ? '' : rawLabel;
    const series = String(p.series_name || '').trim();
    const date = jpDate(p.release_date || p.sale_start_date);
    const dur = num(p.duration_min);
    const genres = String(p.genres || '').split(/[,、]/).map(s => s.trim()).filter(g => g && !SKIP_GENRE.has(g) && !SKIP_GENRE_RE.test(g));
    const isVr = genres.some(g => /VR/.test(g));
    const paras: string[] = [];

    // ① 概要
    {
        const who = maker
            ? `${esc(maker)}${label && label !== maker ? `（${esc(label)}レーベル）` : ''}`
            : '';
        let s = '';
        if (who && date) s = pick([`${who}が${date}に配信した`, `${date}に${who}から配信された`], seed, 1);
        else if (who) s = `${who}の`;
        else if (date) s = `${date}配信の`;
        s += dur ? `収録${dur}分の${isVr ? 'VR' : ''}作品です。` : `${isVr ? 'VR' : ''}作品です。`;
        if (dur && dur >= 240) s += pick(['4時間を超える大ボリュームで、腰を据えて楽しめます。', '長尺なので何回かに分けて見るのもおすすめです。'], seed, 2);
        else if (dur && dur >= 150) s += pick(['見応えのある長めの収録です。', '2時間半を超えるたっぷりした収録です。'], seed, 2);
        else if (dur && dur <= 60) s += '短めの収録なので、手軽に見られます。';
        paras.push(s);
    }

    // ② 出演者
    if (cast.length) {
        const lead = cast[0];
        const bits: string[] = [];
        const pr = leadProfile;
        if (pr) {
            const age = pr.birthday ? calcAge(String(pr.birthday)) : null;
            if (age && age >= 18) bits.push(`${age}歳`);
            const h = num(pr.height);
            if (h) bits.push(`身長${h}cm`);
            if (pr.cup) bits.push(`${esc(pr.cup)}カップ`);
            if (pr.prefectures) bits.push(`${esc(pr.prefectures)}出身`);
        }
        // 素人作品の出演者欄は「素人名義, 本人名」が並ぶことがあり、共演とは限らない
        const amateur = genres.includes('素人');
        let s = cast.length === 1
            ? `出演は<a class="text-primary hover:underline" href="/actress/${encodeURIComponent(lead)}">${esc(lead)}</a>${bits.length ? `（${bits.join('・')}）` : ''}の単独出演。`
            : amateur
            ? `出演者は${cast.slice(0, 4).map(n => `<a class="text-primary hover:underline" href="/actress/${encodeURIComponent(n)}">${esc(n)}</a>`).join('、')}です。`
            : `主演の<a class="text-primary hover:underline" href="/actress/${encodeURIComponent(lead)}">${esc(lead)}</a>${bits.length ? `（${bits.join('・')}）` : ''}に加えて、${cast.slice(1, 4).map(esc).join('、')}${cast.length > 4 ? `ほか計${cast.length}名` : ''}が共演しています。`;
        const n = leadWorks?.length ?? 0;
        if (n >= 2) {
            const idx = leadWorks!.findIndex(w => String(w.product_id).toLowerCase() === id.toLowerCase());
            s += n >= lpMax
                ? `${esc(lead)}は当サイトに${lpMax}作以上が掲載されている人気女優で、`
                : `${esc(lead)}の掲載作品は当サイトで${n}作あり、`;
            s += idx === 0 ? 'この作品はその中で人気No.1です。'
                : idx > 0 && idx < 10 ? `この作品は人気順で${idx + 1}番目です。`
                : 'ほかの出演作も下のおすすめ作品から見られます。';
        } else if (genres.includes('デビュー作品')) {
            s += 'デビュー作なので、初々しい姿が見られます。';
        }
        paras.push(s);
    }

    // ③ ジャンル（見どころ）
    const tagged = genres.slice(0, 4);
    if (tagged.length) {
        const q = tagged.map(g => `<a class="text-primary hover:underline" href="/genre/${encodeURIComponent(g)}">「${esc(g)}」</a>`);
        paras.push(pick([
            `内容は${q.join('')}が中心。`,
            `ジャンルは${q.join('')}。`,
            `${q.join('')}の要素がそろった作品です。`,
        ], seed, 3) + (isVr ? 'VRゴーグルで見ると、目の前で起きているような距離感を味わえます。' : ''));
    }

    // ④ 評価と価格（いずれも D1 の同じ行の値）
    {
        const out: string[] = [];
        const ra = num(p.review_average), rc = num(p.review_count);
        if (ra && rc) {
            const tone = rc < 5 ? 'まだ件数は少なめ' : ra >= 4.5 ? '非常に高い評価' : ra >= 4.0 ? '高めの評価' : ra >= 3.0 ? '平均的な評価' : '評価は分かれ気味';
            out.push(`FANZAのユーザーレビューは★${ra.toFixed(2)}（${rc}件）で${tone}です。`);
        }
        const wish = num(p.wish_count);
        if (wish && wish >= 50) out.push(`MGS動画では${wish.toLocaleString('ja-JP')}人がお気に入りに登録しています。`);
        const list = num(p.list_price), cur = num(p.current_price), pct = num(p.discount_pct);
        const end = ymd(p.sale_end_date);
        if (pct && cur && list && cur < list && (!end || end >= todayJst())) {
            out.push(`掲載時点で${pct}%オフの${cur.toLocaleString('ja-JP')}円（通常${list.toLocaleString('ja-JP')}円）${end ? `、セールは${jpDate(end)}まで` : ''}です。`);
        } else if (cur) {
            out.push(`価格は掲載時点で${cur.toLocaleString('ja-JP')}円からです。`);
        }
        if (out.length) paras.push(out.join(''));
    }

    // ⑤ シリーズ
    if (series && seriesWorks && seriesWorks.length >= 2) {
        const n = seriesWorks.length;
        paras.push(`<a class="text-primary hover:underline" href="/series/${encodeURIComponent(series)}">「${esc(series)}」</a>シリーズの1本で、同シリーズは当サイトに${n >= lpMax ? `${lpMax}作以上` : `${n}作`}あります。気に入ったら続けて見られます。`);
    }

    // こんな人におすすめ
    const fits: string[] = [];
    for (const g of genres) {
        const f = GENRE_FOR[g];
        if (f && !fits.includes(f)) fits.push(f);
        if (fits.length >= 3) break;
    }
    if (cast.length >= 2 && !genres.includes('素人') && fits.length < 4) fits.push('複数の女優の共演を楽しみたい人');
    if (cast.length === 1 && leadWorks && leadWorks.length >= 2 && fits.length < 4) fits.push(`${esc(cast[0])}のファン`);

    if (paras.length < 2 && !fits.length) return '';
    const box = isMobile
        ? 'px-4 py-5 border-t border-slate-100 dark:border-slate-800'
        : 'bg-white p-8 rounded-2xl border border-slate-100 shadow-sm';
    const h2 = isMobile ? 'text-lg font-bold mb-3' : 'text-xl font-black mb-4';
    const pc = isMobile
        ? 'text-sm leading-relaxed text-slate-700 dark:text-slate-300 mb-2'
        : 'text-[15px] leading-loose text-slate-700 mb-3';
    return `<section id="pd-intro" class="${box}">`
        + `<h2 class="${h2}">作品の見どころ</h2>`
        + paras.map(t => `<p class="${pc}">${t}</p>`).join('')
        + (fits.length
            ? `<h3 class="text-sm font-bold text-slate-500 dark:text-slate-400 mt-4 mb-2">こんな人におすすめ</h3>`
              + `<ul class="list-disc pl-5 space-y-1 ${isMobile ? 'text-sm' : 'text-[15px]'} text-slate-700 dark:text-slate-300">${fits.map(f => `<li>${f}</li>`).join('')}</ul>`
            : '')
        + `</section>`;
}
