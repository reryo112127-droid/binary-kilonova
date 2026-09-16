import { NextRequest, NextResponse } from 'next/server';
import { filterActresses } from '../../../lib/actressFilter';
import { getMgsClient, getFanzaClient } from '../../../lib/turso';
import { getCached, setCached } from '../../../lib/apiCache';
import { readStaticCacheAsync as readStaticCache, cacheHeaders } from '../../../lib/staticCache';
import { bestExclusionSql } from '../../../lib/bestFilter';
import { degradedProducts } from '../../../lib/degradedProducts';
import { readLpCards } from '../../../lib/lpCache';
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

// ── FTS プローブ結果の isolate 内キャッシュ（2026-09-10）──────────────────────
// preparePlans() は検索のたびに一致件数のプローブ（FTS / 品番範囲）を投げる。同じ語でも
// sort・offset・他の絞り込みが違えばエッジキャッシュは別キーになるので、女優ページの
// ページ送りなどで同じプローブを何度も読み直していた（実測 1日 約2,800回・約36万行）。
// 一致の集合は日次バッチでしか変わらないので、isolate が生きている間は30分使い回す。
// id を最大2000件持つので件数は小さく抑える（1件あたり最大 約30KB）。
type ProbeResult = { ids: string[] } | { dense: true };
const PROBE_TTL_MS = 30 * 60 * 1000;
const PROBE_CACHE_MAX = 150;
const probeCache = new Map<string, { at: number; r: ProbeResult }>();
function probeCacheGet(key: string): ProbeResult | null {
    const e = probeCache.get(key);
    if (!e) return null;
    if (Date.now() - e.at > PROBE_TTL_MS) { probeCache.delete(key); return null; }
    return e.r;
}
function probeCacheSet(key: string, r: ProbeResult) {
    probeCache.set(key, { at: Date.now(), r });
    while (probeCache.size > PROBE_CACHE_MAX) {
        const oldest = probeCache.keys().next().value;
        if (oldest === undefined) break;
        probeCache.delete(oldest);
    }
}

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
            // 収録範囲はキャッシュから返し、**その先は D1 に行かずに打ち切る**（2026-09-16）。
            // 以前は「ページを丸ごと満たせないなら D1」に落としており、ジャンルLPの無限スクロールが
            // `genres LIKE` の走査（1回 2.5〜3万行・日付条件なし）を叩いて 1日約200万行＝読取の40%を
            // 食っていた。ジャンルは180件（6ページ）まで焼いてあり、それ以上は打ち切ってよい
            // （?page= は robots で拒否＝クロール対象外。利用者には6ページぶん出る）。
            if (cards) {
                const page = offset < cards.length ? cards.slice(offset, offset + limit) : [];
                const ttl = page.length > 0 ? 21600 : 1800;
                const res = NextResponse.json(page, { headers: { 'Content-Type': 'application/json', ...cacheHeaders(ttl, 86400) } });
                if (cfCache && cfCacheKey && page.length > 0) {
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

    // ── D1 縮退応答 ───────────────────────────────────────────────
    // D1 が枠切れ/障害のときだけ、静的キャッシュから一覧を組み立てて返す。
    // （D1 が生きていて本当に該当0件のときは、従来どおり空配列を返す）
    // 縮退応答は静的キャッシュ上のJSフィルタなので、**絞り込めない条件が付いていたら使わない**。
    // （series/カップ/身長/年齢/VR/サンプル動画/日付範囲/除外系はキャッシュ側に情報が無い。
    //   無視して返すと「シリーズ指定なのに無関係な作品が並ぶ」ことになる）
    const degradableQuery = !series && !cup && !cups && !heightRange && !ageMin && !ageMax
        && !vrOnly && !hasVideo && !fromDate && !toDate && !excludeGenres && !excludeLabel;
    const degradedResponse = async (): Promise<NextResponse | null> => {
        if (!degradableQuery) return null;
        const fb = await degradedProducts({
            sort, q, genre, maker, exactMaker, label, source, limit, offset,
            actressGroups: actressNames.length > 0 ? actressGroups : undefined,
            minDiscount: sort === 'discount' ? Math.max(minDiscount, 1) : minDiscount,
            excludeBest,
        });
        if (fb.length === 0) return null;
        // 枠が戻ったら通常結果に復帰できるよう、縮退応答は短いTTLでしかキャッシュしない
        return NextResponse.json(fb, {
            headers: { 'Content-Type': 'application/json', ...cacheHeaders(300, 300), 'X-Degraded': 'static' },
        });
    };

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
        // ブレーカ作動中（D1枠切れ）は両クライアントが null になる。ここで即 503 を返していたため
        // 下の縮退応答に一度も届かず、**枠切れ中の検索・一覧が全部 503** になっていた（2026-09-13）。
        return (await degradedResponse()) ?? NextResponse.json([], { status: 503 });
    }

    // 3文字未満の絞り込みは FTS5 の trigram トークナイザで索引できないので、従来は
    // `actresses LIKE '%X%'` / `label LIKE '%X%'` の全表走査に落ちていた
    // （2026-09-06 実測、直近10h: 女優 約93万行＝枠の19% / レーベル 約81万行＝10%）。
    // scripts/build_short_name_index.mjs が焼いた静的インデックスで肩代わりする。
    type ShortNameIndex = {
        actress?: { fanza?: Record<string, string[]>; mgs?: Record<string, string[]> };
        labels?: { fanza?: string[]; mgs?: string[] };
        /** MGS品番の英字コア → 実在する数字プレフィクス（"259" / "" など）。品番検索用 */
        mgsIdPrefixes?: Record<string, string[]>;
    };
    let shortNameIndex: ShortNameIndex | null = null;
    // maker 絞り込みでも「実在するレーベル名か」の判定に labels を使う（下の maker 条件を参照）
    const needsExactMakerCheck = !!maker && !exactMaker;
    // MGSの品番らしい q（英字と数字が混じる）も静的インデックスを使う（下の idConds を参照）
    const qLooksLikeIdTop = !!q && /^[A-Za-z0-9][A-Za-z0-9_ -]{2,}$/.test(q) && /[A-Za-z]/.test(q) && /\d/.test(q);
    const needsShortIndex = [...actressGroups.flat(), ...profileActresses].some(n => [...n].length < 3)
        // レーベルは長さに関係なく「実在する名前そのものか」を見る（下の label 条件を参照）
        || !!label
        || needsExactMakerCheck
        || qLooksLikeIdTop;
    if (needsShortIndex) {
        try { shortNameIndex = await readStaticCache<ShortNameIndex>('short_name_index.json'); }
        catch { shortNameIndex = null; }
    }

    // カタログに実在するメーカー名の集合（makers_cache.json は週次CIが再生成する静的キャッシュ）
    let knownMakerNames: Set<string> | null = null;
    if (needsExactMakerCheck) {
        try {
            const makers = await readStaticCache<{ name: string }[]>('makers_cache.json');
            if (Array.isArray(makers)) knownMakerNames = new Set(makers.map(m => m.name));
        } catch { knownMakerNames = null; }
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

    // MGS の品番候補を作る。品番は「数字プレフィクス + 英字 + '-' + 数字」（259LUXU-1875）で、
    // 利用者が入れるのは普通プレフィクス無しの `LUXU-1875`。前方一致にできないので従来は
    // `product_id LIKE '%LUXU-1875%'` ＝ **1回 65,217行の全表走査**だった（2026-09-09 実測）。
    // build_short_name_index.mjs が焼いた「英字コア→実在プレフィクス」で候補を組み立て、
    // 主キーの点引き（product_id IN (...)）に変える。コアが索引に無ければ従来の LIKE に落とす。
    //
    // 索引に**無い**コアも LIKE に落とさない（2026-09-10）。索引の供給元ローカル mgs.db は
    // D1 の約半分（6.6万 / 11.7万件）しか持たず、FANZA 品番（SSIS-123 など）を探したときも
    // MGS 側で同じ LIKE が走るので、実測で 1回 32,621行 × 8回/日 が残っていた。
    // コアが未知なら「実在する全プレフィクス（約350種）× 入力」を点引きする。
    // 主キーの点引き350回は外れても数百行で、全表走査の 1/100 以下。
    const MAX_MGS_ID_CANDIDATES = 600;
    let allMgsPrefixes: string[] | null = null;
    function mgsIdCandidates(raw: string): string[] | null {
        const m = raw.toUpperCase().replace(/\s+/g, '').match(/^(\d*)([A-Z]+)[-_]?(\d+)$/);
        if (!m) return null;
        const [, typed, core, num] = m;
        // 利用者が既にプレフィクスまで入れているならそれで一意に決まる
        if (typed) return [`${typed}${core}-${num}`];
        const index = shortNameIndex?.mgsIdPrefixes;
        if (!index) return null; // 索引が読めないときだけ従来の LIKE
        let prefixes = index[core];
        if (!prefixes || prefixes.length === 0) {
            allMgsPrefixes ??= [...new Set(['', ...Object.values(index).flat()])];
            prefixes = allMgsPrefixes;
        }
        if (prefixes.length > MAX_MGS_ID_CANDIDATES) return null;
        // SQLへ直接埋め込むので、他の埋め込み箇所と同じく文字種を検証する
        return prefixes.map(p => `${p}${core}-${num}`).filter(id => /^[A-Za-z0-9_-]+$/.test(id));
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
    // 返り値の sql が null = 「索引にはあるが一致0件」＝条件ごと落としてよい。
    // ここで LIKE に落とすと、別名グループの `FTS OR actresses LIKE ?` で
    // **OR のせいで FTS 駆動が捨てられ全表走査**になる（2026-09-08 実測: MGS 1回 65,226行
    // ＝テーブル全件 × 6回/h でその時間帯の90%）。索引が「無い」のか「0件」なのかを
    // 区別できるよう、別名の短名は 0件でもキーだけ作ってある。
    function shortActressCond(name: string, isMgs: boolean): { sql: string | null; args: string[] } {
        const table = shortNameIndex?.actress?.[isMgs ? 'mgs' : 'fanza'];
        const ids = table?.[name];
        if (ids) {
            // ids は自前の静的ファイル由来。D1 のバインド変数は1文あたり100個までで
            // 数百件の IN には使えないため、英数字・ハイフン・アンダースコアだけに限って直接埋め込む。
            const safe = ids.filter(id => /^[A-Za-z0-9_-]+$/.test(id)).map(id => `'${id}'`);
            return safe.length > 0 ? { sql: `product_id IN (${safe.join(',')})`, args: [] } : { sql: null, args: [] };
        }
        // 索引に無い名前だけ従来どおり LIKE（索引生成後に増えた新人などの保険）。
        // ただし素の LIKE は全表走査で、一致が疎だと 1回 FANZA 67,771行 / MGS 32,630行
        // （2026-09-10 実測）になるので、2文字の q と同じく配信日の下限（直近1年）で走査距離を
        // 頭打ちにする。索引に無い短名は索引生成後に増えた新人が主なので、結果はほぼ変わらない。
        const floor = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
        return isMgs
            ? { sql: "(actresses LIKE ? AND REPLACE(sale_start_date, '/', '-') >= ?)", args: [`%${name}%`, floor] }
            : { sql: '(actresses LIKE ? AND sale_start_date >= ?)', args: [`%${name}%`, floor] };
    }

    // ── q 検索の実行計画を「FTSの一致件数」で切り替える（2026-09-07）──────────────
    //
    // `product_id IN (FTSサブクエリ)` は **一致件数ぶんの点引き**になる。一致が少ない語では
    // 最速だが、ありふれた語では一致が数万件になり、そのすべてを引いてから
    // ORDER BY sale_start_date で並べて 20件返すことになる。
    // 2026-09-07 実測: 1検索あたり FANZA 2シャードで 35,000〜50,000行 × 87回/6h = 3.94M行
    // （その時間帯の55%）。検索は1日350回程度しかないのに読取枠の大半を食っていた。
    //
    // 逆に `(title LIKE ? OR actresses LIKE ?)` は idx_sale_start を新しい順に舐めて
    // 20件そろった時点で止まる計画になるので、**一致が密な語ほど安い**（浅い走査で済む）。
    // 疎な語では深く舐めるので高い ―― つまり2つの計画はちょうど逆の特性を持つ。
    //
    // そこで先に「一致が Q_PROBE_CAP 件を超えるか」だけを測り、
    //   疎(≦2000件) → 一致IDを直接 IN に埋める（点引き。FTSサブクエリより更に安い）
    //   密(>2000件) → LIKE に切り替えて日付順スキャンで早期打ち切りさせる
    // と振り分ける。どちらもコストは概ね 2×Q_PROBE_CAP 行で頭打ちになる。
    //
    // **この振り分けは q だけでなく genre / label / 女優 の FTS 条件すべてに要る**（2026-09-09）。
    // q だけ直したあと、残りの FTS_IN が同じ形で枠を食い続けていた。実測(fanza-0, LIMIT 21):
    //   genres:"中出し"  FTS_IN 255,855行 / genres LIKE '%中出し%' 35行  （7,300倍）
    //   genres:"美少女"  FTS_IN  96,409行 / LIKE 116行
    // ジャンルLPや女優ページは「ありふれた語＝密」ばかりなので、ここが最大の消費源になる。
    const Q_PROBE_CAP = 2000;
    type QPlan = { kind: 'ids'; ids: string[] } | { kind: 'like' };
    /** MATCH式 → 実行計画。プラットフォームごとに1つ持つ（同じ式は1回だけプローブする）。 */
    type PlanMap = Map<string, QPlan | null>;
    // IN に埋め込む id の総量。SQL文は10万バイトまでなので、複数条件が同時に ids になったときは
    // 途中から FTS サブクエリへ戻す（1条件でも点引きになれば十分安い）。
    const MAX_EMBED_CHARS = 60000;

    // LIKE 側は「索引を並び順に舐めて LIMIT で止まる」ことで安くなる計画なので、
    // **ORDER BY が索引で満たせるときだけ**使う（満たせないと全件走査＋一時ソートになり逆効果）。
    // 2026-09-09 に EXPLAIN で確認した対応:
    //   配信日順 → idx_sale_start(FANZA) / idx_sale_date_norm(MGS)
    //   割引率順 → idx_discount（両方にある）
    //   人気順   → idx_wish（MGS。FANZAは `0 AS wish_count` なので配信日順になる）
    // いずれも USE TEMP B-TREE FOR ORDER BY が出ない。知らない sort 値のときは
    // 安全側に倒して従来の FTS サブクエリのままにする。
    const EARLY_STOP_SORTS = ['', 'new', 'date_all', 'pre-order', 'discount', 'wish_count', 'random'];
    const canEarlyStop = () => EARLY_STOP_SORTS.includes(sort);

    // ── 2文字以下の q は配信日の下限を付けて走査距離を頭打ちにする（2026-09-07）────
    //
    // FTS5 の trigram トークナイザは **3文字未満を索引できない**ので、1〜2文字の q は
    // `title LIKE '%q%' OR actresses LIKE '%q%'` になり、idx_sale_start を新しい順に舐めて
    // 20件そろうまで進む計画になる。コストは語の「密度」に反比例する:
    //   実測(ローカル27万件, LIMIT 21 換算): 痴女=831行 / 人妻=441 / 中出=172 … 安い
    //                                       制服=1,897 / 紺野=3,877 / 看護=5,677 / 眼鏡=19,959 … 高い
    // 2026-09-07 の本番では 1回 31,000〜57,000行 × 35回/6h = 1.45M行（その時間帯の20%）。
    //
    // 下限を付けても **よくある語の結果は変わらない**（新着順の先頭20件は下限より新しい）。
    // 変わるのは「1年より古い作品しか無い珍しい2文字」だけで、そこが高コストの正体。
    // 3文字以上は FTS が効くので対象外。
    const SHORT_Q_FLOOR = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const shortQFloorCond = (isMgs: boolean) =>
        isMgs ? "REPLACE(sale_start_date, '/', '-') >= ?" : 'sale_start_date >= ?';

    // ── MATCH式の組み立て（プローブ側とSQL組み立て側で必ず同じ文字列を使う）─────────
    const qMatch = q && q.length >= 3 ? `{title actresses} : "${esc5(q)}"` : null;
    const genreList = genre ? genre.split(',').map(s => s.trim()).filter(Boolean) : [];
    const longGenres = genreList.filter(g => g.length >= 3);
    const genreMatch = longGenres.length > 0
        ? `genres : (${longGenres.map(g => `"${esc5(g)}"`).join(' OR ')})` : null;
    const labelMatch = label && label.length >= 3 ? `label : "${esc5(label)}"` : null;
    // 指定レーベルがカタログに実在する名前そのものか（→ `label = ?` で idx_label_date を使う）。
    // **FANZA だけ**（2026-09-11）。MGS も idx_label_date を持つが、MGS の並び順は
    // REPLACE(sale_start_date) 式や wish_count で索引の順序と合わず、そのレーベルの全作品を
    // 読んで一時ソートになる（実測 1回 3,204行）。MGS は従来の FTS 計画のほうが安い
    // （密なら idx_sale_date_norm / idx_wish を順に舐めて LIMIT で止まる）。
    const isExactLabel = (isMgs: boolean) =>
        !isMgs && !!label && !!shortNameIndex?.labels?.fanza?.includes(label);

    // FANZA 品番の前方一致範囲は **先に主キーで id に解決する**（2026-09-10）。
    // `(FTS条件 OR (product_id >= ? AND product_id < ?))` は本番 D1 では MULTI-INDEX OR に
    // ならず、`SEARCH products USING INDEX idx_sale_start` を舐める計画になっていた
    // （EXPLAIN で確認。09-06 にローカルで確かめた計画と違った）。実測 1回 54,000〜135,000行。
    // 範囲の id を FTS の一致 id と1本の `product_id IN (...)` にまとめれば OR が消える。
    const ID_RANGE_KEY = ' idrange';
    const fanzaIdRange = q && q.length >= 3 && /^[\x20-\x7E]+$/.test(q) ? idPrefixRange(q, false) : null;
    const actressMatch = (names: string[]) => {
        const longs = names.filter(a => a.length >= 3);
        return longs.length > 0 ? `actresses : (${longs.map(a => `"${esc5(a)}"`).join(' OR ')})` : null;
    };

    /** この検索で使う MATCH 式を1回ずつプローブして計画を決める。 */
    async function preparePlans(
        client: Awaited<ReturnType<typeof getMgsClient>>, isMgs: boolean,
    ): Promise<PlanMap> {
        const plans: PlanMap = new Map();
        if (!client) return plans;
        const c = client;
        const pf = isMgs ? 'm' : 'f';
        const exprs = new Set<string>();
        for (const e of [qMatch, genreMatch, isExactLabel(isMgs) ? null : labelMatch,
                         ...actressGroups.map(actressMatch),
                         hasProfileFilter ? actressMatch(profileActresses) : null]) {
            if (e) exprs.add(e);
        }
        /** 一致 id を最大 Q_PROBE_CAP 件まで取る。失敗したら null（呼び出し側は従来の計画に戻す）。 */
        const probe = async (key: string, sql: string, args: string[]): Promise<ProbeResult | null> => {
            const hit = probeCacheGet(key);
            if (hit) return hit;
            try {
                const res = await c.execute({ sql, args });
                // **重複を除いてから数える**（2026-09-10）。products_fts には INSERT OR REPLACE が
                // 溜めた重複行が残っていて（cleanup_fts_duplicates.mjs が掃除中）、1作品が最大32行ある。
                // 行数のまま数えると疎な語を「密」と誤判定して LIKE の日付順走査に落ち、
                // 実測 1回 104,798行（女優指定・fanza-0）を読んでいた。IN にも同じ id が32回並んでいた。
                const ids = [...new Set(res.rows.map(row => String((row as Record<string, unknown>).product_id)))];
                const r: ProbeResult = ids.length > Q_PROBE_CAP
                    ? { dense: true }
                    // SQLへ直接埋め込むので、埋め込み可能な文字だけに限る（D1のバインドは1文100個まで）。
                    : { ids: ids.filter(id => /^[A-Za-z0-9_-]+$/.test(id)) };
                probeCacheSet(key, r);
                return r;
            } catch {
                return null;
            }
        };
        await Promise.all([
            ...[...exprs].map(async expr => {
                const r = await probe(`${pf}|${expr}`,
                    `SELECT DISTINCT product_id FROM products_fts WHERE products_fts MATCH ? LIMIT ${Q_PROBE_CAP + 1}`,
                    [expr]);
                // プローブが失敗したら従来どおり FTS サブクエリで引く（null）
                plans.set(expr, !r ? null
                    : 'dense' in r ? (canEarlyStop() ? { kind: 'like' } : null)
                    : { kind: 'ids', ids: r.ids });
            }),
            (async () => {
                if (isMgs || !fanzaIdRange) return;
                const r = await probe(`${pf}|idrange|${fanzaIdRange[0]}`,
                    `SELECT product_id FROM products WHERE product_id >= ? AND product_id < ? LIMIT ${Q_PROBE_CAP + 1}`,
                    fanzaIdRange);
                // 範囲が密（2000件超）なら従来の範囲条件のまま（その場合は日付順走査でもすぐ埋まる）
                plans.set(ID_RANGE_KEY, r && !('dense' in r) ? { kind: 'ids', ids: r.ids } : null);
            })(),
        ]);
        return plans;
    }

    // 共通SQL条件ビルダー
    function buildConditions(isMgs: boolean, plans: PlanMap = new Map()) {
        const conditions: string[] = [];
        const args: (string | number)[] = [];
        const qPlan = qMatch ? (plans.get(qMatch) ?? null) : null;

        // 埋め込み済み id の総文字数。上限を超えたら FTS サブクエリへ戻す。
        let embedded = 0;
        /**
         * FTS 条件を計画に応じて組み立てる。
         *  ids  … 一致IDを直接 IN に埋める（主キーの点引き。最速）
         *  like … 日付索引を新しい順に舐めて LIMIT で止める（密な語で最速）
         *  null … 従来どおり FTS サブクエリ
         * 戻り値 null は「一致0件と分かっている」＝呼び出し側で 0=1 にする。
         */
        const ftsCond = (
            matchExpr: string | null,
            likeCond: () => { sql: string; args: string[] } | null,
        ): { sql: string; args: (string | number)[] } | null => {
            if (!matchExpr) return null;
            const plan = plans.get(matchExpr) ?? null;
            if (plan?.kind === 'ids') {
                if (plan.ids.length === 0) return null;
                const embed = plan.ids.map(id => `'${id}'`).join(',');
                if (embedded + embed.length <= MAX_EMBED_CHARS) {
                    embedded += embed.length;
                    return { sql: `product_id IN (${embed})`, args: [] };
                }
            } else if (plan?.kind === 'like') {
                const lk = likeCond();
                if (lk) return { sql: lk.sql, args: lk.args };
            }
            return { sql: FTS_IN, args: [matchExpr] };
        };

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
                // 本文一致の条件は preparePlans() の結果で作り分ける（上のコメント参照）。
                // qPlan が無い（プローブ失敗・MGSクライアント不在など）ときは従来の FTS サブクエリ。
                const textConds: string[] = [];
                const textArgs: (string | number)[] = [];
                // 主キーの点引きにまとめる id（FTSの一致・品番範囲・正準品番・MGS品番候補）。
                // 別々の IN / 範囲を OR でつなぐと索引が外れるので、必ず1本の IN にする。
                const idList: string[] = [];
                if (qPlan?.kind === 'ids') {
                    // 一致0件でも product_id の前方一致(品番検索)は残したいので、ここでは何も足さない
                    idList.push(...qPlan.ids);
                } else if (qPlan?.kind === 'like') {
                    textConds.push('(title LIKE ? OR actresses LIKE ?)');
                    textArgs.push(`%${q}%`, `%${q}%`);
                } else {
                    textConds.push(FTS_IN);
                    textArgs.push(qMatch as string);
                }

                const idConds: string[] = [];
                const idArgs: string[] = [];
                if (qIsAscii && isMgs) {
                    if (qLooksLikeId) {
                        const cands = mgsIdCandidates(q);
                        // 索引で候補を作れたら主キーの点引き。索引が読めないときだけ全走査のLIKE。
                        if (cands) idList.push(...cands);
                        else { idConds.push('product_id LIKE ?'); idArgs.push(`%${q}%`); }
                    }
                } else if (qIsAscii) {
                    const range = idPrefixRange(q, false);
                    const canon = canonicalFanzaId(q);
                    const rangePlan = plans.get(ID_RANGE_KEY) ?? null;
                    if (range && rangePlan?.kind === 'ids') idList.push(...rangePlan.ids);
                    else if (range) { idConds.push('(product_id >= ? AND product_id < ?)'); idArgs.push(range[0], range[1]); }
                    // canonicalFanzaId は英小文字＋数字しか返さないので埋め込んでよい
                    if (canon) idList.push(canon);
                }
                const uniqIds = [...new Set(idList)];
                if (uniqIds.length > 0) {
                    const embed = uniqIds.map(id => `'${id}'`).join(',');
                    embedded += embed.length;
                    // 引数を持たない条件なので先頭に置いても args の順序はずれない
                    idConds.unshift(`product_id IN (${embed})`);
                }

                const all = [...textConds, ...idConds];
                // 全部空＝FTSが0件で品番でもない → 走査せず0件（従来はFTSサブクエリで同じ結果を高く買っていた）
                conditions.push(all.length > 0 ? `(${all.join(' OR ')})` : '0=1');
                args.push(...textArgs, ...idArgs);
            } else if (qIsAscii) {
                conditions.push(`(title LIKE ? OR actresses LIKE ? OR product_id LIKE ?)`);
                args.push(`%${q}%`, `%${q}%`, `%${q}%`);
                conditions.push(shortQFloorCond(isMgs));
                args.push(SHORT_Q_FLOOR);
            } else {
                conditions.push(`(title LIKE ? OR actresses LIKE ?)`);
                args.push(`%${q}%`, `%${q}%`);
                conditions.push(shortQFloorCond(isMgs));
                args.push(SHORT_Q_FLOOR);
            }
        }
        if (genre && genreList.length > 0) {
            // カンマ区切りで複数ジャンルOR対応
            const shortGenres = genreList.filter(g => g.length < 3);
            const subConds: string[] = [];
            // ありふれたジャンル（>2000件）は FTS_IN だと一致件数ぶんの点引きになり
            // 1回で25万行読むことがある。密なら LIKE に落として日付順の早期打ち切りに任せる。
            const gc = ftsCond(genreMatch, () => ({
                sql: `(${longGenres.map(() => 'genres LIKE ?').join(' OR ')})`,
                args: longGenres.map(g => `%${g}%`),
            }));
            if (gc) { subConds.push(gc.sql); args.push(...gc.args); }
            shortGenres.forEach(g => {
                subConds.push('genres LIKE ?');
                args.push(`%${g}%`);
            });
            // 長いジャンルが「一致0件」で短いジャンルも無いなら 0件（走査しない）
            conditions.push(subConds.length > 0 ? `(${subConds.join(' OR ')})` : '0=1');
        }
        if (maker) {
            // MGS/FANZA共にlabelも検索対象に含める（メーカー一覧のレーベル項目に対応）
            // `LIKE '%X%'` は maker/label にインデックスが効かず、idx_sale_start を日付順に
            // 舐める計画になる。詳細検索の文脈絞り込みは LIMIT 500 で投げてくるので走査が深く、
            // 2026-09-07 実測で 1回 37,000〜42,000行 × 15回/6h = 658,000行（その時間帯の9%）だった。
            // 指定名が**カタログに実在するメーカー/レーベル名そのもの**なら等値比較にする。
            // 等値なら migrations/0011 の (maker, sale_start_date DESC) が効いて範囲引きで済むうえ、
            // 「プレミアム」で「桃太郎プレミアムベスト」を拾うような取り違えも消える。
            const knownExact = exactMaker
                || knownMakerNames?.has(maker)
                || !!shortNameIndex?.labels?.[isMgs ? 'mgs' : 'fanza']?.includes(maker);
            if (knownExact) {
                // 完全一致（メーカー詳細ページ用: Hunterでlady huntersを除外）
                conditions.push('(maker = ? OR label = ?)');
                args.push(maker, maker);
            } else {
                conditions.push('(maker LIKE ? OR label LIKE ?)');
                args.push(`%${maker}%`, `%${maker}%`);
            }
        }
        if (label) {
            if (isExactLabel(isMgs)) {
                // カタログに実在するレーベル名そのもの → 等値比較（2026-09-10）。
                // `label LIKE '%X%'` は索引が効かず idx_sale_start を日付順に舐める計画で、
                // 実測 1回 7,600〜12,200行 × 88回/日 ≒ 90万行（その日の15%）だった。
                // 等値なら migrations/0011 の idx_label_date で範囲引きになる（EXPLAIN 確認済み）。
                // maker と同じく、別レーベルの部分一致（取り違え）も拾わなくなる。
                conditions.push('label = ?');
                args.push(label);
            } else if (label.length >= 3) {
                const lc = ftsCond(labelMatch, () => ({ sql: 'label LIKE ?', args: [`%${label}%`] }));
                if (lc) { conditions.push(lc.sql); args.push(...lc.args); }
                else conditions.push('0=1');
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
            // ジャンルと同じ理由で、一致が密な女優名（ありふれた部分文字列）は LIKE に落とす。
            const ac = ftsCond(actressMatch(group), () => ({
                sql: `(${longActresses.map(() => 'actresses LIKE ?').join(' OR ')})`,
                args: longActresses.map(a => `%${a}%`),
            }));
            if (ac) { actSubConds.push(ac.sql); args.push(...ac.args); }
            shortActresses.forEach(a => {
                const c = shortActressCond(a, isMgs);
                if (c.sql === null) return; // 一致0件と分かっている名前は条件から外す
                actSubConds.push(c.sql);
                args.push(...c.args);
            });
            // 条件が1つも残らない＝指定された名前がどれも一致しない、なので 0件で返す。
            // ここで条件を push しないと **女優の絞り込みが丸ごと消えて全件返る**（絞り込み解除）。
            conditions.push(actSubConds.length > 0 ? `(${actSubConds.join(' OR ')})` : '0=1');
        }
        if (hasProfileFilter) {
            const longProfiles = profileActresses.filter(a => a.length >= 3);
            const shortProfiles = profileActresses.filter(a => a.length < 3);
            const profSubConds: string[] = [];
            const pc = ftsCond(actressMatch(profileActresses), () => ({
                sql: `(${longProfiles.map(() => 'actresses LIKE ?').join(' OR ')})`,
                args: longProfiles.map(a => `%${a}%`),
            }));
            if (pc) { profSubConds.push(pc.sql); args.push(...pc.args); }
            shortProfiles.forEach(a => {
                const c = shortActressCond(a, isMgs);
                if (c.sql === null) return; // 一致0件と分かっている名前は条件から外す
                profSubConds.push(c.sql);
                args.push(...c.args);
            });
            conditions.push(profSubConds.length > 0 ? `(${profSubConds.join(' OR ')})` : '0=1');
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
            conditions.push('COALESCE(duration_min, 0) < 600');
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
        // 割引率が高い順。**products. で修飾**しないと SELECT の
        // `COALESCE(discount_pct,0) AS discount_pct` に横取りされ、idx_discount が
        // 範囲引きに使えても並び替えが USE TEMP B-TREE FOR ORDER BY（＝該当全行を実体化）になる。
        if (sort === 'discount') return 'ORDER BY products.discount_pct DESC';
        return isMgs ? 'ORDER BY wish_count DESC' : 'ORDER BY sale_start_date DESC';
    }

    const selectCols = (isMgs: boolean) => `product_id, title, actresses, main_image_url,
                         ${isMgs ? 'wish_count,' : '0 AS wish_count,'}
                         genres, maker, duration_min, sale_start_date,
                         sample_video_url,
                         ${isMgs ? 'COALESCE(discount_pct, 0) AS discount_pct, list_price, current_price, NULL AS series_name, NULL AS series_id, 0 AS vr_flag, sale_end_date' : 'COALESCE(discount_pct, 0) AS discount_pct, list_price, current_price, series_name, series_id, COALESCE(vr_flag, 0) AS vr_flag, sale_end_date'}`;
    const shapeRow = (row: unknown, isMgs: boolean) => {
        const r = { ...(row as Record<string, unknown>) };
        r.actresses = filterActresses(
            (r.actresses as string | null) || null,
            (r.genres as string | null) || null,
            (r.maker as string | null) || null
        );
        r.source = isMgs ? 'mgs' : 'fanza';
        return r;
    };

    async function queryTurso(client: Awaited<ReturnType<typeof getMgsClient>>, isMgs: boolean, perLimit: number) {
        if (!client) return [];
        try {
            const plans = await preparePlans(client, isMgs);
            const { conditions, args } = buildConditions(isMgs, plans);
            const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
            const cols = selectCols(isMgs);
            const sql = sort === 'random'
                // 新着 RANDOM_POOL 件に絞ってからシャッフル（OFFSETはランダムでは無意味なので使わない）
                ? `SELECT * FROM (SELECT ${cols} FROM products ${where} ${dateOrderBy(isMgs)} LIMIT ${RANDOM_POOL})
                   ORDER BY RANDOM() LIMIT ${perLimit}`
                : `SELECT ${cols} FROM products ${where} ${buildOrderBy(isMgs)} LIMIT ${perLimit} OFFSET ${perOffset}`;

            const result = await client.execute({ sql, args });
            return result.rows.map(row => shapeRow(row, isMgs));
        } catch (err) {
            console.error(`Query error (${isMgs ? 'mgs' : 'fanza'}):`, err);
            d1Unavailable = true;
            return [];
        }
    }

    // ── 品番の完全一致（2026-09-14）─────────────────────────────────
    // 「SSIS-123」「MIFD-060」のように品番を入れると、英字部の前方一致（ssis の全作品）が
    // 配信日の新しい順に並び、**目当ての作品が先頭41件に入らない**ことがあった（旧作ほど埋もれる）。
    // 完全な品番の形（数字プレフィクス可・英字・数字）で実在する作品が当たったら、それだけを返す。
    // 当たらなければ従来の広い検索に落とす。主キーの点引きなので D1 は数行しか読まない。
    const FULL_ID_RE = /^\d*[A-Za-z]+[-_ ]?\d{2,}[A-Za-z]?$/;
    const qTrim = (q || '').trim();
    if (qTrim && offset === 0 && FULL_ID_RE.test(qTrim)
        && !genre && !maker && !label && !series && actressNames.length === 0) {
        const safe = (ids: (string | null | undefined)[]) =>
            [...new Set(ids.filter((x): x is string => !!x && /^[A-Za-z0-9_-]+$/.test(x)))];
        const compact = qTrim.replace(/[\s_]/g, '');
        const fanzaCands = safe([canonicalFanzaId(qTrim), compact.replace(/-/g, '').toLowerCase()]);
        const mgsUpper = compact.toUpperCase();
        const mgsCands = safe([...(mgsIdCandidates(qTrim) ?? []), mgsUpper.includes('-') ? mgsUpper : mgsUpper.replace(/^(\d*[A-Z]+)(\d+)$/, '$1-$2')]);
        const exactQuery = async (client: Awaited<ReturnType<typeof getMgsClient>>, isMgs: boolean, ids: string[]) => {
            if (!client || ids.length === 0) return [];
            try {
                const r = await client.execute({
                    sql: `SELECT ${selectCols(isMgs)} FROM products WHERE product_id IN (${ids.map(id => `'${id}'`).join(',')}) LIMIT 10`,
                    args: [],
                });
                return r.rows.map(row => shapeRow(row, isMgs));
            } catch { return []; }
        };
        const [mgsExact, fanzaExact] = await Promise.all([
            source === 'fanza' ? Promise.resolve([]) : exactQuery(mgsClient, true, mgsCands),
            source === 'mgs' ? Promise.resolve([]) : exactQuery(fanzaClient, false, fanzaCands),
        ]);
        const exact = [...mgsExact, ...fanzaExact];
        if (exact.length > 0) {
            return NextResponse.json(exact, { headers: { 'Content-Type': 'application/json', ...cacheHeaders(1800, 600) } });
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

    // D1 が途中で枠切れ/障害になって 0 件のときも縮退応答（degradedResponse の定義を参照）
    if (result.length === 0 && d1Unavailable) {
        const degraded = await degradedResponse();
        if (degraded) return degraded;
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
