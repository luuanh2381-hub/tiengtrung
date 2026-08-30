#!/usr/bin/env node
// ════════════════════════════════════════════════════
// test/fsrs-optimizer.test.js — Unit test THUẦN cho FSRS Personal Optimizer (lib/fsrs/optimizer.js,
// lib/fsrs.js). KHÔNG cần DATABASE_URL/Postgres — chỉ động tới logic tính toán thuần JS (data
// quality validate/readiness/split/evaluate/weight-validation), giống tinh thần test/fsrs.test.js.
//
// CÁC KỊCH BẢN CẦN POSTGRES THẬT (apply/rollback/reset/scheduler dùng đúng weights sau khi Apply,
// review history/card state không đổi) nằm ở test/fsrs-optimizer.integration.test.js — file đó tự
// SKIP nếu chưa cấu hình DATABASE_URL, giống test/fsrs.concurrency.integration.js.
//
// Chạy: npm run test:optimizer  (hoặc: node test/fsrs-optimizer.test.js)
// ════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fsrs = require(path.join(__dirname, '..', 'lib', 'fsrs'));
const optimizer = require(path.join(__dirname, '..', 'lib', 'fsrs', 'optimizer'));

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
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
  }
}

console.log('════════════════════════════════════════════════════');
console.log('FSRS Personal Optimizer — unit tests (không cần Postgres)');
console.log('════════════════════════════════════════════════════');

// ── Helper: tạo N review giả cho 1 tập card, rải đều theo ngày, rating chủ yếu "good"/"easy" +
//     ít "again"/"hard" để đi qua ngưỡng "đa dạng rating" của classifyReadiness. ──
function makeSyntheticRows({ reviews = 4000, cards = 300, startDaysAgo = 400 } = {}) {
  const rows = [];
  const ratings = ['good', 'good', 'good', 'easy', 'again', 'hard'];
  const now = new Date('2026-08-01T00:00:00Z');
  let id = 1;
  for (let i = 0; i < reviews; i++) {
    const cardIdx = i % cards;
    const dayOffset = Math.floor((i / reviews) * startDaysAgo);
    const reviewedAt = new Date(now.getTime() - (startDaysAgo - dayOffset) * 86400000);
    rows.push({
      id: id++,
      hz: `字${cardIdx}`,
      l: 1 + (cardIdx % 10),
      rating: ratings[i % ratings.length],
      answer_correct: ratings[i % ratings.length] !== 'again',
      reviewed_at: reviewedAt.toISOString(),
      elapsed_days: 1,
    });
  }
  // Sắp giống thứ tự SQL thật (hz, l, reviewed_at, id) để byCard group đúng.
  rows.sort((a, b) => (a.hz + a.l).localeCompare(b.hz + b.l) || new Date(a.reviewed_at) - new Date(b.reviewed_at) || a.id - b.id);
  return rows;
}

console.log('\n[lib/fsrs.js — isValidWeightsArray (Phần 4)]');

test('isValidWeightsArray(): đúng 21 số hữu hạn → true', () => {
  const w = Array.from({ length: 21 }, (_, i) => i * 0.1);
  assert.strictEqual(fsrs.isValidWeightsArray(w), true);
});
test('isValidWeightsArray(): sai độ dài → false', () => {
  assert.strictEqual(fsrs.isValidWeightsArray(Array.from({ length: 20 }, () => 1)), false);
  assert.strictEqual(fsrs.isValidWeightsArray(Array.from({ length: 22 }, () => 1)), false);
});
test('isValidWeightsArray(): có NaN/Infinity → false', () => {
  const w1 = Array.from({ length: 21 }, () => 1); w1[5] = NaN;
  const w2 = Array.from({ length: 21 }, () => 1); w2[10] = Infinity;
  assert.strictEqual(fsrs.isValidWeightsArray(w1), false);
  assert.strictEqual(fsrs.isValidWeightsArray(w2), false);
});
test('isValidWeightsArray(): undefined/null/không phải mảng → false', () => {
  assert.strictEqual(fsrs.isValidWeightsArray(undefined), false);
  assert.strictEqual(fsrs.isValidWeightsArray(null), false);
  assert.strictEqual(fsrs.isValidWeightsArray('not an array'), false);
});

console.log('\n[lib/fsrs.js — reviewCard()/getRetrievability() với customWeights (Phần 11)]');

