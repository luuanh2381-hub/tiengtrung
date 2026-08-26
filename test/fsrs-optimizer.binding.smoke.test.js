#!/usr/bin/env node
// ════════════════════════════════════════════════════
// test/fsrs-optimizer.binding.smoke.test.js
//
// Smoke test THẬT (không mock, không approximation) cho package official
// "@open-spaced-repetition/binding" — companion optimizer của ts-fsrs. KHÔNG cần Postgres (khác
// test/fsrs-optimizer.integration.test.js) — mục đích DUY NHẤT: xác nhận trên CHÍNH môi trường đang
// chạy test (máy dev, Vercel build step, hoặc 1 lần chạy thủ công sau khi deploy) thì:
//   1) require('@open-spaced-repetition/binding') load được thật.
//   2) computeParameters (qua trainWithOfficialOptimizer) chạy được trên 1 dataset hợp lệ.
//   3) Kết quả là đúng 21 tham số FSRS-6, toàn bộ là số hữu hạn.
//
// Khác với các test khác trong project (SKIP an toàn khi thiếu Postgres), test này KHÔNG được phép
// âm thầm SKIP hay PASS giả khi thiếu dependency — optimizer chính thức là yêu cầu bắt buộc (không
// được thay bằng thuật toán tự viết). Thiếu/lỗi binding → FAIL rõ ràng, exit code 1, kèm chẩn đoán
// môi trường (node/platform/arch) để debug đúng nguyên nhân (thường là thiếu bản native/WASM cho
// đúng platform, hoặc bundler/deploy tool bỏ sót nó — xem vercel.json:includeFiles).
//
// Chạy: npm run test:optimizer:binding
//   (cần đã "npm install" thật trước đó — sandbox review/audit code không có mạng nên KHÔNG tự chạy
//   được bước này; đây là bước BẮT BUỘC bạn tự làm sau khi tải project về máy/CI có mạng.)
// ════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');

const { FSRS6_PARAM_COUNT, isValidWeightsArray } = require(path.join(__dirname, '..', 'lib', 'fsrs', 'scheduler'));
const {
  trainWithOfficialOptimizer,
  getOptimizerBindingVersion,
  getOptimizerEngineStatus,
  OptimizerDependencyError,
} = require(path.join(__dirname, '..', 'lib', 'fsrs', 'optimizer'));

// ── Bước 1: import binding trực tiếp — chính là dòng lệnh đang FAIL trên Vercel production
//    ("Cannot find module '@open-spaced-repetition/binding'"). Nếu dòng này throw ở đây, nghĩa là
//    môi trường đang chạy test CŨNG sẽ bị lỗi y hệt production — cần sửa deploy config trước. ──
function stepImportBinding() {
  let binding;
  try {
    binding = require('@open-spaced-repetition/binding');
  } catch (e) {
    console.error('❌ OPTIMIZER IMPORT: FAIL —', e.message);
    console.error(`   Môi trường: node=${process.version} platform=${process.platform} arch=${process.arch}`);
    throw e;
  }
  const version = getOptimizerBindingVersion();
  assert.ok(version, 'Phải đọc được version từ node_modules/@open-spaced-repetition/binding/package.json');
  assert.strictEqual(typeof binding.computeParameters, 'function', 'binding phải export computeParameters()');
  assert.strictEqual(typeof binding.FSRSBindingItem, 'function', 'binding phải export FSRSBindingItem');
  assert.strictEqual(typeof binding.FSRSBindingReview, 'function', 'binding phải export FSRSBindingReview');
  console.log(`✅ OPTIMIZER IMPORT: PASS — version ${version} (node=${process.version} platform=${process.platform} arch=${process.arch})`);
  return version;
}

// ── Bước 2: dataset test hợp lệ — review log TỔNG HỢP (không phải data thật của user nào), nhiều
//    thẻ, đủ đa dạng rating (1=Again 2=Hard 3=Good 4=Easy) và khoảng cách ngày tăng dần, đúng format
//    mà trainWithOfficialOptimizer()/buildTrainingItems() dùng ({cardId, reviews:[{rating,deltaT}]}).
//    CHỈ để smoke-test khả năng load+chạy của package — không dùng để đánh giá chất lượng weights
//    (việc đó thuộc về evaluateWeights(), đã có test riêng ở test/fsrs-optimizer.test.js). ──
function buildSyntheticDataset() {
  const RATING_CYCLE = [3, 3, 2, 3, 4, 1, 3, 3]; // đa số Good, xen Hard/Easy/Again
  const items = [];
  for (let c = 0; c < 60; c++) {
    const reviews = [];
    let elapsed = 0;
    for (let i = 0; i < RATING_CYCLE.length; i++) {
      const rating = RATING_CYCLE[(i + c) % RATING_CYCLE.length];
      reviews.push({ rating, deltaT: i === 0 ? 0 : elapsed, answerCorrect: rating >= 2 });
      elapsed += 1 + ((i + c) % 5);
    }
    items.push({ cardId: `synthetic-${c}`, reviews });
  }
  return items;
}

