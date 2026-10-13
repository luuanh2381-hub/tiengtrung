-- ════════════════════════════════════════════════════
-- migrations/V104_skill_profile.sql
-- Migration V104 — hồ sơ KỸ NĂNG theo từng từ vựng (nhận diện / nhớ chủ động / nghe), bổ sung cho FSRS.
--
-- Như V69/V76/V93: project KHÔNG có migration runner riêng. Toàn bộ câu lệnh dưới đây được lib/skill-store.js
-- (ensureSkillTables) tự chạy, idempotent, ở lần dùng đầu tiên — file này chỉ để ĐỐI CHIẾU/chạy tay.
-- CHỈ CỘNG THÊM: không DROP/DELETE/UPDATE, không đổi cột cũ, không đụng fsrs_cards. An toàn chạy nhiều lần.
--
-- Kiểu dữ liệu đã xác minh từ schema thật: user_id = TEXT, word_id = INT (vocab_words.id SERIAL).
--
-- Chạy tay (tuỳ chọn, trên bản sao/staging trước):  psql "$DATABASE_URL" -f migrations/V104_skill_profile.sql
-- ════════════════════════════════════════════════════

-- 1. Thống kê gộp: 1 dòng / user / từ / kỹ năng. ON DELETE CASCADE: xoá từ vựng thì thống kê của nó tự mất
--    (không chặn thao tác xoá từ của admin như một khoá ngoại thường).
CREATE TABLE IF NOT EXISTS word_skill_stats (
  user_id TEXT NOT NULL,
  word_id INT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
  skill TEXT NOT NULL CHECK (skill IN ('recognition','recall','listening','pronunciation','context')),
  attempts INT NOT NULL DEFAULT 0,
  correct INT NOT NULL DEFAULT 0,
  w_attempts DOUBLE PRECISION NOT NULL DEFAULT 0,
  w_correct DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, word_id, skill)
);
CREATE INDEX IF NOT EXISTS word_skill_stats_user_skill_idx ON word_skill_stats (user_id, skill);

-- 2. Nhật ký CHỈ cho bài luyện kỹ năng bổ sung (không phải lượt ôn FSRS — không được ghi vào
--    review_history vì optimizer FSRS coi mọi dòng ở đó là 1 lượt review).
CREATE TABLE IF NOT EXISTS skill_practice_log (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  attempt_key TEXT NOT NULL,
  word_id INT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
  skill TEXT NOT NULL,
  exercise_type TEXT NOT NULL,
  answer_correct BOOLEAN NOT NULL,
  response_time_ms INT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_practice_log_key_idx ON skill_practice_log (user_id, attempt_key);
CREATE INDEX IF NOT EXISTS skill_practice_log_user_time_idx ON skill_practice_log (user_id, attempted_at);

-- 3. Tận dụng bảng lịch sử FSRS sẵn có: thêm 2 cột nullable. Các dòng cũ giữ NULL (không biết kỹ năng
--    → không đoán, không backfill).
ALTER TABLE review_history ADD COLUMN IF NOT EXISTS skill TEXT;
ALTER TABLE review_history ADD COLUMN IF NOT EXISTS exercise_type TEXT;

-- ── Kiểm tra sau khi chạy (chỉ đọc) ─────────────────────────────────────────────────────────────
--   SELECT count(*) FROM review_history;            -- phải bằng số dòng trước migration
--   SELECT count(*) FROM fsrs_cards;                -- phải bằng số dòng trước migration
--   SELECT count(*) FROM review_history WHERE skill IS NOT NULL;  -- 0 ngay sau migration, tăng dần khi học
-- ── Hoàn tác (chỉ khi thật sự cần; mất dữ liệu kỹ năng, KHÔNG mất dữ liệu FSRS) ─────────────────
--   DROP TABLE IF EXISTS skill_practice_log; DROP TABLE IF EXISTS word_skill_stats;
--   ALTER TABLE review_history DROP COLUMN IF EXISTS skill; ALTER TABLE review_history DROP COLUMN IF EXISTS exercise_type;
