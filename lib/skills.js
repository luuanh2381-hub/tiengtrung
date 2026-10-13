// lib/skills.js — Hệ thống KỸ NĂNG theo từng từ vựng (bổ sung cho FSRS, KHÔNG thay thế FSRS).
//
// File này THUẦN (không đụng DB/mạng) để dễ kiểm thử. Mọi con số/quy tắc dùng chung cho cả server
// (lib/db.js, lib/skill-adaptive.js, api/index.js) nằm Ở ĐÂY — không rải hằng số ở nhiều nơi.
//
// NGUYÊN TẮC: chỉ ghi nhận kỹ năng mà bài tập THỰC SỰ kiểm tra.
//   - recognition : nhìn chữ Hán → chọn nghĩa.
//   - recall      : nhìn nghĩa (hoặc gợi ý pinyin) → nhớ/chọn/gõ chữ Hán.
//   - listening   : nghe âm thanh → nhận ra chữ Hán.
//   - context     : CHƯA có bài kiểm tra nào hỏi "điền từ vào câu" → chưa được ghi nhận/đề xuất.
//   - pronunciation: hiện chỉ có chấm AI ở Flashcard (không lưu, không xác định được độ tin cậy) →
//                    CHƯA ghi nhận điểm phát âm. Giữ trong danh sách để UI hiển thị "chưa hỗ trợ".

'use strict';

const ALL_SKILLS = ['recognition', 'recall', 'listening', 'pronunciation', 'context'];
// Kỹ năng hiện có bài tập thật sự kiểm tra được (xem EXERCISES bên dưới).
const MEASURABLE_SKILLS = ['recognition', 'recall', 'listening'];

// ── Bảng bài tập hợp lệ. `quizType` là chiều câu hỏi mà /api/study/review đã hiểu (server tự chấm
//     đúng/sai theo quizType) — server CHỈ ghi kỹ năng khi exerciseType khớp với quizType thật của
//     lượt trả lời, để một nhãn gửi sai/gửi bậy từ client không làm bẩn hồ sơ kỹ năng. ──────────
// `fsrs: true`  = lượt này đi qua /api/study/review (lượt FSRS chính thức) → ghi cả skill.
// `fsrs: false` = bài luyện kỹ năng bổ sung (/api/skills/practice) → CHỈ ghi skill, không đụng FSRS.
const EXERCISES = {
  'review-hz2vi':     { skill: 'recognition', quizType: 'hz2vi', fsrs: true },
  'review-vi2hz':     { skill: 'recall',      quizType: 'vi2hz', fsrs: true },
  'review-listen':    { skill: 'listening',   quizType: 'vi2hz', fsrs: true },
  'quiz-hz2vi':       { skill: 'recognition', quizType: 'hz2vi', fsrs: true },
  'quiz-vi2hz':       { skill: 'recall',      quizType: 'vi2hz', fsrs: true },
  'quiz-py2hz':       { skill: 'recall',      quizType: 'py2hz', fsrs: true },
  'type-vi2hz':       { skill: 'recall',      quizType: 'vi2hz', fsrs: true },
  'listen-choose-hz': { skill: 'listening',   quizType: 'vi2hz', fsrs: true },
  // Luyện kỹ năng bổ sung (không phải lượt ôn FSRS):
  'practice-recall':    { skill: 'recall',    quizType: 'vi2hz', fsrs: false },
  'practice-listening': { skill: 'listening', quizType: 'vi2hz', fsrs: false },
};
// Flashcard (tự chấm "đã nhớ/chưa nhớ") CỐ Ý không có trong bảng: đó là tự đánh giá chủ quan,
// không phải một phép kiểm tra khách quan → không ghi vào hồ sơ kỹ năng.

