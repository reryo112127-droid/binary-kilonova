# AVコンシェルジュ — 進捗記録

> 最終更新: 2026-06-15

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
- **avwiki品番→女優マッピングスクレイパー稼働中** (`scripts/scrape_avwiki_products.js`)
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
- **Discord Webhook URL更新** — 全5ファイル一括更新
- **AVWIKIスクレイパーのバグ修正**
- **日次更新スケジュール最適化**
  - FANZA: 深夜 0:05 JST / MGS: 午前 10:05 JST
- **Vercel ↔ GitHub 連携** — pushのたびに自動デプロイ
- **全APIルートの即時反映対応** — `force-dynamic` 追加
- **FANZA女優プロフィール自動更新** — 新出演女優を自動取得しTursoに保存
- **AVWIKIスクレイプ結果のサイト自動反映** — `build_avwiki_profiles.js`

### Phase 12 — 女優プロフィールTurso移行・Vercelエラー解消（2026-03-25）
- **女優プロフィールをFANZA TursoへフルマイグレーションA**
  - `actress_profiles` テーブル: 59,558件（FANZA+AVWIKIマージ）
  - `actress_aliases` テーブル: 249件（別名義マッピング）
- **女優プロフィールAPIをTurso直接クエリに変更**
- **`build_avwiki_profiles.js` をTurso書き込みに変更**
- **Vercel Hobbyプランのボットコミットエラーを解消**
- **`next.config.ts` のバンドル設定を簡素化**（デプロイサイズ大幅縮小）

### Phase 13 — 検索UI拡充・AVWIKI最適化・日次更新修正（2026-03-25）
- **女優プロフィールカード** — `?actress=name` のURL時に検索結果上部に表示
- **MGS / FANZA / すべて 3択トグル** — WEB版検索結果
- **動的サイドバーフィルター** — 実際のメーカー・ジャンルを集計してAND絞り込み
- **詳細検索ページ** (`/search/advanced`) — 完全リニューアル
  - 身長・カップ・年齢・ジャンル40種・期間指定など
- **Products API 身体フィルター拡充** — `cups` / `ageMin` / `ageMax` パラメータ
- **`avwiki_local_runner.js`** — 女優+品番スクレイパーを並列実行・Discord通知
- **FANZA日次更新の方針変更** — 新作取得→予約商品取得（明日〜2ヶ月先）
- **素人カテゴリ (`floor=videoc`) 追加**
- **MGS日次更新バグ修正** — スキーマ適用順序の問題解消（24日間停止を解消）

### Phase 16 — DB最適化・不要データ削除・デイリーフィルター強化（2026-05-13）

#### FANZA videoc（素人）DB取り込み
- **`scripts/fanza_videoc_fetch.js`** — FANZA videoc (floor=videoc) の全作品をTurso + ローカルfanza.dbに取り込み
  - Turso FANZA DBに追加（素人カテゴリ）
  - ローカルfanza.dbへの書き込み追加（better-sqlite3、価格スキャン用）
- **`scripts/scrape_avwiki_products.js`** — `fanza-shirouto-index` のコメントを外して素人系女優情報のスクレイピングを有効化

#### Best/総集編/オムニバス/リマスター削除
- **`scripts/delete_compilations.js`** 新規作成（`--dry-run`対応）
  - FANZA Turso / MGS Turso / ローカルfanza.db から一括削除
  - 削除件数: FANZA ~27,000件 / MGS ~5,000件 / ローカル ~27,000件
- **デイリーフィルター追加**: `COMPILATION_RE = /BEST|ベスト|総集編|オムニバス|リマスター/i` を両日次スクリプトに追加

#### 低品質メーカー削除（30メーカー）
- **`data/blocked_makers.json`** 新規作成（30メーカーのブロックリスト）
  - 対象: グローバルメディアエンタテインメント、小林興業、アテナ映像、ドリームステージ、アリーナエンターテインメント、メディアバンク、FAプロ、アルファーインターナショナル、シネマジック、レアルワークス、いきなりエロざんまい、VIP、JUKUJO99、ながえスタイル ほか16メーカー
  - 削除件数: FANZA Turso 15,116件 / MGS Turso 2,169件 / ローカル 17,069件
  - 合計削除: **34,354件**（Best/総集編分と合わせ合計 ~88,000件削除）
- **`fanza_daily_update.js` / `phase3_daily_update.js`** — BLOCKED_MAKERSフィルターをデイリー取得時に適用

