# AVコンシェルジュ — ロードマップ

> 作成: 2026-03-17 / 最終更新: 2026-06-04

---

## 🎯 目標

FANZAとMGSの作品を横断検索・閲覧できる高品質なアフィリエイトサイト。
独自スコアリングによるランキング・レビュー・いいね機能で差別化。
Tursoによるクラウドネイティブ構成で、Cloudflare Workersにデプロイして常時稼働させる。

---

## ✅ 完了済み

### [x] MGS日次更新のTurso対応（2026-03-18）
### [x] Vercelデプロイ（2026-03-18）— `https://lunar-zodiac.vercel.app`
### [x] 定期実行の自動化（2026-03-18）— タスクスケジューラ 毎日10:10
### [x] WEB版デザイン追加・実データ接続（2026-03-21）
### [x] SEO対策（robots.txt / sitemap / OG / JSON-LD）（2026-03-22）
### [x] ヘッダー統一（ホームをNext.jsコンポーネント化）（2026-03-22）
### [x] アフィリエイトリンク改善（MGS+FANZA両方表示）（2026-03-22）
### [x] ランキングシステム設計・実装（独自スコア）（2026-03-22）
### [x] サイトDB構築（likes / reviews / purchase_events）（2026-03-22）
### [x] いいね・レビュー・購入トラッキングAPI（2026-03-22）
### [x] ProductDetailClientのUIワイヤリング（2026-03-22）
### [x] レビュー投稿ページ実接続（2026-03-22）
### [x] av-wiki.netスクレイピング（女優SNS・別名義3213名）（2026-03-22）
### [x] X自動投稿 全5アカウントAPIキー設定・dry-run確認（2026-03-23）
### [x] FANZA ActressSearch API 全59,932人取得・女優ページ反映（2026-03-23）
### [x] avwiki全女優スクレイパー稼働開始（2026-03-23）
### [x] avwiki品番→女優マッピングスクレイパー稼働開始（2026-03-23）
### [x] GitHub Actions CI構築・Gitリポジトリ初期化（2026-03-23）
  - daily-update.yml: FANZA+MGS毎日10:10 JST自動実行
  - avwiki-scraper.yml: 毎時スクレイプ・進捗コミット
  - PCオフでも日次更新・スクレイプが継続される
### [x] 商品詳細ページSEO強化（サーバーサイドmeta/OG/JSON-LD注入）（2026-03-24）
### [x] 貢献者インセンティブ実装（cast_contributions・バッジ・ランキング）（2026-03-24）
### [x] 検索結果ページ全件表示（「もっと見る」offset pagination）（2026-03-25）
  - モバイル版（search.html）・PC版（search-other.html）両対応
  - APIのoffset計算バグ修正（両DB使用時にperOffset=offset/2）
### [x] VR除外フィルター修正（genre=VR → excludeGenres=VR）（2026-03-25）
### [x] 予約・新作・検索ページの全件表示（limit上限撤廃・もっと見るボタン）（2026-03-25）
  - モバイル: LIMIT=60 + 「もっと見る」append
  - PC: FETCH_LIMIT=200 + 「さらに読み込む」append（前後ページ廃止）
  - APIのperLimitバグ修正（limit/2分割廃止 → 両DBから各limit件取得）
  - 新作デフォルト期間を「直近30日」に変更
### [x] 2026年ランキング日付フィルター修正（2026-01-01〜2026-12-31限定）（2026-03-25）
  - /api/ranking/actress に fromDate/toDate パラメータ追加
  - actress-ranking-2026.html・ranking.html(モバイル) に日付フィルター追加
