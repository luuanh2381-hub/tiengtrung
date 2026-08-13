-- ════════════════════════════════════════════════════
-- migrations/V69_pure_fsrs.sql
-- Migration V69 — chuẩn hóa kiến trúc FSRS production-ready.
--
-- LƯU Ý QUAN TRỌNG: project này KHÔNG dùng 1 migration runner riêng (vd knex/prisma) — mọi bảng
-- được tạo idempotent bằng "CREATE TABLE IF NOT EXISTS" / "ALTER TABLE ... ADD COLUMN IF NOT
-- EXISTS" ngay trong lib/db.js và lib/fsrs/*.js, tự chạy ở lần request/connect đầu tiên (xem
-- ensureFsrsTables, ensureAnalyticsTables, ensureOptimizerTables, ensureUserSettingsTable).
-- File .sql này là bản ĐỐI CHIẾU/THAM KHẢO — mô tả ĐẦY ĐỦ state cuối cùng của schema sau V69, để
-- review/audit hoặc chạy tay 1 lần trên môi trường mới nếu muốn, KHÔNG bắt buộc chạy thủ công
-- (chạy scripts/migrate-to-pure-fsrs.js là đủ, nó gọi đúng các hàm ensure*Table ở trên).
-- Toàn bộ câu lệnh dưới đây AN TOÀN chạy nhiều lần (idempotent).
-- ════════════════════════════════════════════════════

-- ── 1. fsrs_cards / review_history (đã có từ trước V69 — liệt kê lại để đối chiếu đầy đủ) ──
CREATE TABLE IF NOT EXISTS fsrs_cards (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  hz TEXT NOT NULL,
  l INT NOT NULL,
  state INT NOT NULL DEFAULT 0,
  due TIMESTAMPTZ NOT NULL DEFAULT now(),
  stability DOUBLE PRECISION NOT NULL DEFAULT 0,
  difficulty DOUBLE PRECISION NOT NULL DEFAULT 0,
  elapsed_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  scheduled_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  reps INT NOT NULL DEFAULT 0,
  lapses INT NOT NULL DEFAULT 0,
  last_review TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fsrs_cards_user_hz_l_idx ON fsrs_cards (user_id, hz, l);
CREATE INDEX IF NOT EXISTS fsrs_cards_user_due_idx ON fsrs_cards (user_id, due);
CREATE INDEX IF NOT EXISTS fsrs_cards_user_l_idx ON fsrs_cards (user_id, l);
-- V69: cần cho GET /api/fsrs/stats (mature/young cards đếm theo state=Review) — trước đây chỉ có
-- (user_id, due) và (user_id, l), thiếu index phủ theo state khi filter riêng theo state.
CREATE INDEX IF NOT EXISTS fsrs_cards_user_state_idx ON fsrs_cards (user_id, state);

CREATE TABLE IF NOT EXISTS review_history (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  hz TEXT NOT NULL,
  l INT NOT NULL,
  rating TEXT NOT NULL,
  answer_correct BOOLEAN NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  previous_state INT,
  new_state INT,
  previous_due TIMESTAMPTZ,
  new_due TIMESTAMPTZ,
  previous_stability DOUBLE PRECISION,
  new_stability DOUBLE PRECISION,
  previous_difficulty DOUBLE PRECISION,
  new_difficulty DOUBLE PRECISION,
  scheduled_days DOUBLE PRECISION,
  response_time_ms INT,
  answer_changes INT NOT NULL DEFAULT 0,
  auto_rating TEXT
);
-- V69: field bắt buộc cho FSRS Optimizer export (Phần 6) — trước đây KHÔNG được lưu, các dòng cũ
-- (trước V69) sẽ có elapsed_days = NULL, không đủ dùng để train weights cho các lượt review đó.
ALTER TABLE review_history ADD COLUMN IF NOT EXISTS elapsed_days DOUBLE PRECISION;
CREATE INDEX IF NOT EXISTS review_history_user_time_idx ON review_history (user_id, reviewed_at);
CREATE INDEX IF NOT EXISTS review_history_card_idx ON review_history (user_id, hz, l, reviewed_at DESC);
-- V69: cần cho GET /api/fsrs/stats (retention thực tính theo previous_state = Review) và cho
-- optimizer export theo id DESC phân trang — trước đây chưa có index nào phủ previous_state.
CREATE INDEX IF NOT EXISTS review_history_user_prevstate_idx ON review_history (user_id, previous_state);

-- ── 2. user_settings (Phần 5 — Desired Retention theo user) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  desired_retention DOUBLE PRECISION NOT NULL DEFAULT 0.90
    CHECK (desired_retention IN (0.80, 0.85, 0.90, 0.95)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 3. user_fsrs_weights (Phần 7 — Personal Weights, chuẩn bị cho Optimizer, CHƯA train) ──────
CREATE TABLE IF NOT EXISTS user_fsrs_weights (
  user_id TEXT PRIMARY KEY,
  weights DOUBLE PRECISION[] NOT NULL,
  trained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  review_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 4. study_sessions (Phần 9-12 — Study Session Tracker / Dashboard / Streak / Heatmap) ──────
CREATE TABLE IF NOT EXISTS study_sessions (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  duration_seconds INT NOT NULL DEFAULT 0,
  cards_reviewed INT NOT NULL DEFAULT 0,
  correct_count INT NOT NULL DEFAULT 0,
  wrong_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS study_sessions_user_start_idx ON study_sessions (user_id, start_time);
CREATE INDEX IF NOT EXISTS study_sessions_user_end_idx ON study_sessions (user_id, end_time DESC);

-- ── 5. Dữ liệu cũ: progress.srs / progress.streak / progress.lastDate (trong app_store JSONB) ──
-- Các field này ĐÃ NGỪNG ĐƯỢC ĐỌC/GHI bởi api/index.js kể từ V69 (xem emptyProgress()). KHÔNG cần
-- xoá chúng khỏi JSONB đang có sẵn (an toàn hơn — dữ liệu cũ vẫn nằm im trong app_store.data,
-- không ảnh hưởng gì vì code không còn đọc tới). Nếu muốn dọn dẹp triệt để (không bắt buộc), có
-- thể chạy 1 lần:
--   UPDATE app_store
--   SET data = jsonb_set(
--     data, '{users}',
--     (SELECT jsonb_object_agg(key, (value #- '{progress,srs}') #- '{progress,streak}' #- '{progress,lastDate}')
--      FROM jsonb_each(data->'users'))
--   )
--   WHERE id = 1;
-- Không chạy tự động trong migration này — chỉ là tham khảo, vì sửa trực tiếp JSONB thủ công rủi
-- ro cao hơn lợi ích (field không dùng nữa không gây hại gì khi để nguyên).
