/**
 * Telegram Bot — AVコンシェルジュ通知Bot
 *
 * 2つのモードで動作:
 *   1. botモード    : ユーザーからのコマンド・キーワード検索に応答（polling）
 *   2. notifyモード : チャンネルへの新作・セール自動通知（日次バッチから呼び出し）
 *
 * 必要な環境変数（.env.local）:
 *   TELEGRAM_BOT_TOKEN=123456789:ABCdef...
 *   TELEGRAM_CHANNEL_NEW=@yourchannel_new     （新作通知チャンネル）
 *   TELEGRAM_CHANNEL_SALE=@yourchannel_sale   （セール通知チャンネル、任意）
 *
 * 利用方法:
 *   node scripts/telegram_bot.js                          # botモード起動
 *   node scripts/telegram_bot.js --mode=notify --genre=new    # 新作通知（日次バッチから）
 *   node scripts/telegram_bot.js --mode=notify --genre=sale   # セール通知
 *   node scripts/telegram_bot.js --mode=notify --genre=new --dry-run
 */

require('dotenv').config({ path: './site/.env.local' });
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@libsql/client');

// ==============================
// 設定
// ==============================

const SITE_BASE_URL = 'https://lunar-zodiac.vercel.app';

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const CH_NEW         = process.env.TELEGRAM_CHANNEL_NEW;    // @handle or -100xxxx
const CH_SALE        = process.env.TELEGRAM_CHANNEL_SALE;   // 任意

// ==============================
// Tursoクライアント
// ==============================

const getMgsClient   = () => createClient({ url: process.env.TURSO_MGS_URL,   authToken: process.env.TURSO_MGS_TOKEN });
const getFanzaClient = () => createClient({ url: process.env.TURSO_FANZA_URL, authToken: process.env.TURSO_FANZA_TOKEN });

// ==============================
// URL生成
// ==============================

function cushionUrl(productId, source) {
    const prefix = source === 'fanza' ? 'fanza-' : '';
    return `${SITE_BASE_URL}/product/${prefix}${productId}`;
}

// ==============================
// メッセージフォーマット
// ==============================

function formatProduct(product, source) {
    const price = product.current_price
        ? `💰 ${product.current_price.toLocaleString()}円`
        : '';
    const discount = product.discount_pct > 0
        ? ` <b>（${product.discount_pct}%OFF）</b>`
        : '';
    const actresses = product.actresses
        ? `\n👤 ${product.actresses}`
        : '';
    const date = product.sale_start_date
        ? `\n📅 ${product.sale_start_date}`
        : '';

    return [
        `<b>${escapeHtml(product.title)}</b>`,
        actresses,
        date,
        price ? `\n${price}${discount}` : '',
    ].join('');
}

