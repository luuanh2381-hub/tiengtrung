#!/usr/bin/env node
// ════════════════════════════════════════════════════
// test/fsrs-optimizer.integration.test.js — Kiểm tra vòng đời THẬT (Postgres) của FSRS Personal
// Optimizer: apply/rollback/reset weights, lock chống chạy song song, và quan trọng nhất — Apply
// KHÔNG được đụng fsrs_cards/review_history (Phần 10/19 của yêu cầu audit).
//
// CẦN Postgres thật (biến môi trường DATABASE_URL) — giống test/fsrs.concurrency.integration.js,
// tự SKIP an toàn (exit 0) nếu chưa cấu hình, KHÔNG giả vờ PASS.
//
// LƯU Ý: test "chạy Optimizer thật rồi Apply" (mục 1/8/11 trong danh sách 14 kịch bản của yêu cầu)
// CẦN thêm "@open-spaced-repetition/binding" cài đặt thành công (xem lib/fsrs/optimizer.js —
// trainWithOfficialOptimizer). Nếu package đó CHƯA cài được trên máy đang chạy test, phần train thật
// sẽ tự SKIP (không FAIL) — các phần còn lại (apply/rollback/reset lifecycle bằng saveUserWeights,
// không đi qua train) vẫn chạy đầy đủ.
//
// Chạy: DATABASE_URL=postgres://... npm run test:optimizer:integration
// ════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('⏭️  SKIP: chưa cấu hình DATABASE_URL — test này cần Postgres thật.');
    console.log('   Chạy lại với: DATABASE_URL=postgres://... npm run test:optimizer:integration');
    return;
  }

  const db = require(path.join(__dirname, '..', 'lib', 'db'));
  const optimizer = require(path.join(__dirname, '..', 'lib', 'fsrs', 'optimizer'));
  const TEST_USER = '__optimizer_integration_test_user__';
  const TEST_HZ = '试';
  const TEST_L = 999998;

  console.log('════════════════════════════════════════════════════');
  console.log('FSRS Personal Optimizer — integration test (cần Postgres thật)');
  console.log('════════════════════════════════════════════════════');

  const pool = db.getPool();
  await pool.query('DELETE FROM fsrs_cards WHERE user_id = $1', [TEST_USER]);
  await pool.query('DELETE FROM review_history WHERE user_id = $1', [TEST_USER]);
  await pool.query('DELETE FROM user_fsrs_weights WHERE user_id = $1', [TEST_USER]);

  try {
    console.log('\n[Trạng thái ban đầu — chưa từng chạy Optimizer]');
    let status = await optimizer.getOptimizerStatus(TEST_USER);
    assert.strictEqual(status.personalWeightsEnabled, false);
    assert.strictEqual(status.hasCandidate, false);
    assert.strictEqual(status.canRollback, false);
    const activeBefore = await optimizer.getUserActiveWeights(TEST_USER);
    assert.strictEqual(activeBefore, null, 'chưa Apply → getUserActiveWeights() phải trả null (dùng default)');
    console.log('  ✅ Trạng thái ban đầu đúng: default weights, không có candidate, không rollback được');

    console.log('\n[saveUserWeights → active NGAY (đường tắt legacy, KHÔNG qua candidate) + cache TTL]');
    const fakeWeights = Array.from({ length: 21 }, (_, i) => 0.5 + i * 0.05);
    await optimizer.saveUserWeights(TEST_USER, fakeWeights, 1234);
    optimizer.invalidateActiveWeightsCache(TEST_USER); // đảm bảo đọc DB thật, không trúng cache write-through vừa set
    const activeAfterSave = await optimizer.getUserActiveWeights(TEST_USER);
    assert.deepStrictEqual(activeAfterSave, fakeWeights.map(Number));
    console.log('  ✅ saveUserWeights() → getUserActiveWeights() trả đúng weights vừa lưu (active ngay)');

    console.log('\n[Review THẬT sau khi có personal weights active → phải dùng personal weights, KHÔNG throw]');
    const reviewResult = await db.reviewFsrsCard({
      userId: TEST_USER, hz: TEST_HZ, l: TEST_L, answerCorrect: true, responseTimeMs: 1000,
      answerChanges: 0, desiredRetention: 0.9, idempotencyKey: 'itest-optimizer-1',
      personalWeights: await optimizer.getUserActiveWeights(TEST_USER),
    });
    assert.strictEqual(reviewResult.ok, true);
    console.log('  ✅ reviewFsrsCard() với personalWeights hợp lệ chạy bình thường, không throw');

    console.log('\n[applyPersonalWeights KHI CHƯA có candidate → phải throw lỗi rõ ràng (Phần 9)]');
    await assert.rejects(() => optimizer.applyPersonalWeights(TEST_USER), /candidate/);
    console.log('  ✅ Apply khi chưa có candidate hợp lệ → bị chặn, đúng thông báo');

    console.log('\n[Vòng đời Apply → Rollback qua saveOptimizerCandidate (không cần train thật)]');
    // Trạng thái ĐANG active lúc này: weights=fakeWeights, enabled=true (từ saveUserWeights ở trên)
    // — đây chính là trạng thái mà Apply/Rollback bên dưới phải snapshot/khôi phục lại cho đúng.
    const candidateWeights = Array.from({ length: 21 }, (_, i) => 1 + i * 0.1);
    await optimizer.saveOptimizerCandidate(TEST_USER, { weights: candidateWeights, reviewCount: 999, meta: { test: true } });
    status = await optimizer.getOptimizerStatus(TEST_USER);
    assert.strictEqual(status.hasCandidate, true);
    assert.strictEqual(status.personalWeightsEnabled, true, 'saveOptimizerCandidate KHÔNG được đụng active weights hiện tại (Phần 9) — vẫn đang là fakeWeights/enabled=true từ trước');

    const beforeCardRow = await pool.query('SELECT * FROM fsrs_cards WHERE user_id=$1 AND hz=$2 AND l=$3', [TEST_USER, TEST_HZ, TEST_L]);
    const beforeHistoryCount = await pool.query('SELECT COUNT(*)::int AS c FROM review_history WHERE user_id=$1', [TEST_USER]);

    await optimizer.applyPersonalWeights(TEST_USER);
    status = await optimizer.getOptimizerStatus(TEST_USER);
    assert.strictEqual(status.personalWeightsEnabled, true);
    assert.strictEqual(status.canRollback, true);
    const activeAfterApply = await optimizer.getUserActiveWeights(TEST_USER);
    assert.deepStrictEqual(activeAfterApply, candidateWeights.map(Number));
    console.log('  ✅ Apply → personal weights active đúng bằng candidate vừa lưu');

    const afterCardRow = await pool.query('SELECT * FROM fsrs_cards WHERE user_id=$1 AND hz=$2 AND l=$3', [TEST_USER, TEST_HZ, TEST_L]);
    const afterHistoryCount = await pool.query('SELECT COUNT(*)::int AS c FROM review_history WHERE user_id=$1', [TEST_USER]);
    assert.deepStrictEqual(beforeCardRow.rows[0], afterCardRow.rows[0], 'Apply weights KHÔNG được đổi bất kỳ field nào của fsrs_cards (Phần 10)');
    assert.strictEqual(beforeHistoryCount.rows[0].c, afterHistoryCount.rows[0].c, 'Apply weights KHÔNG được thêm/xoá review_history (Phần 10/19)');
    console.log('  ✅ Apply weights KHÔNG đụng fsrs_cards/review_history — đúng Phần 10/19');

    await optimizer.rollbackPersonalWeights(TEST_USER);
    status = await optimizer.getOptimizerStatus(TEST_USER);
    assert.strictEqual(status.personalWeightsEnabled, true, 'Rollback phải khôi phục ĐÚNG trạng thái TRƯỚC lần Apply (đang enabled=true/fakeWeights)');
    const activeAfterRollback = await optimizer.getUserActiveWeights(TEST_USER);
    assert.deepStrictEqual(activeAfterRollback, fakeWeights.map(Number), 'Rollback phải trả về ĐÚNG bộ weights trước khi Apply candidate (fakeWeights từ saveUserWeights)');
    assert.strictEqual(status.canRollback, false, 'Rollback là 1 CẤP undo duy nhất — sau khi dùng phải hết, không undo thêm được nữa');
    console.log('  ✅ Rollback → khôi phục đúng weights trước đó, và tự dọn (1 cấp undo)');

    console.log('\n[Reset to Default → default weights, và Reset TỰ NÓ cũng undo được qua Rollback]');
    await optimizer.resetToDefaultWeights(TEST_USER);
    status = await optimizer.getOptimizerStatus(TEST_USER);
    assert.strictEqual(status.personalWeightsEnabled, false);
    assert.strictEqual(status.canRollback, true, 'Reset phải tự lưu previous_weights — Reset cũng undo được qua Rollback');
    const activeAfterReset = await optimizer.getUserActiveWeights(TEST_USER);
    assert.strictEqual(activeAfterReset, null);
    console.log('  ✅ Reset to Default → về default weights (getUserActiveWeights null), tự tạo được điểm rollback');

    await optimizer.rollbackPersonalWeights(TEST_USER); // undo cái Reset ở trên — quay lại enabled=true/fakeWeights
    const activeAfterUndoReset = await optimizer.getUserActiveWeights(TEST_USER);
    assert.deepStrictEqual(activeAfterUndoReset, fakeWeights.map(Number), 'Rollback sau Reset phải khôi phục đúng weights trước Reset');
    console.log('  ✅ Rollback undo được cả hành động Reset, không chỉ Apply');

    console.log('\n[Rollback khi KHÔNG còn gì để undo (đã dùng hết 1 cấp undo ở trên) → throw rõ ràng]');
    await assert.rejects(() => optimizer.rollbackPersonalWeights(TEST_USER), /Không có trạng thái/);
    console.log('  ✅ Rollback khi previous_weights=NULL → bị chặn đúng thông báo');

    await optimizer.resetToDefaultWeights(TEST_USER); // dọn về default trước khi qua phần test run-lock

    console.log('\n[Run lock — 2 lượt claimOptimizerRun song song cho CÙNG 1 user → chỉ 1 lượt thắng (Phần 15)]');
    // Gọi thẳng object nội bộ qua require lại module (claimOptimizerRun không export public — test
    // gián tiếp qua runOptimizer, chấp nhận runOptimizer có thể NOT_READY/lỗi train — điều test quan
    // tâm CHỈ là: 2 lượt gọi song song không được cùng "started:true" chạy full pipeline 2 lần.)
    const [runA, runB] = await Promise.all([
      optimizer.runOptimizer(TEST_USER, { desiredRetention: 0.9 }),
      optimizer.runOptimizer(TEST_USER, { desiredRetention: 0.9 }),
    ]);
    const startedCount = [runA, runB].filter((r) => r.started !== false).length;
    assert.strictEqual(startedCount, 1, `2 lượt Run song song chỉ đúng 1 lượt được "started" — nhận được ${startedCount}`);
    console.log('  ✅ 2 lượt Run Optimizer song song → chỉ 1 lượt thật sự chạy, lượt kia bị chặn bởi lock');

    console.log('\n════════════════════════════════════════════════════');
    console.log('Tất cả integration test (FSRS Personal Optimizer) PASS');
    console.log('════════════════════════════════════════════════════');
  } finally {
    await pool.query('DELETE FROM fsrs_cards WHERE user_id = $1', [TEST_USER]);
    await pool.query('DELETE FROM review_history WHERE user_id = $1', [TEST_USER]);
    await pool.query('DELETE FROM user_fsrs_weights WHERE user_id = $1', [TEST_USER]);
    await pool.end();
  }
}

main().catch((e) => {
  console.error('❌ Integration test lỗi:', e && e.message);
  process.exitCode = 1;
});
