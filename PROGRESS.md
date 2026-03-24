# AVコンシェルジュ — 進捗記録

> 最終更新: 2026-03-25

---

## ✅ 完了済み

### Phase 1 — MGSデータ収集・DB構築
- MGStageの全作品をスクレイピング（`phase1_list_scrape.js`）
- 詳細ページスクレイピング（`phase2_detail_scrape.js`）
- サンプル動画URL取得（`phase2_5_video_url.js`）
- 女優プロフィール取得（`phase6_actress_profiles.js`）
- ローカルSQLite `data/mgs.db` 構築完了
  - **114,563件**（detail_scraped=1）

### Phase 2 — FANZAデータ収集・DB構築
- DMM API v3 で月別全作品取得（`fanza_phase1_fetch.js`）
  - 2010-01 〜 2026-03 全月完了
  - **383,932件**
- サンプル動画URL取得（`fanza_phase2_5_video.js`）
  - 274,956件に動画URL付与
- ローカルSQLite `data/fanza.db` 構築完了

### Phase 3 — Turso移行（2026-03-16）
- Turso DBセットアップ（2インスタンス）
  - `libsql://mgs-reryo112127-droid.aws-ap-northeast-1.turso.io`
  - `libsql://fanza-reryo112127-droid.aws-ap-northeast-1.turso.io`
- ローカルDB → Turso 全件移行
  - MGS: 114,563件 ✅
  - FANZA: 383,932件 ✅
- `scripts/migrate_to_turso.js` — 初回全件移行
- `scripts/resume_fanza_turso.js` — 途中再開対応

### Phase 4 — サイトAPI Turso対応（2026-03-16〜17）
- `site/lib/turso.ts` — Tursoクライアント管理
- `site/app/api/products/route.ts` — 一覧API（MGS+FANZAマージ）
- `site/app/api/product/[id]/route.ts` — 詳細API
- `site/app/api/suggest/route.ts` — サジェストAPI
  - Turso全件取得 → `data/suggest_cache.json` ローカル読み込みに最適化

### Phase 5 — 日次更新・セール情報（2026-03-17）
- `scripts/fanza_daily_update.js` — FANZA日次更新
  - 新作取得（DMM API、デフォルト過去7日）
  - 直近12ヶ月の価格更新（セール検出）
  - ローカルDB + Turso 同期
  - Discord通知
- `scripts/build_suggest_cache.js` — サジェストキャッシュ生成
  - MGS + FANZA の女優・メーカー・レーベル・ジャンルをJSON出力
- **価格カラム追加**（fanza.db + Turso）
  - `list_price` / `current_price` / `discount_pct` / `price_updated_at`
- 初回価格更新完了: 33,934件 / セール中 2,914件（最大51%OFF）

### Phase 6 — 自動化・デプロイ・フロントエンド（2026-03-18〜21）
- **MGS日次更新のTurso同期**
- **日次更新の自動化** — タスクスケジューラ毎日10:10 (`MGS Daily Update`)
- **Vercelデプロイ** — `https://lunar-zodiac.vercel.app`
- **スマホ版デザイン25ページ展開** (`site/public/design/`)
- **WEB版デザイン28ページ展開** (`site/public/design/web/`)
- **WEB版実データ接続** — home/ranking/new-productsにAPIデータ注入

### Phase 7 — SEO・ヘッダー統一・アフィリエイト改善（2026-03-22）
- **robots.txt** — APIとプライベートページをDisallow
- **動的サイトマップ** (`app/sitemap.ts`) — 静的ページ + 女優2000件 + 人気作品1000件
- **OG/Twitter Card** — layout.tsx / 各ページに動的メタデータ
- **generateMetadata** — `/product/[id]`・`/actress/[name]`・`/ranking`ほか
- **JSON-LD構造化データ** — VideoObject（作品）/ Person（女優）
- **ホームページNext.js化** — `app/route.ts`削除 → `app/page.tsx`でUA分岐
  - `HomePageMobile.tsx` / `HomePageWeb.tsx` — 全ページ共通Header/BottomNav
