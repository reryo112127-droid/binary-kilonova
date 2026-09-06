-- @targets: site
-- ============================================================
--  x_post_decisions（SNS投稿キュー）のインデックス欠落を埋める（FANZA/MGSではなく site DB）
--
--  0001_site.sql はこのテーブルに product_id の UNIQUE しか張っていないため、
--  投稿バッチ・投稿APIが投げる「未投稿の approve をジャンル別に取る」系のクエリが
--  すべて全表走査になっていた。
--
--  2026-09-06 実測（d1QueriesAdaptiveGroups、直近10h。site DB だけで約55万行＝全体の7%）:
--    decision='approve' AND new_genre=? AND posted_at IS NULL ... ORDER BY decided_at
--        → 1回 約16,800行 × 8回
--    decision='approve' AND posted_bsky_at IS NULL ORDER BY decided_at
--        → 1回 約5,100行 × 6回
--    new_genre=? AND posted_at IS NOT NULL AND tweet_id IS NOT NULL ORDER BY posted_at DESC
--        → 1回 約16,300行 × 5回
--
--  キューは1万件規模なので、絞り込み＋並び替えを1本で満たす複合インデックスにすれば
--  LIMIT を満たした時点で走査が止まり数十行で済む。
--
--  ※ product_id GLOB '*-*'（MGS/FANZAの品番形状で振り分け）はインデックスで絞れないが、
--    上位3列で候補が数十件まで落ちるので残りをフィルタしても問題にならない。
-- ============================================================

-- 未投稿キューの取り出し（X: posted_at IS NULL / ジャンル指定 / 投入順）
CREATE INDEX IF NOT EXISTS idx_xpd_queue ON x_post_decisions(decision, new_genre, posted_at, decided_at);

-- Bluesky 側の未投稿キュー（posted_bsky_at IS NULL / 投入順）
CREATE INDEX IF NOT EXISTS idx_xpd_bsky ON x_post_decisions(decision, posted_bsky_at, decided_at);

-- 投稿済み履歴（ジャンル別に新しい順）
CREATE INDEX IF NOT EXISTS idx_xpd_posted ON x_post_decisions(new_genre, posted_at DESC);