#### SQL logic error 修正
- **原因**: `products_au` トリガー（FTS5更新用）がlibsql HTTP経由のUPDATE時にエラー
- **修正**: 両日次スクリプトの価格UPDATE前に `DROP TRIGGER IF EXISTS products_au` を追加

#### デプロイ先変更確認
- Vercel → **Cloudflare Workers** に移行済み
- デプロイコマンド: `npm run deploy:cf:only`

---

### Phase 15 — ホーム・商品詳細・動画ページ改善（2026-04-01）

#### ホームページ データフィルター
- 予約作品: `source=fanza` + `sale_start_date DESC`（配信日が遠い順）に変更
- 新作: `source=fanza` + 当日配信のみ（0件時は直近3日にフォールバック）
- BEST/総集編除外: `excludeBest=1` + 主要メーカー縛り（HOME_MAKERS）

#### 商品詳細ページ データ品質修正
- PC版「出演者 / 制作者」ラベルを「出演者」のみに変更
- `duration_min <= 1` のデータ不備（DMM APIプレースホルダー）をAPI/UI両方で非表示
- `actressFilter.ts` 改善: `\d+歳`・`【】` 含む説明文エントリを検出してフィルタ除外

#### 動画ページ 実装
- TikTok風 snap-scroll 縦フィード（`scroll-snap-type: y mandatory`）
- 「ランダム」タブ: 主要メーカー縛りのランダムMGS動画（無限スクロール）
- 「あなたへ」タブ: いいね作品から上位女優を抽出 → 女優別に関連動画
  いいねなし時は空状態でランキングへ誘導
- ポスター→タップ→MGSプロキシ（`/api/mgs-video`）→MP4インライン再生
- IntersectionObserverで次カードのMP4をプリフェッチ
- 画面外に出た動画は自動一時停止

### Phase 14 — MGSサンプル動画・FANZAシリーズ/VR/別名統合（2026-03-31）

#### MGSサンプル動画インライン再生
- **`/api/mgs-video` プロキシAPI** 新規作成
  - `sampleplayer.html/{UUID}` → `sampleRespons.php?pid={UUID}` → MP4 URL変換
  - 商品詳細ページでMGS動画をインライン再生（外部遷移廃止）

#### FANZAシリーズ情報・VRフラグ
- **`series_id` / `series_name` / `vr_flag` カラム追加**（FANZA Turso・スキーマ）
- **`fanza_daily_update.js` / `fanza_phase1_fetch.js`** — 新規取得時にシリーズ・VR情報を保存
- **`fanza_series_vr_backfill.js`** — 既存22万件にバックフィル
  - STEP1: タイトルパターンでVRフラグ即時更新（19,669件）
  - STEP2: DMM API月別再取得でシリーズ情報更新（8,174件）
- **商品詳細ページ** — VRバッジ・シリーズリンク表示（モバイル・WEB両対応）
- **検索API** — `series` / `vr` クエリパラメータ対応

#### AVWikiスクレイピング完了・DB反映
- **`avwiki_by_actress.js`** — 36,971名処理完了（全FANZAデータの女優名で検索）
- **`seesaawiki_by_actress.js`** — 完了済み
- **`--apply-only`実行** — FANZA DB反映
  - seesaawiki: 204,775件
  - avwiki（1回目）: 451,660件
  - avwiki（最終）: 195,943件（スクレイパー完了後の追加分）
- **女優特定率（最終）**
  - FANZA: 308,500件 / 448,585件（**68.8%**）
  - MGS: 54,643件 / 115,409件（**47.3%**）
  - 合計: 363,143件 / 563,994件（**64.4%**）

#### AVWiki別名・引退データのDB統合
- **`merge_avwiki_aliases.js`** — avwiki_full.jsonlの別名・引退データを統合
  - `actress_aliases.json`: 231グループ/484名 → **1,189グループ/3,311名**
  - Turso `actress_profiles`: aliases設定済み **2,118人** / retired設定済み **89人**
- **`/api/actress/[name]`** — `retired` フィールド追加

#### 商品詳細ページ：出演者プロフィールカード
- **モバイル版** — アフィリエイトボタン上に出演者プロフィールカード表示
- **WEB版** — 右カラム（1/3幅）に出演者プロフィールカード表示
- 表示内容: 顔写真・名前・身長・スリーサイズ・年齢・引退バッジ
- 女優ページへのリンク付き
- プロフィールデータなし（素人等）の場合は非表示

