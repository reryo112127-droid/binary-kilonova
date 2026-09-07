-- @targets: fanza-0,fanza-1,mgs
-- ============================================================
--  メーカー/レーベル絞り込みを全表走査から外すインデックス
--
--  2026-09-07 実測（d1QueriesAdaptiveGroups、直近6h）:
--    WHERE (maker LIKE ? OR label LIKE ?) AND sale_start_date < ? ORDER BY sale_start_date DESC LIMIT 500
--      → MGS 1回 37,715行 × 7回 / FANZA 1回 約41,000行 × 8回 = 計 658,000行（その時間帯の9%）
--
--  発生源は詳細検索(advanced-search.html)の「文脈絞り込み」。呼び出し元一覧のメーカーで
--  500件取ってジャンル/女優の候補を数える作りで、**LIMIT が 500 と大きい**ぶん
--  idx_sale_start を日付降順に舐める距離が 500/密度 まで伸びる。
--
--  maker/label 列にはインデックスが1本も無かったため、等値比較にしてもプランは変わらない。
--  (maker, sale_start_date DESC) を張れば「そのメーカーの作品を新しい順に500件」が
--  インデックスの範囲引きだけで済む。
--
--  ※ MGS の sale_start_date は 'YYYY/MM/DD' で、並び替えは REPLACE(...) 式の関数インデックス
--    idx_sale_date_norm を使う。この複合インデックスは **絞り込み側だけ**効く（並び替えは
--    一致した少数行の一時ソートになる）が、全表走査が消えるので効果は大きい。
--
--  適用: node scripts/apply_perf_indexes.mjs（daily_main.bat が枠リセット直後に実行）
--  ※ CREATE INDEX はテーブルを読むので枠切れ中は実行できない。
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_maker_date ON products(maker, sale_start_date DESC);
CREATE INDEX IF NOT EXISTS idx_label_date ON products(label, sale_start_date DESC);