- **アフィリエイトリンク修正** — MGS/FANZA両方存在すれば両方表示（disabled廃止）
  - `api/product/[id]/route.ts` — 両DB並行検索、`mgs_affiliate_url`/`fanza_affiliate_url`分離
- **Load More実装** — `/search`ページにoffset/hasMore対応

### Phase 8 — ランキングシステム・UIワイヤリング（2026-03-22）
- **スコアリングシステム設計・実装** (`lib/scoring.ts`)
  - 作品: wish_count×1 + サイトいいね×100 + レビュー星評価(-100〜+150) + 購入×1000
  - 女優: サイトいいね×150 + 出演作レビュー(-40〜+50) + 出演作購入×200
- **サイトDB** (`lib/siteDb.ts`) — Turso第3インスタンス（`TURSO_SITE_URL`）
  - テーブル: `product_likes` / `actress_likes` / `product_reviews` / `purchase_events`
  - 遅延スキーマ初期化（`initSiteSchema()`）
- **いいねAPI** — `api/like/product/[id]` / `api/like/actress/[name]` (GET/POST トグル)
- **レビューAPI** — `api/review/[id]` (GET一覧 / POST投稿・上書き、1セッション1レビュー)
- **購入イベントAPI** — `api/purchase/[id]` (POST記録)
- **統合スコアランキングAPI** (`api/ranking/route.ts`)
- **ProductDetailClient UIワイヤリング**（いいね・購入トラッキング）
- **レビュー投稿ページ実接続** (`app/review/add/[id]/page.tsx`)
- **av-wiki.netスクレイピング完了** (`scripts/scrape_avwiki.js`)
  - 3,213名処理 / ページ発見2,250名（70%）/ SNS取得892名 / 別名義885名

### Phase 9 — X自動投稿 本番準備完了（2026-03-23）
- **x_autopost.js** — 全5アカウント（002/004/005/006/008）APIキー設定完了
- **リライトモジュール簡略化** (`lib/gemini_rewrite.js`) — フォールバックフレーズのみ（AI依存なし）
- **全5アカウントdry-run動作確認済み**

### Phase 10 — 女優プロフィール拡充・GitHub Actions CI（2026-03-23）
- **FANZA ActressSearch API 全件取得** (`scripts/fetch_fanza_actresses.js`)
  - 59,932人取得 → `data/actress_profiles.json` に hobby/prefectures/image_url 追加
  - 写真あり: 16,611人（27.9%）/ 趣味あり: 3,942人（6.6%）/ 出身地あり: 3,387人（5.7%）
- **女優プロフィールAPI拡充** (`app/api/actress/[name]/route.ts`)
  - `hobby` / `prefectures` / `image_url` をレスポンスに追加
- **女優ページUI更新**（モバイル版・PC版）
  - FANZA写真をプロフィールアイコンに表示（作品サムネより優先）
  - 出身地を基本情報テキストに追加
  - 趣味を別名義・豊胸バッジエリアに追加
- **avwiki全女優スクレイパー稼働中** (`scripts/scrape_avwiki_full.js`)
  - 9,447 URL収集済み / ローマ字スラグ3,720件が対象
- **avwiki品番→女優マッピングスクレイパー稼働中** (`scripts/scrape_avwiki_products.js`)
  - 15,000件品番ページ → FANZA/MGS女優不明作品を特定・DB更新
- **GitHub Actions CI 構築** (`.github/workflows/`)
  - `daily-update.yml` — FANZA+MGS日次更新 CI自動実行
  - `avwiki-scraper.yml` — avwikiスクレイパーを毎時実行、進捗をrepoにコミット
  - `fanza_daily_update.js` / `phase3_daily_update.js` — CI環境でSQLiteスキップ・Turso直接使用に対応