#### 検索高速化（FTS5 trigram）
- **`scripts/create_fts5.js`** — FANZA・MGS両DBにFTS5 trigramインデックス構築
  - FANZA: 448,585件を一括INSERT（1分49秒）
  - MGS: 115,409件を一括INSERT（41秒）
- **`site/app/api/products/route.ts`** — LIKEをFTS5サブクエリに置き換え
  - 対象: `actress` / `genre` / `q`（title+actresses）/ `profileActresses`
  - **FANZA actress検索: 17秒 → 24ms（700倍高速化）**
  - **FANZA genre検索: 9.8秒 → 17ms**
  - **MGS検索: 2.1秒 → 20ms**

#### サジェスト・エイリアスデータ整備
- suggest_cache から誤登録21名を削除
- `actress_aliases.json` の誤グループ修正（ゴミデータ除去）

---

## 📊 現在のデータ規模

| DB | 総作品数 | 備考 |
|---|---|---|
| FANZA Turso | ~361,000件 | Best/総集編/低品質メーカー削除後 |
| MGS Turso | ~99,000件 | Best/総集編/低品質メーカー削除後 |
| ローカルfanza.db | ~411,000件 | 価格スキャン用 |

| 女優プロフィール | 件数 |
|---|---|
| 総プロフィール数 | 59,696人 |
| 別名データあり | 2,118人 |
| 引退フラグあり | 89人 |
| 別名検索グループ | 1,189グループ / 3,311名 |

---

## 🔄 稼働中（継続タスク）

| タスク | 状況 |
|---|---|
| FANZA日次更新 | 毎日 0:05 JST（GitHub Actions）継続中 |
| MGS日次更新 | 毎日 10:05 JST（GitHub Actions）継続中 |
| avwikiスクレイパー | 全完了 |
| seesaawikiスクレイパー | 全完了 |

---

## 📁 ファイル構成

```
binary-kilonova/
├── .github/workflows/
│   ├── daily-update.yml          # ★ FANZA 0:05 JST / MGS 10:05 JST 自動実行
│   └── avwiki-scraper.yml        # 手動実行のみ（スケジュール削除済み）
├── data/
│   ├── mgs.db                    # MGS SQLite（115,409件）※gitignore
│   ├── fanza.db                  # FANZA SQLite（448,585件）※gitignore
│   ├── actress_aliases.json      # 別名グループ（1,189グループ/3,311名）
│   ├── avwiki_full.jsonl         # avwikiスクレイプ結果（2,859件）
│   └── avwiki_actress_map.jsonl  # 女優→品番マッピング
│   ※ actress_profiles.json → Turso移行済み（ファイル不要）
├── scripts/
│   ├── fanza_daily_update.js          # ★ FANZA日次更新
│   ├── phase3_daily_update.js         # ★ MGS日次更新（Discord通知付き）
│   ├── create_fts5.js                 # FTS5 trigramインデックス構築
│   ├── merge_avwiki_aliases.js        # AVWiki別名・引退データ統合
│   ├── fanza_series_vr_backfill.js    # シリーズ/VRフラグバックフィル
│   ├── avwiki_by_actress.js           # avwiki女優名→品番マッピング（完了）
│   ├── seesaawiki_by_actress.js       # seesaawiki女優スクレイパー（完了）
│   ├── build_avwiki_profiles.js       # avwiki_full.jsonl → Turso UPSERT
│   ├── build_suggest_cache.js         # サジェストキャッシュ生成
│   └── monitor_progress.js            # スクレイピング進捗監視・Discord報告
└── site/                         # Next.jsアプリ（lunar-zodiac.vercel.app）
    └── app/api/
        ├── products/route.ts        # FTS5対応・force-dynamic
        ├── product/[id]/route.ts    # MGS+FANZA両DB並行検索
        ├── actress/[name]/route.ts  # retired フィールド追加
        └── mgs-video/route.ts       # MGSサンプル動画プロキシ
```

---

## ✅ 2026-06 — UI/データ品質・SNS自動投稿

### サイト改善
- **人気順の統一マージ**: MGS(お気に入り)×FANZA(レビュー)を各PF内で z-score 標準化し統一スコアで混在（`mergeByZScore`）
- **クロスプラットフォーム価格比較**: 商品詳細でMGS↔FANZA同一作品の両アフィリンク＋安い方を表示（`build_cross_platform.js`）
  - **価格条件の統一**: FANZA=ダウンロード価格 / MGS=最安(視聴)価格で不公平比較になっていた問題を修正。MGSのダウンロード買い切り価格を詳細ページから収集(`build_mgs_buy_price.js` → `mgs_buy_price.json`)し、APIが優先参照。両PFともダウンロード買い切りで比較（日次更新では上書きされない別キャッシュ管理）