function escapeHtml(text) {
    return (text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ボタン（インラインキーボード）
function buildButtons(product, source) {
    const detailUrl = cushionUrl(product.product_id, source);
    const sampleUrl = product.sample_video_url || null;

    const buttons = [
        Markup.button.url('🔍 作品詳細', detailUrl),
    ];
    if (sampleUrl) {
        buttons.push(Markup.button.url('▶️ サンプル動画', sampleUrl));
    }

    return Markup.inlineKeyboard([buttons]);
}

// ==============================
// DB検索ヘルパー
// ==============================

async function searchByKeyword(keyword, limit = 5) {
    const results = [];

    // MGS検索
    const mgs = getMgsClient();
    const mgsRes = await mgs.execute({
        sql: `SELECT product_id, title, actresses, main_image_url, sample_video_url, sale_start_date
              FROM products
              WHERE detail_scraped = 1
                AND (title LIKE ? OR actresses LIKE ?)
              ORDER BY wish_count DESC LIMIT ?`,
        args: [`%${keyword}%`, `%${keyword}%`, limit],
    });
    mgsRes.rows.forEach(r => results.push({ ...r, source: 'mgs' }));

    // FANZA検索
    const fanza = getFanzaClient();
    const fanzaRes = await fanza.execute({
        sql: `SELECT product_id, title, actresses, main_image_url, sample_video_url,
                     affiliate_url, current_price, discount_pct, sale_start_date
              FROM products
              WHERE (title LIKE ? OR actresses LIKE ?)
              ORDER BY RANDOM() LIMIT ?`,
        args: [`%${keyword}%`, `%${keyword}%`, limit],
    });
    fanzaRes.rows.forEach(r => results.push({ ...r, source: 'fanza' }));

    return results.slice(0, limit);
}

async function getNewReleases(limit = 5, source = 'fanza') {
    const db = source === 'fanza' ? getFanzaClient() : getMgsClient();
    const base = source === 'mgs' ? 'detail_scraped = 1 AND' : '';
    const res = await db.execute({
        sql: `SELECT product_id, title, actresses, main_image_url, sample_video_url,
                     affiliate_url, current_price, discount_pct, sale_start_date
              FROM products
              WHERE ${base} sale_start_date >= date('now', '-3 days')
              ORDER BY sale_start_date DESC LIMIT ?`,
        args: [limit],
    });
    return res.rows.map(r => ({ ...r, source }));
}

async function getSaleItems(limit = 5) {
    const fanza = getFanzaClient();
    const res = await fanza.execute({
        sql: `SELECT product_id, title, actresses, main_image_url, sample_video_url,
                     affiliate_url, current_price, discount_pct, sale_start_date
              FROM products
              WHERE discount_pct >= 30
              ORDER BY discount_pct DESC, RANDOM() LIMIT ?`,
        args: [limit],
    });
    return res.rows.map(r => ({ ...r, source: 'fanza' }));
}

async function getByGenre(genreKeywords, limit = 1, source = 'mgs') {
    const db = source === 'fanza' ? getFanzaClient() : getMgsClient();
    const base = source === 'mgs' ? 'detail_scraped = 1 AND' : '';
    const conditions = genreKeywords.map(() => 'genres LIKE ?').join(' OR ');
    const args = [...genreKeywords.map(k => `%${k}%`), limit];
    const res = await db.execute({
        sql: `SELECT product_id, title, actresses, main_image_url, sample_video_url,
                     affiliate_url, current_price, discount_pct, sale_start_date
              FROM products
              WHERE ${base} (${conditions})
              ORDER BY RANDOM() LIMIT ?`,
        args,
    });
    return res.rows.map(r => ({ ...r, source }));
}

// ==============================
// 作品を1件送信
// ==============================

async function sendProduct(ctx, product, caption) {
    const text = caption || formatProduct(product, product.source);
    const keyboard = buildButtons(product, product.source);

    if (product.main_image_url) {
        try {
            await ctx.replyWithPhoto(product.main_image_url, {
                caption: text,
                parse_mode: 'HTML',
                ...keyboard,
            });
            return;
        } catch {
            // 画像送信失敗 → テキストにフォールバック
        }
    }
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
}

// チャンネルへの通知送信（notifyモード用）
async function sendToChannel(bot, channelId, product) {
    const text = formatProduct(product, product.source);
    const keyboard = buildButtons(product, product.source);

    if (product.main_image_url) {
        try {
            await bot.telegram.sendPhoto(channelId, product.main_image_url, {
                caption: text,
                parse_mode: 'HTML',
                ...keyboard,
            });
            return;
        } catch {
            // fallthrough
        }
    }
    await bot.telegram.sendMessage(channelId, text, { parse_mode: 'HTML', ...keyboard });
}

// ==============================
// ≡ BOT モード
// ==============================

function startBotMode() {
    if (!BOT_TOKEN) {
        console.error('❌ TELEGRAM_BOT_TOKEN が .env.local に未設定です');
        process.exit(1);
    }

    const bot = new Telegraf(BOT_TOKEN);

    // /start
    bot.start(ctx => ctx.reply(
        '🎬 <b>AVコンシェルジュ Bot</b>\n\n' +
        '以下のコマンドが使えます：\n' +
        '/new — 新着作品\n' +
        '/sale — セール中作品\n' +
        '/vr — VR作品\n' +
        '/milf — 人妻・熟女\n' +
        '/amateur — 素人\n' +
        '/kyouen — 共演作\n\n' +
        '💡 女優名・作品名を送るだけで検索できます',
        { parse_mode: 'HTML' }
    ));

    // /new
    bot.command('new', async ctx => {
        await ctx.reply('🆕 新着作品を検索中...');
        const items = await getNewReleases(3);
        if (!items.length) return ctx.reply('新着作品が見つかりませんでした');
        for (const p of items) await sendProduct(ctx, p);
    });

    // /sale
    bot.command('sale', async ctx => {
        await ctx.reply('🏷️ セール中作品を検索中...');
        const items = await getSaleItems(3);
        if (!items.length) return ctx.reply('セール中作品が見つかりませんでした');
        for (const p of items) await sendProduct(ctx, p);
    });

    // /vr
    bot.command('vr', async ctx => {
        await ctx.reply('🥽 VR作品を検索中...');
        const items = await getByGenre(['VR'], 3);
        if (!items.length) return ctx.reply('VR作品が見つかりませんでした');
        for (const p of items) await sendProduct(ctx, p);
    });

    // /milf
    bot.command('milf', async ctx => {
        await ctx.reply('👑 人妻・熟女作品を検索中...');
        const items = await getByGenre(['人妻', '熟女', '母'], 3);
        if (!items.length) return ctx.reply('作品が見つかりませんでした');
        for (const p of items) await sendProduct(ctx, p);
    });

    // /amateur
    bot.command('amateur', async ctx => {
        await ctx.reply('📷 素人作品を検索中...');
        const items = await getByGenre(['素人'], 3);
        if (!items.length) return ctx.reply('作品が見つかりませんでした');
        for (const p of items) await sendProduct(ctx, p);
    });

    // /kyouen
    bot.command('kyouen', async ctx => {
        await ctx.reply('✨ 共演作を検索中...');
        const mgs = getMgsClient();
        const res = await mgs.execute(
            "SELECT product_id, title, actresses, main_image_url, sample_video_url, sale_start_date FROM products WHERE detail_scraped=1 AND actresses LIKE '% / %' ORDER BY RANDOM() LIMIT 3"
        );
        const items = res.rows.map(r => ({ ...r, source: 'mgs' }));
        if (!items.length) return ctx.reply('作品が見つかりませんでした');
        for (const p of items) await sendProduct(ctx, p);
    });

    // テキスト → キーワード検索
    bot.on('text', async ctx => {
        const keyword = ctx.message.text.trim();
        if (keyword.startsWith('/')) return;
        if (keyword.length < 2) return ctx.reply('2文字以上で検索してください');

        await ctx.reply(`🔍 「${keyword}」で検索中...`);
        const items = await searchByKeyword(keyword, 3);
        if (!items.length) return ctx.reply(`「${keyword}」の作品が見つかりませんでした`);
        for (const p of items) await sendProduct(ctx, p);
    });

    bot.catch((err, ctx) => {
        console.error(`エラー (${ctx.updateType}):`, err.message);
    });

    bot.launch();
    console.log('✅ Telegram Bot 起動中（Ctrl+C で終了）');

    process.once('SIGINT',  () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ==============================
// 📢 NOTIFY モード（日次バッチ用）
// ==============================

async function runNotifyMode(genre, count, isDryRun) {
    if (!BOT_TOKEN && !isDryRun) {
        console.error('❌ TELEGRAM_BOT_TOKEN が未設定です');
        process.exit(1);
    }

    const bot = isDryRun ? null : new Telegraf(BOT_TOKEN);
    let items = [];
    let channelId = '';

    if (genre === 'new') {
        channelId = CH_NEW;
        items = await getNewReleases(count, 'fanza');
        console.log(`[新作通知] ${items.length}件取得 → チャンネル: ${channelId}`);
    } else if (genre === 'sale') {
        channelId = CH_SALE || CH_NEW;
        items = await getSaleItems(count);
        console.log(`[セール通知] ${items.length}件取得 → チャンネル: ${channelId}`);
    } else {
        console.error(`❌ --genre=${genre} は未対応です (new | sale)`);
        process.exit(1);
    }

    if (!channelId && !isDryRun) {
        console.error('❌ チャンネルIDが未設定です（TELEGRAM_CHANNEL_NEW）');
        process.exit(1);
    }
    if (!channelId) channelId = '@dry_run_channel';

    for (const product of items) {
        if (isDryRun) {
            console.log('\n[DRY RUN] チャンネル投稿シミュレーション');
            console.log('─'.repeat(40));
            console.log('チャンネル:', channelId);
            console.log('タイトル:', product.title);
            console.log('価格:', product.current_price, '/ 割引:', product.discount_pct, '%');
            console.log('作品詳細URL:', cushionUrl(product.product_id, product.source));
            console.log('─'.repeat(40));
        } else {
            await sendToChannel(bot, channelId, product);  // eslint-disable-line
            // 投稿間隔（Telegram: 30件/秒まで許可だが余裕を持つ）
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    console.log(`✅ notify完了 (${genre}: ${items.length}件)`);
    process.exit(0);
}

// ==============================
// エントリーポイント
// ==============================

const getArg = (name) => {
    const a = process.argv.find(a => a.startsWith(`--${name}=`));
    return a ? a.split('=')[1] : null;
};

const mode     = getArg('mode')  || 'bot';
const genre    = getArg('genre') || 'new';
const count    = parseInt(getArg('count') || '5', 10);
const isDryRun = process.argv.includes('--dry-run');

if (mode === 'notify') {
    runNotifyMode(genre, count, isDryRun).catch(err => {
        console.error('❌ エラー:', err.message);
        process.exit(1);
    });
} else {
    startBotMode();
}
