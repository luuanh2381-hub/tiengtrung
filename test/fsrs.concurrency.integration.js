#!/usr/bin/env node
// ════════════════════════════════════════════════════
// test/fsrs.concurrency.integration.js — Kiểm tra 2 request GHI FSRS CÙNG LÚC trên đúng 1 thẻ
// (double-click / 2 tab / outbox gửi lại trong khi request gốc vẫn đang bay) không làm mất review,
// không tạo 2 dòng review_history, không ghi đè sai lịch ôn (Phần "Đồng bộ Neon"/optimistic locking
// version — xem lib/db.js:reviewFsrsCard).
//
// CẦN Postgres thật (biến môi trường DATABASE_URL) — KHÁC test/fsrs.test.js (thuần logic, không
// cần DB). FIX (audit V79): package.json đã khai báo "test:integration" từ trước nhưng file này
// không tồn tại trong project → luôn lỗi "Cannot find module". Giờ file tồn tại thật và tự SKIP an
// toàn (exit 0, không giả vờ PASS) nếu chưa cấu hình DATABASE_URL, thay vì crash cứng — để lệnh
// `npm run test:integration` chạy được ở MỌI môi trường, chỉ thực sự kiểm tra khi có DB.
//
// Chạy: DATABASE_URL=postgres://... npm run test:integration
// ════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('⏭️  SKIP: chưa cấu hình DATABASE_URL — test này cần Postgres thật để kiểm tra');
    console.log('   race condition ghi đồng thời. Chạy lại với: DATABASE_URL=postgres://... npm run test:integration');
    return;
  }

  const db = require(path.join(__dirname, '..', 'lib', 'db'));
  const TEST_USER = '__integration_test_user__';
  const TEST_HZ = '测试';
  const TEST_L = 999999; // bài giả, không đụng vocab thật

  console.log('════════════════════════════════════════════════════');
  console.log('FSRS — integration test (cần Postgres thật)');
  console.log('════════════════════════════════════════════════════');

  // Dọn dữ liệu test cũ (nếu có, từ lần chạy trước bị ngắt giữa chừng) trước khi bắt đầu.
  const pool = db.getPool();
  await pool.query('DELETE FROM fsrs_cards WHERE user_id = $1', [TEST_USER]);
  await pool.query('DELETE FROM review_history WHERE user_id = $1', [TEST_USER]);

  try {
    console.log('\n[Race condition — 2 request ghi FSRS ĐỒNG THỜI trên CÙNG 1 thẻ]');

    // 2 lượt review "song song" (không đợi nhau) trên đúng 1 thẻ — mô phỏng double-click hoặc
    // outbox gửi lại trong khi request gốc vẫn đang xử lý dở trên server.
    const [r1, r2] = await Promise.all([
      db.reviewFsrsCard({ userId: TEST_USER, hz: TEST_HZ, l: TEST_L, answerCorrect: true, responseTimeMs: 1000, answerChanges: 0, desiredRetention: 0.9, idempotencyKey: 'itest-key-1' }),
      db.reviewFsrsCard({ userId: TEST_USER, hz: TEST_HZ, l: TEST_L, answerCorrect: true, responseTimeMs: 1200, answerChanges: 0, desiredRetention: 0.9, idempotencyKey: 'itest-key-2' }),
    ]);
    assert.strictEqual(r1.ok, true, 'lượt review 1 phải thành công');
    assert.strictEqual(r2.ok, true, 'lượt review 2 phải thành công');

    const historyRes = await pool.query('SELECT COUNT(*)::int AS c FROM review_history WHERE user_id = $1 AND hz = $2 AND l = $3', [TEST_USER, TEST_HZ, TEST_L]);
    assert.strictEqual(historyRes.rows[0].c, 2, 'phải có ĐÚNG 2 dòng lịch sử (2 idempotencyKey khác nhau = 2 lượt review thật, không lượt nào bị mất)');
    console.log('  ✅ 2 request đồng thời (idempotencyKey khác nhau) → cả 2 đều được ghi, không mất lượt nào');

    console.log('\n[Idempotency — gửi TRÙNG idempotencyKey không tạo thêm dòng lịch sử]');
    const before = await pool.query('SELECT COUNT(*)::int AS c FROM review_history WHERE user_id = $1', [TEST_USER]);
    const dup = await db.reviewFsrsCard({ userId: TEST_USER, hz: TEST_HZ, l: TEST_L, answerCorrect: true, responseTimeMs: 900, answerChanges: 0, desiredRetention: 0.9, idempotencyKey: 'itest-key-1' });
    assert.strictEqual(dup.duplicate, true, 'gửi lại đúng idempotencyKey cũ phải được nhận diện là trùng lặp');
    const after = await pool.query('SELECT COUNT(*)::int AS c FROM review_history WHERE user_id = $1', [TEST_USER]);
    assert.strictEqual(after.rows[0].c, before.rows[0].c, 'không được tạo thêm dòng lịch sử nào cho lượt gửi trùng');
    console.log('  ✅ Gửi trùng idempotencyKey → không nhân đôi lịch sử, không chạy lại FSRS');

    console.log('\n[Optimistic locking — version tăng đúng 1 sau mỗi lượt ghi thật]');
    const cardRes = await pool.query('SELECT version FROM fsrs_cards WHERE user_id = $1 AND hz = $2 AND l = $3', [TEST_USER, TEST_HZ, TEST_L]);
    assert.strictEqual(cardRes.rows[0].version, 2, 'đúng 2 lượt ghi thật (không tính lượt trùng) → version phải = 2');
    console.log('  ✅ version tăng đúng theo số lượt ghi FSRS thật, không bị lượt trùng làm lệch');

    console.log('\n════════════════════════════════════════════════════');
    console.log('Tất cả integration test PASS');
    console.log('════════════════════════════════════════════════════');
  } finally {
    // Dọn sạch dữ liệu test — không để lại rác trong DB thật dùng cho test này.
    await pool.query('DELETE FROM fsrs_cards WHERE user_id = $1', [TEST_USER]);
    await pool.query('DELETE FROM review_history WHERE user_id = $1', [TEST_USER]);
    await pool.end();
  }
}

main().catch((e) => {
  console.error('❌ Integration test lỗi:', e && e.message);
  process.exitCode = 1;
});
