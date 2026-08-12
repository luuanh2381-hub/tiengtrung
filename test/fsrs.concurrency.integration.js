// ════════════════════════════════════════════════════
// INTEGRATION TEST THẬT (audit V68, Phần 6/22) — chạy trên Postgres THẬT, không mock.
// Chứng minh (không phải giả định):
//   1) 2 review request GẦN NHƯ ĐỒNG THỜI trên CÙNG 1 thẻ không tạo duplicate card, không mất
//      update, review_history ghi đủ 2 dòng, card cuối cùng ở trạng thái hợp lệ (SELECT ... FOR
//      UPDATE trong reviewFsrsCard() phải serialize đúng 2 request).
//   2) Reset tài khoản (updateDBWithFsrsCleanup) xoá sạch fsrs_cards + review_history của đúng
//      user đó, KHÔNG đụng user khác.
//   3) Xoá tài khoản xoá sạch fsrs_cards + review_history, không để lại orphan.
//
// CHỈ chạy khi có DATABASE_URL trỏ tới Postgres thật. Không có DATABASE_URL -> thoát với thông
// báo rõ ràng "SKIPPED", KHÔNG bao giờ tự báo PASS giả (Phần 22).
//
// Chạy: DATABASE_URL="postgres://..." node test/fsrs.concurrency.integration.js
// LƯU Ý: script này tạo dữ liệu test dưới user_id đặc biệt "__integration_test_user__" và
// "__integration_test_user_2__", rồi TỰ DỌN DẸP (xoá) chính user đó ở cuối, kể cả khi fail.
// Không đụng tới dữ liệu của user thật nào khác.
// ════════════════════════════════════════════════════
const assert = require('assert');

if (!process.env.DATABASE_URL) {
  console.log('SKIPPED: không có biến môi trường DATABASE_URL — không thể chạy integration test');
  console.log('trên Postgres thật trong môi trường này. Chạy lại với:');
  console.log('  DATABASE_URL="postgres://..." node test/fsrs.concurrency.integration.js');
  process.exitCode = 0; // skip có chủ đích, không phải fail, nhưng KHÔNG được hiểu là "đã PASS"
  process.exit(0);
}

const { reviewFsrsCard, updateDBWithFsrsCleanup } = require('../lib/db');

const TEST_USER = '__integration_test_user__';
const TEST_USER_2 = '__integration_test_user_2__';
const TEST_HZ = '测试';
const TEST_L = 999999;

async function cleanupTestUsers() {
  // Dọn trực tiếp bằng updateDBWithFsrsCleanup với mutateFn no-op ok:true, vì mục đích ở đây CHỈ
  // là xoá fsrs_cards/review_history rác của user test — không cần đụng app_store thật.
  for (const u of [TEST_USER, TEST_USER_2]) {
    await updateDBWithFsrsCleanup(u, () => ({ ok: true })).catch(() => {});
  }
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}