### [x] FANZAレビューデータのDB追加・ランキング反映（2026-03-25）
### [x] スマホ版・PC版 UI改善まとめ（2026-04-08〜09）
  - サンプル画像ライトボックス拡大表示（モバイル・PC）
  - FANZA素人系作品の画質向上（jm.jpg → jp-001.jpg）
  - FANZAサンプル動画再生修正（エスケープスラッシュ対応）
  - スマホ版作品一覧ページ: FANZAとMGS実データ表示、全フィルターボタン機能化
  - スマホ版カスタムランキング作成ページ: Stitch設計を使用、フォーム送信実装
  - スマホ版女優ランキング: Stitch仮データ削除、リアルデータのみ表示
  - スマホ版ランキング→カスタムランキング遷移（tuneアイコン実装）
  - カスタムランキングページ: ボトムナビ削除、「この条件でランキングを作成」ボタン表示
  - 詳細検索・カスタムランキングのプラットフォームデフォルトを「両方」に変更
  - PC版詳細検索: プラットフォーム・ジャンル・カップ数の選択枠をオレンジ色に修正
### [x] Turso読み取り削減 フェーズ1（2026-04-08）
  - `lib/apiCache.ts` 新規: 共通TTLインメモリキャッシュ（最大100エントリ）
  - `searchOptions.ts`: getSearchOptions()をTurso不要化（suggest_cache.json読み込み）、SAMPLE 15000→3000削減
  - `getContextualSearchOptions()` に5分キャッシュ追加
  - `/api/products`: offset=0クエリに5分インメモリキャッシュ
  - `/api/ranking` `/api/ranking/actress`: 30分インメモリキャッシュ
  - `scripts/generate-static-cache.mjs` 新規: 静的JSONキャッシュ生成スクリプト
  - 静的JSON優先配信: 新着・人気作品・2026ランキング・女優ランキングはTurso読み取りゼロ化（Turso解除後に有効化）
### [x] Turso読み取り削減 フェーズ2（2026-04-17）
  - **ローカルSQLiteから静的キャッシュ生成**: Turso未接続時でもキャッシュ更新可能に
    - `scripts/generate-static-cache-local.mjs` 新規: ローカルfanza.db/mgs.dbから生成
    - `data/home_preorder_cache.json` / `data/sale_cache.json` 新規追加
  - **SSRデータの静的JSON優先化** (`lib/ssrFetch.ts`):
    - `ssrFetchFanzaPreOrders` / `ssrFetchFanzaNewProducts` / `ssrFetchRanking` / `ssrFetchActressRanking`
    - 各関数で静的JSONを優先読み込み → Tursoブロック中でもホームページが正常表示
  - **APIの静的キャッシュ拡張** (`/api/products`):
    - `sort=pre-order` → `home_preorder_cache.json`
    - `sort=discount` → `sale_cache.json`（minDiscountフィルタも対応）
  - **Vercel CDN キャッシュ実装** (`lib/staticCache.ts` に `cacheHeaders()` 追加):
    - 静的キャッシュ経由レスポンス: `s-maxage=3600, stale-while-revalidate=86400`（1時間CDNキャッシュ）
    - インメモリキャッシュ経由: `s-maxage=300`
    - Turso直接クエリ: `s-maxage=60`
    - ページHTML: `/sale` `/ranking/2026` `s-maxage=3600` / `/ranking` `/products` `s-maxage=600` / `/` `s-maxage=60`
    - 効果: 同一URLの2回目以降はTurso呼び出しゼロ
  - **セールページ実装** (`/sale`):
    - モバイル `public/design/sale.html` / PC `public/design/web/sale.html`
    - 割引率フィルター（10%/20%/30%/50%以上）
    - ボトムナビ「動画」→「セール」に差し替え / PCナビに「セール」追加
    - ホームページにセールカルーセルセクション追加（モバイル・PC両対応）
