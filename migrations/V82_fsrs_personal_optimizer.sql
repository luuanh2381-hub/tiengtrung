-- ════════════════════════════════════════════════════
-- migrations/V82_fsrs_personal_optimizer.sql
-- Migration V82 — FSRS Personal Optimizer: mở rộng bảng user_fsrs_weights (đã tồn tại từ V69) để hỗ
-- trợ candidate weights (kết quả optimizer, CHƯA active), versioning 1-cấp (previous_* cho
-- Rollback), và run-lock (status/run_started_at chống chạy song song).
--
-- LƯU Ý QUAN TRỌNG (giống mọi migration khác trong project): file .sql này là bản ĐỐI CHIẾU/THAM
-- KHẢO — schema thật được tạo/mở rộng idempotent bằng "ALTER TABLE ... ADD COLUMN IF NOT EXISTS"
-- ngay trong lib/fsrs/optimizer.js:ensureOptimizerTables(), tự chạy ở lần dùng đầu tiên. KHÔNG cần
-- chạy tay file này — nó chỉ để review/audit schema cuối cùng cho dễ.
-- Toàn bộ câu lệnh dưới đây AN TOÀN chạy nhiều lần (idempotent), và AN TOÀN chạy trên DB đã có sẵn
-- dữ liệu (chỉ ADD COLUMN, không đổi/xoá 5 cột gốc từ V69: user_id/weights/trained_at/review_count/
-- created_at/updated_at).
-- ════════════════════════════════════════════════════

-- ── Bảng gốc (đã có từ V69 — liệt kê lại để đối chiếu đầy đủ) ──
CREATE TABLE IF NOT EXISTS user_fsrs_weights (
  user_id TEXT PRIMARY KEY,
  weights DOUBLE PRECISION[] NOT NULL,      -- weights ĐANG active NẾU enabled = true (xem cột mới bên dưới)
  trained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  review_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── V82: có đang dùng weights cá nhân hay không (Phần 9/11 — mặc định false, KHÔNG tự động bật) ──
ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT false;

-- ── V82: snapshot 1-cấp để Rollback (Phần 8) — ghi bởi applyPersonalWeights()/resetToDefaultWeights() ──
ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS previous_weights DOUBLE PRECISION[];
ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS previous_enabled BOOLEAN;
ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS previous_trained_at TIMESTAMPTZ;
ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS previous_review_count INT;

-- ── V82: kết quả lần chạy Optimizer gần nhất — CHƯA active cho tới khi user bấm Apply (Phần 9) ──
ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS candidate_weights DOUBLE PRECISION[];
ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS candidate_trained_at TIMESTAMPTZ;
ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS candidate_review_count INT;
ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS candidate_meta JSONB; -- data quality report + default/personal score + improvement %, v.v.

-- ── V82: run-lock (Phần 15 — chống 2 optimizer chạy song song cho cùng 1 user) ──
ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'idle'; -- 'idle' | 'running' | 'error'
ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS run_started_at TIMESTAMPTZ;
ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