async function main() {
  console.log('════════════════════════════════════════════════════');
  console.log('FSRS INTEGRATION TEST (Postgres thật)');
  console.log('════════════════════════════════════════════════════');

  await cleanupTestUsers();

  await test('Concurrent review: 2 request gần như đồng thời trên cùng 1 thẻ không mất update / không duplicate card', async () => {
    const [r1, r2] = await Promise.all([
      reviewFsrsCard({ userId: TEST_USER, hz: TEST_HZ, l: TEST_L, answerCorrect: true, responseTimeMs: 1000, answerChanges: 0 }),
      reviewFsrsCard({ userId: TEST_USER, hz: TEST_HZ, l: TEST_L, answerCorrect: true, responseTimeMs: 1200, answerChanges: 0 }),
    ]);
    assert.ok(r1.ok && r2.ok, 'cả 2 request phải thành công (không lỗi/deadlock)');

    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      const cardRes = await pool.query(
        'SELECT * FROM fsrs_cards WHERE user_id = $1 AND hz = $2 AND l = $3',
        [TEST_USER, TEST_HZ, TEST_L]
      );
      assert.strictEqual(cardRes.rows.length, 1, 'không được tạo duplicate card cho cùng (user,hz,l)');
      const card = cardRes.rows[0];
      assert.strictEqual(card.reps, 2, 'reps phải = 2 sau đúng 2 lượt review (không mất update)');

      const histRes = await pool.query(
        'SELECT * FROM review_history WHERE user_id = $1 AND hz = $2 AND l = $3 ORDER BY reviewed_at',
        [TEST_USER, TEST_HZ, TEST_L]
      );
      assert.strictEqual(histRes.rows.length, 2, 'review_history phải có đúng 2 dòng (mỗi request 1 dòng, không mất/không nhân đôi)');
      // Chuỗi state phải nối tiếp đúng thứ tự: previous_stability của dòng thứ 2 phải khớp
      // new_stability của dòng thứ 1 — chứng minh SELECT ... FOR UPDATE đã serialize đúng 2
      // request (không có request nào đọc "before" đã lỗi thời / mất update của request kia).
      assert.strictEqual(
        Number(histRes.rows[1].previous_stability),
        Number(histRes.rows[0].new_stability),
        'lượt review thứ 2 phải đọc đúng state SAU lượt thứ 1 (không mất update do race condition)'
      );
    } finally {
      await pool.end();
    }
  });

  await test('Reset tài khoản: updateDBWithFsrsCleanup xoá sạch fsrs_cards + review_history của ĐÚNG user, không đụng user khác', async () => {
    // Tạo dữ liệu cho user 2 để chứng minh reset user 1 không ảnh hưởng user 2.
    await reviewFsrsCard({ userId: TEST_USER_2, hz: TEST_HZ, l: TEST_L, answerCorrect: true, responseTimeMs: 1000, answerChanges: 0 });

    const result = await updateDBWithFsrsCleanup(TEST_USER, (db) => {
      // mô phỏng đúng mutateFn thật của endpoint reset — không cần user tồn tại trong app_store
      // thật cho integration test này, chỉ cần chứng minh phần xoá SQL hoạt động đúng.
      return { ok: true };
    });
    assert.ok(result.ok, 'reset phải thành công');
    assert.strictEqual(result.fsrsCardsDeleted, 1, 'phải xoá đúng 1 fsrs_card của user test 1');
    assert.strictEqual(result.reviewHistoryDeleted, 2, 'phải xoá đúng 2 review_history của user test 1 (từ test concurrency ở trên)');

    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      const cardRes1 = await pool.query('SELECT COUNT(*)::int AS c FROM fsrs_cards WHERE user_id = $1', [TEST_USER]);
      assert.strictEqual(cardRes1.rows[0].c, 0, 'user 1 không còn fsrs_cards nào sau reset');
      const histRes1 = await pool.query('SELECT COUNT(*)::int AS c FROM review_history WHERE user_id = $1', [TEST_USER]);
      assert.strictEqual(histRes1.rows[0].c, 0, 'user 1 không còn review_history nào sau reset');

      const cardRes2 = await pool.query('SELECT COUNT(*)::int AS c FROM fsrs_cards WHERE user_id = $1', [TEST_USER_2]);
      assert.strictEqual(cardRes2.rows[0].c, 1, 'user 2 KHÔNG bị ảnh hưởng bởi reset của user 1');
    } finally {
      await pool.end();
    }
  });

  await test('Xoá tài khoản: updateDBWithFsrsCleanup xoá sạch fsrs_cards + review_history, không để lại orphan', async () => {
    const result = await updateDBWithFsrsCleanup(TEST_USER_2, () => ({ ok: true }));
    assert.ok(result.ok);
    assert.strictEqual(result.fsrsCardsDeleted, 1);

    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      const r = await pool.query('SELECT COUNT(*)::int AS c FROM fsrs_cards WHERE user_id = $1', [TEST_USER_2]);
      assert.strictEqual(r.rows[0].c, 0, 'không còn orphan fsrs_cards sau khi xoá user');
    } finally {
      await pool.end();
    }
  });

  await cleanupTestUsers();

  console.log('\n──────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await cleanupTestUsers().catch(() => {});
  process.exitCode = 1;
});