// ── Quy tắc điểm (đơn giản, giải thích được) ───────────────────────────────────────────────
// Mỗi (user, từ, kỹ năng) giữ 2 cặp số:
//   attempts/correct         : đếm THÔ, không bao giờ phai (dùng để quyết định "đủ dữ liệu chưa").
//   w_attempts/w_correct     : đếm CÓ TRỌNG SỐ GIẢM DẦN — mỗi lượt mới nhân số cũ với DECAY (0.85)
//                              rồi cộng lượt mới → lượt gần đây nặng hơn lượt cũ (người học tiến bộ
//                              thì điểm tăng theo, không bị kéo mãi bởi lần sai từ rất lâu).
// Điểm năng lực = (w_correct + 1) / (w_attempts + 2) — ước lượng Laplace: ít dữ liệu thì bị kéo về
// 0.5 (không kết luận chắc chắn từ 1-2 câu), nhiều dữ liệu thì tiến dần về tỉ lệ đúng thật.
const DECAY = 0.85;
const MIN_ATTEMPTS = 3;      // dưới ngưỡng này → "Chưa đủ dữ liệu", KHÔNG hiện điểm, KHÔNG gọi là yếu/giỏi
const WEAK_THRESHOLD = 0.6;  // đủ dữ liệu và điểm < ngưỡng này → "yếu"

// Câu trả lời CÓ được tính vào kỹ năng không? "Bỏ trống" (bấm Kiểm tra khi chưa gõ gì) có thể là
// bấm nhầm → không phản ánh năng lực → bỏ qua. "Bỏ qua" (chủ động bấm Bỏ qua) = không nhớ ra → tính SAI.
function isCountableAnswer(selectedAnswer) {
  if (typeof selectedAnswer !== 'string') return false;
  const s = selectedAnswer.trim();
  if (!s) return false;
  if (s === '⨯ (bỏ trống) ⨯') return false;
  return true;
}

function resolveExercise(exerciseType, quizType) {
  if (typeof exerciseType !== 'string') return null;
  const def = EXERCISES[exerciseType];
  if (!def) return null;
  if (quizType && def.quizType !== quizType) return null; // nhãn không khớp chiều câu hỏi thật → bỏ
  return { exerciseType, ...def };
}

function estimateScore(wAttempts, wCorrect) {
  const a = Number(wAttempts) || 0;
  const c = Number(wCorrect) || 0;
  return (c + 1) / (a + 2);
}

// Độ tin cậy 0..1: n/(n+3). 3 lượt → 0.5, 9 lượt → 0.75, 27 lượt → 0.9.
function confidenceOf(attempts) {
  const n = Math.max(0, Number(attempts) || 0);
  return n / (n + 3);
}

// Phân loại 1 dòng thống kê (hoặc null = chưa có dữ liệu gì).
// Trả về { status: 'insufficient'|'weak'|'ok', score|null, confidence, attempts }
function classify(row) {
  const attempts = row ? Number(row.attempts) || 0 : 0;
  if (!row || attempts < MIN_ATTEMPTS) {
    return { status: 'insufficient', score: null, confidence: confidenceOf(attempts), attempts };
  }
  const score = estimateScore(row.w_attempts, row.w_correct);
  return { status: score < WEAK_THRESHOLD ? 'weak' : 'ok', score, confidence: confidenceOf(attempts), attempts };
}

// Bản JS của đúng phép cập nhật mà SQL UPSERT thực hiện — dùng trong test để chứng minh công thức.
function applyAttempt(prev, isCorrect) {
  const p = prev || { attempts: 0, correct: 0, w_attempts: 0, w_correct: 0 };
  const ok = isCorrect ? 1 : 0;
  return {
    attempts: p.attempts + 1,
    correct: p.correct + ok,
    w_attempts: p.w_attempts * DECAY + 1,
    w_correct: p.w_correct * DECAY + ok,
  };
}

module.exports = {
  ALL_SKILLS, MEASURABLE_SKILLS, EXERCISES,
  DECAY, MIN_ATTEMPTS, WEAK_THRESHOLD,
  isCountableAnswer, resolveExercise, estimateScore, confidenceOf, classify, applyAttempt,
};
