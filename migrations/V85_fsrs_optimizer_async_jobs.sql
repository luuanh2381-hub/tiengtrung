-- ════════════════════════════════════════════════════
-- migrations/V85_fsrs_optimizer_async_jobs.sql
-- Migration V85 — FSRS Optimizer: kiến trúc BẤT ĐỒNG BỘ (async job) cho "Run Optimizer".
--
-- Trước V85, 1 lượt "Run Optimizer" chạy TOÀN BỘ pipeline (đọc review_history → validate → train
-- bằng optimizer chính thức → evaluate → lưu candidate) trong 1 request HTTP DUY NHẤT — nếu Vercel
-- giết process giữa chừng (timeout/thu hồi), DB kẹt ở "status=running" mãi mãi, UI đứng ở "Đang
-- chạy...". V85 tách "tạo job" (rẻ, trả về ngay) khỏi "chạy job" (nặng, chạy ở 1 invocation RIÊNG,
-- có heartbeat để tự phục hồi nếu chết giữa chừng) — xem lib/fsrs/optimizer.js (phần ADDENDUM V85)
-- và api/index.js (POST /api/fsrs-optimizer/run + /worker, GET /api/fsrs-optimizer/status).
--
-- LƯU Ý (giống mọi migration khác trong project): file .sql này là bản ĐỐI CHIẾU/THAM KHẢO — schema
-- thật được tạo idempotent bằng "CREATE TABLE IF NOT EXISTS"/"CREATE INDEX IF NOT EXISTS" ngay trong
-- lib/fsrs/optimizer.js:ensureOptimizerTables(), tự chạy ở lần dùng đầu tiên. KHÔNG cần chạy tay file
-- này. An toàn chạy nhiều lần, và an toàn trên DB đã có dữ liệu (chỉ TẠO MỚI bảng, KHÔNG đụng tới
-- user_fsrs_weights/fsrs_cards/review_history hiện có).
-- ════════════════════════════════════════════════════

-- ── Bảng MỚI: 1 dòng = 1 lượt "Run Optimizer" (khác hẳn user_fsrs_weights — bảng đó lưu WEIGHTS
--     đang có (active/candidate/previous), không phải vòng đời của 1 lượt chạy). Giữ được LỊCH SỬ
--     nhiều lượt chạy (audit/debug), không như 3 cột status/run_started_at/last_error cũ trên
--     user_fsrs_weights (V82) chỉ giữ được đúng 1 lượt gần nhất, bị ghi đè mỗi lần Run. ──
CREATE TABLE IF NOT EXISTS fsrs_optimizer_jobs (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',   -- 'queued' | 'running' | 'completed' | 'failed'
  stage  TEXT NOT NULL DEFAULT 'queued',   -- 'queued'|'loading_reviews'|'preparing_data'|'training'|'evaluating'|'saving'|'completed'|'failed'
  desired_retention DOUBLE PRECISION,
  progress_current INT,
  progress_total INT,
  data_quality JSONB,      -- cache {report, readiness} — tính 1 lần ở stage preparing_data, GET /status đọc từ đây (không quét lại review_history mỗi lần poll)
  result_meta JSONB,       -- kết quả cuối (default/personal score, improvement, recommend...) — NULL nếu NOT_READY (không có gì để train)
  error_message TEXT,      -- lỗi ĐẦY ĐỦ, nội bộ — CHỈ trả cho admin (Phần "ERROR SECURITY")
  error_public TEXT,       -- câu lỗi AN TOÀN cho user thường
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ, -- worker cập nhật định kỳ trong lúc chạy — dùng để phát hiện job "chết" giữa chừng
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Khoá chống 2 job cùng chạy song song cho 1 user — THỰC THI Ở TẦNG DATABASE (Phần
--     "IDEMPOTENCY/CONCURRENCY": "Phải xử lý race condition ở database, không chỉ dựa vào
--     frontend"). Tại 1 thời điểm, mỗi user CHỈ được có TỐI ĐA 1 dòng có status IN
--     ('queued','running') — INSERT thứ 2 tự động bị Postgres từ chối (23505 unique_violation). ──
CREATE UNIQUE INDEX IF NOT EXISTS uq_fsrs_optimizer_jobs_active_per_user
  ON fsrs_optimizer_jobs (user_id) WHERE status IN ('queued', 'running');

-- ── Phục vụ GET /status (lấy job mới nhất của user) và dọn lịch sử job cũ sau này nếu cần. ──
CREATE INDEX IF NOT EXISTS idx_fsrs_optimizer_jobs_user_created
  ON fsrs_optimizer_jobs (user_id, created_at DESC);

-- ── user_fsrs_weights (V69/V82) — GIỮ NGUYÊN, không đổi/xoá cột nào. 3 cột status/run_started_at/
--     last_error (V82) vẫn còn trong schema (backward-safe) nhưng V85 KHÔNG còn ghi vào đó nữa —
--     nguồn sự thật cho "đang chạy" giờ là fsrs_optimizer_jobs ở trên. ──