- **画像品質の是正**: `poster()` で MGS裏表紙`pb_e_`→表紙`pf_e_`、素人`jm.jpg`(100×100)→`jp-001.jpg`、`pt/ps`→`pl`。詳細ヒーローにも適用。DB正規化(`normalize_main_images.js`)＋R2商品キャッシュ無効化で生値も是正（amateur 46,135件リフレッシュ）
- **詳細検索のページ文脈化**: 新作/メーカー一覧から、その文脈のメーカー・女優・ジャンルを数の多い順で絞り込み
- **モバイル作品一覧の整理**: 未配線ボタン(filter/calendar/昇降順)を削除、ボタン配置統一、bfcacheでスクロール位置復元(`no-store`→`max-age=60`)
- **女優ランキングをD1生成に切替**: `build_actress_ranking_d1.js`（ローカルDBの旧出演者名による取り違え=Ruru等を解消）。手動補正(改名/除外/顔写真上書き)対応
- **作品・女優ランキングの両PF公平化（ハイブリッド）**: 旧来はMGSお気に入り偏重（FANZAはレビューのみ/女優はスコア0）だった。FANZAのお気に入り/売上数はAPIに無いため、**人気順(`sort=rank`=売上/人気)の順位を人気指標**として収集（`build_fanza_popularity.js`→`fanza_popularity.json`）。FANZA人気度=0.6×人気順+0.4×レビュー。作品=`mergeByZScore`、女優=各PFをz-score化し`max(0,z_mgs)+max(0,z_fanza)`で合算。→瀬戸環奈・石川澪・松本いちか・月野かすみ等のFANZA人気女優も上位入り。多作の本物女優を誤除外していた`excludeAmbiguous`(メーカー20社超)も手動補正名は免除
- **データ清掃**: 画像403消失のテスト/ジャンク作品 `pf_o2_` 17件を削除

