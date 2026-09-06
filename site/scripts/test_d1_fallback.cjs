// D1 縮退フォールバックの回帰テスト（npm run test:fallback）
// tsc で lib/*.ts を .tmp_test へ出してから実行する。静的キャッシュは site/data を読む。
const B = require('../.tmp_test/d1Breaker.js');
const D = require('../.tmp_test/degradedProducts.js');
let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };

// ── ブレーカ: 誤爆しないこと ──
ok(!B.isQuotaError(new Error('too many SQL variables')), 'バインド上限エラーは枠切れ扱いしない');
ok(!B.isQuotaError(new Error('D1_ERROR: no such table: products')), '通常のSQLエラーは枠切れ扱いしない');
ok(!B.isQuotaError(new Error('Too many API requests by single worker invocation.')), 'subrequest上限は枠切れ扱いしない');
// ── ブレーカ: 枠切れは検知すること ──
for (const m of [
  'D1_ERROR: Exceeded daily read limit of 5000000 rows',
  'Your account has exceeded its daily D1 limits',
  'HTTP 429 Too Many Requests',
  'Daily quota exceeded',
]) ok(B.isQuotaError(new Error(m)), '枠切れ検知: ' + m.slice(0, 40));

// ── ブレーカ: 3ストライクで作動、UTC0時を超えない ──
B.resetD1Breaker();
const t0 = Date.parse('2026-09-04T10:00:00Z');
const quota = new Error('exceeded daily limit');
B.noteD1Error(quota, t0); B.noteD1Error(quota, t0 + 100);
ok(!B.isD1Blocked(t0 + 200), '2回では作動しない');
B.noteD1Error(quota, t0 + 200);
ok(B.isD1Blocked(t0 + 300), '3回で作動する');
ok(!B.isD1Blocked(t0 + 16 * 60 * 1000), '15分後に再プローブのため解除される');

B.resetD1Breaker();
const late = Date.parse('2026-09-04T23:55:00Z');
for (let i = 0; i < 3; i++) B.noteD1Error(quota, late + i);
ok(new Date(B.d1BreakerState(late).blockedUntil).toISOString() === '2026-09-05T00:00:00.000Z', 'UTC0時(枠リセット)を超えて止めない');

// ── ブレーカ: 成功でストライク解消 ──
B.resetD1Breaker();
B.noteD1Error(quota, t0); B.noteD1Error(quota, t0 + 1);
B.noteD1Success();
B.noteD1Error(quota, t0 + 2);
ok(!B.isD1Blocked(t0 + 3), '間に成功が挟まればストライクは積み上がらない');

// ── ブレーカ: 古いストライクは忘れる ──
B.resetD1Breaker();
B.noteD1Error(quota, t0); B.noteD1Error(quota, t0 + 1);
B.noteD1Error(quota, t0 + 120000);
ok(!B.isD1Blocked(t0 + 120001), '60秒より古い失敗は数えない');

