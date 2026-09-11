-- @targets: site
-- ============================================================
--  X投稿キューの取り出しを「プラットフォーム」まで索引で絞る（2026-09-11）
--
--  scripts/x_browser_post.js（30分毎 × 6アカウント）と lib/xPost.ts は、承認キューから
--  MGS / FANZA を同数ずつ取るため
--    WHERE decision='approve' AND posted_at IS NULL AND new_genre IN (?) AND product_id GLOB '*-*'
--    ORDER BY decided_at ASC LIMIT ?
--  を投げる。0010 の idx_xpd_queue は (decision, new_genre, posted_at, decided_at) なので
--  PF の条件は索引で絞れず、decided_at 順に「反対PFの行」を読み飛ばしながら進む。
--  FANZA の滞留が厚いジャンルで MGS を探すと深く舐めることになり、
--  実測 1回 600〜800行 × 1日 約300回 ≒ 10〜18万行/日 だった。
--
--  PF 判定式 (product_id GLOB '*-*') を decided_at の手前に入れた式インデックスにすると、
--  `(product_id GLOB '*-*') = 1` / `= 0` の条件で PF まで範囲引きになり、LIMIT で止まる。
--  ※ 式インデックスは **WHERE 側も同じ式を `= 値` の形で書いたときだけ** 使われる
--    （素の `product_id GLOB '*-*'` では使われない。ローカル SQLite の EXPLAIN で確認済み）。
--
--  コスト: 作成時に x_post_decisions の行数ぶん（約1.4万行）の読取と書込が1回だけ発生する。
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_xpd_queue_pf
    ON x_post_decisions(decision, new_genre, posted_at, (product_id GLOB '*-*'), decided_at);
