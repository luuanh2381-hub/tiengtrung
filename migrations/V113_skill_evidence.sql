-- V113 — BẰNG CHỨNG kỹ năng + đánh dấu lượt "vừa xem đáp án". CHỈ THÊM cột có DEFAULT an toàn; không DROP/DELETE.
-- (Ứng dụng cũng tự chạy các ALTER này idempotent ở lần dùng đầu — file này để đối chiếu / chạy tay.)

ALTER TABLE word_skill_stats ADD COLUMN IF NOT EXISTS active_days INT NOT NULL DEFAULT 0;
ALTER TABLE word_skill_stats ADD COLUMN IF NOT EXISTS delayed_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE word_skill_stats ADD COLUMN IF NOT EXISTS delayed_correct INT NOT NULL DEFAULT 0;
ALTER TABLE review_history ADD COLUMN IF NOT EXISTS exposure TEXT;

-- BACKFILL TÙY CHỌN (idempotent: chỉ hàng còn active_days = 0 và delayed_attempts = 0). Tính từ lịch sử THẬT:
--   review_history (hàng có skill) + skill_practice_log (bỏ nguồn check/redo, đúng quy tắc V113).
-- Không đổi attempts/correct/w_*: điểm cũ giữ nguyên. Hàng cũ không có lịch sử gán nhãn kỹ năng sẽ vẫn là 0 = "chưa biết".
WITH ev AS (
  SELECT user_id, word_id, skill, reviewed_at AS ts, answer_correct AS ok
    FROM review_history WHERE skill IS NOT NULL AND word_id IS NOT NULL AND exposure IS DISTINCT FROM 'intro'
  UNION ALL
  SELECT user_id, word_id, skill, attempted_at, answer_correct
    FROM skill_practice_log WHERE COALESCE(source, 'practice') NOT IN ('check', 'redo')
), g AS (
  SELECT *, LAG(ts) OVER (PARTITION BY user_id, word_id, skill ORDER BY ts) AS prev FROM ev
), agg AS (
  SELECT user_id, word_id, skill,
         COUNT(DISTINCT (ts AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::int AS active_days,
         COUNT(*) FILTER (WHERE prev IS NOT NULL AND ts - prev >= interval '24 hours')::int AS dn,
         COUNT(*) FILTER (WHERE prev IS NOT NULL AND ts - prev >= interval '24 hours' AND ok)::int AS dc
    FROM g GROUP BY user_id, word_id, skill
)
UPDATE word_skill_stats s
   SET active_days = agg.active_days, delayed_attempts = agg.dn, delayed_correct = agg.dc
  FROM agg
 WHERE s.user_id = agg.user_id AND s.word_id = agg.word_id AND s.skill = agg.skill
   AND s.active_days = 0 AND s.delayed_attempts = 0;

-- HOÀN TÁC (nếu cần): ALTER TABLE word_skill_stats DROP COLUMN active_days, DROP COLUMN delayed_attempts, DROP COLUMN delayed_correct;
--                     ALTER TABLE review_history DROP COLUMN exposure;