// ── 縮退応答（静的キャッシュのみで一覧が組めるか）──
B.resetD1Breaker();
(async () => {
  const news = await D.degradedProducts({ sort: 'new', limit: 20 });
  ok(news.length === 20, '新作: 静的キャッシュから20件返る');
  const dates = news.map(p => String(p.sale_start_date).replace(/\//g, '-').slice(0, 10));
  ok(dates.join() === [...dates].sort().reverse().join(), '新作: 配信日の降順');

  const sale = await D.degradedProducts({ sort: 'discount', limit: 20 });
  const today = new Date().toISOString().slice(0, 10);
  ok(sale.length > 0 && sale.every(p => Number(p.discount_pct) >= 1), 'セール: 割引作品のみ');
  ok(sale.every(p => { const m = String(p.sale_end_date ?? '').match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/); return !m || `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` >= today; }), 'セール: 終了済みを除外');
  ok(sale.every((p, i) => i === 0 || Number(sale[i-1].discount_pct) >= Number(p.discount_pct)), 'セール: 割引率降順');

  const pop = await D.degradedProducts({ sort: 'wish_count', limit: 10 });
  ok(pop.length === 10, '人気順: 10件返る');

  const q = await D.degradedProducts({ sort: 'new', q: '巨乳', limit: 30 });
  ok(q.length > 0 && q.every(p => (String(p.title) + p.genres + p.actresses).includes('巨乳')), '検索: q が題名/ジャンル/出演者に含まれる');

  const mgs = await D.degradedProducts({ sort: 'new', source: 'mgs', limit: 10 });
  ok(mgs.every(p => p.source === 'mgs'), 'source絞り込みが効く');

  const name = String(news.find(p => p.actresses && !String(p.actresses).includes(','))?.actresses || '').trim();
  if (name) {
    const byActress = await D.degradedProducts({ sort: 'new', actressGroups: [[name]], limit: 10 });
    ok(byActress.length > 0 && byActress.every(p => String(p.actresses).split(/[,、]/).map(s=>s.trim()).includes(name)), '女優絞り込みが完全一致で効く: ' + name);
  }

  const none = await D.degradedProducts({ sort: 'new', q: 'ZZZ該当なしZZZ', limit: 10 });
  ok(none.length === 0, '該当なしは空配列（通常の空応答に戻る）');

  const best = await D.degradedProducts({ sort: 'new', excludeBest: true, limit: 50 });
  ok(best.every(p => !/BEST|ベスト|総集編/i.test(String(p.title))), 'excludeBest が効く');


  // ── 商品詳細の静的シャード ──
  const S = require('../.tmp_test/productShard.js');
  const gen = await import('./build_product_shards.mjs');
  const fsx = require('fs'), pathx = require('path');
  const shardDir = pathx.join(__dirname, '..', 'data', 'product');
  if (!fsx.existsSync(shardDir)) {
    ok(false, 'data/product/ が無い（npm run build:shards を先に実行）');
  } else {
    ok(S.PRODUCT_SHARD_COUNT === gen.SHARD_COUNT, '分割数がランタイムと生成側で一致');
    const files = fsx.readdirSync(shardDir);
    ok(files.length === S.PRODUCT_SHARD_COUNT, `シャードが ${S.PRODUCT_SHARD_COUNT} ファイルある`);
    // ハッシュ実装のズレ＝全作品がフォールバック不能になる最悪の事故。全件で照合する。
    let mis = 0, misplaced = 0, count = 0;
    const shardKeys = new Set();
    for (const f of files) {
      const nn = f.replace(/.json$/, '');
      const d = JSON.parse(fsx.readFileSync(pathx.join(shardDir, f), 'utf8'));
      for (const id of Object.keys(d)) {
        count++;
        shardKeys.add(id);
        if (S.productShardKey(id) !== gen.productShardKey(id)) mis++;
        if (S.productShardKey(id) !== nn) misplaced++;
      }
    }
    ok(mis === 0, `ハッシュがランタイム/生成側で一致 (${count}件)`);
    ok(misplaced === 0, '全レコードが自分のシャードに入っている');
    ok(S.productShardKey('ABF-380') === S.productShardKey('abf-380'), '大文字小文字を吸収する');

    // 「一覧に出る作品は必ず詳細も出せる」ことの担保
    const listed = new Set();
    for (const f of ['products_new_cache', 'products_popular_cache', 'sale_cache', 'ranking_2026_cache', 'ranking_default_cache']) {
      for (const p2 of JSON.parse(fsx.readFileSync(pathx.join(__dirname, '..', 'data', f + '.json'), 'utf8'))) if (p2.product_id) listed.add(String(p2.product_id));
    }
    let missing = 0;
    for (const id of listed) if (!(await S.readShardProduct(id))) missing++;
    ok(missing === 0, `一覧に出る ${listed.size} 件すべてに詳細レコードがある`);

    // サイトマップ掲載URL（索引対象）が枠切れ中に404にならないこと
    const sm = JSON.parse(fsx.readFileSync(pathx.join(__dirname, '..', 'data', 'sitemap_cache.json'), 'utf8')).products || [];
    let smMiss = 0;
    for (const id of sm) if (!shardKeys.has(String(id).toLowerCase())) smMiss++;
    const cover = sm.length ? (sm.length - smMiss) / sm.length : 1;
    ok(cover >= 0.85, `サイトマップ掲載 ${sm.length}件のうち ${(cover*100).toFixed(1)}% に詳細レコードがある`);
    const one = await S.readShardProduct([...listed][0]);
    ok(!!(one && one.title && one.source), 'シャードのレコードに title と source がある');
    ok((await S.readShardProduct('NOSUCH-999999')) === null, '未収録は null（呼び出し側は404のまま）');
  }

  // ── 長尾LPの静的キャッシュ ──
  const L = require('../.tmp_test/lpCache.js');
  const lpGen = await import('./build_lp_cache.mjs');
  const lpDir = pathx.join(__dirname, '..', 'data', 'lp');
  if (!fsx.existsSync(lpDir)) {
    ok(false, 'data/lp/ が無い（npm run build:lp を先に実行）');
  } else {
    ok(L.LP_SHARD_COUNT === lpGen.LP_SHARD_COUNT, 'LP分割数がランタイムと生成側で一致');
    let lpMis = 0, lpCount = 0, emptyList = 0;
    for (const type of fsx.readdirSync(lpDir)) {
      for (const f of fsx.readdirSync(pathx.join(lpDir, type))) {
        const nn = f.replace(/.json$/, '');
        const d = JSON.parse(fsx.readFileSync(pathx.join(lpDir, type, f), 'utf8'));
        for (const slug of Object.keys(d)) {
          lpCount++;
          if (L.lpShardKey(slug) !== lpGen.lpShardKey(slug) || L.lpShardKey(slug) !== nn) lpMis++;
          if (!Array.isArray(d[slug]) || d[slug].length === 0) emptyList++;
        }
      }
    }
    ok(lpMis === 0, `LPハッシュが一致し正しいシャードにある (${lpCount}スラッグ)`);
    ok(emptyList === 0, '空のLPリストを保存していない（0件はD1へ落とす方針）');

    const genres = JSON.parse(fsx.readFileSync(pathx.join(__dirname, '..', 'data', 'genres_cache.json'), 'utf8'));
    let gMissing = 0;
    for (const g of genres) if (!(await L.readLpCards('genre', g.name))) gMissing++;
    ok(gMissing === 0, `ジャンルLP ${genres.length}件すべてにカードがある`);

    // 商品詳細の「関連作品」は作品の genres 列の値でそのまま /api/products?genre= を叩くので、
    // LPを持つ287件だけでは足りず、**カタログに出る全ジャンル**が収録されている必要がある。
    // 落ちると1リクエストあたり約6万行のFTS全マッチがD1に走る（2026-09-05の枠切れの主因）。
    const shardDir = pathx.join(__dirname, '..', 'public', 'data', 'lp', 'genre');
    const cachedGenres = new Set();
    for (const f of fsx.readdirSync(shardDir)) {
      for (const k of Object.keys(JSON.parse(fsx.readFileSync(pathx.join(shardDir, f), 'utf8')))) cachedGenres.add(k);
    }
    // 収録対象は「BEST/総集編を除いたあとに1件でも残るジャンル」。
    // 「16時間以上作品」のように全作品が総集編のジャンルは、D1に落ちても0件しか返らないので対象外。
    const BF = require('../.tmp_test/bestFilter.js');
    const catalogGenres = new Set();
    for (const dbFile of ['fanza.db', 'mgs.db']) {
      const p = pathx.join(__dirname, '..', '..', 'data', dbFile);
      if (!fsx.existsSync(p)) continue;
      const db = new (require('better-sqlite3'))(p, { readonly: true });
      for (const row of db.prepare('SELECT genres, title, duration_min FROM products WHERE genres IS NOT NULL').iterate()) {
        if (BF.isBestOrCompilation(row.title, row.duration_min)) continue;
        for (const el of String(row.genres).split(/,\s*/)) { const g = el.trim(); if (g) catalogGenres.add(g); }
      }
      db.close();
    }
    if (catalogGenres.size > 0) {
      const uncovered = [...catalogGenres].filter(g => !cachedGenres.has(g));
      ok(uncovered.length === 0,
        `カタログ全ジャンル ${catalogGenres.size}件がLPキャッシュに収録されている` +
        (uncovered.length ? `（未収録: ${uncovered.slice(0, 5).join(', ')}…計${uncovered.length}）` : ''));
    }

    const one = await L.readLpCards('genre', genres[0].name);
    ok(one.length > 0 && one.every(c => c.product_id && c.title !== undefined), `LPカードに product_id と title がある (${genres[0].name}: ${one.length}件)`);
    ok((await L.readLpCards('genre', '存在しないジャンルZZZ')) === null, '未収録スラッグは null（D1へ落とす）');
  }

  // ---- 短名女優インデックス（scripts/build_short_actress_index.mjs） ----
  // /api/products は3文字未満の女優名をこのインデックスの product_id IN 引きに置き換える。
  // 落ちると actresses LIKE '%X%' の全表走査に戻る（1回 約13万行）。
  {
    const p = pathx.join(__dirname, '..', 'public', 'data', 'short_name_index.json');
    if (fsx.existsSync(p)) {
      const idx = JSON.parse(fsx.readFileSync(p, 'utf8'));
      ok(idx && idx.actress && idx.labels, '短名インデックスに actress と labels がある');
      const names = [...Object.keys((idx.actress||{}).fanza || {}), ...Object.keys((idx.actress||{}).mgs || {})];
      ok(names.length > 0, `短名女優インデックスが空でない (${names.length}名)`);
      ok(names.every(n => [...n].length < 3), '収録名はすべて3文字未満（3文字以上はFTSで引くので入れない）');
      // **ids は SQL に直接埋め込まれる**ので、英数字・ハイフン・アンダースコア以外が
      // 混ざっていないことをここで担保する（混ざったらランタイムが黙って除外し、
      // その女優の作品が検索から消える）。
      const ids = [...Object.values((idx.actress||{}).fanza || {}), ...Object.values((idx.actress||{}).mgs || {})].flat();
      const badIds = ids.filter(id => !/^[A-Za-z0-9_-]+$/.test(id));
      ok(badIds.length === 0,
        `品番はSQL埋め込み可能な文字だけ (${ids.length}件)` +
        (badIds.length ? `（不正: ${badIds.slice(0, 3).join(', ')}…計${badIds.length}）` : ''));

      // レーベル一覧は「2文字レーベル検索を走査せず0件で返す」判定に使う。
      // 空だと全部0件になってしまうので、件数と実在レーベルの収録を確認する。
      const labs = [...(idx.labels.fanza || []), ...(idx.labels.mgs || [])];
      ok(labs.length > 100, `レーベル一覧が十分ある (${labs.length}件)`);
      const db = new (require('better-sqlite3'))(pathx.join(__dirname, '..', '..', 'data', 'fanza.db'), { readonly: true });
      const sample = db.prepare("SELECT label, COUNT(*) c FROM products WHERE label IS NOT NULL AND TRIM(label)<>'' GROUP BY label ORDER BY c DESC LIMIT 20").all();
      db.close();
      const uncovered = sample.map(r => String(r.label).trim()).filter(l => !idx.labels.fanza.includes(l));
      ok(uncovered.length === 0,
        `主要レーベル20件が一覧に載っている` + (uncovered.length ? `（未収録: ${uncovered.slice(0, 3).join(', ')}）` : ''));
    }
  }
  console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
})();
