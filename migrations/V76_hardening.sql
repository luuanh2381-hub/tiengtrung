-- ════════════════════════════════════════════════════
-- migrations/V76_hardening.sql
-- Migration V76 — hoàn thiện kiến trúc học tập: single source of truth, chống lặp từ, optimistic
-- locking đa thiết bị, idempotent review (đã có từ trước, xem V69), Reset FSRS / Xoá toàn bộ dữ
-- liệu học tập tự phục vụ.
--
-- Như V69: KHÔNG dùng migration runner riêng — câu lệnh dưới đây chỉ là bản ĐỐI CHIẾU/THAM KHẢO,
-- migration THẬT chạy tự động, idempotent, ngay trong lib/db.js (ensureFsrsTables) ở lần
-- request/connect đầu tiên. An toàn chạy tay nhiều lần nếu muốn.
-- ════════════════════════════════════════════════════

-- ── 1. fsrs_cards.version (Yêu cầu 3 — optimistic locking đồng bộ đa thiết bị) ──────────────────
-- SELECT ... FOR UPDATE (lib/db.js: reviewFsrsCard) đã chống ghi đè giữa 2 request Postgres GẦN
-- NHƯ ĐỒNG THỜI. version là lớp bảo vệ TƯỜNG MINH bổ sung, đúng công thức yêu cầu:
--   UPDATE fsrs_cards SET ..., version = version + 1 WHERE id = ? AND version = ?
-- rowCount = 0 (conflict) → KHÔNG last-write-wins → rollback, đọc lại dữ liệu MỚI NHẤT, tính lại,
-- retry (tối đa 3 lần). Không làm mất review_history ở bất kỳ nhánh nào.
ALTER TABLE fsrs_cards ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0;

-- ── 2. review_history.idempotency_key (Yêu cầu 4 — ĐÃ CÓ từ V69/V71, liệt kê lại để đối chiếu) ──
-- Mỗi lượt review có 1 idempotency_key do client sinh 1 lần; gửi lại (double-click/outbox retry)
-- được nhận diện qua unique index dưới đây, trả về ĐÚNG kết quả cũ, không insert/không tính lại FSRS.
ALTER TABLE review_history ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS review_history_idem_key_idx
  ON review_history (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── 3. Yêu cầu 6/7 — Reset FSRS / Xoá toàn bộ dữ liệu học tập ────────────────────────────────
-- KHÔNG cần bảng mới: 2 endpoint tự phục vụ POST /api/fsrs/reset và POST /api/user/reset-learning-
-- data (api/index.js) tái dùng ĐÚNG hàm updateDBWithFsrsCleanup() đã có sẵn (BEGIN/COMMIT/ROLLBACK
-- — Yêu cầu 8), chỉ khác targetUserId = CHÍNH user đang đăng nhập (thay vì admin thao tác trên
-- user khác) và tham số alsoDeleteAnalytics:
--   /api/fsrs/reset              → xoá fsrs_cards + review_history                      (alsoDeleteAnalytics=false)
--   /api/user/reset-learning-data → xoá thêm study_sessions + user_settings + user_fsrs_weights,
--                                    reset progress.ui về mặc định                        (alsoDeleteAnalytics=true)
-- Cả 2 đều KHÔNG đụng: users (tài khoản/email/mật khẩu/role), vocab_words/word_examples/hanzi_parts
-- (từ vựng hệ thống), activity_logs (nhật ký hệ thống).