- **Gitリポジトリ初期化** — initial commit (232ファイル)

### Phase 11 — セール情報・MGS価格・女優名検索・自動化改善（2026-03-24）
- **MGS価格・セール情報取得**
  - `list_price` / `current_price` / `discount_pct` / `sale_end_date` カラム追加（MGS DB + Turso）
  - `lib/parser.js` — 検索ページ・詳細ページからの価格パース追加
  - `phase3_daily_update.js` — 新作取得時の価格保存 + 直近3,600件の価格更新（STEP2）
- **FANZAセール期間取得**
  - `fanza_daily_update.js` — DMM APIの `campaign.date_end` から `sale_end_date` 取得
- **商品詳細ページのセールUI刷新**
  - FANZA優先・MGSフォールバックで `discount_pct` / `sale_end_date` を統合表示
  - 赤バッジ `X%OFF` + `〜M/D まで` の期間表示（PC版・モバイル版）
- **MGS女優名インデックス** (`data/mgs_actress_index.json`)
  - `actor[]` URLパラメータから女優IDを抽出・蓄積
  - 日次更新時に当日新作の出演レポートをコンソール出力
- **Discord Webhook URL更新** — 全5ファイル一括更新
- **AVWIKIスクレイパーのバグ修正**
  - `scrape_avwiki_products.js` — SIGTERMハンドラー追加・`saveProgress`をDB更新前に実行
  - `scrape_avwiki_full.js` — SIGTERMハンドラー追加
  - `avwiki-scraper.yml` — `git pull --rebase` でpush競合を解消
- **日次更新スケジュール最適化**
  - FANZA: 深夜 0:05 JST（予約作品公開+5分）
  - MGS: 午前 10:05 JST（新作公開+5分）
  - FANZA・MGSそれぞれ独立したcronジョブ（`if: github.event.schedule`で分岐）
- **Vercel ↔ GitHub 連携**
  - VercelプロジェクトをGitHubリポジトリに接続
  - pushのたびに自動デプロイ
- **全APIルートの即時反映対応**
  - `api/products` / `api/product/[id]` に `export const dynamic = 'force-dynamic'` 追加
  - Turso更新後の次リクエストから最新データを即時配信
- **FANZA女優プロフィール自動更新**
  - `fanza_daily_update.js` — 新出演女優を DMM ActressSearch API で自動取得しTursoに保存
- **AVWIKIスクレイプ結果のサイト自動反映**
  - `scripts/build_avwiki_profiles.js` — `avwiki_full.jsonl` → Turso UPSERT
  - スクレイプ毎時実行後にTursoへ直接書き込み（ファイルコミット不要）

### Phase 12 — 女優プロフィールTurso移行・Vercelエラー解消（2026-03-25）
- **女優プロフィールをFANZA TursoへフルマイグレーションA**
  - `scripts/migrate_actress_profiles_to_turso.js` — 一回限りの移行スクリプト
  - `actress_profiles` テーブル: 59,558件（FANZA+AVWIKIマージ）
  - `actress_aliases` テーブル: 249件（別名義マッピング）
- **女優プロフィールAPIをTurso直接クエリに変更**
  - `api/actress/[name]/route.ts` — `fs.readFileSync` → Tursoクエリ
  - エイリアス解決・プロフィール取得を1〜2クエリで完結
  - `force-dynamic` 追加 → スクレイプ後すぐサイトに反映（デプロイ不要）
- **`build_avwiki_profiles.js` をTurso書き込みに変更**
  - JSONファイル出力廃止 → Turso UPSERT（COALESCE で既存データを保護）
  - 別名義も `actress_aliases` テーブルに登録
- **Vercel Hobbyプランのボットコミットエラーを解消**
  - 原因: `github-actions[bot]` コミットがVercel Hobbyでブロックされエラーメール
  - 解決: 全ボットコミットに `[vercel skip]` を追加
  - 根本解決: 女優プロフィールをTursoへ移行しファイルコミット自体が不要に
