// lib/skills.js — Hệ thống KỸ NĂNG theo từng từ vựng (bổ sung cho FSRS, KHÔNG thay thế FSRS).
//
// File này THUẦN (không đụng DB/mạng) để dễ kiểm thử. Mọi con số/quy tắc dùng chung cho cả server
// (lib/db.js, lib/skill-adaptive.js, api/index.js) nằm Ở ĐÂY — không rải hằng số ở nhiều nơi.
//
// NGUYÊN TẮC: chỉ ghi nhận kỹ năng mà bài tập THỰC SỰ kiểm tra.
//   - recognition : nhìn chữ Hán → chọn nghĩa.
//   - recall      : nhìn nghĩa (hoặc gợi ý pinyin) → nhớ/chọn/gõ chữ Hán.
//   - listening   : nghe âm thanh → nhận ra chữ Hán.
//   - pinyin      : nhìn chữ Hán → chọn Pinyin (V106).
//   - context     : điền từ vào câu có sẵn trong dữ liệu (V106).
//   - pronunciation: hiện chỉ có chấm AI ở Flashcard (không lưu, không xác định được độ tin cậy) →
//                    CHƯA ghi nhận điểm phát âm. Giữ trong danh sách để UI hiển thị "chưa hỗ trợ".

'use strict';

const AM = require('../js/answer-match'); // V110: bộ chấm đáp án tự nhập dùng chung với trình duyệt

const ALL_SKILLS = ['recognition', 'recall', 'listening', 'pinyin', 'context', 'pronunciation'];
// Kỹ năng hiện có bài tập thật sự kiểm tra được (xem EXERCISES bên dưới). V106: thêm 'pinyin' (chữ Hán →
// Pinyin) và 'context' (điền từ vào câu). 'pronunciation' vẫn KHÔNG có (chưa có chấm phát âm đáng tin).
const MEASURABLE_SKILLS = ['recognition', 'recall', 'listening', 'pinyin', 'context'];

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
  'type-vi2hz':       { skill: 'recall',      quizType: 'vi2hz', fsrs: true, typed: 'hz' }, // V110: tab Gõ chữ — chấm chuẩn hoá Unicode/khoảng trắng
  'listen-choose-hz': { skill: 'listening',   quizType: 'vi2hz', fsrs: true },
  // V106 — dạng bài mới đi đường FSRS chính thức (server tự chấm theo quizType; đáp án là nghĩa/hz/pinyin):
  'review-listen-vi': { skill: 'listening',  quizType: 'hz2vi', fsrs: true },  // nghe → chọn nghĩa
  'review-hz2py':     { skill: 'pinyin',     quizType: 'hz2py', fsrs: true },  // chữ Hán → chọn Pinyin
  'review-cloze':     { skill: 'context',    quizType: 'vi2hz', fsrs: true },  // điền từ vào câu (đáp án = chữ Hán)
  // V110 — câu TỰ NHẬP đáp án. `typed` = 'hz' | 'py' → server chấm bằng js/answer-match.js (chuẩn hoá Unicode,
  // khoảng trắng, hoa/thường, dấu thanh/số thanh) thay vì so chuỗi chính xác. Chỉ nhãn khai báo `typed` mới được
  // chấm kiểu này — client không thể tự bật.
  'review-vi2hz-typed': { skill: 'recall', quizType: 'vi2hz', fsrs: true, typed: 'hz' }, // nghĩa → tự gõ chữ Hán
  'review-hz2py-typed': { skill: 'pinyin', quizType: 'hz2py', fsrs: true, typed: 'py' }, // chữ Hán → tự gõ pinyin
  // Luyện kỹ năng bổ sung (không phải lượt ôn FSRS):
  'practice-recall-typed':  { skill: 'recall', quizType: 'vi2hz', fsrs: false, typed: 'hz' },
  'practice-pinyin-typed':  { skill: 'pinyin', quizType: 'hz2py', fsrs: false, typed: 'py' },
  'practice-recognition':   { skill: 'recognition', quizType: 'hz2vi', fsrs: false },
  'practice-recall':        { skill: 'recall',      quizType: 'vi2hz', fsrs: false },
  'practice-listening':     { skill: 'listening',   quizType: 'vi2hz', fsrs: false },
  'practice-listening-vi':  { skill: 'listening',   quizType: 'hz2vi', fsrs: false },
  'practice-pinyin':        { skill: 'pinyin',      quizType: 'hz2py', fsrs: false },
  'practice-context':       { skill: 'context',     quizType: 'vi2hz', fsrs: false },
  'practice-confusable':    { skill: 'recall',      quizType: 'vi2hz', fsrs: false }, // phân biệt chữ dễ nhầm (nhóm có chú giải)
  'practice-match-vi':      { skill: 'recognition', quizType: 'hz2vi', fsrs: false }, // ghép cặp chữ Hán ↔ nghĩa
  'practice-match-py':      { skill: 'pinyin',      quizType: 'hz2py', fsrs: false }, // ghép cặp chữ Hán ↔ Pinyin
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
const GOOD_THRESHOLD = 0.75; // V110: đủ dữ liệu và điểm ≥ ngưỡng này → "tốt"; giữa 2 ngưỡng → "đang phát triển"

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
    return { status: 'insufficient', level: 'insufficient', score: null, confidence: confidenceOf(attempts), attempts };
  }
  const score = estimateScore(row.w_attempts, row.w_correct);
  // V110: `level` là cách gọi thân thiện cho giao diện (status giữ NGUYÊN vì nhiều nơi đang dùng):
  // insufficient (chưa đủ dữ liệu) | weak (yếu) | developing (đang phát triển) | good (tốt).
  const level = score < WEAK_THRESHOLD ? 'weak' : (score < GOOD_THRESHOLD ? 'developing' : 'good');
  return { status: score < WEAK_THRESHOLD ? 'weak' : 'ok', level, score, confidence: confidenceOf(attempts), attempts };
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


