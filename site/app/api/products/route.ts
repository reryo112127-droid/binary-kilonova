import { NextRequest, NextResponse } from 'next/server';
import { filterActresses } from '../../../lib/actressFilter';
import { getMgsClient, getFanzaClient } from '../../../lib/turso';
import { getCached, setCached } from '../../../lib/apiCache';
import { readStaticCacheAsync as readStaticCache, cacheHeaders } from '../../../lib/staticCache';

export const dynamic = 'force-dynamic';

const PRODUCTS_TTL = 5 * 60 * 1000; // 5分

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const sort = searchParams.get('sort') || 'new';
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const limit = parseInt(searchParams.get('limit') || '20', 10);

    // フィルターなし・offset=0 のみ静的JSONを使用
    const noFilter = !searchParams.get('q') && !searchParams.get('genre') && !searchParams.get('actress')
        && !searchParams.get('maker') && !searchParams.get('fromDate') && !searchParams.get('source')
        && !searchParams.get('cup') && !searchParams.get('height') && !searchParams.get('vr');

    if (noFilter && offset === 0) {
        const file = sort === 'wish_count' ? 'products_popular_cache.json'
                   : sort === 'new'        ? 'products_new_cache.json'
                   : sort === 'pre-order'  ? 'home_preorder_cache.json'
                   : null;
        if (file) {
            const cached = await readStaticCache<unknown[]>(file);
            if (cached && cached.length > 0) return NextResponse.json(
                cached.slice(0, limit),
                { headers: { 'Content-Type': 'application/json', ...cacheHeaders(3600, 86400) } }
            );
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
            return NextResponse.json(
                filtered.slice(0, limit),
                { headers: { 'Content-Type': 'application/json', ...cacheHeaders(3600, 86400) } }
            );
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

    const mgsClient = (source === 'fanza') ? null : getMgsClient();
    const fanzaClient = (source === 'mgs') ? null : getFanzaClient();

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
            // FTS5 trigram は3文字以上必要。短いキーワードは LIKE にフォールバック
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
            // FTS5 trigram は3文字以上必要。短いジャンル名は LIKE にフォールバック
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
            conditions.push('maker LIKE ?');
            args.push(`%${maker}%`);
        }
        if (label) {
            conditions.push('label LIKE ?');
            args.push(`%${label}%`);
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
            // FTS5 trigram は3文字以上必要。短い名前は LIKE にフォールバック
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
            // 配信済み作品のみ（今日以前）
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
            conditions.push('(duration_min IS NULL OR duration_min <= 200)');
        }
        if (hasVideo) {
            conditions.push('sample_video_url IS NOT NULL');
        }
        if (series && !isMgs) {
            conditions.push('series_name LIKE ?');
            args.push(`%${series}%`);
        }
        if (vrOnly && !isMgs) {
            conditions.push('vr_flag = 1');
        }
        if (sort === 'discount' && isMgs) {
            conditions.push('1=0'); // MGSにはセール情報なし
        }
        if (!isMgs && (sort === 'discount' || minDiscount > 0)) {
            const threshold = minDiscount > 0 ? minDiscount : 1;
            conditions.push('discount_pct >= ?');
            args.push(threshold);
        }
        if (isMgs) {
            conditions.push('(duration_min IS NULL OR duration_min < 600)');
        }

        return { conditions, args };
    }

    function buildOrderBy(isMgs: boolean) {
        if (sort === 'new') return 'ORDER BY sale_start_date DESC';          // 配信日が新しい順
        if (sort === 'pre-order') return 'ORDER BY sale_start_date DESC';      // 配信日が遠い順（最も先の日付が先頭）
        if (sort === 'random') return 'ORDER BY RANDOM()';
        if (sort === 'discount') return 'ORDER BY discount_pct DESC';         // 割引率が高い順
        return isMgs ? 'ORDER BY wish_count DESC' : 'ORDER BY sale_start_date DESC';
    }

    async function queryTurso(client: ReturnType<typeof getMgsClient>, isMgs: boolean, perLimit: number) {
        if (!client) return [];
        try {
            const { conditions, args } = buildConditions(isMgs);
            const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
            const orderBy = buildOrderBy(isMgs);
            const sql = `SELECT product_id, title, actresses, main_image_url,
                         ${isMgs ? 'wish_count,' : '0 AS wish_count,'}
                         genres, maker, duration_min, sale_start_date,
                         sample_video_url,
                         ${isMgs ? '0 AS discount_pct, NULL AS list_price, NULL AS current_price, NULL AS series_name, NULL AS series_id, 0 AS vr_flag, NULL AS sale_end_date' : 'COALESCE(discount_pct, 0) AS discount_pct, list_price, current_price, series_name, series_id, COALESCE(vr_flag, 0) AS vr_flag, sale_end_date'}
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

    // 交互にマージ
    const combined: Record<string, unknown>[] = [];
    const maxLen = Math.max(mgsResults.length, fanzaResults.length);
    for (let i = 0; i < maxLen; i++) {
        if (mgsResults[i]) combined.push(mgsResults[i]);
        if (fanzaResults[i]) combined.push(fanzaResults[i]);
    }

    const result = combined.slice(0, limit);
    const cacheKey = (request as NextRequest & { _cacheKey?: string })._cacheKey;
    if (cacheKey) setCached(cacheKey, result);
    return NextResponse.json(result, { headers: { 'Content-Type': 'application/json', ...cacheHeaders(60, 300) } });
}