### SNS自動投稿（新規）
- **Bluesky自動投稿**: 無料・OG画像カード＋`sexual`セルフラベル（`bluesky_autopost.js`）
- **X自動投稿（Playwright実ブラウザ）**: `x_browser_post.js`。公式API/Cookie方式は不可(402/code32)だが実ブラウザで投稿成功。**ツリー型**=1ポスト目:紹介文＋**サンプル動画**(FANZA/MGSを5〜15秒/冒頭5秒に`ffmpeg`自動編集) / 2ポスト目:女優ハッシュタグ＋URL。6アカウント自動振り分け、タスクスケジューラで1日6回
- **投稿キュー自動充填**: `x_queue_fill.js`（VR=FANZA配信済み、anon=FANZA C(videoc)+MGS、Now Printing除外）
  - **作品選定をホーム特定メーカー＋MGS独占に限定(2026-06)**: X投稿はホーム予約掲載の特定メーカー(HOME_MAKERS 18ブランド)の作品のみ。MGS作品はFANZAに無い独占配信(`cross_platform.json`で判定、独占355件)のみ。MGSの不足はFANZA特定メーカー(52,013件)でカバー(new/collab/ladyにFANZAソース追加)
  - **VR投稿は1枚目のサンプル画像**: 動画(VR形式は平面で歪む)もパッケージも使わず `pl.jpg→jp-1.jpg`(本編1枚目)を投稿。**VR以外の全アカウントはサンプル動画のみ**(動画が取れない作品はスキップ、パッケージ画像へはフォールバックしない)
  - **サンプル動画はダイジェストモンタージュ(見栄え・テンポ重視)**: 約90〜120秒のサンプルから30%/50%/70%地点の各4秒を抜き12秒に連結(ffmpeg filter_complex)。冒頭タイトルで女優が写らず終わる問題を解消、本編中盤〜後半なので女優も自然に写る
  - **投稿スケジュール**: タスク「SNS X Browser Post」を6〜24時の2時間毎(10回/日)に。ウェイクタイマー＋**無人スリープのタイムアウトを2分→20分に延長**(既定2分だとスリープから起きた回が投稿完了前に再スリープして`^C`で落ちていた)
  - **共演とアンソロジーの判別**: 共演ジャンルから総集編/アンソロジーを除外(女優5人以上・240分以上・総集編系タイトルを除外、構造指標を主に)
  - **配信5年以内に限定(2026-06)**: 全ジャンルの選定に `sale_start_date >= 5年前` を追加(MGSは `YYYY/MM/DD` を `REPLACE` で `-` 化して比較、FANZAはそのまま)。古い作品を投稿しない。NULL日付は除外。
  - **non-VRジャンルからVR作品を除外(2026-06)**: `NOT_VR`(`title`/`genres` の `%VR%` ＋品番 `%vr%`=dsvr/fcvr/juvr等)をvr以外の全ジャンルに付与。VR作品はサンプル動画を平面MP4化できず毎回スキップされ、キュー先頭(decided_at ASC)に居座って担当アカウント(sale/collab/lady等)を「対象なし」で塞いでいたため。既存キューに滞留していたVR品番5件(sale3/lady1/collab1)も削除済み。
  - **総集編/アンソロジーを全ジャンルで除外(2026-06)**: 旧来collabのみだった `NOT_ANTHOLOGY`(女優5人以上・240分以上・総集編系タイトル・`genres`の総集編/アンソロジー)をSQL組み立て時に全ジャンル一律で付与。lady等に2012年マドンナ総集編(`jusd00439`=478分/女優75人)が混入して投稿された事例への対処。既存キューの古い作品(配信5年超4件)＋総集編2件も削除済み。
  - **投稿前キュー補充で枯渇防止(2026-06)**: 旧来は「SNS Daily Pipeline」(毎日11:00)が `x_queue_fill --per=8` を1日1回だけ実行 → セールが16時に在庫0で停止した。`sns_x_browser.bat` を**各投稿回(2時間毎・10回/日)の投稿前に `x_queue_fill --per=8` を実行**するよう変更し、終日継続補充に。INSERT OR IGNOREで重複登録は回避。供給が構造的に細いジャンル(sale等)は新規割引が出た分を随時取り込む。
  - **セールの下段にセール期間を明記(2026-06)**: `x_browser_post.js` の `saleInfoLine(p)`。ツリー2ポスト目(下段)の先頭に `🔥{discount_pct}%OFFセール中 {M}/{D}まで` を表示。`sale_end_date`(FANZA `YYYY-MM-DD`/MGS `YYYY/MM/DD`)を正規表現でM/D抽出。**終了日がDBにNULLの作品(FANZAは多い)は割引率のみ**表示。SELECTに `discount_pct`/`sale_end_date` を追加。
  - **anon(素人)はHOME_MAKERS条件を除外(2026-06)**: HOME_MAKERSがプレミアム18ブランド縛りなのに対し、素人は `floor='videoc'`/素人ジャンルで定義されメーカー縛りに該当しない。全ソース一律でmakerCondを掛けていたため「素人 かつ プレミアムメーカー」=常に0件 → anon在庫が枯渇し008(素人)アカウントが「対象なし」で投稿停止していた。`g.genre==='anon'` のときmakerCond/makerArgsをスキップ(=`1=1`)に修正。素人videoc(5年以内)は181件あり供給回復。

### データ供給・運用
- **VR新作**: MGS→FANZA `VR専用` 配信済みに変更（KMPVR等のVR専業メーカー中心、Now Printing除外）
- **MGS新作の発売日NULL問題修正** ＋ `daily_main.bat` 再構成（新作→価格分離、D1ランキング再生成、R2無効化）。bat類のCRLF/ASCII化(255失敗の真因)
- **全メーカー出演者回収(AVWIKI)** をDBへ反映、whitelist追加

---

## 🔧 日常コマンド

```bash
# FANZA日次更新（女優プロフィール自動取得込み）
node scripts/fanza_daily_update.js

# MGS日次更新
node scripts/phase3_daily_update.js

# AVWiki別名・引退データ再統合（avwiki_full.jsonl更新後）
node scripts/merge_avwiki_aliases.js

# サジェストキャッシュのみ再生成
node scripts/build_suggest_cache.js

# FTS5インデックス再構築（DBリセット後など）
node scripts/create_fts5.js

# サイト開発サーバー
cd site && npm run dev
```

---

## 🗓 データ自動更新フロー

```
0:05 JST    GitHub Actions: fanza_daily_update.js
            → 予約商品（明日〜2ヶ月先）videoa + videoc 両floor取得
            → 価格更新（直近12ヶ月）→ Turso FANZA DB更新（即時反映）
            → 新出演女優プロフィール → Turso actress_profiles更新
            → build_suggest_cache.js 実行
            → Discord通知

10:05 JST   GitHub Actions: phase3_daily_update.js
            → 新作 + 価格 + 女優インデックス → Turso MGS DB更新（即時反映）
            → Discord通知
```
