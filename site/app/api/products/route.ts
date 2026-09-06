import { NextRequest, NextResponse } from 'next/server';
import { filterActresses } from '../../../lib/actressFilter';
import { getMgsClient, getFanzaClient } from '../../../lib/turso';
import { getCached, setCached } from '../../../lib/apiCache';
import { readStaticCacheAsync as readStaticCache, cacheHeaders } from '../../../lib/staticCache';
import { bestExclusionSql } from '../../../lib/bestFilter';
import { degradedProducts } from '../../../lib/degradedProducts';
import { readLpCards, LP_MAX_PER } from '../../../lib/lpCache';
import { isD1Blocked } from '../../../lib/d1Breaker';

export const dynamic = 'force-dynamic';

const PRODUCTS_TTL = 5 * 60 * 1000; // 5分

// セールページ・ホームで使用するメーカーホワイトリスト（FANZA限定）
// ['exact'|'like', value]
// exact: maker = ? OR label = ?  （完全一致 → 誤ヒット防止）
// like:  maker LIKE ? OR label LIKE ?  （部分一致 → DB登録名が長い場合）
const SALE_MAKERS_FANZA: [string, string][] = [
    ['like',  'エスワン'],       // DB: "エスワン ナンバーワンスタイル"
    ['exact', 'ムーディーズ'],
    ['exact', 'アイデアポケット'],
    ['exact', 'OPPAI'],
    ['exact', 'E-BODY'],
    ['exact', 'Fitch'],
    ['exact', 'マドンナ'],       // exact: マドンナモンロー を除外
    ['exact', '本中'],
    ['like',  'ダスッ'],         // DB: "ダスッ！"
    ['exact', 'kawaii'],
    ['exact', 'Hunter'],         // exact: LADY HUNTERS（桃太郎映像出版）を除外
    ['exact', 'ワンズファクトリー'],
    ['exact', 'SODクリエイト'],
    ['exact', 'FALENO'],         // exact: FALENO TUBE を除外
    ['exact', 'TAMEIKE'],
    ['like',  'million'],        // label: "million（ミリオン）"
    ['exact', 'プレミアム'],     // exact: プレミアム熟女/エマニエル を除外
    ['exact', 'DAHLIA'],
];

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const sort = searchParams.get('sort') || 'new';
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const limit = parseInt(searchParams.get('limit') || '20', 10);

    // Cloudflare Cache API — エッジでDBクエリ結果を共有キャッシュ
    const cfCache = typeof caches !== 'undefined' ? caches.default : null;
    let cfCacheKey: Request | null = null;
    if (cfCache) {
        const normUrl = new URL(request.url);
        const sorted = Array.from(normUrl.searchParams.entries())
            .sort(([a], [b]) => a.localeCompare(b));
        normUrl.search = new URLSearchParams(sorted).toString();
        cfCacheKey = new Request(normUrl.toString());
        const cfHit = await cfCache.match(cfCacheKey);
        if (cfHit) return cfHit as unknown as NextResponse;
    }

    // フィルターなし・offset=0 のみ静的JSONを使用（予約作品は常にTurso直接クエリ）
    const noFilter = sort !== 'pre-order'
        && !searchParams.get('q') && !searchParams.get('genre') && !searchParams.get('actress')
        && !searchParams.get('maker') && !searchParams.get('makers') && !searchParams.get('label') && !searchParams.get('exactMaker')
        && !searchParams.get('fromDate') && !searchParams.get('toDate') && !searchParams.get('source')
        && !searchParams.get('cup') && !searchParams.get('cups') && !searchParams.get('height')
        && !searchParams.get('vr') && !searchParams.get('series') && !searchParams.get('hasVideo')
        && !searchParams.get('excludeBest') && !searchParams.get('minDiscount')
        && !searchParams.get('ageMin') && !searchParams.get('ageMax')
        // 除外系も静的キャッシュには反映されていない（指定時に無視すると絞り込みが効かなくなる）
        && !searchParams.get('excludeGenres') && !searchParams.get('excludeLabel');

    // 女優別商品リストを静的JSONから返す（Tursoクエリ不要）
    // top_products(top200) → extended_products(~2000人) の順で検索
    // 女優キャッシュは1人ぶんのキーしか持たないため、複数女優(共演検索)では使わずD1へ落とす。
    const actressParam = (searchParams.get('actress') || '').includes(',')
        ? '' // 複数指定 → 静的キャッシュを使わない
        : (searchParams.get('actress') || '').trim();
    // excludeBest条件を外す: キャッシュはBEST除外済みデータを格納しているため
    if (
        actressParam && offset === 0 &&
        (sort === 'new' || sort === '') &&
        !searchParams.get('q') && !searchParams.get('genre') && !searchParams.get('maker') &&
        !searchParams.get('fromDate') && !searchParams.get('toDate') && !searchParams.get('source') &&
        !searchParams.get('vr') && !searchParams.get('hasVideo')
    ) {
        // extended は約19MBあり、パースするとisolateメモリ(128MB)を大きく削る。
        // top(2MB)で当たる女優のほうが多いので、外れたときだけ extended を読み込む。
        const topCache = await readStaticCache<Record<string, unknown[]>>('actress_top_products.json');
        const products = topCache?.[actressParam]
            ?? (await readStaticCache<Record<string, unknown[]>>('actress_extended_products.json'))?.[actressParam];
        // キャッシュ(actress_top/extended)は女優あたり最大20件程度に打ち切られているため、
        // 要求件数を満たせる場合のみキャッシュを返す。満たせない（=全作品を見たい）場合は
        // D1のFTSクエリ(軽量)にフォールスルーして出演作品をすべて取得する。
        if (products && products.length >= limit) {
            const page = products.slice(0, limit + 1);
            const res = NextResponse.json(page, { headers: { 'Content-Type': 'application/json', ...cacheHeaders(1800, 600) } });
            if (cfCache && cfCacheKey) {
                await cfCache.put(cfCacheKey, new Response(JSON.stringify(page), {
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' },
                }));
            }
            return res;
        }
    }

    if (noFilter) {
        const file = sort === 'wish_count' ? 'products_popular_cache.json'
                   : sort === 'new'        ? 'products_new_cache.json'
                   : sort === 'pre-order'  ? 'home_preorder_cache.json'
                   : null;
        if (file) {
            const cached = await readStaticCache<unknown[]>(file);
            if (cached && cached.length > 0) {
                // キャッシュから完全な1ページ分（limit件）が取得できる場合のみ返す。
                // 最終バッチなど limit 未満しか残っていない場合は Turso にフォールスルーして
                // hasMore 判定が正確に行われるようにする。
                if (offset + limit <= cached.length) {
                    const page = cached.slice(offset, offset + limit);
                    const res = NextResponse.json(
                        page,
                        { headers: { 'Content-Type': 'application/json', ...cacheHeaders(1800, 300) } }
                    );
                    // CF Cache API にも保存して次回 Turso クエリを防ぐ
                    if (cfCache && cfCacheKey) {
                        await cfCache.put(cfCacheKey, new Response(JSON.stringify(page), {
                            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' },
                        }));
                    }
                    return res;
                }
            }
        }
    }

    // セール: sort=discount, offset=0 → 静的キャッシュ（sourceなし時のみ。source指定時はDBから取得してsale_end_dateを含める）
    if (sort === 'discount' && offset === 0 && !searchParams.get('source')) {
        const saleCached = await readStaticCache<Array<Record<string, unknown>>>('sale_cache.json');
        if (saleCached && saleCached.length > 0) {
            // 終了済みセール(sale_end_date が過去)を除外。終了日不明(NULL)は進行中扱いで残す。
            // 古いキャッシュがデプロイされていても期限切れの高割引が先頭に居座らない＝自己修復。
            const today = new Date().toISOString().slice(0, 10);
            const notExpired = (p: Record<string, unknown>) => {
                const m = String(p.sale_end_date ?? '').match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
                return !m || `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` >= today;
            };
            const minD = parseInt(searchParams.get('minDiscount') || '0', 10);
            const filtered = saleCached.filter(p => notExpired(p) && (minD <= 0 || Number(p.discount_pct) >= minD));
            const page = filtered.slice(0, limit);
            const res = NextResponse.json(
                page,
                { headers: { 'Content-Type': 'application/json', ...cacheHeaders(1800, 300) } }
            );
            // CF Cache API にも保存
            if (cfCache && cfCacheKey) {
                await cfCache.put(cfCacheKey, new Response(JSON.stringify(page), {
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' },
                }));
            }
            return res;
        }
    }

    // ── 長尾LP(ジャンル/メーカー/シリーズ)は静的キャッシュから返す ────────────────
    // 実測(2026-09-04)で D1 の日次読取枠を食い潰していた張本人がここだった:
    //   maker LIKE ? OR label LIKE ?   … 1回あたり約2万行 × 523回/日 = 10.6M行
    //   series_name = ? + ORDER BY 日付 … 1回あたり約3.4万行 × 136回/日 = 4.6M行
    //   genres LIKE ?                  … 1回あたり約6,700行
    // LIKE '%…%' はインデックスが効かず全件スキャンになり、FANZAは2シャードへfan-outするので
    // 1回のメーカー絞り込みで約49万行を読む。LPのSSRも無限スクロールの続きもここを通る。
    // → LPと同じ並び・同じ条件で焼いた静的カード(scripts/build_lp_cache.mjs)で置き換える。
    // 条件が少しでも違う(sortが違う/他の絞り込みが乗る/キャッシュ範囲外)ときは D1 に落とす。
    {
        const lpGenre = searchParams.get('genre') || '';
        const lpMaker = searchParams.get('maker') || '';
        const lpSeries = searchParams.get('series') || '';
        const specified = [lpGenre, lpMaker, lpSeries].filter(Boolean);
        // 他の絞り込みが一切乗っていないこと（乗っていたら静的カードでは絞れない）
        const noOtherFilter = !searchParams.get('q') && !searchParams.get('actress')
            && !searchParams.get('makers') && !searchParams.get('label') && !searchParams.get('exactMaker')
            && !searchParams.get('source') && !searchParams.get('cup') && !searchParams.get('cups')
            && !searchParams.get('height') && !searchParams.get('ageMin') && !searchParams.get('ageMax')
            && !searchParams.get('vr') && !searchParams.get('hasVideo') && !searchParams.get('minDiscount')
            && !searchParams.get('fromDate') && !searchParams.get('toDate')
            && !searchParams.get('excludeGenres') && !searchParams.get('excludeLabel');
        // LPが投げる形と同じときだけ使う（並びが違うキャッシュを流用しない）
        const excludeBestOn = searchParams.get('excludeBest') === '1';
        const lpType = specified.length !== 1 || !noOtherFilter ? ''
            : lpGenre && sort === 'wish_count' && excludeBestOn ? 'genre'
            : lpMaker && sort === 'wish_count' && excludeBestOn ? 'maker'
            : lpSeries && sort === 'new' ? 'series'
            : '';
        if (lpType) {
            const slug = lpGenre || lpMaker || lpSeries;
            const cards = await readLpCards(lpType, slug);
            // ページを丸ごと満たせるとき、または「収録上限未満＝そのLPの全件が入っている」ときに返す。
            // 後者は短いページを返してよい（クライアントは件数不足で hasMore=false と判断する＝正しい）。
            const complete = !!cards && cards.length < LP_MAX_PER;
            if (cards && offset < cards.length && (complete || offset + limit <= cards.length)) {
                const page = cards.slice(offset, offset + limit);
                const res = NextResponse.json(page, { headers: { 'Content-Type': 'application/json', ...cacheHeaders(21600, 86400) } });
                if (cfCache && cfCacheKey) {
                    await cfCache.put(cfCacheKey, new Response(JSON.stringify(page), {
                        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600' },
                    }));
                }
                return res;
            }
        }
    }

    // 予約: sort=pre-order, offset=0 → 静的キャッシュ
    // 予約は build_preorder_cache.mjs が DMM API から日次生成する（D1もローカルDBも使わない）。
    // D1 側の予約は枠切れの日に落ちるうえローカルDBは未来日付を持たないので、
    // ここは静的キャッシュを正にする。配信済みになったものは読み出し時に落とす＝自己修復。
    // source=fanza も静的キャッシュで返せる（このキャッシュは DMM API 由来＝全件 FANZA・BEST除外済み）。
    // ホーム(HomePageWeb/Mobile)は `sort=pre-order&source=fanza&excludeBest=1` を送るため、
    // source を弾いていた頃はホーム表示のたびに D1 の予約クエリ（実測 約9万行/回）へ落ちていた。
    if (sort === 'pre-order' && offset === 0 && searchParams.get('source') !== 'mgs' && !searchParams.get('maker') && !searchParams.get('q')) {
        const preCached = await readStaticCache<Array<Record<string, unknown>>>('home_preorder_cache.json');
        if (preCached && preCached.length > 0) {
            const today = new Date().toISOString().slice(0, 10);
            const dateOf = (p: Record<string, unknown>) => String(p.sale_start_date ?? '').replace(/\//g, '-').slice(0, 10);
            const page = preCached.filter(p => dateOf(p) > today)
                .sort((a, b) => dateOf(b).localeCompare(dateOf(a)))   // 配信が遠い順（D1経路と同じ並び）
                .slice(0, limit);
            if (page.length > 0) {
                const res = NextResponse.json(page, { headers: { 'Content-Type': 'application/json', ...cacheHeaders(1800, 300) } });
                if (cfCache && cfCacheKey) {
                    await cfCache.put(cfCacheKey, new Response(JSON.stringify(page), {
                        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' },
                    }));
                }
                return res;
            }
        }
    }

    // offset=0 のシンプルなクエリはインメモリキャッシュ
    const offset0 = offset === 0;
    if (offset0) {
        const cacheKey = 'products_' + Array.from(searchParams.entries())
            .filter(([k]) => k !== 'offset')
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('&');
        const hit = getCached<unknown[]>(cacheKey, PRODUCTS_TTL);
        if (hit) return NextResponse.json(hit, { headers: { 'Content-Type': 'application/json', ...cacheHeaders(300, 600) } });

        // 結果取得後にキャッシュ（後続の処理で設定）
        (request as NextRequest & { _cacheKey?: string })._cacheKey = cacheKey;
    }
    const q = searchParams.get('q') || '';
    const genre = searchParams.get('genre') || '';
    const actress = searchParams.get('actress') || '';
    const maker = searchParams.get('maker') || '';
    const exactMaker = searchParams.get('exactMaker') === '1';
    const label = searchParams.get('label') || '';
    const excludeGenres = searchParams.get('excludeGenres') || '';
    const excludeLabel = searchParams.get('excludeLabel') || '';
    const cup = searchParams.get('cup') || '';
    const cups = searchParams.get('cups') || ''; // カンマ区切り複数カップ e.g. "C,D,E"
    const heightRange = searchParams.get('height') || '';
    const ageMin = parseInt(searchParams.get('ageMin') || '0', 10);
    const ageMax = parseInt(searchParams.get('ageMax') || '0', 10);
    const fromDate = searchParams.get('fromDate') || '';
    const toDate = searchParams.get('toDate') || '';
    const source = searchParams.get('source') || ''; // 'mgs' | 'fanza' | ''
    const makers = searchParams.get('makers') || ''; // カンマ区切りメーカーホワイトリスト
    // BEST/総集編を除外（判定条件は lib/bestFilter.ts に集約）。
    // 女優絞り込みでも同じく効かせる: 検索バー・詳細検索・女優ページ・商品詳細の出演者欄が
    // すべて excludeBest=1 を送るため、どの入口からでも同じ件数になる。
    const excludeBestParam = searchParams.get('excludeBest') === '1';
    const hasVideo = searchParams.get('hasVideo') === '1'; // サンプル動画ありのみ
    const series = searchParams.get('series') || ''; // シリーズ名
    const vrOnly = searchParams.get('vr') === '1'; // VR作品のみ
    const minDiscount = parseInt(searchParams.get('minDiscount') || '0', 10); // 最低割引率

    // 女優は「,」区切りで複数指定できる（例 actress=葵つかさ,三上悠亜）。
    // 複数指定は **AND=共演作品** を意味する（1人だけの作品は出さない）。
    // 名寄せ辞書はグループ内OR（別名は同一人物）なので、
    //   (A の別名いずれか) AND (B の別名いずれか) … という構造になる。
    // D1のバインド上限(100個/クエリ)とFTSサブクエリの本数を抑えるため人数は上限5人。
    const MAX_ACTRESSES = 5;
    const actressNames = actress.split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_ACTRESSES);

    const excludeBest = excludeBestParam;
    let actressGroups: string[][] = actressNames.map(n => [n]);
    if (actressNames.length > 0) {
        try {
            const aliasesData = await readStaticCache<string[][]>('actress_aliases.json');
            if (aliasesData) {
                actressGroups = actressNames.map(n => {
                    const entry = aliasesData.find((a: string[]) => a.includes(n));
                    return entry ? entry : [n];
                });
            }
        } catch (e) {
            console.error('Alias load error:', e);
        }
    }

    // プロフィールフィルター
    let profileActresses: string[] = [];
    let hasProfileFilter = false;
    const cupSet = cups ? new Set(cups.split(',').map(s => s.trim()).filter(Boolean)) : null;
    function calcAge(birthday: string): number {
        const d = new Date(birthday), t = new Date();
        let a = t.getFullYear() - d.getFullYear();
        if (t.getMonth() < d.getMonth() || (t.getMonth() === d.getMonth() && t.getDate() < d.getDate())) a--;
        return a;
    }
    if (cup || heightRange || (cupSet && cupSet.size > 0) || ageMin || ageMax) {
        hasProfileFilter = true;
        try {
            const profiles = await readStaticCache<Record<string, { cup?: string; height?: number; birthday?: string }>>('actress_profiles.json');
            if (profiles) {
                for (const name of Object.keys(profiles)) {
                    if (name.startsWith('NOT_FOUND_')) continue;
                    const p = profiles[name];
                    let match = true;
                    if (cup && (!p.cup || p.cup !== cup)) match = false;
                    if (match && cupSet && cupSet.size > 0 && (!p.cup || !cupSet.has(p.cup))) match = false;
                    if (match && heightRange) {
                        const [min, max] = heightRange.split('-').map(Number);
                        if (!p.height || p.height < min || (max && p.height >= max)) match = false;
                    }
                    if (match && (ageMin || ageMax)) {
                        if (!p.birthday) { match = false; }
                        else {
                            const age = calcAge(p.birthday);
                            if (ageMin && age < ageMin) match = false;
                            if (ageMax && age > ageMax) match = false;
                        }
                    }
                    if (match) profileActresses.push(name);
                }
            }
        } catch (e) { console.error('Profile filter error:', e); }
        if (profileActresses.length === 0) profileActresses = ['__NO_MATCH__'];
        profileActresses = profileActresses.slice(0, 150);
    }

    // series はFANZAのみが持つメタデータ。MGSはseries列が無く絞り込めず全件流入するため、
    // series指定時はFANZA限定にする。
    const mgsClient = (source === 'fanza' || series) ? null : await getMgsClient();
    const fanzaClient = (source === 'mgs') ? null : await getFanzaClient();
    // D1 が使えたか（枠切れ・障害の検知用）。使えなかったのに結果0件なら静的キャッシュで縮退応答する。
    // 「D1は生きていて本当に0件」のケースと区別するためのフラグ。
    let d1Unavailable = isD1Blocked()
        || (source !== 'fanza' && !series && !mgsClient)
        || (source !== 'mgs' && !fanzaClient);

    if (!mgsClient && !fanzaClient) {
        return NextResponse.json([], { status: 503 });
    }

    // 3文字未満の絞り込みは FTS5 の trigram トークナイザで索引できないので、従来は
    // `actresses LIKE '%X%'` / `label LIKE '%X%'` の全表走査に落ちていた
    // （2026-09-06 実測、直近10h: 女優 約93万行＝枠の19% / レーベル 約81万行＝10%）。
    // scripts/build_short_name_index.mjs が焼いた静的インデックスで肩代わりする。
    type ShortNameIndex = {
        actress?: { fanza?: Record<string, string[]>; mgs?: Record<string, string[]> };
        labels?: { fanza?: string[]; mgs?: string[] };
    };
    let shortNameIndex: ShortNameIndex | null = null;
    const needsShortIndex = [...actressGroups.flat(), ...profileActresses].some(n => [...n].length < 3)
        || (!!label && [...label].length < 3);
    if (needsShortIndex) {
        try { shortNameIndex = await readStaticCache<ShortNameIndex>('short_name_index.json'); }
        catch { shortNameIndex = null; }
    }

    // FTS5 special char エスケープ
    function esc5(s: string): string { return s.replace(/"/g, '""'); }
    // FTS5 サブクエリ（?にMATCH文字列をバインド）
    const FTS_IN = `product_id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?)`;

    // 文字列の「次」（末尾コードポイントを+1）。前方一致 LIKE 'x%' と同じ集合を
    // `col >= 'x' AND col < next('x')` の範囲比較で表すために使う。
    // LIKE は既定で大小無視なのでインデックスが効かないが、範囲比較は効く。
    function nextStr(s: string): string | null {
        const cp = s.codePointAt(s.length - 1);
        if (cp === undefined || cp >= 0x10ffff) return null;
        const head = s.slice(0, s.length - String.fromCodePoint(cp).length);
        return head + String.fromCodePoint(cp + 1);
    }

    // q から product_id の前方一致範囲を作る。
    // FANZA の品番は小文字英数字（例 ssis00123）、MGS は大文字＋数字（例 259LUXU-1875 / SIRO-5716）。
    // 記号（'-' など）の手前までを接頭辞にする。2文字未満は絞り込みにならないので使わない。
    function idPrefixRange(raw: string, isMgs: boolean): [string, string] | null {
        const m = raw.match(/^[A-Za-z0-9]+/);
        if (!m) return null;
        const pfx = isMgs ? m[0].toUpperCase() : m[0].toLowerCase();
        if (pfx.length < 2) return null;
        const hi = nextStr(pfx);
        return hi ? [pfx, hi] : null;
    }

    // 「ssis-123」「SSIS 123」のような入力を FANZA の正準品番 ssis00123 に正規化する。
    // FANZA は数字部を5桁ゼロ詰めで格納しているため、従来の LIKE '%ssis-123%' では
    // **1件も当たらなかった**（この正規化で品番検索がむしろ改善する）。
    function canonicalFanzaId(raw: string): string | null {
        const m = raw.match(/^([A-Za-z]+)[-_ ]?(\d{1,5})$/);
        if (!m) return null;
        return m[1].toLowerCase() + m[2].padStart(5, '0');
    }

    // 短名（3文字未満）女優の条件を作る。静的インデックスに載っていれば主キーの IN 引きに、
    // 載っていなければ従来どおり LIKE の全走査に落とす（新人など索引生成後に増えた名前の保険）。
    function shortActressCond(name: string, isMgs: boolean): { sql: string; args: string[] } {
        const ids = shortNameIndex?.actress?.[isMgs ? 'mgs' : 'fanza']?.[name];
        if (ids && ids.length > 0) {
            // ids は自前の静的ファイル由来。D1 のバインド変数は1文あたり100個までで
            // 数百件の IN には使えないため、英数字・ハイフン・アンダースコアだけに限って直接埋め込む。
            const safe = ids.filter(id => /^[A-Za-z0-9_-]+$/.test(id)).map(id => `'${id}'`);
            if (safe.length > 0) return { sql: `product_id IN (${safe.join(',')})`, args: [] };
        }
        return { sql: 'actresses LIKE ?', args: [`%${name}%`] };
    }

    // 共通SQL条件ビルダー
    function buildConditions(isMgs: boolean) {
        const conditions: string[] = [];
        const args: (string | number)[] = [];

        if (q) {
            // product_id は英数字と記号だけ。日本語を含む q は product_id に絶対一致しないので
            // `OR product_id LIKE '%q%'` を **付けてはいけない**。
            // この OR があると SQLite は FTS 駆動をあきらめ、
            //   SEARCH products USING INDEX idx_sale_start (sale_start_date>?)
            // という「日付順にテーブルを舐めながら1行ずつ OR を評価する」計画を選ぶ。
            // 一致が少ない語ほど深く舐めるので、実測で **1検索あたり約63,000行**を読んでいた
            // （2026-09-05 の日次枠オーバーの約3割）。OR を外すと
            //   SEARCH products USING INDEX sqlite_autoindex_products_1 (product_id=?)
            // ＝ FTS の一致件数ぶんの点引きになり、実測分布(中央値 約1,000件/シャード)では
            // 2,000行程度で済む。
            //
            // 英数字クエリ(品番検索)でも `OR product_id LIKE '%q%'` は同じ罠を踏む
            // （2026-09-06 実測: FANZA 2シャードで 1検索 約82,000行 × 20回 = 1.65M行 = その日の20%）。
            // LIKE を **前方一致の範囲比較** に置き換えると、EXPLAIN QUERY PLAN が
            //   MULTI-INDEX OR
            //     INDEX 1: SEARCH products USING INDEX sqlite_autoindex_products_1 (product_id=?)
            //     INDEX 2: SEARCH products USING INDEX sqlite_autoindex_products_1 (product_id>? AND product_id<?)
            // になり、主キーの点引き＋狭い範囲引きだけで済む（実測で確認済み）。
            // MGS は品番の先頭に数字プレフィクス（259LUXU-1875 の "259"）が付く形があり、
            // 前方一致では「LUXU-1875」を拾えなくなるので LIKE を残す。ただし
            // 品番らしい入力（英字と数字が混じる）に限定して、一般語の検索では走査しない。
            const qIsAscii = /^[\x20-\x7E]+$/.test(q);
            const qLooksLikeId = /^[A-Za-z0-9][A-Za-z0-9_-]{2,}$/.test(q) && /[A-Za-z]/.test(q) && /\d/.test(q);
            if (q.length >= 3) {
                const qMatch = `{title actresses} : "${esc5(q)}"`;
                if (qIsAscii && isMgs) {
                    if (qLooksLikeId) {
                        conditions.push(`(${FTS_IN} OR product_id LIKE ?)`);
                        args.push(qMatch, `%${q}%`);
                    } else {
                        conditions.push(`(${FTS_IN})`);
                        args.push(qMatch);
                    }
                } else if (qIsAscii) {
                    const range = idPrefixRange(q, false);
                    const canon = canonicalFanzaId(q);
                    const idConds: string[] = [];
                    const idArgs: string[] = [];
                    if (range) { idConds.push('(product_id >= ? AND product_id < ?)'); idArgs.push(range[0], range[1]); }
                    if (canon) { idConds.push('product_id = ?'); idArgs.push(canon); }
                    conditions.push(`(${[FTS_IN, ...idConds].join(' OR ')})`);
                    args.push(qMatch, ...idArgs);
                } else {
                    conditions.push(`(${FTS_IN})`);
                    args.push(qMatch);
                }
            } else if (qIsAscii) {
                conditions.push(`(title LIKE ? OR actresses LIKE ? OR product_id LIKE ?)`);
                args.push(`%${q}%`, `%${q}%`, `%${q}%`);
            } else {
                conditions.push(`(title LIKE ? OR actresses LIKE ?)`);
                args.push(`%${q}%`, `%${q}%`);
            }
        }
        if (genre) {
            // カンマ区切りで複数ジャンルOR対応
            const genreList = genre.split(',').map(s => s.trim()).filter(Boolean);
            if (genreList.length > 0) {
                const longGenres = genreList.filter(g => g.length >= 3);
                const shortGenres = genreList.filter(g => g.length < 3);
                const subConds: string[] = [];
                if (longGenres.length > 0) {
                    const escaped = longGenres.map(g => `"${esc5(g)}"`).join(' OR ');
                    subConds.push(FTS_IN);
                    args.push(`genres : (${escaped})`);
                }
                shortGenres.forEach(g => {
                    subConds.push('genres LIKE ?');
                    args.push(`%${g}%`);
                });
                conditions.push(`(${subConds.join(' OR ')})`);
            }
        }
        if (maker) {
            // MGS/FANZA共にlabelも検索対象に含める（メーカー一覧のレーベル項目に対応）
            if (exactMaker) {
                // 完全一致（メーカー詳細ページ用: Hunterでlady huntersを除外）
                conditions.push('(maker = ? OR label = ?)');
                args.push(maker, maker);
            } else {
                conditions.push('(maker LIKE ? OR label LIKE ?)');
                args.push(`%${maker}%`, `%${maker}%`);
            }
        }
        if (label) {
            if (label.length >= 3) {
                conditions.push(FTS_IN);
                args.push(`label : "${esc5(label)}"`);
            } else {
                // 2文字以下は FTS で引けないので LIKE の全表走査になる（1回 約7万行）。
                // 高いのは「どのレーベルにも一致しない」疎なクエリなので、静的なレーベル一覧に
                // 1件も含むものが無ければ走査せず 0 件で返す。1件でも含めば従来どおり LIKE
                // （一致が密なので ORDER BY + LIMIT で早く止まる）。
                // 一覧はローカルSQLite由来でD1より件数が少ないため、ごく新しいレーベルは
                // 取りこぼしうる（その2文字検索が翌日の再生成まで0件になる）。
                const known = shortNameIndex?.labels?.[isMgs ? 'mgs' : 'fanza'];
                if (known && known.length > 0 && !known.some(l => l.includes(label))) {
                    conditions.push('0=1');
                } else {
                    conditions.push('label LIKE ?');
                    args.push(`%${label}%`);
                }
            }
        }
        if (excludeGenres) {
            excludeGenres.split(',').map(s => s.trim()).filter(Boolean).forEach(ex => {
                conditions.push('genres NOT LIKE ?');
                args.push(`%${ex}%`);
            });
        }
        if (excludeLabel && !isMgs) {
            conditions.push('label NOT LIKE ?');
            args.push(`%${excludeLabel}%`);
        }
        // 女優グループごとに1条件を push する。conditions は AND で結合されるので、
        // 複数女優を指定すると「全員が出ている作品」= 共演作品だけが残る。
        for (const group of actressGroups) {
            const longActresses = group.filter(a => a.length >= 3);
            const shortActresses = group.filter(a => a.length < 3);
            const actSubConds: string[] = [];
            if (longActresses.length > 0) {
                const escaped = longActresses.map(a => `"${esc5(a)}"`).join(' OR ');
                actSubConds.push(FTS_IN);
                args.push(`actresses : (${escaped})`);
            }
            shortActresses.forEach(a => {
                const c = shortActressCond(a, isMgs);
                actSubConds.push(c.sql);
                args.push(...c.args);
            });
            if (actSubConds.length > 0) conditions.push(`(${actSubConds.join(' OR ')})`);
        }
        if (hasProfileFilter) {
            const longProfiles = profileActresses.filter(a => a.length >= 3);
            const shortProfiles = profileActresses.filter(a => a.length < 3);
            const profSubConds: string[] = [];
            if (longProfiles.length > 0) {
                const escaped = longProfiles.map(a => `"${esc5(a)}"`).join(' OR ');
                profSubConds.push(FTS_IN);
                args.push(`actresses : (${escaped})`);
            }
            shortProfiles.forEach(a => {
                const c = shortActressCond(a, isMgs);
                profSubConds.push(c.sql);
                args.push(...c.args);
            });
            if (profSubConds.length > 0) conditions.push(`(${profSubConds.join(' OR ')})`);
        }
        const today = new Date().toISOString().slice(0, 10);
        // FANZA は sale_start_date が 'YYYY-MM-DD HH:MM:SS'。日付比較に SUBSTR(...,1,10) を使うと
        // **idx_sale_start が一切効かなくなる**（実測 2026-09-05: 予約クエリが1回13.5万行＝シャード全走査）。
        // 生の列のまま「翌日未満 / 翌日以上」で比較すれば意味は同じでインデックスが効く:
        //   SUBSTR(d,1,10) >  X  ⟺  d >= 翌日(X)     （'2026-09-06 00:00' >= '2026-09-06' は真）
        //   SUBSTR(d,1,10) <= X  ⟺  d <  翌日(X)     （'2026-09-05 23:59' <  '2026-09-06' は真）
        //   SUBSTR(d,1,10) >= X  ⟺  d >= X
        // NULL はどちらの形でも比較結果が NULL＝除外されるので挙動は変わらない。
        // MGS は 'YYYY/MM/DD' で、REPLACE 式そのものに関数インデックス idx_sale_date_norm が
        // 張ってあるため REPLACE のままでよい（変えると逆にインデックスが外れる）。
        const nextDay = (d: string) => new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
        if (sort === 'pre-order') {
            // 未配信作品のみ（今日より後＝明日以降）
            conditions.push(isMgs ? "REPLACE(sale_start_date, '/', '-') > ?" : 'sale_start_date >= ?');
            args.push(isMgs ? today : nextDay(today));
        }
        if (sort === 'new') {
            // 配信済み作品のみ（予約作品を除く）
            conditions.push("sale_start_date IS NOT NULL");
            conditions.push(isMgs ? "REPLACE(sale_start_date, '/', '-') <= ?" : 'sale_start_date < ?');
            args.push(isMgs ? today : nextDay(today));
        }
        if (fromDate) {
            conditions.push(isMgs ? "REPLACE(sale_start_date, '/', '-') >= ?" : 'sale_start_date >= ?');
            args.push(fromDate);
        }
        if (toDate) {
            conditions.push(isMgs ? "REPLACE(sale_start_date, '/', '-') <= ?" : 'sale_start_date < ?');
            args.push(isMgs ? toDate : nextDay(toDate));
        }
        if (makers) {
            const makerList = makers.split(',').map(s => s.trim()).filter(Boolean);
            if (makerList.length > 0) {
                if (isMgs) {
                    // MGS: maker列にブランド名が入っている
                    const makerConds = makerList.map(() => 'maker LIKE ?').join(' OR ');
                    conditions.push(`(${makerConds})`);
                    makerList.forEach(m => args.push(`%${m}%`));
                } else {
                    // FANZA: label列にブランド名、maker列に会社名が入っているため両方チェック
                    const makerConds = makerList.map(() => '(label LIKE ? OR maker LIKE ?)').join(' OR ');
                    conditions.push(`(${makerConds})`);
                    makerList.forEach(m => args.push(`%${m}%`, `%${m}%`));
                }
            }
        }
        if (excludeBest) {
            // 予約作品はduration_minが未確定なのでdurationフィルターを除外
            const { conds, args: bestArgs } = bestExclusionSql({ skipDuration: sort === 'pre-order' });
            conditions.push(...conds);
            args.push(...bestArgs);
        }
        if (hasVideo) {
            conditions.push('sample_video_url IS NOT NULL');
        }
        if (series && !isMgs) {
            // 同一シリーズに限定（完全一致）。LIKEだと「ガンギマリ」が「ブリブリガンギマリ…」等の
            // 別シリーズを誤って拾うため、シリーズ名の完全一致で絞る。
            conditions.push('series_name = ?');
            args.push(series);
        }
        if (vrOnly && !isMgs) {
            conditions.push('vr_flag = 1');
        }
        if (sort === 'discount') {
            // セールページ: FANZA は HOME_MAKERS のみ（maker/makers 未指定時）
            conditions.push('discount_pct >= 1');
            if (!isMgs && !maker && !makers) {
                const saleParts = SALE_MAKERS_FANZA.map(([type]) =>
                    type === 'exact' ? '(maker = ? OR label = ?)' : '(maker LIKE ? OR label LIKE ?)'
                );
                conditions.push(`(${saleParts.join(' OR ')})`);
                SALE_MAKERS_FANZA.forEach(([type, val]) => {
                    if (type === 'exact') { args.push(val, val); }
                    else { args.push(`%${val}%`, `%${val}%`); }
                });
            }
        }
        if (minDiscount > 0) {
            // 検索での割引フィルター: メーカー制限なし・全作品のセール情報を表示
            conditions.push('discount_pct >= ?');
            args.push(minDiscount);
        }
        if (isMgs) {
            conditions.push('(duration_min IS NULL OR duration_min < 600)');
        }

        return { conditions, args };
    }

    // ランダム抽出の候補プール。ORDER BY RANDOM() は「条件に合う全行」を実体化してから
    // ソートするため、117k件のMGSに素で当てるとD1の1日読み取り枠(500万行)を数十リクエストで
    // 使い切る。日付インデックスで新しい方から N 件だけ取り、その中でシャッフルする。
    const RANDOM_POOL = 500;

    function dateOrderBy(isMgs: boolean) {
        // MGSは YYYY/MM/DD 形式のため REPLACE で正規化 → 関数インデックス idx_sale_date_norm が効く
        return isMgs ? "ORDER BY REPLACE(sale_start_date,'/','-') DESC" : 'ORDER BY sale_start_date DESC';
    }

    function buildOrderBy(isMgs: boolean) {
        if (sort === 'new' || sort === 'date_all') return dateOrderBy(isMgs);
        // FANZA は SUBSTR で並べると idx_sale_start が使えず一時B-treeで全件ソートになる。
        // 生の列で並べれば同じ日付順（同日内は時刻順というより良いタイブレークになるだけ）。
        if (sort === 'pre-order') return isMgs ? "ORDER BY REPLACE(sale_start_date,'/','-') DESC" : 'ORDER BY sale_start_date DESC';
        if (sort === 'discount') return 'ORDER BY discount_pct DESC';         // 割引率が高い順
        return isMgs ? 'ORDER BY wish_count DESC' : 'ORDER BY sale_start_date DESC';
    }

    async function queryTurso(client: Awaited<ReturnType<typeof getMgsClient>>, isMgs: boolean, perLimit: number) {
        if (!client) return [];
        try {
            const { conditions, args } = buildConditions(isMgs);
            const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
            const cols = `product_id, title, actresses, main_image_url,
                         ${isMgs ? 'wish_count,' : '0 AS wish_count,'}
                         genres, maker, duration_min, sale_start_date,
                         sample_video_url,
                         ${isMgs ? 'COALESCE(discount_pct, 0) AS discount_pct, list_price, current_price, NULL AS series_name, NULL AS series_id, 0 AS vr_flag, sale_end_date' : 'COALESCE(discount_pct, 0) AS discount_pct, list_price, current_price, series_name, series_id, COALESCE(vr_flag, 0) AS vr_flag, sale_end_date'}`;
            const sql = sort === 'random'
                // 新着 RANDOM_POOL 件に絞ってからシャッフル（OFFSETはランダムでは無意味なので使わない）
                ? `SELECT * FROM (SELECT ${cols} FROM products ${where} ${dateOrderBy(isMgs)} LIMIT ${RANDOM_POOL})
                   ORDER BY RANDOM() LIMIT ${perLimit}`
                : `SELECT ${cols} FROM products ${where} ${buildOrderBy(isMgs)} LIMIT ${perLimit} OFFSET ${perOffset}`;

            const result = await client.execute({ sql, args });
            return result.rows.map(row => {
                const r = { ...row } as Record<string, unknown>;
                r.actresses = filterActresses(
                    (r.actresses as string | null) || null,
                    (r.genres as string | null) || null,
                    (r.maker as string | null) || null
                );
                r.source = isMgs ? 'mgs' : 'fanza';
                return r;
            });
        } catch (err) {
            console.error(`Query error (${isMgs ? 'mgs' : 'fanza'}):`, err);
            d1Unavailable = true;
            return [];
        }
    }

    const perLimit = limit;
    const perOffset = offset;

    const [mgsResults, fanzaResults] = await Promise.all([
        queryTurso(mgsClient, true, perLimit),
        queryTurso(fanzaClient, false, perLimit),
    ]);

    // 重複除去（MGS優先）
    const mgsIds = new Set(mgsResults.map(r => String(r.product_id)));
    const dedupedFanza = fanzaResults.filter(r => !mgsIds.has(String(r.product_id)));

    let combined: Record<string, unknown>[];

    if (sort === 'new' || sort === 'date_all' || sort === 'pre-order') {
        // 日付系ソートは結合後に再ソート（1:1交互では日付順が崩れる）
        // MGS: "YYYY/MM/DD" → normalize / → -  FANZA: "YYYY-MM-DD HH:MM:SS" → slice 10
        combined = [...mgsResults, ...dedupedFanza].sort((a, b) => {
            const da = String(a.sale_start_date ?? '').replace(/\//g, '-').slice(0, 10);
            const db = String(b.sale_start_date ?? '').replace(/\//g, '-').slice(0, 10);
            return sort === 'pre-order' ? da.localeCompare(db) : db.localeCompare(da);
        });
    } else {
        // 人気順・割引順は交互インターリーブ（MGS人気 + FANZA人気を均等に混在）
        combined = [];
        const maxLen = Math.max(mgsResults.length, dedupedFanza.length);
        for (let i = 0; i < maxLen; i++) {
            if (mgsResults[i]) combined.push(mgsResults[i]);
            if (dedupedFanza[i]) combined.push(dedupedFanza[i]);
        }
    }

    // 女優検索: FTS(trigram)/短名LIKEは部分一致（「ちな」→「ちなみ」「ちなつ」等）で
    // 別人を巻き込む。actressesのcomma区切りエントリと完全一致するものだけに絞る。
    // 複数女優(共演検索)のときは **全グループが一致する作品だけ** を残す。
    if (actressGroups.length > 0) {
        const wantedSets = actressGroups.map(g => new Set(g));
        combined = combined.filter(p => {
            const acts = String((p as Record<string, unknown>).actresses ?? '')
                .split(/[,、]/).map(s => s.trim());
            return wantedSets.every(w => acts.some(a => w.has(a)));
        });
    }

    // MGSとFANZAに同一作品が両方ある場合、品番コアで重複カードを1枚に統一（MGS優先=先頭を残す）
    {
        const coreId = (id: string) => {
            let s = String(id || '').toLowerCase().replace(/^h_\d+/, '').replace(/^\d+/, '').replace(/[^a-z0-9]/g, '');
            const m = s.match(/^([a-z]+)0*(\d+)$/);
            return m ? m[1] + m[2] : s;
        };
        const seen = new Set<string>();
        combined = combined.filter(p => {
            const k = coreId(String((p as Record<string, unknown>).product_id ?? ''));
            if (!k) return true;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
    }

    const result = combined.slice(0, limit);

    // ── D1 縮退応答 ───────────────────────────────────────────────
    // D1 が枠切れ/障害で 0 件になったときだけ、静的キャッシュから一覧を組み立てて返す。
    // （D1 が生きていて本当に該当0件のときは、従来どおり空配列を返す）
    // 縮退応答は静的キャッシュ上のJSフィルタなので、**絞り込めない条件が付いていたら使わない**。
    // （series/カップ/身長/年齢/VR/サンプル動画/日付範囲/除外系はキャッシュ側に情報が無い。
    //   無視して返すと「シリーズ指定なのに無関係な作品が並ぶ」ことになる）
    const degradableQuery = !series && !cup && !cups && !heightRange && !ageMin && !ageMax
        && !vrOnly && !hasVideo && !fromDate && !toDate && !excludeGenres && !excludeLabel;
    if (result.length === 0 && d1Unavailable && degradableQuery) {
        const fb = await degradedProducts({
            sort, q, genre, maker, exactMaker, label, source, limit, offset,
            actressGroups: actressNames.length > 0 ? actressGroups : undefined,
            minDiscount: sort === 'discount' ? Math.max(minDiscount, 1) : minDiscount,
            excludeBest,
        });
        if (fb.length > 0) {
            // 枠が戻ったら通常結果に復帰できるよう、縮退応答は短いTTLでしかキャッシュしない
            return NextResponse.json(fb, {
                headers: { 'Content-Type': 'application/json', ...cacheHeaders(300, 300), 'X-Degraded': 'static' },
            });
        }
    }

    const cacheKey = (request as NextRequest & { _cacheKey?: string })._cacheKey;
    if (cacheKey) setCached(cacheKey, result);

    // CF Cache API に保存（空結果はキャッシュしない → 次回リクエストで再取得）
    if (result.length > 0 && cfCache && cfCacheKey) {
        await cfCache.put(cfCacheKey, new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' },
        }));
    }
    // 空結果は短いTTLで返す（キャッシュ汚染防止）
    const resHeaders = result.length > 0
        ? { 'Content-Type': 'application/json', ...cacheHeaders(1800, 600) }
        : { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    return NextResponse.json(result, { headers: resHeaders });
}