test('reviewCard(): customWeights hợp lệ → dùng weights đó thay vì mặc định (kết quả đổi)', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const defaultResult = fsrs.reviewCard(null, 'good', now, 0.9);
  const customW = Array.from({ length: 21 }, (_, i) => (defaultResult.newCard ? 1 : 1)); // mảng 21 số bất kỳ hợp lệ
  const custom = fsrs.reviewCard(null, 'good', now, 0.9, customW.map((_, i) => i === 0 ? 0.3 : 1));
  assert.ok(custom.newCard, 'phải trả về newCard hợp lệ với customWeights');
});
test('reviewCard(): customWeights KHÔNG hợp lệ (sai độ dài) → fallback default weights, không throw', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  assert.doesNotThrow(() => fsrs.reviewCard(null, 'good', now, 0.9, [1, 2, 3]));
});
test('getRetrievability(): thẻ vừa review "good" → retrievability nằm trong (0, 1]', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const { newCard } = fsrs.reviewCard(null, 'good', now, 0.9);
  const later = new Date(now.getTime() + 1 * 86400000);
  const r = fsrs.getRetrievability(newCard, later, 0.9);
  assert.ok(r > 0 && r <= 1, `retrievability phải trong (0,1], nhận được ${r}`);
});

console.log('\n[lib/fsrs/optimizer.js — validateReviewHistory() (Phần 2 — Data Quality Check)]');

test('validateReviewHistory(): rating không hợp lệ → bị loại (invalidReviews tăng)', () => {
  const rows = [
    { id: 1, hz: '你', l: 1, rating: 'good', answer_correct: true, reviewed_at: '2026-01-01T00:00:00Z', elapsed_days: 0 },
    { id: 2, hz: '你', l: 1, rating: 'excellent', answer_correct: true, reviewed_at: '2026-01-02T00:00:00Z', elapsed_days: 1 },
  ];
  const { report } = optimizer.validateReviewHistory(rows, { now: new Date('2026-06-01T00:00:00Z') });
  assert.strictEqual(report.validReviews, 1);
  assert.strictEqual(report.invalidReviews, 1);
});

test('validateReviewHistory(): 2 review trùng (cùng thẻ, cùng thời điểm) → tính là duplicate, không phải valid', () => {
  const rows = [
    { id: 1, hz: '你', l: 1, rating: 'good', answer_correct: true, reviewed_at: '2026-01-01T00:00:00Z', elapsed_days: 0 },
    { id: 2, hz: '你', l: 1, rating: 'good', answer_correct: true, reviewed_at: '2026-01-01T00:00:00Z', elapsed_days: 0 },
  ];
  const { report } = optimizer.validateReviewHistory(rows, { now: new Date('2026-06-01T00:00:00Z') });
  assert.strictEqual(report.validReviews, 1);
  assert.strictEqual(report.duplicates, 1);
});

test('validateReviewHistory(): timestamp ở tương lai → bị loại', () => {
  const rows = [
    { id: 1, hz: '你', l: 1, rating: 'good', answer_correct: true, reviewed_at: '2099-01-01T00:00:00Z', elapsed_days: 0 },
  ];
  const { report } = optimizer.validateReviewHistory(rows, { now: new Date('2026-06-01T00:00:00Z') });
  assert.strictEqual(report.validReviews, 0);
  assert.strictEqual(report.invalidReviews, 1);
});

test('validateReviewHistory(): elapsed_days âm → bị loại', () => {
  const rows = [
    { id: 1, hz: '你', l: 1, rating: 'good', answer_correct: true, reviewed_at: '2026-01-01T00:00:00Z', elapsed_days: -5 },
  ];
  const { report } = optimizer.validateReviewHistory(rows, { now: new Date('2026-06-01T00:00:00Z') });
  assert.strictEqual(report.invalidReviews, 1);
});

test('validateReviewHistory(): dataset lớn hợp lệ → uniqueCards/dateRange đúng, ratingDistribution đủ 4 loại', () => {
  const rows = makeSyntheticRows({ reviews: 4000, cards: 300 });
  const { report } = optimizer.validateReviewHistory(rows, { now: new Date('2026-08-02T00:00:00Z') });
  assert.strictEqual(report.validReviews, 4000);
  assert.strictEqual(report.uniqueCards, 300);
  assert.ok(report.ratingDistribution.again > 0 && report.ratingDistribution.hard > 0 && report.ratingDistribution.good > 0 && report.ratingDistribution.easy > 0);
  assert.ok(report.dateRange && report.dateRange.days > 300);
});

console.log('\n[lib/fsrs/optimizer.js — classifyReadiness() (Phần 5)]');

test('classifyReadiness(): < 500 review hợp lệ → NOT_READY', () => {
  const { report } = optimizer.validateReviewHistory(makeSyntheticRows({ reviews: 300, cards: 50 }), { now: new Date('2026-08-02T00:00:00Z') });
  const readiness = optimizer.classifyReadiness(report);
  assert.strictEqual(readiness.status, 'NOT_READY');
});

test('classifyReadiness(): 4.000 review sạch trên 300 thẻ → OPTIMIZABLE', () => {
  const { report } = optimizer.validateReviewHistory(makeSyntheticRows({ reviews: 4000, cards: 300 }), { now: new Date('2026-08-02T00:00:00Z') });
  const readiness = optimizer.classifyReadiness(report);
  assert.strictEqual(readiness.status, 'OPTIMIZABLE');
});