### [x] GitHub・Vercel・SNS設定・自動投稿キュー連携（2026-04-18 後半）
  - リポジトリをPublicに変更（GitHub Actions無制限化）
  - GitHub Secrets 7件確認済み（DMM_API_ID / DMM_AFFILIATE_ID / DMM_AFFILIATE_IDS / TURSO_FANZA_URL / TURSO_FANZA_TOKEN / TURSO_MGS_URL / TURSO_MGS_TOKEN）
  - Vercel環境変数 確認済み（ADMIN_KEY / NEXT_PUBLIC_SITE_URL / TURSO_SITE_URL / TURSO_SITE_TOKEN）
  - Blueskyアカウント登録（`avrankings.bsky.social`）・App Password設定済み
  - Telegramアカウント・Bot作成・チャンネル（`@avrankings`）設定済み
  - 全SNSスクリプトの `SITE_BASE_URL` を `avrankings.com` に統一
  - Telegram・Bluesky・Xスクリプトを管理画面キュー（`x_post_decisions`）連動に改修
    - 管理画面で承認 → `decision='approve'` 登録 → スクリプトが自動投稿
    - 重複投稿防止: `posted_at` / `posted_bsky_at` / `posted_tg_at` カラムで管理
  - `/admin/x-post` をデザインエクスポート（`x-post-select.html`）のカードレイアウトに刷新
    - ヘッダーは現行の管理画面ヘッダーを維持
    - ジャンル別アクセントカラー・Public Sansフォント・レスポンシブグリッド
  - Telegramスクリプト: `TELEGRAM_CHANNEL_NEW` / `TELEGRAM_CHANNEL_SALE` → `TELEGRAM_CHANNEL` 1本化

### [x] 管理画面・出演者追加・セールページ改善（2026-04-18）
  - 管理画面パスワード設定（`ADMIN_KEY` を `.env.local` で管理）
  - カスタムランキング・詳細検索: 身体的特徴（身長・カップ・年齢）指定時に出演者ランキングへ振り分け
  - `/api/ranking/actress` に height/cup/ageMin フィルター追加（actress_profiles.json 参照）
  - 出演者ランキングページ: 身体的特徴フィルターバッジ表示・フィルター付きAPI呼び出し対応
  - セールページ（PC・モバイル）: 終了日表示（`sale_end_date`）実装
    - FANZAのAPIが `campaign.date_end` を返す作品のみ表示（現状は全件NULL）
    - **Turso読み取り制限解除（2026-05-01）後に `fanza_daily_update.js` を再実行すること**
  - 出演者情報追加ページ（`/cast/register/[id]`）: 横長パッケージ画像表示・フォーム送信実装
  - 出演者情報追加完了ページ（`/cast/complete`）: 新規ルート作成（`cast-add-complete.html` 配信）
  - **⚠️ 管理画面の動作確認は Turso 読み取り制限解除（2026-05-01）後に行うこと**
    - 現在ローカル開発サーバーから Turso への読み取りがブロック中
    - コード自体は正しく実装済み。制限解除後に投稿データ確認・動作検証を行う

### [x] スマホヘッダー検索欄修正・ボトムナビリンク修正（2026-03-26）
  - MOBILE_SEARCH_SCRIPT: `/api/suggest?q=` 形式に更新（旧: 全件取得→クライアントフィルタ、新: サーバーサイドフィルタ）
  - 女優は文字列配列 / メーカーも表示
  - ボトムナビ「検索」: `/search` → `/search/advanced`
  - ボトムナビ「動画」: `/search?sort=new` → `/video`
  - `/video`: ReactページをDesign_Export(video.html)に切り替え、APIデータ接続済み
  - `/search/advanced`: Design_Export(advanced-search.html)を配信
  - `/api/products` に `hasVideo=1`・`sample_video_url` SELECT 追加
  - FANZA Turso DBに review_count / review_average カラム追加
  - fanza_daily_update.js で DMM API の review.count / review.average を保存
  - scoring.ts に FANZA_REVIEW=400 係数追加（review_count × average/5 × 400）
  - /api/ranking でFANZAレビュースコアをランキング計算に組み込み

---

## 🚀 優先度: 高

### [ ] Tursoブロック解除後: 静的JSONキャッシュ生成 ← **次のステップ（〜2026-05-01）**
- Turso無料枠は毎月1日リセット。解除されたら即実行すること
- 手順:
  1. `cd site && node scripts/generate-static-cache.mjs`
  2. `npx vercel deploy --prod --yes`
  3. `git add data/*_cache.json && git commit -m "静的キャッシュ更新" && git push`