// ── V110: CHẤM ĐÁP ÁN ──────────────────────────────────────────────────────────────────────────
// `ex` = kết quả resolveExercise() (hoặc null). Chỉ khi nhãn bài tập khai báo `typed` mới chấm kiểu tự nhập;
// còn lại giữ NGUYÊN hành vi cũ (so chuỗi chính xác sau trim) → không đổi kết quả của mọi dạng trắc nghiệm.
// Trả { answerCorrect, verdict }. verdict: 'exact' | 'wrong' | 'toneless' | 'tone_mismatch' | 'empty'.
function gradeAnswer(correctAnswer, selectedAnswer, ex) {
  if (ex && ex.typed) {
    const r = AM.grade(ex.typed, selectedAnswer, correctAnswer);
    return { answerCorrect: r.correct, verdict: r.verdict };
  }
  const ok = String(selectedAnswer).trim() === String(correctAnswer).trim();
  return { answerCorrect: ok, verdict: ok ? 'exact' : 'wrong' };
}

// ── V110: NGUỒN GỐC KẾT QUẢ + PHÂN TÍCH TRÍ NHỚ DÀI HẠN ─────────────────────────────────────────
// source (lưu ở skill_practice_log.source; review_history = luôn 'fsrs' = lượt ôn chính thức):
//   fsrs    : lượt ôn FSRS chính thức (đổi lịch ôn).
//   check   : câu kiểm tra NGAY sau khi vừa xem từ mới (đã thấy đáp án) — luyện bổ sung.
//   redo    : luyện lại câu sai (vừa thấy đáp án) — luyện bổ sung.
//   extra / match / practice / mode / delayed : luyện bổ sung khác.
const PRACTICE_SOURCES = ['check', 'redo', 'extra', 'match', 'practice', 'mode', 'delayed'];
// Nguồn mà ngay trước đó người học vừa được XEM đáp án → đo "nhớ ngắn hạn", không phải nhớ sau khoảng nghỉ.
const SHOWN_ANSWER_SOURCES = ['check', 'redo'];

// Nhóm khoảng cách (giờ kể từ lần GẶP TỪ trước — bất kể kỹ năng nào). Đây là nhóm phân tích tham khảo,
// KHÔNG phải lịch kiểm tra cố định. Thứ tự: từ ngắn đến dài; `maxH` là cận trên loại trừ.
const RETENTION_BUCKETS = [
  { id: 'immediate', label: 'Ngay sau khi học (dưới 1 giờ / vừa xem đáp án)', maxH: 1 },
  { id: 'day',       label: 'Sau khoảng 1 ngày (1 giờ – dưới 3 ngày)',         maxH: 72 },
  { id: 'week',      label: 'Sau khoảng 1 tuần (3 – dưới 14 ngày)',            maxH: 24 * 14 },
  { id: 'month',     label: 'Sau khoảng 1 tháng trở lên (từ 14 ngày)',         maxH: Infinity },
];
const MIN_RETENTION_N = 10; // dưới ngưỡng này → KHÔNG báo tỉ lệ (chưa đủ mẫu), chỉ báo số lượt

function retentionBucketOf(gapHours, shownAnswerBefore) {
  if (shownAnswerBefore) return 'immediate';
  if (gapHours === null || gapHours === undefined || gapHours === '') return null; // Number(null) = 0 sẽ bị xếp nhầm vào 'immediate'
  const g = Number(gapHours);
  if (!Number.isFinite(g) || g < 0) return null; // không biết khoảng cách → KHÔNG xếp vào nhóm nào (không đoán)
  for (const b of RETENTION_BUCKETS) if (g < b.maxH) return b.id;
  return null;
}

// rows: [{ bucket, kind: 'fsrs'|'practice', n, correct }] (đã gộp từ SQL) → báo cáo có MẪU SỐ rõ ràng.
// Tỉ lệ = correct / n của CHÍNH nhóm đó; từ chưa được kiểm tra lại không có mặt trong mẫu số (không coi là quên).
function summarizeRetention(rows) {
  const out = {};
  for (const b of RETENTION_BUCKETS) {
    out[b.id] = { label: b.label, fsrs: { n: 0, correct: 0, rate: null }, practice: { n: 0, correct: 0, rate: null }, all: { n: 0, correct: 0, rate: null } };
  }
  for (const r of rows || []) {
    const slot = out[r.bucket];
    if (!slot || (r.kind !== 'fsrs' && r.kind !== 'practice')) continue;
    const n = Number(r.n) || 0, c = Number(r.correct) || 0;
    slot[r.kind].n += n; slot[r.kind].correct += c;
    slot.all.n += n; slot.all.correct += c;
  }
  for (const b of RETENTION_BUCKETS) {
    for (const k of ['fsrs', 'practice', 'all']) {
      const x = out[b.id][k];
      x.rate = x.n >= MIN_RETENTION_N ? x.correct / x.n : null;
    }
  }
  return out;
}

module.exports = {
  ALL_SKILLS, MEASURABLE_SKILLS, EXERCISES,
  DECAY, MIN_ATTEMPTS, WEAK_THRESHOLD, GOOD_THRESHOLD,
  isCountableAnswer, resolveExercise, estimateScore, confidenceOf, classify, applyAttempt,
  gradeAnswer, PRACTICE_SOURCES, SHOWN_ANSWER_SOURCES, RETENTION_BUCKETS, MIN_RETENTION_N, retentionBucketOf, summarizeRetention,
};