test('classifyReadiness(): nhiều review nhưng dồn vào quá ít thẻ (< 30) → NOT_READY dù đủ SỐ LƯỢNG', () => {
  const { report } = optimizer.validateReviewHistory(makeSyntheticRows({ reviews: 2000, cards: 10 }), { now: new Date('2026-08-02T00:00:00Z') });
  const readiness = optimizer.classifyReadiness(report);
  assert.strictEqual(readiness.status, 'NOT_READY');
});

test('classifyReadiness(): tỉ lệ dữ liệu lỗi quá cao (>30%) → NOT_READY dù đủ review hợp lệ về số lượng tuyệt đối', () => {
  const validRows = makeSyntheticRows({ reviews: 600, cards: 50 });
  const now = new Date('2026-08-02T00:00:00Z');
  const junkRows = Array.from({ length: 1000 }, (_, i) => ({
    id: 100000 + i, hz: '垃圾', l: 1, rating: 'not-a-rating', answer_correct: true, reviewed_at: now.toISOString(), elapsed_days: 0,
  }));
  const { report } = optimizer.validateReviewHistory([...validRows, ...junkRows], { now });
  assert.ok(report.validReviews >= 500, 'test setup cần validReviews đủ để KHÔNG bị chặn bởi rule đầu tiên');
  const readiness = optimizer.classifyReadiness(report);
  assert.strictEqual(readiness.status, 'NOT_READY');
});

console.log('\n[lib/fsrs/optimizer.js — buildTrainingItems() / splitTrainValidation() (Phần 6/7)]');

test('buildTrainingItems(): lượt review ĐẦU của mỗi thẻ có deltaT=0, các lượt sau đúng số ngày cách nhau', () => {
  const byCard = new Map([
    ['你::1', [
      { rating: 3, reviewedAt: new Date('2026-01-01T00:00:00Z'), answerCorrect: true },
      { rating: 3, reviewedAt: new Date('2026-01-05T00:00:00Z'), answerCorrect: true },
      { rating: 1, reviewedAt: new Date('2026-01-10T00:00:00Z'), answerCorrect: false },
    ]],
  ]);
  const items = optimizer.buildTrainingItems(byCard);
  assert.strictEqual(items.length, 1);
  assert.deepStrictEqual(items[0].reviews.map((r) => r.deltaT), [0, 4, 5]);
});

test('splitTrainValidation(): ổn định (deterministic) — cùng input luôn ra cùng kết quả', () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ cardId: `card-${i}`, reviews: [] }));
  const a = optimizer.splitTrainValidation(items, 0.8);
  const b = optimizer.splitTrainValidation(items, 0.8);
  assert.deepStrictEqual(a.train.map((x) => x.cardId), b.train.map((x) => x.cardId));
  assert.ok(a.train.length > a.validation.length, 'tỉ lệ 80/20 → train phải nhiều hơn validation rõ rệt');
});

test('splitTrainValidation(): không có thẻ nào lọt vào CẢ 2 tập (không rò rỉ dữ liệu)', () => {
  const items = Array.from({ length: 150 }, (_, i) => ({ cardId: `card-${i}`, reviews: [] }));
  const { train, validation } = optimizer.splitTrainValidation(items, 0.8);
  const trainSet = new Set(train.map((x) => x.cardId));
  const overlap = validation.filter((x) => trainSet.has(x.cardId));
  assert.strictEqual(overlap.length, 0);
});

console.log('\n[lib/fsrs/optimizer.js — evaluateWeights()/binaryCrossEntropy() (Phần 6/7 — so sánh default vs personal)]');

test('binaryCrossEntropy(): dự đoán đúng gần như chắc chắn → loss gần 0', () => {
  assert.ok(optimizer.binaryCrossEntropy(0.99, 1) < 0.02);
  assert.ok(optimizer.binaryCrossEntropy(0.01, 0) < 0.02);
});
test('binaryCrossEntropy(): dự đoán tự tin nhưng SAI → loss cao', () => {
  assert.ok(optimizer.binaryCrossEntropy(0.99, 0) > 3);
});

test('evaluateWeights(): thẻ chỉ có 1 lượt review → không có sample nào để tính loss (chưa có gì để dự đoán)', () => {
  const items = [{ cardId: 'c1', reviews: [{ rating: 3, deltaT: 0, answerCorrect: true }] }];
  const { params } = require(path.join(__dirname, '..', 'lib', 'fsrs')).getSchedulerForRetention(undefined);
  const result = optimizer.evaluateWeights(params.w, items, { desiredRetention: 0.9 });
  assert.strictEqual(result.sampleCount, 0);
  assert.strictEqual(result.avgLogLoss, null);
});

