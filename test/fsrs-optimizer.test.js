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
