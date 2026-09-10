#!/usr/bin/env node
// ════════════════════════════════════════════════════
// test/fsrs.test.js — Unit test THUẦN cho lớp FSRS (lib/fsrs.js, lib/fsrs-auto-rating.js,
// lib/fsrs/studyScope.js, lib/fsrs/scheduler.js). KHÔNG cần DATABASE_URL/Postgres — mọi hàm test
// ở đây chỉ động tới logic tính toán thuần JS, không chạm DB.
//
// FIX (audit V79): package.json đã khai báo `"test": "node test/fsrs.test.js"` từ các đợt audit
// trước (V69/V72 có nhắc tới file này), nhưng thư mục test/ không tồn tại trong project — `npm
// test` luôn báo lỗi "Cannot find module". File này khôi phục lại `npm test` ở trạng thái CHẠY
// ĐƯỢC THẬT, với các khẳng định (assertion) có ý nghĩa thay vì test rỗng cho có.
//
// Chạy: npm test  (hoặc: node test/fsrs.test.js)
// ════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');

const fsrs = require(path.join(__dirname, '..', 'lib', 'fsrs'));
const { getAutomaticFSRSRating, personalBaselineMs } = require(path.join(__dirname, '..', 'lib', 'fsrs-auto-rating'));
const studyScope = require(path.join(__dirname, '..', 'lib', 'fsrs', 'studyScope'));

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
  }
}

console.log('════════════════════════════════════════════════════');
console.log('FSRS — unit tests (không cần Postgres)');
console.log('════════════════════════════════════════════════════');

console.log('\n[lib/fsrs.js — scheduler thật (ts-fsrs)]');

test('FSRS-6 dùng đúng 21 weights (w[0]..w[20])', () => {
  const info = fsrs.getFsrsVerificationInfo();
  assert.strictEqual(info.paramCount, 21);
  assert.strictEqual(info.isFsrs6, true);
});

test('isAllowedRetention() chỉ chấp nhận đúng 4 mức đã duyệt', () => {
  assert.strictEqual(fsrs.isAllowedRetention(0.90), true);
  assert.strictEqual(fsrs.isAllowedRetention(0.80), true);
  assert.strictEqual(fsrs.isAllowedRetention(0.95), true);
  assert.strictEqual(fsrs.isAllowedRetention(0.99), false);
  assert.strictEqual(fsrs.isAllowedRetention('không phải số'), false);
  assert.strictEqual(fsrs.isAllowedRetention(undefined), false);
});

test('ratingFromString() chỉ nhận đúng 4 giá trị, không phân biệt hoa/thường', () => {
  assert.strictEqual(fsrs.ratingFromString('again'), fsrs.Rating.Again);
  assert.strictEqual(fsrs.ratingFromString('GOOD'), fsrs.Rating.Good);
  assert.strictEqual(fsrs.ratingFromString('Easy'), fsrs.Rating.Easy);
  assert.strictEqual(fsrs.ratingFromString('xyz'), null);
  assert.strictEqual(fsrs.ratingFromString(''), null);
});

test('reviewCard(): thẻ MỚI + rating "again" → vẫn ở trạng thái đang học (không nhảy thẳng lên Review)', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const { newCard } = fsrs.reviewCard(null, 'again', now, 0.9);
  assert.notStrictEqual(newCard.state, fsrs.State.Review);
  assert.ok(newCard.due.getTime() >= now.getTime(), 'due phải >= thời điểm review');
});

test('reviewCard(): thẻ MỚI + rating "easy" cho khoảng cách ôn xa hơn "again" (đúng bản chất FSRS)', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const again = fsrs.reviewCard(null, 'again', now, 0.9).newCard;
  const easy = fsrs.reviewCard(null, 'easy', now, 0.9).newCard;
  assert.ok(easy.due.getTime() >= again.due.getTime(), 'Easy phải cho lịch ôn xa hơn hoặc bằng Again');
});

test('reviewCard(): retention thấp hơn → scheduled_days dài hơn (đúng công thức FSRS)', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  // Cần vài lượt "good" liên tiếp để thẻ có stability đáng kể trước khi so sánh scheduled_days.
  function simulate(retention) {
    let card = null;
    let cur = now;
    for (let i = 0; i < 3; i++) {
      const r = fsrs.reviewCard(card, 'good', cur, retention);
      card = r.newCard;
      cur = new Date(cur.getTime() + (card.scheduled_days || 1) * 86400000);
    }
    return card.scheduled_days;
  }
  const days80 = simulate(0.80);
  const days95 = simulate(0.95);
  assert.ok(days80 >= days95, `retention thấp hơn (0.80) phải cho scheduled_days dài hơn hoặc bằng (0.95): ${days80} vs ${days95}`);
});

