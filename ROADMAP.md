# AVコンシェルジュ — ロードマップ

> 作成: 2026-03-17 / 最終更新: 2026-03-26

---

## 🎯 目標

FANZAとMGSの作品を横断検索・閲覧できる高品質なアフィリエイトサイト。
独自スコアリングによるランキング・レビュー・いいね機能で差別化。
Tursoによるクラウドネイティブ構成で、Vercelにデプロイして常時稼働させる。

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

### [ ] GitHub Secretsの設定 ← **次のステップ**
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
- `/ranking` ページに「女優ランキング」タブ追加
- `/api/ranking/actress` エンドポイント作成
  - `actress_likes` + 出演作レビュー + 出演作購入でスコア計算

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
| 🔴 高 | GitHub Secrets設定（CIを稼働させる） | **次のステップ** |
| 🔴 高 | Vercel環境変数設定（TURSO_SITE_URL等） | 未着手 |
| 🔴 高 | OGP画像の非露骨化（SNS Phase A） | 未着手 |
| 🔴 高 | Blueskyアカウント登録・`.env`設定 | 未着手 |
| 🔴 高 | Telegram Botアカウント登録・`.env`設定 | 未着手 |
| ⏳ 待機 | avwikiデータ統合（スクレイプ完了後 〜04/08） | スクレイプ中 |
| ⏳ 待機 | avwiki品番DB反映確認（〜04/12） | スクレイプ中 |
| 🟡 中 | セールページ実装 | 未着手 |
| 🟡 中 | 女優ランキングタブ追加 | 未着手 |
| 🟡 中 | レビュー一覧を作品詳細に表示 | 未着手 |

---

## 🌐 デプロイ先

**本番URL: https://lunar-zodiac.vercel.app**

- デプロイは常に `cd site && rm -rf .next && vercel --prod` で実行すること（ビルドキャッシュ問題回避）
- プロジェクト: `avdesires-projects/lunar-zodiac`

---

## 🗒️ メモ

- DMM API レート制限: 1リクエスト/秒（`RATE_LIMIT_MS = 1200ms` で対応）
- Turso 無料プラン制限: 500 DB reads/day → 必要なら有料プランへ
- `suggest_cache.json` は日次更新時に自動再生成される
- `site/.env.local` に Turso 接続情報が入っている（Gitに含めないこと）
  - `TURSO_MGS_URL` / `TURSO_MGS_TOKEN`
  - `TURSO_FANZA_URL` / `TURSO_FANZA_TOKEN`
  - `TURSO_SITE_URL` / `TURSO_SITE_TOKEN` ← サイトDB用（Vercelにも要設定）
- GitHub Actions CI: PCオフ時も毎日10:10 JSTにFANZA+MGS日次更新が実行される
  - Secrets未設定の場合は失敗するので先に設定すること
- avwikiスクレイパー2本が並行稼働中（タスクスケジューラ＋GitHub Actions）
  - `scrape_avwiki_full.js`: 女優プロフィール 残2,383件（〜04/08）
  - `scrape_avwiki_products.js`: 品番→女優マッピング 残14,995件（〜04/12）