- 生成されるファイル:
  - `data/products_new_cache.json` — 新着作品60件（Turso読み取りゼロ化）
  - `data/products_popular_cache.json` — 人気作品60件（Turso読み取りゼロ化）
  - `data/ranking_2026_cache.json` — 作品ランキング2026 top100（Turso読み取りゼロ化）
  - `data/actress_ranking_2026_cache.json` — 女優ランキング2026 top50（Turso読み取りゼロ化）
- 以降、月1回または新しいデータに更新したいタイミングで再実行する

### [ ] GitHub Secretsの設定
- GitHubリポジトリ → Settings → Secrets and variables → Actions
- 追加するSecrets:
  - `DMM_API_ID` / `DMM_AFFILIATE_ID` / `DMM_AFFILIATE_IDS`
  - `TURSO_FANZA_URL` / `TURSO_FANZA_TOKEN`
  - `TURSO_MGS_URL` / `TURSO_MGS_TOKEN`
- 設定完了でGitHub ActionsのCI（日次更新・avwikiスクレイプ）が稼働開始

### [ ] Vercel環境変数の設定
- `TURSO_SITE_URL` / `TURSO_SITE_TOKEN` をVercelダッシュボードに追加
- サイトDBが本番で機能するために必須

### [ ] avwikiスクレイプ完了後: データ統合
- `avwiki_full.jsonl` → `avwiki_profiles.json` にマージするスクリプト作成
- 別名義を `actress_aliases.json` に統合してサジェスト精度向上
- 完了まで残り約16日（2026-04-08頃）

### [ ] avwiki品番スクレイプ完了後: DB反映確認
- MGS/FANZA女優不明作品がどれだけ特定されたか確認
- 完了まで残り約20日（2026-04-12頃）

### [ ] セールページの追加
- `/sale` ルートを新規作成
- `discount_pct > 0` の作品一覧を割引率順で表示
- API: `/api/products?sort=discount` を追加

---

## 📋 優先度: 中

### [ ] 女優ランキングタブ
- スマホ版: 作品タブ・出演者タブ切り替えは実装済み
- PC版: 女優ランキングセクションを追加
- `/api/ranking/actress` エンドポイント実装済み（actress_likes + wish_countでスコア計算）

### [ ] レビュー一覧の作品詳細ページへの表示
- `ProductDetailClient.tsx` にレビューセクション追加
- `/api/review/[id]` GET で取得、星評価サマリー + コメント一覧表示

### [ ] セール情報をサイトに表示
- 作品詳細ページに「○%OFF セール中」バッジを表示
- トップページにセール中作品のカルーセルを追加

### [ ] 検索機能の強化
- 複数ジャンル AND/OR 検索
- 発売日範囲指定（カレンダー UI）
- 価格帯フィルター（〜500円 / 〜1000円 / 1000円〜）

### [ ] 検索のロングテール対策（Turso読み込み削減の最終段階）← 条件付き
- 背景: 2026-06-04にTurso読み込み94%到達への対策を実施済み
  - バッチ重複解消（generate-static-cache 1日3回→1回）
  - FANZAインデックス追加（フルスキャン解消）
  - 女優プロフィール6万件・女優別商品リスト2,445人を静的JSON化
  - 商品詳細をR2 read-throughキャッシュ化（→ `avrankings-r2-cache` 参照）
- **残るTurso読み込み源は「検索のロングテール」**:
  - 女優×ジャンル×日付など組み合わせが無限のフィルター検索
  - `actress_extended_products.json`(2,445人)に入らないマイナー女優の検索
  - 短い検索語（3文字未満）のLIKE検索（FTS5が効かずフルスキャン）
- 対策候補（着手時に検討）:
  1. フィルター検索結果もR2 read-throughキャッシュ化（クエリ文字列をキーに、TTL付き）
  2. フィルター検索のCF Cache TTL延長（現状30分→数時間）
  3. `actress_extended_products.json` の対象を2,500人→拡大（10作品/人に減らせば人数増可能、25MBアセット上限に注意）
  4. 3文字未満検索のFTS5 trigram対応 or 最小文字数制限
