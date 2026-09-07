-- ════════════════════════════════════════════════════
-- migrations/V93_vocab_identity.sql
-- Migration V93 — audit "thống nhất từ vựng giữa các bài": chuyển identity của 1 từ vựng từ
-- (hz, lesson) sang (id)/(hz) ổn định; bài học chỉ còn là QUAN HỆ của từ với lesson, không còn là
-- 1 phần của identity.
--
-- Như V69/V76: câu lệnh dưới đây CHỈ để ĐỐI CHIẾU/THAM KHẢO phần SCHEMA (bảng/cột/index mới) — phần
-- schema này chạy tự động, idempotent, ngay trong lib/db.js (ensureVocabTable/ensureFsrsTables) ở
-- lần request/connect đầu tiên, AN TOÀN chạy tay nhiều lần.
--
-- KHÁC V69/V76: migration V93 còn có 1 phần DỮ LIỆU (gộp các vocab_words trùng hz thành 1 canonical,
-- backfill word_id cho fsrs_cards/review_history) — phần này KHÔNG tự chạy ngầm trong lib/db.js
-- (cố ý — đây là thao tác quét/gộp cả bảng, không nên chạy trên mọi cold start/mọi request), mà
-- PHẢI chạy 1 lần bằng tay:
--     DATABASE_URL=... node scripts/migrate-vocab-identity.js          (xem trước: thêm DRY_RUN=1)
-- Script tự in báo cáo trước/sau, tự rollback nếu phát hiện bất thường, an toàn chạy lại nhiều lần
-- (idempotent — lần 2 trở đi không còn duplicate nào để gộp).
-- ════════════════════════════════════════════════════

-- ── 1. vocab_lessons — quan hệ NHIỀU-NHIỀU từ ↔ bài (Phần 2 audit) ──────────────────────────────
-- "Một từ = một vocabulary record duy nhất; Bài học chỉ là quan hệ của từ với lesson."
-- vocab_words.l ĐƯỢC GIỮ NGUYÊN (không xoá cột) — đóng vai trò "bài chính/đầu tiên" cho các truy
-- vấn cũ chưa kịp cập nhật (tương thích ngược); nguồn THẬT cho "từ này thuộc những bài nào" là bảng
-- dưới đây, KHÔNG còn dựa vào việc tạo nhiều dòng vocab_words trùng hz cho mỗi bài nữa.
CREATE TABLE IF NOT EXISTS vocab_lessons (
  word_id INT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
  lesson INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (word_id, lesson)
);
CREATE INDEX IF NOT EXISTS vocab_lessons_lesson_idx ON vocab_lessons (lesson);

-- ── 2. vocab_words_hz_idx — CHỈ tạo SAU KHI đã dedupe xong (Phần 12 audit) ──────────────────────
-- KHÔNG được tạo trước — nếu production vẫn còn hz trùng (chưa chạy script migrate-vocab-identity.js)
-- câu này sẽ FAIL. Vì vậy KHÔNG nằm trong ensureVocabTable() (chạy ngầm mọi request) mà CHỈ được
-- script migrate-vocab-identity.js tạo, ở bước cuối cùng, sau khi đã tự verify sạch duplicate.
--   CREATE UNIQUE INDEX IF NOT EXISTS vocab_words_hz_idx ON vocab_words (hz);
-- (index (hz, l) cũ — vocab_words_hz_l_idx — được GIỮ NGUYÊN, không xoá, để không phải ALTER gì
-- thêm trên bảng production ngoài mức cần thiết; sau dedupe nó tương đương hz_idx nên vô hại.)

-- ── 3. fsrs_cards.word_id / review_history.word_id — identity ổn định cho FSRS (Phần 3/10) ──────
-- "FSRS/progress phải tham chiếu vocabulary identity ổn định" — KHÔNG còn (hz, lesson). Cột MỚI,
-- NULLABLE, cộng thêm — KHÔNG đổi/xoá cột hz/l cũ (vẫn giữ cho hiển thị/tương thích ngược — Phần 11).
ALTER TABLE fsrs_cards ADD COLUMN IF NOT EXISTS word_id INT REFERENCES vocab_words(id);
-- Unique PARTIAL index — chính là ràng buộc Ở TẦNG DATABASE cho "1 user chỉ có 1 fsrs_card cho mỗi
-- từ, bất kể từ đó xuất hiện ở bao nhiêu bài". AN TOÀN tạo TRƯỚC khi script dedupe chạy (lúc đó mọi
-- word_id đều NULL, predicate WHERE word_id IS NOT NULL không khớp dòng nào).
CREATE UNIQUE INDEX IF NOT EXISTS fsrs_cards_user_word_idx ON fsrs_cards (user_id, word_id) WHERE word_id IS NOT NULL;

ALTER TABLE review_history ADD COLUMN IF NOT EXISTS word_id INT REFERENCES vocab_words(id);
CREATE INDEX IF NOT EXISTS review_history_user_word_idx ON review_history (user_id, word_id);

-- ── 4. Phần DỮ LIỆU (không phải schema — xem scripts/migrate-vocab-identity.js) ─────────────────
-- a) Gộp các vocab_words trùng hz: giữ canonical = id NHỎ NHẤT trong nhóm; merge py/vi/tag/hanviet
--    KHÔNG BAO GIỜ ghi đè bằng giá trị rỗng (lib/vocab-merge.js:mergeManyVocabRecords).
-- b) Gộp lesson assignment của mọi bản ghi trùng vào vocab_lessons(canonical_id, lesson).
-- c) Với mỗi user đang có NHIỀU fsrs_cards trùng hz: chọn 1 thẻ sống sót deterministic (ưu tiên
--    reps cao nhất, rồi last_review gần nhất, rồi id nhỏ nhất — lib/vocab-merge.js:pickSurvivingFsrsCard),
--    gắn word_id=canonical cho thẻ sống sót, XOÁ thẻ thua (KHÔNG đụng review_history của chúng).
-- d) Backfill word_id cho TOÀN BỘ review_history theo hz -> canonical (review_history KHÔNG BAO GIỜ
--    bị xoá/sửa nội dung — chỉ thêm 1 cột liên kết).
-- e) Xoá các vocab_words bản ghi THUA (chỉ sau khi đã chuyển hết reference ở b/c/d).
-- f) Verify (đếm trước/sau, review_history/user không được giảm) rồi mới tạo vocab_words_hz_idx (mục 2).
-- Toàn bộ nằm trong 1 transaction DUY NHẤT — lỗi ở bất kỳ bước nào sẽ ROLLBACK SẠCH.