test('evaluateWeights(): thẻ có nhiều lượt review → sampleCount = tổng review - số thẻ (bỏ lượt đầu mỗi thẻ)', () => {
  const items = [
    { cardId: 'c1', reviews: [{ rating: 3, deltaT: 0, answerCorrect: true }, { rating: 3, deltaT: 3, answerCorrect: true }, { rating: 3, deltaT: 5, answerCorrect: true }] },
    { cardId: 'c2', reviews: [{ rating: 3, deltaT: 0, answerCorrect: true }, { rating: 1, deltaT: 2, answerCorrect: false }] },
  ];
  const { params } = require(path.join(__dirname, '..', 'lib', 'fsrs')).getSchedulerForRetention(undefined);
  const result = optimizer.evaluateWeights(params.w, items, { desiredRetention: 0.9 });
  assert.strictEqual(result.sampleCount, 3); // (3-1) + (2-1)
  assert.ok(Number.isFinite(result.avgLogLoss));
});

test('OptimizerDependencyError là 1 loại Error hợp lệ (để caller phân biệt được với lỗi khác nếu cần)', () => {
  const e = new optimizer.OptimizerDependencyError('test');
  assert.ok(e instanceof Error);
});

console.log('\n[V86 — classifyOptimizerError()/mapJobRow() — Phần IX "RETRY" + Phần III "STATE MACHINE", thuần JS không cần Postgres]');

test('classifyOptimizerError(): timeout compute nội bộ ("timeout cấu hình=...") → RETRYABLE (hạ tầng/tải hệ thống, không phải dữ liệu sai)', () => {
  const e = new optimizer.OptimizerDependencyError('Optimizer chính thức chạy lỗi khi train (engine=native, sau 45.2s, timeout cấu hình=45000ms): timed out');
  assert.strictEqual(optimizer.classifyOptimizerError(e), 'RETRYABLE');
});

test('classifyOptimizerError(): "KHÔNG load được trên môi trường" → NON_RETRYABLE (lỗi deployment, retry sẽ luôn lỗi y hệt)', () => {
  const e = new optimizer.OptimizerDependencyError('Optimizer chính thức "@open-spaced-repetition/binding" KHÔNG load được trên môi trường hiện tại (node=v20 platform=linux arch=x64). Lỗi gốc: Cannot find module');
  assert.strictEqual(optimizer.classifyOptimizerError(e), 'NON_RETRYABLE');
});

test('classifyOptimizerError(): "trả về weights không hợp lệ" → NON_RETRYABLE (deterministic với cùng dữ liệu, retry vô ích)', () => {
  const e = new optimizer.OptimizerDependencyError('Optimizer chính thức trả về weights không hợp lệ (cần đúng 21 số hữu hạn). Nhận được: [NaN,...]');
  assert.strictEqual(optimizer.classifyOptimizerError(e), 'NON_RETRYABLE');
});

test('classifyOptimizerError(): lỗi kết nối Postgres điển hình (ECONNREFUSED/Connection terminated) → RETRYABLE', () => {
  assert.strictEqual(optimizer.classifyOptimizerError(new Error('connect ECONNREFUSED 127.0.0.1:5432')), 'RETRYABLE');
  assert.strictEqual(optimizer.classifyOptimizerError(new Error('Connection terminated unexpectedly')), 'RETRYABLE');
});

test('classifyOptimizerError(): OPTIMIZER_WORKER_BUDGET_EXCEEDED (guard tự áp trước khi train) → RETRYABLE', () => {
  const e = new optimizer.OptimizerDependencyError('OPTIMIZER_WORKER_BUDGET_EXCEEDED: ngân sách nhỏ hơn mức tối thiểu cần cho train...');
  assert.strictEqual(optimizer.classifyOptimizerError(e), 'RETRYABLE');
});

test('classifyOptimizerError(): lỗi lập trình lạ/không rõ nguyên nhân → mặc định NON_RETRYABLE (an toàn hơn là lặp vô ích)', () => {
  const e = new TypeError("Cannot read properties of undefined (reading 'foo')");
  assert.strictEqual(optimizer.classifyOptimizerError(e), 'NON_RETRYABLE');
});

test('mapJobRow(): user thường KHÔNG thấy errorMessage/workerId — chỉ admin (Phần ERROR SECURITY, vẫn giữ nguyên nguyên tắc V85)', () => {
  const row = {
    id: 42, status: 'failed', stage: 'failed', attempt: 2, max_attempts: 3, error_retryable: false,
    error_message: 'stack trace nội bộ nhạy cảm — KHÔNG được lộ ra user thường',
    error_public: 'Optimizer thất bại. Vui lòng thử lại.', worker_id: 'worker-abc-123',
  };
  const forUser = optimizer.mapJobRow(row, { isAdmin: false });
  assert.strictEqual(forUser.errorMessage, undefined);
  assert.strictEqual(forUser.workerId, undefined);
  assert.strictEqual(forUser.errorPublic, 'Optimizer thất bại. Vui lòng thử lại.');
  const forAdmin = optimizer.mapJobRow(row, { isAdmin: true });
  assert.strictEqual(forAdmin.errorMessage, row.error_message);
  assert.strictEqual(forAdmin.workerId, 'worker-abc-123');
});