test('reviewCard(): rating không hợp lệ phải throw, không âm thầm chạy sai', () => {
  assert.throws(() => fsrs.reviewCard(null, 'excellent', new Date(), 0.9));
});

test('rowToCard()/cardToRow(): round-trip giữ nguyên giá trị số', () => {
  const row = {
    state: 2, due: '2026-02-01T00:00:00Z', stability: 12.5, difficulty: 4.2,
    elapsed_days: 3, scheduled_days: 10, reps: 5, lapses: 1, last_review: '2026-01-22T00:00:00Z',
  };
  const card = fsrs.rowToCard(row);
  assert.strictEqual(card.stability, 12.5);
  assert.strictEqual(card.difficulty, 4.2);
  assert.strictEqual(card.state, 2);
  const back = fsrs.cardToRow(card);
  assert.strictEqual(back.stability, 12.5);
  assert.strictEqual(back.state, 2);
});

test('rowToCard(null) trả null (word hoàn toàn mới, chưa có fsrs_card)', () => {
  assert.strictEqual(fsrs.rowToCard(null), null);
});

test('getSchedulerForRetention(): giá trị không hợp lệ fallback về DEFAULT_RETENTION, không throw', () => {
  const { params } = fsrs.getSchedulerForRetention(1.5); // không nằm trong ALLOWED_RETENTIONS
  assert.strictEqual(params.request_retention, fsrs.DEFAULT_RETENTION);
});

console.log('\n[lib/fsrs-auto-rating.js — suy luận rating từ hành vi trả lời]');

test('Trả lời SAI luôn ra "again", bất kể trả lời nhanh hay chậm', () => {
  assert.strictEqual(getAutomaticFSRSRating({ answerCorrect: false, responseTimeMs: 500, card: null, reviewHistory: [] }), 'again');
  assert.strictEqual(getAutomaticFSRSRating({ answerCorrect: false, responseTimeMs: 30000, card: { state: 2, reps: 5 }, reviewHistory: [] }), 'again');
});

test('Từ MỚI trả lời đúng rất nhanh KHÔNG được tự suy ra "easy" (tránh nhầm may mắn/đoán với đã nhớ chắc)', () => {
  const r = getAutomaticFSRSRating({ answerCorrect: true, responseTimeMs: 300, card: null, reviewHistory: [], answerChanges: 0 });
  assert.notStrictEqual(r, 'easy');
});

test('Từ MỚI trả lời đúng, đổi đáp án nhiều lần trước khi chốt → "hard"', () => {
  const r = getAutomaticFSRSRating({ answerCorrect: true, responseTimeMs: 1000, card: null, reviewHistory: [], answerChanges: 3 });
  assert.strictEqual(r, 'hard');
});

test('Chưa đủ lịch sử để dựng baseline cá nhân → mặc định bảo thủ "good", không đoán bừa "easy"', () => {
  const r = getAutomaticFSRSRating({
    answerCorrect: true, responseTimeMs: 100, answerChanges: 0,
    card: { state: 2, reps: 1, stability: 5, difficulty: 3 }, reviewHistory: [],
  });
  assert.strictEqual(r, 'good');
});

console.log('\n[lib/fsrs-auto-rating.js — fix "review nhiễu khi thoát ra vào lại" (MAX_TRUSTED_RESPONSE_MS)]');

test('responseTimeMs cực lớn (vd thoát app 10 phút) trên từ MỚI, trả lời ĐÚNG → KHÔNG bị chấm "hard" oan', () => {
  const r = getAutomaticFSRSRating({
    answerCorrect: true, responseTimeMs: 10 * 60 * 1000, answerChanges: 0, card: null, reviewHistory: [],
  });
  assert.strictEqual(r, 'good', 'responseTime bất thường phải bị bỏ qua, KHÔNG được suy ra hard chỉ vì "chậm"');
});

test('responseTimeMs cực lớn trên card ĐÃ có baseline hợp lệ → vẫn KHÔNG bị chấm "hard" vì lý do thời gian', () => {
  const reviewHistory = [
    { answer_correct: true, response_time_ms: 2000, reviewed_at: '2026-01-01' },
    { answer_correct: true, response_time_ms: 2200, reviewed_at: '2026-01-02' },
    { answer_correct: true, response_time_ms: 1800, reviewed_at: '2026-01-03' },
  ];
  const r = getAutomaticFSRSRating({
    answerCorrect: true, responseTimeMs: 45 * 60 * 1000, answerChanges: 0,
    card: { state: 2, reps: 5, stability: 8, difficulty: 3, last_review: '2026-01-03' },
    reviewHistory,
  });
  assert.strictEqual(r, 'good', 'baseline vẫn dựng được từ lịch sử hợp lệ, nhưng rt hiện tại bị loại nên rơi về nhánh "không có rt" -> good mặc định');
});