- **着手条件: 来月（2026-07）もTurso読み込みが上限に近い場合**。まず6月の数字で今回の対策効果を確認してから判断する

---

## 📢 SNS戦略（`SNS_STRATEGY.md` 参照）

### [ ] Phase A — OGP画像の非露骨化（クッションページ整備）
- 作品詳細ページのOG imageをセンシティブでない画像に制御

### [x] Phase B — x_autopost.js リファクタ・APIキー設定完了（2026-03-23）

### [ ] Phase C — Bluesky自動投稿 アカウント登録・設定
- `scripts/bluesky_autopost.js` 実装済み（`@atproto/api` v0.19.4）
- **残タスク**: Blueskyアカウント登録 → `BSKY_MAIN_IDENTIFIER` / `BSKY_MAIN_PASSWORD` を`.env`に入力

### [ ] Phase D — Telegram Bot アカウント登録・設定
- `scripts/telegram_bot.js` 実装済み（`telegraf` v4.16.3）
- **残タスク**: BotFather でBot作成 → `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHANNEL_NEW` / `TELEGRAM_CHANNEL_SALE` を`.env`に入力

---

## 💡 優先度: 低（アイデア）

### [ ] 週間・月間ランキング
- wish_count の変化を追跡（`wish_count_history` テーブル）
- 週間増加数でランキング

### [ ] MyPage統計
- localStorageの閲覧履歴・いいね一覧を表示
- 購入済み作品マーク

### [ ] サイト高速化
- Next.js の ISR（Incremental Static Regeneration）活用
- 人気作品ページを静的生成

---

## 📅 直近の作業予定

| 優先 | タスク | 状態 |
|------|--------|------|
| 🔴 高 | **Tursoブロック解除後に静的JSON生成**（〜06/01） | ⏳ 待機中 |
| 🔴 高 | **管理画面・投稿データ動作確認**（Turso解除後 06/01〜） | 待機中 |
| 🔴 高 | **fanza_daily_update.js 再実行 → sale_end_date 取得確認**（06/01〜） | 待機中 |
| 🟡 中 | OGP画像の非露骨化（SNS Phase A） | 未着手 |
| 🟡 中 | Blueskyアカウント登録・`.env`設定 | 未着手 |
| 🟡 中 | Telegram Botアカウント登録・`.env`設定 | 未着手 |
| 🟡 中 | 女優ランキングタブ追加 | 未着手 |
| 🟡 中 | レビュー一覧を作品詳細に表示 | 未着手 |
| ⚠️ 条件付 | **Oracle Cloud移行**（6月もTurso上限に到達した場合） | 待機中 |

---

## 🌐 デプロイ先

**本番URL: https://avrankings.com**

- デプロイ: `cd site && npm run deploy:cf:only`
- プロジェクト: Cloudflare Workers（`wrangler.toml` 参照）

---

## 🗒️ メモ

- DMM API レート制限: 1リクエスト/秒（`RATE_LIMIT_MS = 1200ms` で対応）
- Turso 無料プラン制限: 読み取り上限は月次リセット（毎月1日）。2026-05-13現在上限超過中（解除: 2026-06-01）
  - ブロック解除後にやること（順番通りに実行）:
    1. `node scripts/generate-static-cache.mjs` → 静的JSONキャッシュ生成
    2. `cd site && npm run deploy:cf:only` → Cloudflare Workers 本番デプロイ
    3. `node scripts/fanza_daily_update.js` → sale_end_date 取得（campaign.date_end が入れば表示されるようになる）
    4. 管理画面（`/admin/x-post`）で投稿データ（出演者追加・SNS・改名）の動作確認
    5. `node scripts/x_autopost.js --dry-run` → X投稿dry-run確認
    6. `node scripts/bluesky_autopost.js --dry-run` → Bluesky投稿dry-run確認
    7. `node scripts/telegram_bot.js --mode=notify --dry-run` → Telegram投稿dry-run確認
  - ホーム・ランキング・新着など主要エンドポイントはJSONから配信されTurso読み取りゼロになる