// ── Bước 3: chạy optimizer CHÍNH THỨC thật qua trainWithOfficialOptimizer() (không mock) ──
async function stepTrain() {
  const dataset = buildSyntheticDataset();
  try {
    const weights = await trainWithOfficialOptimizer(dataset, { enableShortTerm: true });
    console.log(`✅ OPTIMIZER TRAIN: PASS — nhận được ${weights.length} weights từ dataset tổng hợp (${dataset.length} thẻ)`);
    return weights;
  } catch (e) {
    const label = e instanceof OptimizerDependencyError ? 'OptimizerDependencyError' : e.constructor.name;
    console.error(`❌ OPTIMIZER TRAIN: FAIL (${label}) —`, e.message);
    throw e;
  }
}

// ── Bước 4: validate đúng 21 weights, toàn bộ hữu hạn — dùng LẠI isValidWeightsArray() (định nghĩa
//    DUY NHẤT trong project, lib/fsrs.js), không tự viết lại rule validate. ──
function stepValidateWeights(weights) {
  assert.strictEqual(weights.length, FSRS6_PARAM_COUNT, `Phải có đúng ${FSRS6_PARAM_COUNT} weights, nhận được ${weights.length}`);
  weights.forEach((w, i) => {
    assert.strictEqual(typeof w, 'number', `w[${i}] phải là number, nhận được ${typeof w}`);
    assert.ok(Number.isFinite(w), `w[${i}] phải là số hữu hạn (không NaN/Infinity), nhận được ${w}`);
  });
  assert.ok(isValidWeightsArray(weights), 'isValidWeightsArray() phải chấp nhận kết quả optimizer trả về');
  console.log(`✅ 21 WEIGHTS: PASS — [${weights.map((w) => w.toFixed(4)).join(', ')}]`);
}

// ── Bước 5 (V83-FIX-v3): getOptimizerEngineStatus() phải phản ánh ĐÚNG cùng 1 sự thật mà bước 1-4
//    vừa xác nhận thật — đây chính là hàm GET /api/fsrs-optimizer/status dùng để báo cho user TRƯỚC
//    khi bấm Run (Phần 11), nên nếu train ở trên PASS thì status ở đây BẮT BUỘC phải available=true. ──
function stepEngineStatus() {
  const status = getOptimizerEngineStatus();
  assert.strictEqual(status.available, true, 'getOptimizerEngineStatus().available phải khớp với việc train vừa PASS ở trên');
  assert.ok(['native', 'wasi', 'unknown'].includes(status.engine), `engine phải là native/wasi/unknown, nhận được ${status.engine}`);
  console.log(`✅ ENGINE STATUS: PASS — available=true engine=${status.engine} (node=${status.nodeVersion} platform=${status.platform} arch=${status.arch}${status.glibcVersion ? ' glibc=' + status.glibcVersion : ''})`);
}

async function main() {
  console.log('════════════════════════════════════════════════════');
  console.log('Smoke test THẬT: @open-spaced-repetition/binding trên môi trường hiện tại');
  console.log('════════════════════════════════════════════════════');
  stepImportBinding();
  const weights = await stepTrain();
  stepValidateWeights(weights);
  stepEngineStatus();
  console.log('\n════════════════════════════════════════════════════');
  console.log('TẤT CẢ PASS — optimizer chính thức load + train thật thành công trên môi trường này.');
  console.log('════════════════════════════════════════════════════');
}

main().catch((e) => {
  console.error('\n════════════════════════════════════════════════════');
  console.error('SMOKE TEST FAIL — optimizer chính thức KHÔNG chạy được trên môi trường này.');
  console.error('KHÔNG coi đây là "chấp nhận được" rồi fallback sang thuật toán tự viết — phải sửa');
  console.error('dependency/deploy config (xem lib/fsrs/optimizer.js:trainWithOfficialOptimizer và');
  console.error('vercel.json:includeFiles) rồi chạy lại test này cho tới khi PASS.');
  console.error('════════════════════════════════════════════════════');
  process.exitCode = 1;
});