- **`next.config.ts` のバンドル設定を簡素化**
  - 女優プロフィールファイル（計13MB）のバンドルを削除
  - Vercelデプロイサイズが大幅縮小

---

## 🔄 稼働中（継続タスク）

| タスク | 状況 | 完了見込み |
|---|---|---|
| avwiki女優スクレイプ | 100/9,447 URL完了（毎時~100件） | 約94時間 |
| avwiki品番マッピング | 100/15,000 URL完了（毎時~200件） | 約75時間 |

---

## 📁 ファイル構成

```
binary-kilonova/
├── .github/workflows/
│   ├── daily-update.yml          # ★ FANZA 0:05 JST / MGS 10:05 JST 自動実行
│   └── avwiki-scraper.yml        # ★ AVWikiスクレイパー (毎時) + profiles変換
├── data/
│   ├── mgs.db                    # MGS SQLite（114,563件）※gitignore
│   ├── fanza.db                  # FANZA SQLite（384,000件+）※gitignore
│   ├── suggest_cache.json        # サジェスト用キャッシュ
│   ├── avwiki_full.jsonl         # avwiki新スクレイプ出力（稼働中）
│   ├── avwiki_product_map.jsonl  # avwiki品番→女優マッピング（稼働中）
│   └── avwiki_product_urls.json  # 品番ページURLリスト（15,000件）
│   ※ actress_profiles.json / avwiki_profiles.json → Turso移行済み（ファイル不要）
├── scripts/
│   ├── fanza_daily_update.js               # ★ FANZA日次更新（女優プロフィールTurso保存）
│   ├── phase3_daily_update.js              # ★ MGS日次更新
│   ├── scrape_avwiki_full.js               # avwiki全女優スクレイパー（稼働中）
│   ├── scrape_avwiki_products.js           # avwiki品番スクレイパー（稼働中）
│   ├── build_avwiki_profiles.js            # ★ avwiki_full.jsonl → Turso UPSERT
│   ├── migrate_actress_profiles_to_turso.js # 移行済み（一回限り）
│   ├── build_suggest_cache.js              # サジェストキャッシュ生成
│   └── ...
└── site/                         # Next.jsアプリ（lunar-zodiac.vercel.app）
    └── app/api/
        ├── products/route.ts        # force-dynamic — 即時反映
        ├── product/[id]/route.ts    # force-dynamic — 即時反映
        └── actress/[name]/route.ts  # force-dynamic — Turso直接クエリ
```

---

## 🔧 日常コマンド

```bash
# FANZA日次更新（女優プロフィール自動取得込み）
node scripts/fanza_daily_update.js

# MGS日次更新
node scripts/phase3_daily_update.js

# avwikiスクレイプ結果をTursoに反映
node scripts/build_avwiki_profiles.js

# サジェストキャッシュのみ再生成
node scripts/build_suggest_cache.js

# avwikiスクレイプ状況確認
node -e "const p=require('./data/avwiki_full_progress.json');console.log('女優:',p.found,'件');"; \
node -e "const p=require('./data/avwiki_products_progress.json');console.log('品番:',p.scraped,'件')"

# サイト開発サーバー
cd site && npm run dev
```

---

## 🗓 データ自動更新フロー

```
毎時        avwikiスクレイプ → avwiki_profiles.json変換 → Vercel自動デプロイ

0:05 JST    FANZAが予約作品公開 (+5分後)
            → fanza_daily_update.js 実行
            → 新作 + 価格 → Turso FANZA DB更新（即時反映）
            → 新出演女優プロフィール → actress_profiles.json更新 → Vercel自動デプロイ

10:05 JST   MGSが新作公開 (+5分後)
            → phase3_daily_update.js 実行
            → 新作 + 価格 + 女優インデックス → Turso MGS DB更新（即時反映）
```
