-- ============================================================
--  product_samples: 予約作品のサンプル画像／サンプル動画を後から埋めるためのテーブル
--  対象DB: avrankings-fanza-0 / avrankings-fanza-1（FANZAシャード両方）
--
--  背景:
--    FANZAは未発売(予約)作品のパッケージ画像を同一URLで now_printing(準備中)へ302し、
--    サンプル画像・サンプル動画も発売日前後まで公開しない。
--    予約作品を取り込む fanza_daily_update.js は「明日以降に発売」の作品しか再取得しないため、
--    発売日を過ぎた瞬間に対象から外れ、あとから公開されたサンプルが永久に取り込まれなかった
--    （実測: 予約1,134件中223件・発売直後14日844件中129件が sample_video_url NULL のまま）。
--    さらに 0005 のスリムスキーマで products から sample_images_json を外したため、
--    FANZA作品のサンプル画像は保存先自体が無い状態だった。
--
--  設計:
--    全作品ぶんを持つと 27万件 × 約1.5KB ≒ 400MB で無料枠(500MB/DB)を圧迫するため、
--    「予約中 〜 発売後 N日」のローリング窓の作品だけを保持する。
--    窓から出た行は backfill_preorder_samples.js が削除する。
-- ============================================================

CREATE TABLE IF NOT EXISTS product_samples (
    product_id         TEXT PRIMARY KEY,
    sample_images_json TEXT,             -- JSON配列（DMM APIの sample_l 優先、無ければ sample_s）
    sample_video_url   TEXT,
    sale_start_date    TEXT,             -- 窓の判定用（products と同じ値のコピー）
    image_count        INTEGER DEFAULT 0,
    checked_at         TEXT,             -- 最後に DMM API へ問い合わせた日時
    check_count        INTEGER DEFAULT 0,
    filled_at          TEXT,             -- 画像が初めて揃った日時（準備中→公開の記録）
    updated_at         TEXT
);

-- 未充足(image_count=0)を古い確認順に拾うためのインデックス
CREATE INDEX IF NOT EXISTS idx_product_samples_pending
    ON product_samples(image_count, checked_at);

-- 窓の外に出た行の掃除用
CREATE INDEX IF NOT EXISTS idx_product_samples_date
    ON product_samples(sale_start_date);
