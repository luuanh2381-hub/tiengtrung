-- ════════════════════════════════════════════════════
-- migrations/V110_retention_tracking.sql
-- Migration V110 — dữ liệu phục vụ PHÂN TÍCH TRÍ NHỚ DÀI HẠN + phát hiện từ hay bị NHẦM.
--
-- Như V104–V106: project KHÔNG có migration runner riêng. Các câu lệnh dưới đây được lib/skill-store.js
-- (ensureSkillTables) tự chạy, idempotent, ở lần dùng đầu — file này chỉ để ĐỐI CHIẾU/chạy tay.
-- CHỈ CỘNG THÊM cột nullable + 1 index: không DROP/DELETE/UPDATE, không đổi cột cũ, không đụng fsrs_cards.
-- Dòng cũ giữ NULL (không biết nguồn/phiên → không đoán, không backfill). An toàn chạy nhiều lần.
--
-- Chạy tay (tuỳ chọn, trên bản sao/staging trước):  psql "$DATABASE_URL" -f migrations/V110_retention_tracking.sql
-- ════════════════════════════════════════════════════

-- session_id   : id phiên học do client sinh (gom các câu cùng phiên).
-- source       : nguồn của bài LUYỆN BỔ SUNG — check | redo | extra | match | practice | mode | delayed.
--                (review_history = luôn lượt FSRS chính thức nên không cần cột này ở bảng đó.)
-- wrong_answer : đáp án người học chọn/gõ NẾU SAI (cắt 60 ký tự); NULL khi đúng. Dùng để phát hiện từ hay bị nhầm.
ALTER TABLE skill_practice_log ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE skill_practice_log ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE skill_practice_log ADD COLUMN IF NOT EXISTS wrong_answer TEXT;
ALTER TABLE review_history ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE review_history ADD COLUMN IF NOT EXISTS wrong_answer TEXT;

-- Truy vấn chi tiết 1 từ (lịch sử theo từ) — chỉ cho skill_practice_log; review_history đã có index (user_id, hz, l, reviewed_at).
CREATE INDEX IF NOT EXISTS skill_practice_log_user_word_idx ON skill_practice_log (user_id, word_id, attempted_at);

-- ── Kiểm tra sau khi chạy (chỉ đọc) ─────────────────────────────────────────────────────────────
--   SELECT count(*) FROM review_history;           -- phải bằng số dòng trước migration
--   SELECT count(*) FROM fsrs_cards;               -- phải bằng số dòng trước migration
--   SELECT count(*) FROM review_history WHERE session_id IS NOT NULL;  -- 0 ngay sau migration, tăng dần khi học
-- ── Hoàn tác (chỉ khi thật sự cần; mất dữ liệu V110, KHÔNG mất dữ liệu FSRS) ─────────────────────
--   DROP INDEX IF EXISTS skill_practice_log_user_word_idx;
--   ALTER TABLE skill_practice_log DROP COLUMN IF EXISTS session_id, DROP COLUMN IF EXISTS source, DROP COLUMN IF EXISTS wrong_answer;
--   ALTER TABLE review_history DROP COLUMN IF EXISTS session_id, DROP COLUMN IF EXISTS wrong_answer;