- **6月にTurso読み込み上限が再び到達した場合はOracle Cloud Autonomous Databaseへ移行する**（→ 下記「DB移行計画」参照）
- `suggest_cache.json` は日次更新時に自動再生成される
- `site/.env.local` に Turso 接続情報が入っている（Gitに含めないこと）
  - `TURSO_MGS_URL` / `TURSO_MGS_TOKEN`
  - `TURSO_FANZA_URL` / `TURSO_FANZA_TOKEN`
  - `TURSO_SITE_URL` / `TURSO_SITE_TOKEN` ← サイトDB用（Vercelにも要設定）
- GitHub Actions CI: PCオフ時も毎日10:10 JSTにFANZA+MGS日次更新が実行される
  - Secrets未設定の場合は失敗するので先に設定すること
- avwikiスクレイパー: 完了済み

---

## 🗄️ Turso 完全廃止 → Cloudflare D1 移行（コード移行: 完了）

**移行先: Cloudflare D1（全て無料枠内）**。Turso 3 DB（MGS/FANZA カタログ + SITE 可変データ）を
すべて D1 に統合。Oracle 案は不採用（CF 内で完結し追加サービス不要なため）。

### 無料枠の設計方針（D1 Free: 合計5GB / 読 500万行・書 10万行 per day / 10 DBまで）
- **読**: ホットパス（ホーム/ランキング/新着/人気/商品詳細/サジェスト）は従来どおり静的JSON+R2（D1読み取り0）。
  D1 はロングテール検索のフォールバック専用。テキスト検索は FTS5(trigram)、構造化は B-tree インデックスで
  1クエリの rows_read を最小化。
- **書**: 初期インポート約49万行(products)+約49万行(FTS)は **10万行/日**に合わせ日割り。
  日次デルタは数百〜数千行で上限内。価格更新では FTS トリガを WHEN ガードで発火させず書き込み枠を温存。

### コードに入った変更（このコミット）
- `site/lib/turso.ts` … @libsql → **D1 バインディング(DB_MGS/DB_FANZA/DB_SITE)アダプタ**（execute互換、await化）
- 全 route/lib（約23ファイル）… `getXxxClient()` を `await` 化（呼び出し本体は不変）
- `site/wrangler.toml` … D1 バインディング3つ追記
- `site/migrations/0001_site.sql` `0002_catalog_mgs.sql` `0003_catalog_fanza.sql` `0004_catalog_fts.sql`
- 移行スクリプト: `scripts/export_turso_site_to_d1.mjs` / `scripts/export_catalog_to_d1.mjs`
- D1 REST クライアント: `scripts/lib/d1.js`（libsql互換 execute/batch、位置アクセス対応、close no-op）
- 日次/週次 書き込み: `fanza_daily_update.js` `phase3_daily_update.js` `build_suggest_cache.js`
  `site/scripts/generate-weekly-cache.mjs` `site/scripts/generate-static-cache.mjs` を D1 化
- workflows: `daily-update.yml` `weekly-price-refresh.yml` `weekly-sitemap-cache.yml` の env を D1 シークレットに更新

### 進捗（2026-06-05 実施分）
- ✅ **D1 3つ作成済み**（wrangler.toml に database_id 反映済み）:
  `avrankings-site=a1161083-9be8-4338-85ee-aebd0900c0b0` /
  `avrankings-fanza=d899665d-0959-4fec-b801-9bb8010a822d` /
  `avrankings-mgs=b16721a8-273b-460d-b476-89a814a8f459`
- ✅ **スキーマ投入済み**（0001 SITE / 0002 MGS / 0003 FANZA / 0004 FTS×2）
- ✅ **カタログ全量投入済み**: MGS 117,695 + FANZA 374,727（products=FTS 一致、検索動作確認済み）。storage 計 約1.45GB（5GB枠内）。
  ※ 1チャンク50k行＝約40万write（インデックス+FTS で約8倍）。累計約390万 write 投入したが**無料枠の書き込み上限ブロックは発生せず**完走。`wrangler d1 import` は当バージョンに存在せず **`d1 execute --remote --file`** で投入（`export_catalog_to_d1.mjs` はD1のSQL文上限~100KB対策でバイト分割、0004適用後はproducts投入時にトリガがFTS自動生成）。
