-- migrations/V105_word_notes.sql — "Mẹo nhớ của bạn" (ghi chú liên tưởng riêng cho từng từ).
-- Như V104: lib/word-notes.js (ensureNotesTable) tự chạy idempotent ở lần dùng đầu; file này để đối chiếu/chạy tay.
-- CHỈ CỘNG THÊM, không đụng bảng cũ. Kiểu đã xác minh: user_id TEXT, word_id INT.
CREATE TABLE IF NOT EXISTS word_notes (
  user_id TEXT NOT NULL,
  word_id INT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, word_id)
);
-- Hoàn tác (mất ghi chú của người dùng, không ảnh hưởng FSRS):  DROP TABLE IF EXISTS word_notes;
