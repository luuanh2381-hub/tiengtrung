-- migrations/V106_skill_pinyin_context.sql — thêm kỹ năng 'pinyin' vào ràng buộc CHECK của word_skill_stats (V106).
-- Tự chạy idempotent trong lib/skill-store.js (ensureSkillTables); file này để đối chiếu/chạy tay. Không đụng dữ liệu.
-- Chỉ cần nếu bảng word_skill_stats đã được tạo từ V104 (CHECK cũ chưa có 'pinyin'); bảng mới tạo đã có sẵn.
ALTER TABLE word_skill_stats DROP CONSTRAINT IF EXISTS word_skill_stats_skill_check;
ALTER TABLE word_skill_stats ADD CONSTRAINT word_skill_stats_skill_check
  CHECK (skill IN ('recognition','recall','listening','pinyin','pronunciation','context'));
-- Hoàn tác: dùng lại CHECK của V104 (sẽ lỗi nếu đã có dòng skill='pinyin' — xoá các dòng đó trước).
