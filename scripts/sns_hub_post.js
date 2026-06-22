/**
 * SNSハブ投稿(WS4): 長尾LP/ハブページ(/ranking・/genres・/genre/X・/sale)への週次プロモを
 * Bluesky に投稿し、トラフィックとソーシャルシグナルをハブへ送る。
 *
 * 個別作品投稿(bluesky_autopost.js / x_browser_post.js)とは別物で、
 * 「まとめページ」へ誘導することで内部リンクの発見性とLPの被リンク/シグナルを補強する。
 *
 * 利用:
 *   node scripts/sns_hub_post.js                 # ランダムなハブへ1投稿
 *   node scripts/sns_hub_post.js --target=ranking
 *   node scripts/sns_hub_post.js --dry-run
 *
 * 認証: bluesky_autopost.js と同じ BSKY_MAIN_IDENTIFIER / BSKY_MAIN_PASSWORD(.env.local)。
 */
require('dotenv').config({ path: './site/.env.local' });
const fs = require('fs');
const path = require('path');
const { AtpAgent, RichText } = require('@atproto/api');

const SITE = 'https://avrankings.com';
const isDry = process.argv.includes('--dry-run');
const arg = (k) => { const a = process.argv.find(x => x.startsWith('--' + k)); return a ? (a.split('=')[1] ?? true) : null; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// 固定ハブ
const FIXED_TARGETS = {
    ranking: { url: '/ranking', label: '総合人気ランキング', tag: '#AVランキング',
        phrases: ['今週の人気ランキングを更新。みんなが選んだ作品には理由がある', '評価が高い作品を人気順にまとめました。気になるやつを探して'] },
    genres:  { url: '/genres', label: '人気ジャンル一覧', tag: '#AV',
        phrases: ['ジャンルから探せるようにしました。好みのジャンルの人気作をどうぞ', '巨乳・人妻・素人…ジャンル別の人気ランキングまとめ'] },
    sale:    { url: '/sale', label: 'セール中の人気作品', tag: '#AVセール',
        phrases: ['今セール中のお得な作品をまとめました。タイミング逃すともったいない', 'セール情報まとめ。普段の値段知ってると驚く割引率'] },
};

// genres_cache.json から人気ジャンルLPをターゲットに加える(なければ固定のみ)
function loadGenreTargets() {
    try {
        const p = path.join(__dirname, '..', 'site', 'data', 'genres_cache.json');
        const genres = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return genres.slice(0, 20).map(g => ({
            url: `/genre/${encodeURIComponent(g.name)}`,
            label: `${g.name}の人気AV作品`,
            tag: `#${g.name.replace(/[^\p{L}\p{N}]/gu, '')}`,
            phrases: [`${g.name}の人気作品を人気順にまとめました`, `${g.name}好きはこれ見て。人気ランキングはこちら`],
        }));
    } catch { return []; }
}

function buildTargets() {
    const which = arg('target');
    if (which && FIXED_TARGETS[which]) return [FIXED_TARGETS[which]];
    return [...Object.values(FIXED_TARGETS), ...loadGenreTargets()];
}

async function fetchOgCard(url) {
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Blueskybot/1.0' }, signal: AbortSignal.timeout(8000) });
        const html = await res.text();
        const meta = (prop) => {
            const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
                || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
            return m ? m[1] : null;
        };
        return { uri: url, title: meta('og:title') || url, description: meta('og:description') || '', thumb: meta('og:image') || null };
    } catch { return { uri: url, title: url, description: '', thumb: null }; }
}

async function postToBluesky(agent, text, ogCard) {
    const rt = new RichText({ text });
    await rt.detectFacets(agent);
    const extEmbed = { $type: 'app.bsky.embed.external', external: { uri: ogCard.uri, title: ogCard.title, description: ogCard.description } };
    if (ogCard.thumb && !isDry) {
        try {
            const imgRes = await fetch(ogCard.thumb);
            const buf = Buffer.from(await imgRes.arrayBuffer());
            const up = await agent.uploadBlob(buf, { encoding: imgRes.headers.get('content-type') || 'image/jpeg' });
            extEmbed.external.thumb = up.data.blob;
        } catch { /* サムネ失敗は無視 */ }
    }
    const record = {
        text: rt.text, facets: rt.facets, embed: extEmbed,
        labels: { $type: 'com.atproto.label.defs#selfLabels', values: [{ val: 'sexual' }] },
        createdAt: new Date().toISOString(),
    };
    if (isDry) {
        console.log('\n[DRY RUN] Bluesky ハブ投稿シミュレーション\n' + '─'.repeat(40));
        console.log('テキスト:', rt.text);
        console.log('URL:', ogCard.uri, '\nOGタイトル:', ogCard.title, '\n' + '─'.repeat(40));
        return { uri: 'dry_run' };
    }
    return agent.post(record);
}

(async () => {
    const target = pick(buildTargets());
    const url = `${SITE}${target.url}`;
    const phrase = pick(target.phrases);
    const text = `${phrase}\n${target.tag} #AV`;

    console.log(`[ハブ投稿] ${target.label} → ${url}`);
    const ogCard = await fetchOgCard(url);

    const agent = new AtpAgent({ service: 'https://bsky.social' });
    if (!isDry) {
        const id = process.env.BSKY_MAIN_IDENTIFIER, pw = process.env.BSKY_MAIN_PASSWORD;
        if (!id || !pw) throw new Error('BSKY_MAIN_IDENTIFIER / BSKY_MAIN_PASSWORD が未設定です');
        await agent.login({ identifier: id, password: pw });
        console.log(`[ログイン] ${id}`);
    }
    const posted = await postToBluesky(agent, text, ogCard);
    console.log(`✅ 完了 (ハブ投稿 / ${target.label}) ${posted.uri}`);
})().catch(e => { console.error('❌ エラー:', e.message); process.exit(1); });
