import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { filterActresses } from '../../../lib/actressFilter';
import { getMgsClient, getFanzaClient } from '../../../lib/turso';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const sort = searchParams.get('sort') || 'wish_count';
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const q = searchParams.get('q') || '';
    const genre = searchParams.get('genre') || '';
    const actress = searchParams.get('actress') || '';
    const maker = searchParams.get('maker') || '';
    const label = searchParams.get('label') || '';
    const excludeGenres = searchParams.get('excludeGenres') || '';
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

    // 女優名寄せ辞書
    let actressList = [actress];
    if (actress) {
        try {
            const aliasPath = path.join(process.cwd(), 'data', 'actress_aliases.json');
            if (fs.existsSync(aliasPath)) {
                const aliasesData = JSON.parse(fs.readFileSync(aliasPath, 'utf-8'));
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
            const profilesPath = path.join(process.cwd(), 'data', 'actress_profiles.json');
            if (fs.existsSync(profilesPath)) {
                const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf-8'));
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

    // 共通SQL条件ビルダー
    function buildConditions(isMgs: boolean) {
        const conditions: string[] = [];
        const args: (string | number)[] = [];

        if (q) {
            conditions.push('(title LIKE ? OR actresses LIKE ? OR product_id LIKE ?)');
            args.push(`%${q}%`, `%${q}%`, `%${q}%`);
        }
        if (genre) {
            conditions.push('genres LIKE ?');
            args.push(`%${genre}%`);
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
        if (actress) {
            const actressConditions = actressList.map(() => 'actresses LIKE ?').join(' OR ');
            conditions.push(`(${actressConditions})`);
            actressList.forEach(a => args.push(`%${a}%`));
        }
        if (hasProfileFilter) {
            const profConditions = profileActresses.map(() => 'actresses LIKE ?').join(' OR ');
            conditions.push(`(${profConditions})`);
            profileActresses.forEach(a => args.push(`%${a}%`));
        }
        const today = new Date().toISOString().slice(0, 10);
        if (sort === 'pre-order') {
            // 未配信作品のみ（今日より後）
            // MGS: YYYY/MM/DD（スラッシュ） → REPLACE で正規化してから比較
            // FANZA: YYYY-MM-DD（ハイフン） → そのまま比較可能
            conditions.push("REPLACE(sale_start_date, '/', '-') > ?");
            args.push(today);
        }
        if (sort === 'new') {
            // 配信済み作品のみ（今日以前）
            conditions.push("sale_start_date IS NOT NULL");
            conditions.push("REPLACE(sale_start_date, '/', '-') <= ?");
            args.push(today);
        }
        if (fromDate) {
            conditions.push('sale_start_date >= ?');
            args.push(fromDate);
        }
        if (toDate) {
            conditions.push('sale_start_date <= ?');
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
        if (isMgs) {
            conditions.push('(duration_min IS NULL OR duration_min < 600)');
        }

        return { conditions, args };
    }

    function buildOrderBy(isMgs: boolean) {
        if (sort === 'new') return 'ORDER BY sale_start_date DESC';          // 配信日が新しい順
        if (sort === 'pre-order') return 'ORDER BY scraped_at DESC';          // 新たに追加された順
        if (sort === 'random') return 'ORDER BY RANDOM()';
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
                         ${isMgs ? '0 AS discount_pct, NULL AS list_price, NULL AS current_price' : 'COALESCE(discount_pct, 0) AS discount_pct, list_price, current_price'}
                         FROM products ${where} ${orderBy} LIMIT ${perLimit} OFFSET ${offset}`;

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

    const bothAvailable = mgsClient && fanzaClient;
    const perLimit = bothAvailable ? Math.ceil(limit / 2) : limit;

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

    return NextResponse.json(combined.slice(0, limit));
}
