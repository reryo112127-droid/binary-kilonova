import { NextRequest, NextResponse } from 'next/server';
import { readStaticCacheAsync, cacheHeaders } from '../../../lib/staticCache';

export const dynamic = 'force-dynamic';

const SITE = 'https://avrankings.com';

// ジャンル別の紹介フレーズ（BotBird等が投稿する文。1作品ごとにランダム選択）
const PHRASES: Record<string, string[]> = {
    new:    ['新作きた！これ絶対チェックして', '今日配信開始のやつ。第一印象めちゃくちゃ良い', 'ついに出た…！待ってた人多いでしょこれ'],
    sale:   ['今セール中だから今のうちに！', 'このタイミング逃したらもったいない。お得すぎ', 'セール情報きた！これはマジで買い'],
    vr:     ['VRで見たら没入感やばすぎた', 'これVR持ってる人は絶対見て。距離感バグる', '目の前にいる感覚がリアルすぎる'],
    collab: ['この組み合わせ、神すぎる…', '共演って奇跡だよね。この二人が揃ったのは今しかない', '単体より共演派にこれは刺さる'],
    anon:   ['この素人感がリアルでめちゃくちゃ良い', 'ガチ感がすごい。演技じゃ出せないリアクション', '隠れた名作見つけた'],
    lady:   ['大人の色気ってこういうことだよね', '夜にゆっくり見てほしい。雰囲気が良い', '癒されたい夜にぴったりの一本'],
};

type Work = { product_id?: string; title?: string; actresses?: string; genres?: string; maker?: string; source?: string; sale_start_date?: string };

// ジャンルに合う作品を静的キャッシュから選ぶ（D1読み取りゼロ）
async function selectWorks(genre: string): Promise<Work[]> {
    const [nw, pop, sale] = await Promise.all([
        readStaticCacheAsync<Work[]>('products_new_cache.json'),
        readStaticCacheAsync<Work[]>('products_popular_cache.json'),
        readStaticCacheAsync<Work[]>('sale_cache.json'),
    ]);
    const pool = [...(nw || []), ...(pop || [])];
    const hasAct = (w: Work) => !!(w.actresses && w.actresses.trim());
    if (genre === 'new')  return (nw || []).filter(hasAct).slice(0, 30);
    if (genre === 'sale') return (sale || []).filter(hasAct).slice(0, 30);
    if (genre === 'vr')   return pool.filter(w => hasAct(w) && /VR/i.test(w.genres || '')).slice(0, 30);
    if (genre === 'lady') return pool.filter(w => hasAct(w) && /人妻|熟女|母/.test(w.genres || '')).slice(0, 30);
    if (genre === 'anon') return pool.filter(w => hasAct(w) && (/素人|ハメ撮り|ナンパ/.test(w.genres || '') || /素人|シロウト|ナンパ/.test(w.maker || ''))).slice(0, 30);
    if (genre === 'collab') return pool.filter(w => hasAct(w) && /[,、]/.test(w.actresses || '')).slice(0, 30);
    return (nw || []).filter(hasAct).slice(0, 30);
}

function actressTags(raw: string): string {
    return String(raw || '').split(/[,、/／]+/).map(s => s.trim())
        .filter(n => n && n.length > 1 && !/\d+歳|[（()【】\[\]]/.test(n))
        .slice(0, 3).map(n => '#' + n.replace(/\s+/g, '_')).join(' ');
}
const xmlEsc = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
// product_id を元に毎回同じフレーズを選ぶ（フィード安定化）
function pick(arr: string[], seed: string): string {
    let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return arr[h % arr.length];
}

export async function GET(request: NextRequest) {
    const genre = (new URL(request.url).searchParams.get('genre') || 'new').toLowerCase();
    const pool = PHRASES[genre] ? genre : 'new';
    const works = await selectWorks(pool);

    const items = works.map((w) => {
        const pid = String(w.product_id || '');
        if (!pid) return '';
        const phrase = pick(PHRASES[pool], pid);
        const tags = actressTags(String(w.actresses || ''));
        const url = `${SITE}/product/${encodeURIComponent(pid)}?og=pkg`;
        const text = [phrase, tags].filter(Boolean).join(' ');
        const date = (w.sale_start_date || '').replace(/\//g, '-').slice(0, 10);
        const pub = date ? new Date(date + 'T12:00:00+09:00').toUTCString() : new Date().toUTCString();
        return `    <item>
      <title>${xmlEsc(text)}</title>
      <link>${xmlEsc(url)}</link>
      <guid isPermaLink="false">${xmlEsc(pid)}</guid>
      <description>${xmlEsc(text + ' ' + url)}</description>
      <pubDate>${pub}</pubDate>
    </item>`;
    }).filter(Boolean).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>avrankings 投稿フィード (${xmlEsc(pool)})</title>
    <link>${SITE}</link>
    <description>${xmlEsc(pool)} ジャンルのおすすめ作品</description>
    <language>ja</language>
${items}
  </channel>
</rss>`;

    return new NextResponse(xml, {
        headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', ...cacheHeaders(1800, 600) },
    });
}
