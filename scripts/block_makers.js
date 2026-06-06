/**
 * 指定メーカーの作品を FANZA から削除＋今後もブロック（ブロックリスト化）。
 *   node scripts/block_makers.js          # dry-run（対象メーカーと件数のみ）
 *   node scripts/block_makers.js --apply  # ローカルfanza.db + D1シャード削除 + blocked_makers.json更新
 * 実行後: 静的キャッシュ再生成 → デプロイ が必要。
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const ROOT = path.join(__dirname, '..');
const FANZA_DB = path.join(ROOT, 'data', 'fanza.db');
const BLOCKED_PATH = path.join(ROOT, 'data', 'blocked_makers.json');

// 部分一致の検索語（崩れ表記は補正済み）。ティッシュは「シコレール」で限定（ウェットティッシュ巻き込み回避）
const TERMS = [
    'アートビデオ','アウダースジャパン','アドア','アパッチ','おしゃぶりクッキング','コロナ社','シャイ企画',
    'ダイナマイトエンタープライズ','ちちくりジョニー','シコレール','はめチャンネル','ハヤブサ','ピュアスタイル',
    'ヒルズ妻','フォーディメンション','ブリット','ブレーントラストカンパニー','ボインな君と','マニアゼロ',
    'みなみ工房','モデスト','ロイヤルアート','援堂','現映社','黒船提督','熟蜜のヒミツ','信州書店','青空ソフト',
    '東京スペシ','北池袋盗撮倶楽部','AVマーケット','A子さん','e-エステ','GIGO','LadyHunter','SEX MACHINE',
    'SPYEYE','TMクリエイト','Tokyo247','Yellow Mo','ZOOO','群雄社',
    '熟女LABO','P-WIFE','中嶋興業','人妻空蝉橋','SILK LABO',
];

const db = new Database(FANZA_DB, { readonly: !APPLY });
const distinct = db.prepare('SELECT DISTINCT maker FROM products WHERE maker LIKE ?');
const makers = new Set();
for (const t of TERMS) {
    for (const r of distinct.all('%' + t + '%')) makers.add(r.maker);
}
const list = [...makers].sort();
const ph = list.map(() => '?').join(',');
const count = db.prepare(`SELECT COUNT(*) n FROM products WHERE maker IN (${ph})`).get(...list).n;

console.log(`対象メーカー: ${list.length} 件 / 削除対象作品: ${count.toLocaleString()} 件`);
console.log(list.join(', '));

if (!APPLY) { console.log('\n[dry-run] --apply で削除します'); db.close(); process.exit(0); }

// 1) ローカル fanza.db から削除
const del = db.prepare(`DELETE FROM products WHERE maker IN (${ph})`);
const localDeleted = del.run(...list).changes;
console.log(`\n✅ ローカル fanza.db 削除: ${localDeleted.toLocaleString()} 件`);

// 2) blocked_makers.json 更新（今後の日次更新で非登録）
let blocked = { makers: [] };
try { blocked = JSON.parse(fs.readFileSync(BLOCKED_PATH, 'utf-8')); } catch {}
const set = new Set(blocked.makers || []);
list.forEach(m => set.add(m));
blocked.makers = [...set].sort();
fs.writeFileSync(BLOCKED_PATH, JSON.stringify(blocked, null, 2));
console.log(`✅ blocked_makers.json: ${blocked.makers.length} メーカー登録`);
db.close();

// 3) D1シャードから削除（smart client: DELETE→両シャード。FTSはトリガで自動削除）
(async () => {
    const { fanzaShards } = require('./lib/d1.js');
    const fz = fanzaShards();
    // バインド変数上限(100)内に収めるため makerを分割
    const CH = 80;
    let done = 0;
    for (let i = 0; i < list.length; i += CH) {
        const chunk = list.slice(i, i + CH);
        const p = chunk.map(() => '?').join(',');
        await fz.execute({ sql: `DELETE FROM products WHERE maker IN (${p})`, args: chunk });
        done += chunk.length;
    }
    console.log(`✅ D1シャード削除実行（${done}メーカー分・両シャード）`);
    console.log('\n次: node site/scripts/generate-static-cache-local.mjs → cd site && npm run deploy:cf');
})().catch(e => { console.error('D1削除エラー:', e.message); process.exit(1); });