- ⏳ **未完**: SITE データ移行 / シークレット投入 / 本番デプロイ / Turso削除。

### ✅ 残りのユーザー実行 runbook
1. **SITE データ移行（要 Turso 読み取り回復）**: 現状 Turso SITE は**読み取り禁止（無料枠超過）**で吸い出せない。読み取りが回復したら:
   ```
   node ../scripts/export_turso_site_to_d1.mjs
   for f in ../d1_export/site/*.sql; do wrangler d1 execute avrankings-site --remote --file="$f"; done
   ```
   （回復しない場合は既存いいね/レビューは諦め、空SITEで運用＝新規はD1に蓄積）
2. **シークレット投入**（D1編集権限のAPIトークンを作成）:
   - **GitHub Secrets**: `CLOUDFLARE_ACCOUNT_ID` `CLOUDFLARE_D1_TOKEN` `D1_FANZA_ID` `D1_MGS_ID`（投稿スクリプトでSITE書く場合 `D1_SITE_ID`）。
   - **ローカル実行用**: `.env`（root, 日次スクリプト）と `site/.env.local`（generate系・投稿系）に同じ変数を追記。
   - ランタイム（Workers）は wrangler.toml の binding 経由なのでダッシュボード変数追加は不要。
3. **デプロイ**: `cd site && npm run deploy:cf`（※ SITE データ移行 or 諦めの判断後に。今は保留中）
4. **検証**（下記「検証」）後、**Turso 3 DB を削除**し各所の `TURSO_*` を撤去。

### 🔍 検証
- ローカル: `wrangler d1 execute <db> --local --file=migrations/*.sql` でスキーマ確認 → `wrangler dev` でいいね/レビュー/検索を試す。
- 本番デプロイ後: ホーム/ランキング/新着が静的経由で表示（D1読み取り0）。詳細検索のロングテール（マイナー女優/メーカー）が FTS 経由で返る。いいね/レビュー/購入/出演者投稿が D1 に記録される。
- D1 メトリクスで日次 読/書 が無料枠内か 1〜2日観測。

### ✅ 追加で D1 化済み（2026-06-05）
- **avwiki**: `scrape_avwiki_products.js`（接続をd1化。FTSトリガ管理 DROP/rebuild/CREATE は `scripts/lib/d1.js` 側で
  no-op 化＝D1のproducts_auトリガが自動同期）、`build_avwiki_profiles.js`、`avwiki-scraper.yml` の env。
- **投稿系**: `bluesky_autopost.js` / `x_autopost.js` / `telegram_bot.js`（site/mgs/fanza クライアントを `d1(...)` に）。

### ✅ 後始末も完了（2026-06-05）
- `@libsql/client` を package.json(root/site) から削除。`site/wrangler.toml` の `[alias] cross-fetch` と
  `postinstall: patch-hrana.js` を撤去。不要ファイル `cf-cross-fetch-shim.js` / `scripts/patch-hrana.js` /
  `scripts/export_turso_site_to_d1.mjs` を削除。
- `site/scripts/generate-static-cache-local.mjs` を `scripts/lib/localsqlite.cjs`(better-sqlite3 の libsql互換ラッパ)へ切替（動作確認済み）。
- ランタイムは @libsql 非依存（バンドルの libsql 記載は Next の tracingIncludes のみで実importなし。次回ビルドで消える）。

### ⏳ 任意の残り
- 一回限りの保守/デバッグ系（`_*`, `migrate_*_to_turso.js`, `create_fts5.js`, `backfill_*`, `delete_*` 等）は
  Turso 削除済みのため既に非機能。使う場合のみ D1 化。`npm ci` 後はこれらが `@libsql` 不在で起動時エラーになる点に注意。
- 完全に反映するには次回の `npm install`（@libsqlをnode_modulesから除去）+ `npm run deploy:cf`（クリーンなバンドル再生成）。
