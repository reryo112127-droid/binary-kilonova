-- ============================================================
--  D1 の行読取を減らすための性能インデックス（FANZAシャード用）
--
--  2026-09-04 に Cloudflare の GraphQL クエリ分析で実測したところ、
--  日次枠(500万行読取)を毎日5〜37倍オーバーしており、その内訳の上位が:
--
--    WHERE series_name = ? ... ORDER BY sale_start_date DESC
--        → 1回あたり約34,000行 × 136回/日 = 4.6M行
--    WHERE (BEST除外) ORDER BY review_count DESC, sale_start_date DESC
--        → 1回あたり約71,000行 × 15回/日 = 1.1M行
--
--  原因は 0005_catalog_fanza_slim.sql のスリムスキーマに
--  series_name / review_count のインデックスが無いこと。
--  series_name は等値比較なのに、プランナが ORDER BY を満たすため
--  idx_sale_start を舐めながら series_name で弾く計画を選び、
--  LIMIT を満たすまで数万行を読んでいた。
--  → **(series_name, sale_start_date DESC) の複合インデックス**にすると
--    絞り込みと並び替えを1本で満たせるので数十行で済む。
--
--  MGS には series_name / review_count 列が無いので、このファイルは
--  **FANZAシャード(avrankings-fanza-0 / -1)にだけ**適用すること。
--  適用: node scripts/apply_perf_indexes.mjs（D1の日次枠が残っている時間帯に）
--  ※ CREATE INDEX はテーブルを読むので、枠切れ中は実行できない（UTC 0時にリセット）。
-- ============================================================

-- シリーズLP: series_name で絞って配信日降順に並べる（/api/products?series=）
CREATE INDEX IF NOT EXISTS idx_series_date ON products(series_name, sale_start_date DESC);

-- 人気順: review_count DESC の全件ソートを避ける
CREATE INDEX IF NOT EXISTS idx_review_count ON products(review_count DESC);
