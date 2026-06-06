import { NextRequest, NextResponse } from 'next/server';
import { filterActresses } from '../../../lib/actressFilter';
import { getMgsClient, getFanzaClient } from '../../../lib/turso';
import { getCached, setCached } from '../../../lib/apiCache';
import { readStaticCacheAsync as readStaticCache, cacheHeaders } from '../../../lib/staticCache';

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
        && !searchParams.get('ageMin') && !searchParams.get('ageMax');

    // 女優別商品リストを静的JSONから返す（Tursoクエリ不要）
    // top_products(top200) → extended_products(~2000人) の順で検索
    const actressParam = searchParams.get('actress') || '';
    // excludeBest条件を外す: キャッシュはBEST除外済みデータを格納しているため
    if (
        actressParam && offset === 0 &&
        (sort === 'new' || sort === '') &&
        !searchParams.get('q') && !searchParams.get('genre') && !searchParams.get('maker') &&
        !searchParams.get('fromDate') && !searchParams.get('toDate') && !searchParams.get('source') &&
        !searchParams.get('vr') && !searchParams.get('hasVideo')
    ) {
        const [topCache, extCache] = await Promise.all([
            readStaticCache<Record<string, unknown[]>>('actress_top_products.json'),
            readStaticCache<Record<string, unknown[]>>('actress_extended_products.json'),
        ]);
        const products = topCache?.[actressParam] ?? extCache?.[actressParam];
        if (products && products.length > 0) {
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
        const saleCached = await readStaticCache<unknown[]>('sale_cache.json');
        if (saleCached && saleCached.length > 0) {
            const minD = parseInt(searchParams.get('minDiscount') || '0', 10);
            const filtered = minD > 0
                ? (saleCached as Array<Record<string, unknown>>).filter(p => Number(p.discount_pct) >= minD)
                : saleCached;
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
    const excludeBest = searchParams.get('excludeBest') === '1'; // BEST/総集編を除外
    const hasVideo = searchParams.get('hasVideo') === '1'; // サンプル動画ありのみ
    const series = searchParams.get('series') || ''; // シリーズ名
    const vrOnly = searchParams.get('vr') === '1'; // VR作品のみ
    const minDiscount = parseInt(searchParams.get('minDiscount') || '0', 10); // 最低割引率

    // 女優名寄せ辞書
    let actressList = [actress];
    if (actress) {
        try {
            const aliasesData = await readStaticCache<string[][]>('actress_aliases.json');
            if (aliasesData) {
                const entry = aliasesData.find((a: string[]) => a.includes(actress));
                if (entry) actressList = entry;
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

    if (!mgsClient && !fanzaClient) {
        return NextResponse.json([], { status: 503 });
    }

    // FTS5 special char エスケープ
    function esc5(s: string): string { return s.replace(/"/g, '""'); }
    // FTS5 サブクエリ（?にMATCH文字列をバインド）
    const FTS_IN = `product_id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?)`;

    // 共通SQL条件ビルダー
    function buildConditions(isMgs: boolean) {
        const conditions: string[] = [];
        const args: (string | number)[] = [];

        if (q) {
            if (q.length >= 3) {
                const qMatch = `{title actresses} : "${esc5(q)}"`;
                conditions.push(`(${FTS_IN} OR product_id LIKE ?)`);
                args.push(qMatch, `%${q}%`);
            } else {
                conditions.push(`(title LIKE ? OR actresses LIKE ? OR product_id LIKE ?)`);
                args.push(`%${q}%`, `%${q}%`, `%${q}%`);
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
                conditions.push('label LIKE ?');
                args.push(`%${label}%`);
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
        if (actress) {
            const longActresses = actressList.filter(a => a.length >= 3);
            const shortActresses = actressList.filter(a => a.length < 3);
            const actSubConds: string[] = [];
            if (longActresses.length > 0) {
                const escaped = longActresses.map(a => `"${esc5(a)}"`).join(' OR ');
                actSubConds.push(FTS_IN);
                args.push(`actresses : (${escaped})`);
            }
            shortActresses.forEach(a => {
                actSubConds.push('actresses LIKE ?');
                args.push(`%${a}%`);
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
                profSubConds.push('actresses LIKE ?');
                args.push(`%${a}%`);
            });
            if (profSubConds.length > 0) conditions.push(`(${profSubConds.join(' OR ')})`);
        }
        const today = new Date().toISOString().slice(0, 10);
        if (sort === 'pre-order') {
            // 未配信作品のみ（今日より後）
            // MGS: YYYY/MM/DD（スラッシュ） → REPLACE で正規化
            // FANZA: YYYY-MM-DD HH:MM:SS（タイムスタンプ） → SUBSTR で日付部分のみ取得
            conditions.push(isMgs ? "REPLACE(sale_start_date, '/', '-') > ?" : "SUBSTR(sale_start_date, 1, 10) > ?");
            args.push(today);
        }
        if (sort === 'new') {
            // 配信済み作品のみ（予約作品を除く）
            conditions.push("sale_start_date IS NOT NULL");
            conditions.push(isMgs ? "REPLACE(sale_start_date, '/', '-') <= ?" : "SUBSTR(sale_start_date, 1, 10) <= ?");
            args.push(today);
        }
        if (fromDate) {
            conditions.push(isMgs ? "REPLACE(sale_start_date, '/', '-') >= ?" : "SUBSTR(sale_start_date, 1, 10) >= ?");
            args.push(fromDate);
        }
        if (toDate) {
            conditions.push(isMgs ? "REPLACE(sale_start_date, '/', '-') <= ?" : "SUBSTR(sale_start_date, 1, 10) <= ?");
            args.push(toDate);
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
            ['%BEST%', '%ベスト%', '%総集編%', '%コレクション%', '%Best%'].forEach(p => {
                conditions.push('title NOT LIKE ?');
                args.push(p);
            });
            // 予約作品はduration_minが未確定なのでdurationフィルターを除外
            if (sort !== 'pre-order') {
                conditions.push('(duration_min IS NULL OR duration_min <= 200)');
            }
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

    function buildOrderBy(isMgs: boolean) {
        // MGSは YYYY/MM/DD 形式のため REPLACE で正規化 → 関数インデックス idx_sale_date_norm が効く
        if (sort === 'new' || sort === 'date_all') return isMgs ? "ORDER BY REPLACE(sale_start_date,'/','-') DESC" : 'ORDER BY sale_start_date DESC';
        if (sort === 'pre-order') return isMgs ? "ORDER BY REPLACE(sale_start_date,'/','-') DESC" : 'ORDER BY SUBSTR(sale_start_date,1,10) DESC';
        if (sort === 'random') return 'ORDER BY RANDOM()';
        if (sort === 'discount') return 'ORDER BY discount_pct DESC';         // 割引率が高い順
        return isMgs ? 'ORDER BY wish_count DESC' : 'ORDER BY sale_start_date DESC';
    }

    async function queryTurso(client: Awaited<ReturnType<typeof getMgsClient>>, isMgs: boolean, perLimit: number) {
        if (!client) return [];
        try {
            const { conditions, args } = buildConditions(isMgs);
            const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
            const orderBy = buildOrderBy(isMgs);
            const sql = `SELECT product_id, title, actresses, main_image_url,
                         ${isMgs ? 'wish_count,' : '0 AS wish_count,'}
                         genres, maker, duration_min, sale_start_date,
                         sample_video_url,
                         ${isMgs ? 'COALESCE(discount_pct, 0) AS discount_pct, list_price, current_price, NULL AS series_name, NULL AS series_id, 0 AS vr_flag, sale_end_date' : 'COALESCE(discount_pct, 0) AS discount_pct, list_price, current_price, series_name, series_id, COALESCE(vr_flag, 0) AS vr_flag, sale_end_date'}
                         FROM products ${where} ${orderBy} LIMIT ${perLimit} OFFSET ${perOffset}`;

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

    const result = combined.slice(0, limit);
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
