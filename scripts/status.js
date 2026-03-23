/**
 * プロジェクトステータス確認
 * 実行: npm run status
 */

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATA_DIR = path.join(__dirname, '..', 'data');

function bar(pct, len = 20) {
    const filled = Math.round(pct / 100 * len);
    return '█'.repeat(filled) + '░'.repeat(len - filled);
}

function fileSize(filePath) {
    try {
        const mb = fs.statSync(filePath).size / 1024 / 1024;
        return mb >= 1 ? `${mb.toFixed(0)} MB` : `${(mb * 1024).toFixed(0)} KB`;
    } catch { return '—'; }
}

async function main() {
    console.log('\n' + '═'.repeat(52));
    console.log('  🎬  AVコンシェルジュ — プロジェクト状態');
    console.log('═'.repeat(52));

    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    console.log(`  📅 ${now}\n`);

    // ---- ローカルDB ----
    console.log('  ─── ローカルDB ───────────────────────');

    try {
        const mgs = new Database(path.join(DATA_DIR, 'mgs.db'), { readonly: true });
        const mgsCount = mgs.prepare('SELECT COUNT(*) as c FROM products').get().c;
        mgs.close();
        console.log(`  MGS    : ${mgsCount.toLocaleString().padStart(7)} 件  [${fileSize(path.join(DATA_DIR, 'mgs.db'))}]`);
    } catch { console.log('  MGS    : ❌ 読み込みエラー'); }

    try {
        const fanza = new Database(path.join(DATA_DIR, 'fanza.db'), { readonly: true });
        const total   = fanza.prepare('SELECT COUNT(*) as c FROM products').get().c;
        const onSale  = fanza.prepare("SELECT COUNT(*) as c FROM products WHERE discount_pct > 0").get().c;
        const maxDisc = fanza.prepare("SELECT MAX(discount_pct) as m FROM products").get().m || 0;
        const priceUpdated = fanza.prepare(
            "SELECT MAX(price_updated_at) as t FROM products WHERE price_updated_at IS NOT NULL"
        ).get().t;
        fanza.close();

        console.log(`  FANZA  : ${total.toLocaleString().padStart(7)} 件  [${fileSize(path.join(DATA_DIR, 'fanza.db'))}]`);
        console.log(`  セール中: ${onSale.toLocaleString().padStart(7)} 件  (最大 ${maxDisc}%OFF)`);
        if (priceUpdated) {
            const d = new Date(priceUpdated);
            console.log(`  価格更新: ${d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
        }
    } catch { console.log('  FANZA  : ❌ 読み込みエラー'); }

    // ---- suggest_cache.json ----
    const cachePath = path.join(DATA_DIR, 'suggest_cache.json');
    if (fs.existsSync(cachePath)) {
        try {
            const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            const genAt = cache.generated_at
                ? new Date(cache.generated_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
                : '不明';
            console.log(`\n  ─── サジェストキャッシュ ──────────────`);
            console.log(`  女優: ${cache.actresses?.length.toLocaleString()} / メーカー: ${cache.makers?.length.toLocaleString()} / ジャンル: ${cache.genres?.length.toLocaleString()}`);
            console.log(`  生成: ${genAt}  [${fileSize(cachePath)}]`);
        } catch { /* skip */ }
    }

    // ---- Turso ----
    console.log('\n  ─── Turso (Cloud) ─────────────────────');

    const tursoUrl   = process.env.TURSO_FANZA_URL;
    const tursoToken = process.env.TURSO_FANZA_TOKEN;
    const mgsUrl     = process.env.TURSO_MGS_URL;
    const mgsToken   = process.env.TURSO_MGS_TOKEN;

    if (tursoUrl && tursoToken && mgsUrl && mgsToken) {
        try {
            const fanzaTurso = createClient({ url: tursoUrl, authToken: tursoToken });
            const mgsTurso   = createClient({ url: mgsUrl, authToken: mgsToken });

            const [fanzaRes, mgsRes, saleRes] = await Promise.all([
                fanzaTurso.execute('SELECT COUNT(*) as c FROM products'),
                mgsTurso.execute('SELECT COUNT(*) as c FROM products'),
                fanzaTurso.execute('SELECT COUNT(*) as c FROM products WHERE discount_pct > 0'),
            ]);

            const fanzaCount = Number(fanzaRes.rows[0].c);
            const mgsCount   = Number(mgsRes.rows[0].c);
            const saleCount  = Number(saleRes.rows[0].c);

            const localFanza = (() => {
                try {
                    const db = new Database(path.join(DATA_DIR, 'fanza.db'), { readonly: true });
                    const c = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
                    db.close(); return c;
                } catch { return 0; }
            })();

            const syncPct = localFanza > 0 ? (fanzaCount / localFanza * 100) : 0;

            console.log(`  MGS    : ${mgsCount.toLocaleString().padStart(7)} 件`);
            console.log(`  FANZA  : ${fanzaCount.toLocaleString().padStart(7)} 件  セール中: ${saleCount.toLocaleString()}件`);
            console.log(`  同期率  : [${bar(syncPct)}] ${syncPct.toFixed(1)}%`);

            fanzaTurso.close();
            mgsTurso.close();
        } catch (e) {
            console.log(`  ❌ Turso接続エラー: ${e.message}`);
        }
    } else {
        console.log('  ⚠️  TURSO環境変数が未設定');
    }

    // ---- 次のアクション ----
    console.log('\n  ─── 次のアクション ────────────────────');
    console.log('  1. node scripts/fanza_daily_update.js    # 日次更新');
    console.log('  2. cd site && npm run dev                # サイト起動');
    console.log('  3. cat ROADMAP.md                        # 計画確認');
    console.log('\n' + '═'.repeat(52) + '\n');
}

main().catch(err => {
    console.error('エラー:', err.message);
    process.exit(1);
});