test('responseTimeMs VỪA PHẢI (dưới ngưỡng) vẫn hoạt động bình thường — không bị lớp phòng thủ này chặn nhầm', () => {
  const reviewHistory = [
    { answer_correct: true, response_time_ms: 2000, reviewed_at: '2026-01-01' },
    { answer_correct: true, response_time_ms: 2200, reviewed_at: '2026-01-02' },
    { answer_correct: true, response_time_ms: 1800, reviewed_at: '2026-01-03' },
  ];
  const r = getAutomaticFSRSRating({
    answerCorrect: true, responseTimeMs: 5000, answerChanges: 0, // chậm hơn baseline (~2000) nhưng KHÔNG bất thường
    card: { state: 2, reps: 5, stability: 8, difficulty: 3, last_review: '2026-01-03' },
    reviewHistory,
  });
  assert.strictEqual(r, 'hard', 'ratio ~2.3x baseline vẫn phải được TÍNH BÌNH THƯỜNG (ra hard theo đúng tín hiệu thật), không bị lớp phòng thủ 90s ảnh hưởng');
});

test('personalBaselineMs(): 1 lượt lịch sử CŨ bị nhiễu (thoát app) KHÔNG được kéo lệch baseline của các lượt SAU', () => {
  const reviewHistory = [
    { answer_correct: true, response_time_ms: 40 * 60 * 1000, reviewed_at: '2026-01-04' }, // nhiễu cũ — phải bị loại
    { answer_correct: true, response_time_ms: 2000, reviewed_at: '2026-01-03' },
    { answer_correct: true, response_time_ms: 2200, reviewed_at: '2026-01-02' },
    { answer_correct: true, response_time_ms: 1800, reviewed_at: '2026-01-01' },
  ];
  const baseline = personalBaselineMs(reviewHistory);
  assert.ok(baseline !== null && baseline < 3000, `baseline phải phản ánh đúng tốc độ thật (~2000ms), không bị kéo lên bởi lượt nhiễu 40 phút: ${baseline}`);
});

console.log('\n[lib/fsrs/studyScope.js — chọn bài học / thứ tự ưu tiên từ mới]');

test('resolveCurrentLesson(): currentLesson đã lưu còn nằm trong phạm vi → giữ nguyên', () => {
  assert.strictEqual(studyScope.resolveCurrentLesson({ currentLesson: 5 }, [3, 4, 5, 6]), 5);
});

test('resolveCurrentLesson(): currentLesson đã lưu KHÔNG còn trong phạm vi (đổi Quyển/bài) → lấy bài nhỏ nhất trong phạm vi mới', () => {
  assert.strictEqual(studyScope.resolveCurrentLesson({ currentLesson: 99 }, [3, 4, 5]), 3);
});

test('resolveCurrentLesson(): phạm vi rỗng → fallback bài 1, không throw', () => {
  assert.strictEqual(studyScope.resolveCurrentLesson({ currentLesson: null }, []), 1);
});

test('buildLessonPriorityOrder(): ưu tiên đúng thứ tự bài trước → bài hiện tại → bài sau, TRONG phạm vi trước khi ra ngoài', () => {
  const { inScopeOrder, outside } = studyScope.buildLessonPriorityOrder(5, [3, 5, 7, 9], [1, 2, 3, 5, 7, 9, 20]);
  assert.deepStrictEqual(inScopeOrder, [3, 5, 7, 9]);
  assert.ok(!outside.includes(3) && !outside.includes(5) && !outside.includes(7) && !outside.includes(9));
  assert.ok(outside.includes(1) && outside.includes(2) && outside.includes(20));
});

test('bookOfLessonServer(): map đúng bài → Quyển theo BOOKS_RANGES', () => {
  assert.strictEqual(studyScope.bookOfLessonServer(10), 1); // Quyển 1: 1-15
  assert.strictEqual(studyScope.bookOfLessonServer(20), 2); // Quyển 2: 16-30
  assert.strictEqual(studyScope.bookOfLessonServer(9999), 1); // không khớp Quyển nào -> fallback 1
});

console.log('\n════════════════════════════════════════════════════');
console.log(`Kết quả: ${passed} PASS, ${failed} FAIL`);
console.log('════════════════════════════════════════════════════');
if (failed > 0) process.exitCode = 1;
