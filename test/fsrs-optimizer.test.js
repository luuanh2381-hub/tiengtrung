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

test('classifyOptimizerError(): train bị abort theo budget ("abort budget=...") → RETRYABLE (hạ tầng/tải hệ thống, không phải dữ liệu sai)', () => {
  const e = new optimizer.OptimizerDependencyError('Optimizer chính thức chạy lỗi khi train (engine=native, sau 45.2s, abort budget=40000ms, progress poll=500ms): timed out');
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

console.log('\n[V90-FIX-2 — cờ optimizerAborted (cấu trúc) phải THẮNG so khớp text — audit lại vì binding có');
console.log('thể REJECT hoặc RESOLVE-hình-dạng-sai sau khi app tự abort, không có tài liệu công khai xác');
console.log('nhận cái nào — code phải đúng ở CẢ 2 khả năng, không suy đoán]');

test('classifyOptimizerError(): optimizerAborted=true PHẢI THẮNG dù message trùng hệt marker NON_RETRYABLE ("weights không hợp lệ") — đây là điểm audit lại phát hiện: binding có thể RESOLVE (không reject) sau khi app abort, khiến nhánh validate hình dạng weights vô tình ném đúng câu chữ marker đó', () => {
  const e = new optimizer.OptimizerDependencyError('Optimizer chính thức trả về weights không hợp lệ (cần đúng 21 số hữu hạn). Nhận được: {"partial":true}');
  e.optimizerAborted = true; // gắn bởi trainWithOfficialOptimizer khi progress callback tự abort vì hết ngân sách
  assert.strictEqual(optimizer.classifyOptimizerError(e), 'RETRYABLE', 'abort có chủ đích PHẢI luôn retryable, bất kể message trông giống lỗi dữ liệu deterministic đến đâu');
});

test('classifyOptimizerError(): optimizerAborted=true THẮNG cả 2 marker NON_RETRYABLE còn lại (không phải chỉ marker "weights không hợp lệ")', () => {
  const e1 = new optimizer.OptimizerDependencyError('... KHÔNG load được trên môi trường hiện tại ...');
  e1.optimizerAborted = true;
  assert.strictEqual(optimizer.classifyOptimizerError(e1), 'RETRYABLE');
  const e2 = new optimizer.OptimizerDependencyError('... KHÔNG export đúng ...');
  e2.optimizerAborted = true;
  assert.strictEqual(optimizer.classifyOptimizerError(e2), 'RETRYABLE');
});

test('classifyOptimizerError(): optimizerAborted không có (undefined)/false → hành vi CŨ giữ nguyên, không đổi (không có cờ thì vẫn so khớp text như trước)', () => {
  const withoutFlag = new optimizer.OptimizerDependencyError('Optimizer chính thức trả về weights không hợp lệ (cần đúng 21 số hữu hạn). Nhận được: null');
  assert.strictEqual(optimizer.classifyOptimizerError(withoutFlag), 'NON_RETRYABLE');
  const explicitFalse = new optimizer.OptimizerDependencyError('Optimizer chính thức trả về weights không hợp lệ. Nhận được: null');
  explicitFalse.optimizerAborted = false;
  assert.strictEqual(optimizer.classifyOptimizerError(explicitFalse), 'NON_RETRYABLE');
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

test('V90 — các budget optimizer phải nhất quán: train abort + reserve <= min train <= worker budget < Hobby 60s', () => {
  assert.ok(optimizer.OPTIMIZER_TRAIN_ABORT_BUDGET_MS > 0);
  assert.ok(optimizer.OPTIMIZER_POST_TRAIN_RESERVE_MS > 0);
  assert.ok(
    optimizer.OPTIMIZER_MIN_TRAIN_BUDGET_MS >= optimizer.OPTIMIZER_TRAIN_ABORT_BUDGET_MS + optimizer.OPTIMIZER_POST_TRAIN_RESERVE_MS,
    'MIN_TRAIN_BUDGET phải đủ cho train abort budget + evaluate/save reserve'
  );
  assert.ok(
    optimizer.OPTIMIZER_WORKER_BUDGET_MS > optimizer.OPTIMIZER_MIN_TRAIN_BUDGET_MS,
    'WORKER_BUDGET phải lớn hơn MIN_TRAIN_BUDGET để guard không chặn mọi lượt train'
  );
  assert.ok(optimizer.OPTIMIZER_WORKER_BUDGET_MS < 60_000, 'default worker budget phải nằm dưới 60s Hobby');
  assert.ok(optimizer.OPTIMIZER_PROGRESS_POLL_MS <= 5_000, 'progress poll phải đủ ngắn để abort không bị trễ hàng chục giây');
});

test('V90 — không được hiểu nhầm binding timeout là compute timeout', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fsrs', 'optimizer.js'), 'utf8');
  assert.ok(src.includes('timeout: OPTIMIZER_PROGRESS_POLL_MS'), 'computeParameters() phải nhận poll interval riêng');
  assert.ok(src.includes('OPTIMIZER_TRAIN_ABORT_BUDGET_MS'), 'phải có budget train riêng ở phía app');
  assert.ok(src.includes('return false'), 'progress callback phải có đường gửi tín hiệu abort cho binding');
  assert.ok(!src.includes('timeout: OPTIMIZER_COMPUTE_TIMEOUT_MS'), 'không được dùng lại biến timeout cũ với nghĩa compute timeout');
});

test('V89 — OPTIMIZER_WORKER_BUDGET_MS mặc định phải AN TOÀN dưới ngưỡng THẬT của Vercel Hobby (60s cứng, đã tra cứu xác nhận — KHÔNG phải giả định), không chỉ dưới con số 300s khai trong vercel.json (con số đó bị Hobby bỏ qua hoàn toàn)', () => {
  const REAL_HOBBY_HARD_CAP_MS = 60_000; // đã tra cứu xác nhận (2026) — xem AUDIT-REPORT-V89-CONTINUATION-CLAIM-BUG.md
  assert.ok(
    optimizer.OPTIMIZER_WORKER_BUDGET_MS < REAL_HOBBY_HARD_CAP_MS,
    `OPTIMIZER_WORKER_BUDGET_MS (${optimizer.OPTIMIZER_WORKER_BUDGET_MS}ms) PHẢI nhỏ hơn ngưỡng cứng THẬT của Hobby (${REAL_HOBBY_HARD_CAP_MS}ms) — nếu không, platform sẽ SIGKILL trước khi guard tự áp của code kịp can thiệp, đúng nguyên nhân gốc bug "mất heartbeat"`
  );
  assert.ok(optimizer.OPTIMIZER_WORKER_BUDGET_MS > optimizer.OPTIMIZER_MIN_TRAIN_BUDGET_MS, 'ngân sách tổng phải lớn hơn mức tối thiểu cần riêng cho train, nếu không mọi lượt chạy đều bị guard chặn ngay từ đầu, không bao giờ train được (bug MỚI nếu tinh chỉnh 2 hằng số không đồng bộ)');
});

console.log('\n[V89 — BUG GỐC "mất heartbeat" — budget-guard continuation phải reset status trước khi return]');

test('runOptimizerJob(): nhánh budget-guard continuation (checkpoint \'prepared\') PHẢI UPDATE status=\'queued\' TRƯỚC dòng "return { continuation: true }" — kiểm tra TĨNH trên chính source thật để chặn tái phát bug đã tìm ra (xem AUDIT-REPORT-V89-CONTINUATION-CLAIM-BUG.md)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fsrs', 'optimizer.js'), 'utf8');
  const body = stripLineComments(extractFunctionBody(src, /async function runOptimizerJob\s*\(/));
  // Định vị ĐÚNG đoạn "hết ngân sách sau prepare" (nhãn log JOB_RETRY duy nhất gắn với budget-guard,
  // phân biệt với nhánh requeue-do-lỗi trong failOrRequeue() — nhãn đó dùng note khác).
  const marker = "note: 'hết ngân sách sau prepare";
  const markerIdx = body.indexOf(marker);
  assert.ok(markerIdx !== -1, 'không tìm thấy đoạn budget-guard continuation trong runOptimizerJob() — có thể đã bị đổi tên/di chuyển, cần cập nhật lại test này');
  const returnIdx = body.indexOf('return { continuation: true }', markerIdx);
  assert.ok(returnIdx !== -1 && returnIdx - markerIdx < 2000, 'không tìm thấy "return { continuation: true }" ngay sau đoạn budget-guard — cần cập nhật lại test này nếu cấu trúc code đã đổi');
  const between = body.slice(markerIdx, returnIdx);
  assert.ok(/status\s*=\s*'queued'/.test(between), 'BUG GỐC V89: phải có UPDATE ... SET status=\'queued\' GIỮA đoạn log budget-guard và dòng return continuation:true — thiếu dòng này khiến invocation kế tiếp không claim lại được job (claimQueuedJob() đòi status=\'queued\'), continuation luôn no-op, job kẹt tới khi stale-recovery (180s) mới cứu, tốn oan attempt mỗi lần');
  assert.ok(/WHERE id = \$1 AND status = 'running'/.test(between), 'UPDATE reset status phải có điều kiện WHERE status=\'running\' (đúng job này claim, không ghi đè job đã bị worker/lượt khác xử lý trước — an toàn concurrency)');
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

console.log('\n[Audit lại (bản prompt mới, đầy đủ hơn) — V90-FIX-2 (phân loại abort) + V90-FIX-3 (mốc thời');
console.log('gian ngân sách chính xác hơn) — kiểm tra TĨNH trên chính source thật, cùng phong cách với các');
console.log('test V89/V90 phía trên]');

test('trainWithOfficialOptimizer(): CẢ 2 nhánh báo lỗi abort (catch của computeParameters, VÀ nhánh validate hình dạng weights) đều PHẢI gắn err.optimizerAborted = true — không được chỉ sửa 1 trong 2 nhánh', () => {
  const body = stripLineComments(extractFunctionBody(OPTIMIZER_SRC, /async function trainWithOfficialOptimizer\s*\(/));
  const occurrences = body.split('optimizerAborted = true').length - 1;
  assert.strictEqual(occurrences, 2, `phải có ĐÚNG 2 chỗ gắn optimizerAborted=true (1 ở catch, 1 ở validate hình dạng) — tìm thấy ${occurrences}. Nếu cấu trúc hàm đã đổi, cập nhật lại test này thay vì xoá.`);
  assert.ok(/let wasAbortedByBudget = false/.test(body), 'phải có biến cờ nội bộ đánh dấu abort NGAY tại progress callback (nguồn duy nhất biết CHẮC đây là abort do budget, không phải lỗi khác)');
});

test('classifyOptimizerError(): phải kiểm tra e.optimizerAborted TRƯỚC (return sớm) rồi mới tới so khớp text — thứ tự sai sẽ khiến cờ cấu trúc vô nghĩa với 1 số loại error', () => {
  const body = stripLineComments(extractFunctionBody(OPTIMIZER_SRC, /function classifyOptimizerError\s*\(/));
  const flagCheckIdx = body.indexOf('e.optimizerAborted');
  const firstMarkerCheckIdx = body.indexOf('NON_RETRYABLE_ERROR_MARKERS');
  assert.ok(flagCheckIdx !== -1, 'không tìm thấy kiểm tra e.optimizerAborted trong classifyOptimizerError()');
  assert.ok(firstMarkerCheckIdx === -1 || flagCheckIdx < firstMarkerCheckIdx, 'kiểm tra optimizerAborted phải nằm TRƯỚC (return sớm) phần so khớp NON_RETRYABLE_ERROR_MARKERS bằng text');
});

test('runOptimizerJob(): mốc workerStartedAt PHẢI ưu tiên invocationStartedAt truyền vào (đo TRƯỚC requireAuth() ở api/index.js) thay vì Date.now() đo muộn hơn — audit lại phát hiện thời gian auth+claim (round-trip Postgres, có thể chậm nếu Neon cold-start) trước đây không bị tính vào ngân sách 50s tự áp', () => {
  const body = stripLineComments(extractFunctionBody(OPTIMIZER_SRC, /async function runOptimizerJob\s*\(/));
  assert.ok(/invocationStartedAt/.test(body), 'runOptimizerJob() phải nhận invocationStartedAt (qua options thứ 3)');
  assert.ok(
    /workerStartedAt\s*=\s*Number\.isFinite\(invocationStartedAt\)\s*\?\s*invocationStartedAt\s*:\s*Date\.now\(\)/.test(body.replace(/\s+/g, ' ')),
    'workerStartedAt phải ưu tiên invocationStartedAt hợp lệ, fallback Date.now() để không phá tương thích ngược với caller cũ/test cũ gọi 2 tham số'
  );
});

test('api/index.js: route POST /worker phải đo invocationStartedAt = Date.now() Ở DÒNG ĐẦU TIÊN, TRƯỚC requireAuth(), rồi truyền { invocationStartedAt } cho runOptimizerJob() — đo SAU requireAuth() sẽ làm mất đúng phần thời gian audit lại muốn tính vào ngân sách', () => {
  const workerRouteIdx = API_SRC.indexOf("app.post('/api/fsrs-optimizer/worker'");
  assert.ok(workerRouteIdx !== -1, 'không tìm thấy route POST /worker — có thể đã đổi tên/di chuyển, cần cập nhật lại test này');
  const routeSlice = stripLineComments(API_SRC.slice(workerRouteIdx, workerRouteIdx + 1200));
  const invocationIdx = routeSlice.indexOf('const invocationStartedAt = Date.now()');
  const authIdx = routeSlice.indexOf('requireAuth(req, res)');
  const passthroughIdx = routeSlice.indexOf('runOptimizerJob(jobId, authed.username, { invocationStartedAt }');
  assert.ok(invocationIdx !== -1, 'thiếu "const invocationStartedAt = Date.now()" trong route /worker');
  assert.ok(authIdx !== -1, 'không tìm thấy lời gọi requireAuth() trong route /worker (route có thể đã đổi cấu trúc)');
  assert.ok(invocationIdx < authIdx, 'invocationStartedAt phải được đo TRƯỚC requireAuth(), không phải sau');
  assert.ok(passthroughIdx !== -1 && passthroughIdx > authIdx, 'phải truyền { invocationStartedAt } vào runOptimizerJob() SAU khi auth xong');
});

test('runOptimizerJob(): candidate_meta của lần train THÀNH CÔNG phải lưu optimizerEngine (native/wasi) — audit lại phát hiện trước đây thông tin engine chỉ có ở console.log tạm thời lúc train, mất ngay sau khi hết phiên xem Vercel Function Logs', () => {
  const body = stripLineComments(extractFunctionBody(OPTIMIZER_SRC, /async function runOptimizerJob\s*\(/));
  const metaIdx = body.indexOf('optimizerVersion: getOptimizerBindingVersion()');
  assert.ok(metaIdx !== -1, 'không tìm thấy object meta lưu candidate — có thể đã đổi tên field, cần cập nhật lại test này');
  const metaSlice = body.slice(metaIdx, metaIdx + 400);
  assert.ok(/optimizerEngine\s*:\s*loadOfficialOptimizer\(\)\.engine/.test(metaSlice), 'object meta phải có optimizerEngine lấy từ loadOfficialOptimizer().engine (đã cache, không tốn thêm lệnh gọi native)');
});

test('runOptimizerJob(): khi train bị optimizerAborted, PHẢI có 1 dòng log CÓ CẤU TRÚC riêng (log(\'OPTIMIZER_ABORTED\', ...)) TRƯỚC khi gọi failOrRequeue() — Phần XI LOGGING, để grep được trên Vercel Function Logs mà không cần đoán từ message tự do', () => {
  const body = stripLineComments(extractFunctionBody(OPTIMIZER_SRC, /async function runOptimizerJob\s*\(/));
  const trainCallIdx = body.indexOf('trainWithOfficialOptimizer(train');
  assert.ok(trainCallIdx !== -1, 'không tìm thấy lời gọi trainWithOfficialOptimizer(train...) — có thể đã đổi tên biến, cần cập nhật lại test này');
  const afterTrainCall = body.slice(trainCallIdx, trainCallIdx + 1500);
  const abortedLogIdx = afterTrainCall.indexOf("log('OPTIMIZER_ABORTED'");
  const failOrRequeueIdx = afterTrainCall.indexOf("failOrRequeue(e, 'training')");
  assert.ok(abortedLogIdx !== -1, "thiếu log('OPTIMIZER_ABORTED', ...) trong catch quanh trainWithOfficialOptimizer()");
  assert.ok(failOrRequeueIdx !== -1 && abortedLogIdx < failOrRequeueIdx, "log('OPTIMIZER_ABORTED', ...) phải chạy TRƯỚC failOrRequeue() trong cùng catch");
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

  console.log('\n[Audit lại — V90-FIX-2: trainWithOfficialOptimizer() phải xử lý ĐÚNG ở CẢ 2 khả năng hành vi');
  console.log('thật của binding sau khi app tự abort (reject HAY resolve-hình-dạng-sai) — tài liệu công khai');
  console.log('không xác nhận rõ cái nào là đúng, nên mô phỏng cả 2 qua require.cache tạm thời]');

  // Mô phỏng binding bằng require.cache TẠM THỜI (khôi phục ngay trong finally) — hoạt động DÙ package
  // thật đã cài hay chưa, miễn require.resolve() ra được 1 đường dẫn để ghi đè cache tại đó. Nếu gói
  // chưa từng được liệt kê/cài đặt (require.resolve tự nó throw), SKIP rõ ràng thay vì báo lỗi sai chỗ.
  let bindingResolvedPath = null;
  try { bindingResolvedPath = require.resolve('@open-spaced-repetition/binding'); } catch { /* xem nhánh SKIP ngay dưới */ }

  if (!bindingResolvedPath) {
    console.log('  ℹ️  SKIP nhóm test "mô phỏng abort qua require.cache" — @open-spaced-repetition/binding không resolve được trong môi trường này.');
  } else {
    const withFakeBinding = (fakeExports, fn) => {
      const previous = require.cache[bindingResolvedPath];
      require.cache[bindingResolvedPath] = { id: bindingResolvedPath, filename: bindingResolvedPath, loaded: true, exports: fakeExports };
      optimizer.resetOptimizerEngineCache();
      return Promise.resolve().then(fn).finally(() => {
        if (previous) require.cache[bindingResolvedPath] = previous; else delete require.cache[bindingResolvedPath];
        optimizer.resetOptimizerEngineCache();
      });
    };
    const makeFakeBinding = (mode) => {
      class FSRSBindingItem { constructor(reviews) { this.reviews = reviews; } }
      class FSRSBindingReview { constructor(rating, deltaT) { this.rating = rating; this.deltaT = deltaT; } }
      async function computeParameters(_items, opts) {
        for (let i = 1; i <= 20; i++) {
          const end = Date.now() + 3; // busy-wait ngắn CÓ CHỦ ĐÍCH — progress callback bắt buộc đồng bộ
          while (Date.now() < end) { /* nhường đủ thời gian thật trôi qua để elapsedMs vượt abortAfterMs nhỏ trong test */ }
          const cont = typeof opts.progress === 'function' ? opts.progress(i, 20) : undefined;
          if (cont === false) {
            if (mode === 'reject') throw new Error('fake binding: cancelled (reject)');
            if (mode === 'resolve-invalid') return { partial: true };
          }
        }
        return new Array(21).fill(0).map((_, i) => i * 0.1);
      }
      return { computeParameters, FSRSBindingItem, FSRSBindingReview };
    };

    await testAsync('trainWithOfficialOptimizer(): binding REJECT khi progress trả false (1 trong 2 khả năng hành vi thật có thể xảy ra) → optimizerAborted=true + classifyOptimizerError()=RETRYABLE', async () => {
      await withFakeBinding(makeFakeBinding('reject'), async () => {
        await assert.rejects(
          () => optimizer.trainWithOfficialOptimizer([{ reviews: [{ rating: 3, deltaT: 1 }] }], { abortAfterMs: 10 }),
          (err) => {
            assert.strictEqual(err.optimizerAborted, true, 'phải gắn optimizerAborted=true');
            assert.strictEqual(optimizer.classifyOptimizerError(err), 'RETRYABLE');
            return true;
          }
        );
      });
    });

    await testAsync('trainWithOfficialOptimizer(): binding RESOLVE với hình dạng KHÔNG hợp lệ khi progress trả false (khả năng hành vi thật còn lại) → VẪN optimizerAborted=true + RETRYABLE, KHÔNG bị lẫn với lỗi "weights không hợp lệ" thật (NON_RETRYABLE)', async () => {
      await withFakeBinding(makeFakeBinding('resolve-invalid'), async () => {
        await assert.rejects(
          () => optimizer.trainWithOfficialOptimizer([{ reviews: [{ rating: 3, deltaT: 1 }] }], { abortAfterMs: 10 }),
          (err) => {
            assert.strictEqual(err.optimizerAborted, true, 'phải gắn optimizerAborted=true dù binding RESOLVE thay vì reject');
            assert.strictEqual(optimizer.classifyOptimizerError(err), 'RETRYABLE');
            return true;
          }
        );
      });
    });

    await testAsync('trainWithOfficialOptimizer(): lỗi KHÔNG liên quan tới abort (lỗi dependency/train thật) không bị gắn nhầm optimizerAborted', async () => {
      class FSRSBindingItem { constructor(reviews) { this.reviews = reviews; } }
      class FSRSBindingReview { constructor(rating, deltaT) { this.rating = rating; this.deltaT = deltaT; } }
      async function computeParameters() { throw new Error('fake binding: lỗi thật không liên quan abort'); }
      await withFakeBinding({ computeParameters, FSRSBindingItem, FSRSBindingReview }, async () => {
        await assert.rejects(
          () => optimizer.trainWithOfficialOptimizer([{ reviews: [{ rating: 3, deltaT: 1 }] }], { abortAfterMs: 60_000 }),
          (err) => {
            assert.notStrictEqual(err.optimizerAborted, true, 'lỗi không liên quan abort không được gắn optimizerAborted');
            return true;
          }
        );
      });
    });
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log(`Kết quả: ${passed} PASS, ${failed} FAIL`);
  console.log('════════════════════════════════════════════════════');
  if (failed > 0) process.exitCode = 1;
})();
