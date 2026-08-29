-- migrations/V86_fsrs_optimizer_durable_retry.sql
-- ════════════════════════════════════════════════════
-- THAM KHẢO — schema THẬT được áp dụng tự động, idempotent, lúc runtime qua
-- lib/fsrs/optimizer.js:ensureOptimizerTables() (đúng convention V82/V85 — KHÔNG cần chạy tay file
-- này, chỉ giữ lại để tra cứu lịch sử thay đổi schema). An toàn chạy nhiều lần, an toàn với dữ liệu
-- production hiện có (4.372 review / 794 cards / job history cũ) — chỉ ADD COLUMN IF NOT EXISTS,
-- không xoá/đổi kiểu cột nào, không mất dữ liệu.
--
-- Bối cảnh: FIX TRIỆT ĐỂ bug "job optimizer đôi khi mất heartbeat dù dữ liệu đủ điều kiện" — xem đầy
-- đủ root cause + thiết kế ở AUDIT-REPORT-V86-FSRS-OPTIMIZER-DURABILITY.md. Tóm tắt 1 câu: V85-
-- HEARTBEAT-FIX phát hiện ĐÚNG khi worker chết, nhưng không có gì NGĂN worker chết nếu 1 lượt train
-- cần nhiều wall-clock hơn ngân sách 1 Vercel Function invocation cho phép — 5 cột dưới đây phục vụ
-- (1) tách pipeline train thành 2 checkpoint có thể resume, (2) retry có kiểm soát/phân loại được.
-- ════════════════════════════════════════════════════

ALTER TABLE fsrs_optimizer_jobs ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 1;
-- Số lần THỬ (bắt đầu từ 1) của ĐÚNG job này — KHÔNG tạo dòng mới mỗi lần tự động retry (dễ audit
-- lịch sử 1 job xuyên suốt). Tăng lên mỗi khi requeue sau lỗi RETRYABLE (xem classifyOptimizerError,
-- recoverStaleJobsForUser, failOrRequeue trong lib/fsrs/optimizer.js).

ALTER TABLE fsrs_optimizer_jobs ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 3;
-- Trần số lần tự động thử lại — KHÔNG retry vô hạn (đúng yêu cầu Phần IX). Hết attempt → 'failed' hẳn.

ALTER TABLE fsrs_optimizer_jobs ADD COLUMN IF NOT EXISTS worker_id TEXT;
-- Định danh ngẫu nhiên (UUID) cho ĐÚNG lượt claim/invocation hiện tại — CHỈ phục vụ logging/chẩn đoán
-- (Phần III/XIII "mỗi job phải có worker_id/execution_id"), KHÔNG ảnh hưởng logic transition (logic
-- vẫn dựa trên cột status + điều kiện WHERE nguyên tử như V85).

ALTER TABLE fsrs_optimizer_jobs ADD COLUMN IF NOT EXISTS training_payload JSONB;
-- CHECKPOINT giữa 2 bước (Phần VI "chia optimization thành các bước có thể resume"): lưu train/
-- validation items ĐÃ build xong (sau load_reviews + validate) — nếu invocation hiện tại hết ngân
-- sách an toàn TRƯỚC khi train xong, dừng sạch ở đây; invocation MỚI đọc lại training_payload, nhảy
-- thẳng vào train với ngân sách MỚI TINH, không phải load/validate lại từ đầu. Bị xoá (NULL) ngay khi
-- job đạt trạng thái cuối (completed/failed) — không lưu dữ liệu suy ra từ review history lâu hơn cần.

ALTER TABLE fsrs_optimizer_jobs ADD COLUMN IF NOT EXISTS error_retryable BOOLEAN;
-- Kết quả phân loại lỗi gần nhất (classifyOptimizerError) — true=RETRYABLE (hạ tầng/tạm thời),
-- false=NON_RETRYABLE (dữ liệu/lập trình/deployment, hoặc đã hết attempt), NULL=job chưa từng lỗi.
-- Chủ yếu phục vụ observability (admin xem log/debug) — quyết định requeue-hay-không đã áp dụng NGAY
-- lúc lỗi xảy ra (failOrRequeue), không đọc lại cột này để quyết định.