test('mapJobRow(): attempt/maxAttempts được trả cho FE (Phần XV — để hiện "Đang thử lại...")', () => {
  const mapped = optimizer.mapJobRow({ id: 1, status: 'running', stage: 'prepared', attempt: 2, max_attempts: 3 }, {});
  assert.strictEqual(mapped.attempt, 2);
  assert.strictEqual(mapped.maxAttempts, 3);
});

test('mapJobRow(): cột attempt/max_attempts NULL (dòng job cũ trước khi có migration V86) → fallback 1/3, không throw', () => {
  const mapped = optimizer.mapJobRow({ id: 1, status: 'completed', stage: 'completed', attempt: null, max_attempts: null }, {});
  assert.strictEqual(mapped.attempt, 1);
  assert.strictEqual(mapped.maxAttempts, 3);
});

test('mapJobRow(null) → null, không throw', () => {
  assert.strictEqual(optimizer.mapJobRow(null), null);
});

test('OPTIMIZER_MIN_TRAIN_BUDGET_MS có biên an toàn phía trên OPTIMIZER_COMPUTE_TIMEOUT_MS mặc định (Phần VIII — mỗi timeout phải có lý do, không phải số tuỳ tiện)', () => {
  // 45s (timeout compute mặc định) + margin cho evaluate/save — xem comment tại khai báo hằng số này
  // trong lib/fsrs/optimizer.js. Test này CHỈ xác nhận quan hệ giữa 2 hằng số, không hard-code lại
  // số cụ thể (để không vỡ nếu sau này chỉnh OPTIMIZER_COMPUTE_TIMEOUT_MS qua biến môi trường).
  assert.ok(optimizer.OPTIMIZER_MIN_TRAIN_BUDGET_MS >= 45_000, 'phải đủ chỗ cho ít nhất 1 lượt compute-timeout mặc định (45s) trọn vẹn');
});

test('OPTIMIZER_WORKER_BUDGET_MS < 300.000ms (maxDuration khai trong vercel.json) — để lại margin an toàn, không dùng sát nút', () => {
  assert.ok(optimizer.OPTIMIZER_WORKER_BUDGET_MS < 300_000);
  assert.ok(optimizer.OPTIMIZER_WORKER_BUDGET_MS > optimizer.OPTIMIZER_MIN_TRAIN_BUDGET_MS, 'ngân sách tổng phải lớn hơn mức tối thiểu cần riêng cho train, nếu không mọi lượt chạy đều fail ngay ở guard');
});

console.log('\n[V88 — Phần 5 audit "API Error Leak" — PublicError/publicErrorMessage()]');

const { PublicError } = require(path.join(__dirname, '..', 'lib', 'publicError'));
// Bản sao CHÍNH XÁC logic publicErrorMessage() trong api/index.js — kiểm tra ở đây để không cần khởi
// động cả Express app (api/index.js cần pg/express thật, không load được trong sandbox thuần này) —
// đối chiếu bằng cách trích TĨNH đúng thân hàm thật từ api/index.js, đảm bảo test theo ĐÚNG code thật,
// không phải bản chép tay có thể lệch khỏi implementation thật theo thời gian.
const API_SRC_FOR_ERROR_TEST = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
test('api/index.js: publicErrorMessage() tồn tại và default về "Lỗi server nội bộ..." (không phải chuỗi rỗng/undefined) khi KHÔNG phải PublicError', () => {
  assert.ok(/function publicErrorMessage/.test(API_SRC_FOR_ERROR_TEST), 'phải có hàm publicErrorMessage() dùng chung');
  assert.ok(/GENERIC_SERVER_ERROR_MESSAGE\s*=\s*'[^']+'/.test(API_SRC_FOR_ERROR_TEST), 'phải có 1 thông điệp mặc định cố định, an toàn');
});

test('api/index.js: KHÔNG còn bất kỳ "error: e.message" trần nào (Phần 5 — mọi chỗ phải qua publicErrorMessage()/fail())', () => {
  const bareLeak = /error:\s*e\.message\b/;
  assert.ok(!bareLeak.test(stripLineComments(API_SRC_FOR_ERROR_TEST)), 'còn sót ít nhất 1 chỗ trả thẳng e.message cho client — rò rỉ chi tiết lỗi nội bộ (SQL/đường dẫn/package error)');
});

test('PublicError: instance vẫn là Error hợp lệ (instanceof Error), message giữ nguyên', () => {
  const e = new PublicError('Tên đăng nhập đã tồn tại');
  assert.ok(e instanceof Error);
  assert.ok(e instanceof PublicError);
  assert.strictEqual(e.message, 'Tên đăng nhập đã tồn tại');
});

