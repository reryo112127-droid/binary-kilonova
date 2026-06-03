/**
 * 翌日ポスト用ツイート紹介文をClaudeで事前生成するスクリプト
 *
 * 使い方:
 *   node scripts/generate-tweet-texts.mjs          # 全ジャンルの未生成分を処理
 *   node scripts/generate-tweet-texts.mjs --preview # 生成結果を確認のみ（DB保存なし）
 *   node scripts/generate-tweet-texts.mjs --regen   # 既存テキストも再生成
 *
 * 前日夜に実行 → 翌日の自動投稿で使用される
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import * as readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const args    = process.argv.slice(2);
const PREVIEW = args.includes('--preview');
const REGEN   = args.includes('--regen');

const mgs  = createClient({ url: process.env.TURSO_MGS_URL,   authToken: process.env.TURSO_MGS_TOKEN });
const site = createClient({ url: process.env.TURSO_SITE_URL,  authToken: process.env.TURSO_SITE_TOKEN });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const GENRE_LABELS = { new:'新作', sale:'セール', anon:'匿名', lady:'レディ', vr:'VR', collab:'共演' };

// tweet_text カラムを追加（なければ）
await site.execute(`ALTER TABLE x_post_decisions ADD COLUMN tweet_text TEXT`).catch(() => {});

// 承認済み・未投稿・未生成の作品を取得
const whereText = REGEN
    ? `decision = 'approve' AND posted_at IS NULL`
    : `decision = 'approve' AND posted_at IS NULL AND (tweet_text IS NULL OR tweet_text = '')`;

const decisions = await site.execute({
    sql: `SELECT id, product_id, new_genre FROM x_post_decisions WHERE ${whereText} ORDER BY decided_at ASC`,
    args: [],
}).then(r => r.rows);

if (decisions.length === 0) {
    console.log('生成対象なし（承認済み作品がないか、全て生成済みです）');
    console.log('先に /admin/x-post でポストしたい作品を承認してください。');
    process.exit(0);
}

console.log(`\n対象: ${decisions.length}件${PREVIEW ? ' [プレビューのみ]' : ''}${REGEN ? ' [再生成]' : ''}`);
console.log('─'.repeat(60));

// rl for interactive confirmation
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

let generated = 0, skipped = 0;

for (const dec of decisions) {
    const pid    = String(dec.product_id);
    const genre  = String(dec.new_genre || 'new');
    const glabel = GENRE_LABELS[genre] || genre;

    // MGSから作品情報取得
    const prod = await mgs.execute({
        sql: 'SELECT title, actresses, genres FROM products WHERE product_id = ?',
        args: [pid],
    }).then(r => r.rows[0]);

    if (!prod) {
        console.log(`\n[${glabel}] ${pid} → 作品情報なし（スキップ）`);
        skipped++;
        continue;
    }

    const title    = String(prod.title    || '');
    const actresses = String(prod.actresses || '');
    const genres   = String(prod.genres   || '');

    console.log(`\n[${glabel}] ${pid}`);
    console.log(`タイトル: ${title.slice(0, 60)}`);
    console.log(`出演者: ${actresses || '不明'}`);

    // Claude で紹介文生成
    process.stdout.write('生成中...');
    let tweetText = '';
    try {
        const msg = await claude.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 150,
            messages: [{
                role: 'user',
                content: `X(Twitter)への短い投稿文を作成してください。
条件:
- 50文字以内
- 作品タイトルは含めない
- 出演者名も含めない（ハッシュタグで別途追加します）
- プラットフォーム規約を遵守し、性的・露骨な表現を避ける
- 感想や紹介の一言フレーズ
- 絵文字を1〜2個使う
- URLは含めない

ジャンル: ${genres}

投稿文のみ出力:`,
            }],
        });
        const content = msg.content[0];
        tweetText = content.type === 'text' ? content.text.trim() : title.slice(0, 60);
    } catch (e) {
        tweetText = title.slice(0, 70);
        process.stdout.write(' (API失敗、タイトル使用)');
    }
    process.stdout.write('\r');

    // 役名ハッシュタグ
    const hashtag = actresses ? '#' + actresses.split(/[,、]/)[0].trim().replace(/\s+/g, '_') : '';
    const detailUrl = `https://avrankings.com/product/${pid}`;
    const fullTweet = [tweetText, hashtag, detailUrl].filter(Boolean).join('\n');

    console.log('\n─── 生成テキスト ───');
    console.log(fullTweet);
    console.log(`（${fullTweet.length}文字）`);
    console.log('────────────────────');

    if (PREVIEW) {
        generated++;
        continue;
    }

    // 確認プロンプト
    const ans = await ask('保存しますか？ [y/編集/s(スキップ)/q(終了)] > ');

    if (ans.toLowerCase() === 'q') {
        console.log('\n中断しました。');
        break;
    } else if (ans.toLowerCase() === 's') {
        skipped++;
        continue;
    } else if (ans.toLowerCase() !== 'y' && ans.trim() !== '') {
        // 手動入力
        const edited = ans.trim();
        const editedFull = [edited, hashtag, detailUrl].filter(Boolean).join('\n');
        await site.execute({
            sql: `UPDATE x_post_decisions SET tweet_text = ? WHERE id = ?`,
            args: [editedFull, Number(dec.id)],
        });
        console.log('✓ 編集テキストを保存しました');
    } else {
        // y または Enter で保存
        await site.execute({
            sql: `UPDATE x_post_decisions SET tweet_text = ? WHERE id = ?`,
            args: [fullTweet, Number(dec.id)],
        });
        console.log('✓ 保存しました');
    }
    generated++;
}

rl.close();
console.log(`\n完了: 生成${generated}件 / スキップ${skipped}件`);
if (!PREVIEW) console.log('明日の自動投稿で使用されます。');
process.exit(0);