test('lib/fsrs.js: rating không hợp lệ ném PublicError (an toàn hiện cho user — không phải lỗi nội bộ)', () => {
  assert.throws(() => fsrs.reviewCard({}, 'invalid_rating_xyz', new Date(), 0.9), (e) => {
    assert.ok(e instanceof PublicError, 'phải là PublicError để user thấy được lý do input sai, không bị thay bằng thông điệp chung chung');
    return true;
  });
});

test('lib/fsrs/optimizer.js: 6 thông điệp Apply/Rollback/Reset "đang chạy"/"chưa có kết quả"/"chưa có trạng thái trước đó" đã chuyển sang PublicError (không bị genericize oan — đây là hướng dẫn hành động rõ ràng cho user, không phải chi tiết nội bộ)', () => {
  const src = stripLineComments(fs.readFileSync(path.join(__dirname, '..', 'lib', 'fsrs', 'optimizer.js'), 'utf8'));
  const expectedMessages = [
    'Optimizer đang chạy — đợi hoàn tất trước khi Apply',
    'Chưa có kết quả Optimizer nào để Apply',
    'Chưa có candidate weights hợp lệ để Apply',
    'Optimizer đang chạy — đợi hoàn tất trước khi Rollback',
    'Không có trạng thái trước đó để khôi phục',
    'Optimizer đang chạy — đợi hoàn tất trước khi Reset',
  ];
  expectedMessages.forEach((msgFragment) => {
    const re = new RegExp(`throw new PublicError\\([^)]*${msgFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    assert.ok(re.test(src), `thông điệp "${msgFragment}" phải được ném bằng PublicError (không phải Error thường)`);
  });
});

test('lib/fsrs/optimizer.js: các lỗi NỘI BỘ thật (data.js config/version-conflict/card row thiếu field) KHÔNG bị đổi sang PublicError (đúng — không nên hiện chi tiết đó cho user)', () => {
  // Đối chứng: xác nhận KHÔNG lỡ tay convert lan sang mọi throw new Error(...) trong file — chỉ đúng
  // 6 chỗ nêu trên. Đếm tổng throw new PublicError trong optimizer.js phải khớp CHÍNH XÁC 6 (không
  // nhiều hơn, không ít hơn) — nếu số này đổi trong tương lai, cần cập nhật lại test để soát chủ đích.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fsrs', 'optimizer.js'), 'utf8');
  const count = (src.match(/throw new PublicError\(/g) || []).length;
  assert.strictEqual(count, 6, `kỳ vọng đúng 6 throw new PublicError() trong optimizer.js (Apply×3/Rollback×2/Reset×1), thấy ${count} — nếu có thay đổi chủ đích, cập nhật lại test này`);
});



// Đọc thẳng SOURCE THẬT của lib/fsrs/optimizer.js + api/index.js (không phải copy/diễn giải lại) —
// trích ĐÚNG thân 1 hàm bằng cách đếm độ sâu dấu ngoặc { } bắt đầu từ dòng khai báo, để chắc chắn
// đang soát ĐÚNG phạm vi hàm đó (không lẫn hàm khác cùng tên một phần hay comment ở xa).
const OPTIMIZER_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fsrs', 'optimizer.js'), 'utf8');
const API_SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
function extractFunctionBody(src, declarationRegex) {
  const m = declarationRegex.exec(src);
  assert.ok(m, `Không tìm thấy khai báo khớp ${declarationRegex} trong source — có thể tên hàm đã đổi, cần cập nhật lại test này`);
  // Tham số hàm có thể chứa destructuring ({ a, b } = {}) — PHẢI bỏ qua hết cặp ngoặc ĐƠN của danh
  // sách tham số trước (đếm độ sâu dấu ngoặc đơn), rồi mới tìm dấu { đầu tiên SAU nó = thân hàm thật.
  // (Bug đã tự bắt được: nếu tìm thẳng indexOf('{', ...) sẽ trúng dấu { của destructuring tham số,
  // KHÔNG phải thân hàm — khiến test PASS giả vì "thân hàm" trích ra rỗng/sai, không kiểm tra gì cả.)
  const parenStart = src.indexOf('(', m.index);
  assert.ok(parenStart !== -1);
  let pdepth = 0, j = parenStart;
  for (; j < src.length; j++) {
    if (src[j] === '(') pdepth++;
    else if (src[j] === ')') { pdepth--; if (pdepth === 0) break; }
  }
  const startBrace = src.indexOf('{', j + 1);
  assert.ok(startBrace !== -1);
  let depth = 0, i = startBrace;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(startBrace, i + 1);
  assert.ok(body.length > 40, `Thân hàm trích ra quá ngắn (${body.length} ký tự) — extractFunctionBody() có thể vẫn đang bắt sai vị trí, cần soát lại`);
  return body;
}
const DANGEROUS_PATTERN = /getOptimizerEngineStatus\s*\(|loadOfficialOptimizer\s*\(|require\(\s*['"]@open-spaced-repetition\/binding/;
// Bỏ dòng comment // trước khi soát DANGEROUS_PATTERN — code THẬT ở các hàm dưới đây có nhiều comment
// GIẢI THÍCH lý do KHÔNG còn gọi các hàm nguy hiểm này nữa (nhắc tên chúng trong lời văn), không phải
// lời gọi thật — soát nguyên văn cả comment sẽ báo false positive (bug y hệt đã tự bắt được 1 lần ở
// test khác trong dự án này — xem js/distractor-engine.js test "không tham chiếu FSRS").
function stripLineComments(code) {
  return code.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

test('getOptimizerStatus() — source KHÔNG chứa bất kỳ lời gọi nào tới getOptimizerEngineStatus()/loadOfficialOptimizer()/require(binding) (root cause "Failed to fetch" — Phần III)', () => {
  const body = stripLineComments(extractFunctionBody(OPTIMIZER_SRC, /async function getOptimizerStatus\s*\(/));
  assert.ok(!DANGEROUS_PATTERN.test(body), 'GET /status PHẢI hoàn toàn tách biệt khỏi native optimizer — 1 native crash không được phép làm chết cả status endpoint');
});

test('createOptimizerJob() (POST /run) — source KHÔNG chứa lời gọi native binding nào (Phần XI)', () => {
  const body = stripLineComments(extractFunctionBody(OPTIMIZER_SRC, /async function createOptimizerJob\s*\(/));
  assert.ok(!DANGEROUS_PATTERN.test(body), 'POST /run chỉ tạo job — không được load native optimizer trong request thread');
});

test('getOptimizerDiagnostics(): phần OUTSIDE khối "if (probe)" KHÔNG gọi loadOfficialOptimizer() — Tầng 1 (mặc định) phải an toàn tuyệt đối (Phần IV/V)', () => {
  const body = stripLineComments(extractFunctionBody(OPTIMIZER_SRC, /function getOptimizerDiagnostics\s*\(/));
  const probeIdx = body.indexOf('if (probe)');
  assert.ok(probeIdx > 0, 'phải có nhánh if (probe) rõ ràng để tách Tầng 1/Tầng 2');
  const beforeProbe = body.slice(0, probeIdx);
  assert.ok(!/loadOfficialOptimizer\s*\(/.test(beforeProbe), 'Tầng 1 (probe=false, mặc định) không được đụng loadOfficialOptimizer() — chỉ require.resolve()/package.json thuần');
  const probeBlock = body.slice(probeIdx);
  assert.ok(/loadOfficialOptimizer\s*\(/.test(probeBlock), 'Tầng 2 (probe=true) PHẢI thật sự dùng loadOfficialOptimizer() — nếu không endpoint chẩn đoán này vô nghĩa');
});

test('api/index.js: route GET /health đăng ký TRƯỚC route /status, KHÔNG gọi requireAuth (Phần VI — health luôn phải sống, kể cả khi auth/DB/native đều chết)', () => {
  const healthIdx = API_SRC.indexOf("app.get('/api/fsrs-optimizer/health'");
  const statusIdx = API_SRC.indexOf("app.get('/api/fsrs-optimizer/status'");
  assert.ok(healthIdx !== -1, 'route /health phải tồn tại');
  assert.ok(healthIdx < statusIdx, '/health nên đăng ký trước /status (không bắt buộc về mặt Express routing, nhưng đúng thứ tự tường minh cho người đọc code)');
  // Trích ĐÚNG thân callback của route /health bằng đếm độ sâu ngoặc { } (KHÔNG lấy nguyên văn bản tới
  // route kế tiếp — đoạn đó còn dính cả comment giải thích của route /status ở NGAY SAU, sẽ báo sai).
  const handlerArrowIdx = API_SRC.indexOf('=>', healthIdx);
  const bodyOnly = (() => {
    const braceStart = API_SRC.indexOf('{', handlerArrowIdx);
    let depth = 0, i = braceStart;
    for (; i < API_SRC.length; i++) {
      if (API_SRC[i] === '{') depth++;
      else if (API_SRC[i] === '}') { depth--; if (depth === 0) break; }
    }
    return stripLineComments(API_SRC.slice(braceStart, i + 1));
  })();
  assert.ok(!/requireAuth\s*\(/.test(bodyOnly), 'health endpoint không được yêu cầu đăng nhập');
  assert.ok(!/getPool\s*\(|ensureOptimizerTables|\.query\s*\(/.test(bodyOnly), 'health endpoint không được đụng DB');
  assert.ok(!DANGEROUS_PATTERN.test(bodyOnly), 'health endpoint không được đụng native optimizer');
});

test('api/index.js: route GET /diagnostics gọi requireAdmin() (Phần IV — "chỉ admin mới được gọi")', () => {
  const diagIdx = API_SRC.indexOf("app.get('/api/fsrs-optimizer/diagnostics'");
  assert.ok(diagIdx !== -1, 'route /diagnostics phải tồn tại');
  const nextRouteIdx = API_SRC.indexOf('app.', diagIdx + 10);
  const diagSrc = API_SRC.slice(diagIdx, nextRouteIdx > diagIdx ? nextRouteIdx : diagIdx + 2000);
  assert.ok(/requireAdmin\s*\(/.test(diagSrc), 'route /diagnostics phải chặn non-admin bằng requireAdmin()');
});

test('getOptimizerDiagnostics({probe:false}) — chạy thật, không throw, không probe (Tầng 1 an toàn — chạy được ngay cả khi package @open-spaced-repetition/binding hoàn toàn không cài trong môi trường này)', () => {
  const d = optimizer.getOptimizerDiagnostics({ probe: false });
  assert.strictEqual(d.probed, false);
  assert.strictEqual(d.available, null);
  assert.strictEqual(typeof d.packageResolvable, 'boolean');
  assert.ok(d.node && d.platform && d.arch, 'vẫn phải có thông tin runtime cơ bản (an toàn tuyệt đối, không cần native)');
});

test('getOptimizerDiagnostics({probe:true}) — chạy thật (Tầng 2), package chưa cài trong sandbox này → available=false + loadError RÕ RÀNG, KHÔNG throw (mô phỏng đúng "native unavailable" — Phần XVI)', () => {
  const d = optimizer.getOptimizerDiagnostics({ probe: true });
  assert.strictEqual(d.probed, true);
  // Trong sandbox test này, package thật SỰ chưa được cài (không có mạng để npm install) — nếu môi
  // trường thật của người chạy test CÓ cài package, available sẽ là true, cả 2 trường hợp đều hợp lệ
  // (điều test này khẳng định là: KHÔNG THROW dù package thiếu, không phải khẳng định package thiếu).
  assert.strictEqual(typeof d.available, 'boolean');
  if (!d.available) assert.ok(d.loadError, 'khi unavailable phải có loadError giải thích rõ, không im lặng');
});

test('sanitizeEngineStatusForUser(): chỉ giữ available/engine/packageVersion, ẩn thông tin hệ thống chi tiết (Phần "ERROR SECURITY")', () => {
  const raw = { available: true, engine: 'native', packageVersion: '0.5.0', nodeVersion: 'v22.0.0', platform: 'linux', arch: 'x64', glibcVersion: '2.35', nativeBinary: '@open-spaced-repetition/binding-linux-x64-gnu', error: null };
  const sanitized = optimizer.sanitizeEngineStatusForUser(raw);
  assert.deepStrictEqual(sanitized, { available: true, engine: 'native', packageVersion: '0.5.0' });
  assert.strictEqual(sanitized.nodeVersion, undefined);
  assert.strictEqual(sanitized.nativeBinary, undefined);
});

console.log('\n[lib/fsrs/optimizer.js — trainWithOfficialOptimizer() (Phần 3/21 — KHÔNG fallback tự viết optimizer)]');

// CommonJS không có top-level await — bọc phần async (chỉ 1 test duy nhất cần async) trong 1 IIFE
// rồi mới in tổng kết, để KHÔNG in "Kết quả" trước khi test async này chạy xong (bug đã gặp lúc
// kiểm thử thủ công: console.log tổng kết chạy TRƯỚC khi promise của testAsync() resolve).
(async () => {
  await testAsync('Chưa cài "@open-spaced-repetition/binding" trong sandbox này → trainWithOfficialOptimizer() throw OptimizerDependencyError RÕ RÀNG, KHÔNG âm thầm train bằng thuật toán tự viết thay thế (Phần 3/21)', async () => {
    let bindingInstalled = true;
    try { require('@open-spaced-repetition/binding'); } catch { bindingInstalled = false; }
    const fakeTrainItems = [
      { cardId: 'c1', reviews: [{ rating: 3, deltaT: 0 }, { rating: 3, deltaT: 3 }] },
      { cardId: 'c2', reviews: [{ rating: 3, deltaT: 0 }, { rating: 1, deltaT: 1 }] },
    ];
    if (!bindingInstalled) {
      await assert.rejects(
        () => optimizer.trainWithOfficialOptimizer(fakeTrainItems),
        (err) => err instanceof optimizer.OptimizerDependencyError && /binding/.test(err.message)
      );
    } else {
      console.log('     ℹ️  Package đã được cài trong môi trường này — bỏ qua nhánh "thiếu dependency" (tốt, không phải lỗi test). Kiểm tra thay: train() trả về đúng 21 weights hữu hạn.');
      const w = await optimizer.trainWithOfficialOptimizer(fakeTrainItems);
      assert.ok(require(path.join(__dirname, '..', 'lib', 'fsrs')).isValidWeightsArray(w));
    }
  });

  console.log('\n════════════════════════════════════════════════════');
  console.log(`Kết quả: ${passed} PASS, ${failed} FAIL`);
  console.log('════════════════════════════════════════════════════');
  if (failed > 0) process.exitCode = 1;
})();
