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

    await optimizer.resetToDefaultWeights(TEST_USER); // dọn về default trước khi qua phần test job

    // ════════════════════════════════════════════════════
    // V85 — kiến trúc job bất đồng bộ: createOptimizerJob (tạo, rẻ, idempotent với race condition)
    // tách rời khỏi runOptimizerJob (worker, nặng — xem lib/fsrs/optimizer.js ADDENDUM V85).
    // ════════════════════════════════════════════════════

    console.log('\n[Job — double-click gần như đồng thời (Phần "IDEMPOTENCY/CONCURRENCY") → chỉ 1 job thật, KHÔNG tạo trùng]');
    const [jobA, jobB] = await Promise.all([
      optimizer.createOptimizerJob(TEST_USER, { desiredRetention: 0.9 }),
      optimizer.createOptimizerJob(TEST_USER, { desiredRetention: 0.9 }),
    ]);
    assert.strictEqual(jobA.job.id, jobB.job.id, 'Double-click gần như đồng thời → PHẢI trả về CÙNG 1 job, không tạo 2 job riêng biệt');
    const createdCount = [jobA, jobB].filter((x) => x.created).length;
    assert.strictEqual(createdCount, 1, `Chỉ đúng 1 lượt thực sự INSERT job mới (race condition xử lý ở DB qua partial unique index) — nhận được ${createdCount}`);
    assert.strictEqual(jobA.job.status, 'queued');
    console.log('  ✅ 2 lượt tạo job gần như đồng thời → chỉ 1 job thật, lượt kia idempotent trả lại job đã có (Test bắt buộc #4)');

    console.log('\n[Job — stale (queued quá lâu, worker không bao giờ claim) → tự chuyển failed, KHÔNG kẹt mãi (Phần "FAILURE HANDLING")]');
    // V86: attempt = max_attempts mô phỏng "đã hết lượt retry" — giữ ĐÚNG mục đích gốc của test này
    // (kiểm tra trạng thái CUỐI CÙNG là failed, không kẹt mãi). Hành vi MỚI "còn lượt thì requeue
    // trước khi failed hẳn" được test RIÊNG ở Test F/G bên dưới, không lẫn vào đây.
    await pool.query(
      `UPDATE fsrs_optimizer_jobs SET created_at = now() - interval '10 minutes', heartbeat_at = now() - interval '10 minutes', attempt = max_attempts WHERE id = $1`,
      [jobA.job.id]
    );
    const statusAfterStale = await optimizer.getOptimizerStatus(TEST_USER);
    assert.strictEqual(statusAfterStale.job.status, 'failed', 'Job queued quá lâu mà không được worker claim → phải tự chuyển failed khi kiểm tra lại status');
    assert.ok(statusAfterStale.lastError, 'Job stale phải có lastError (câu thông báo an toàn cho user)');
    const retryAfterStale = await optimizer.createOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
    assert.strictEqual(retryAfterStale.created, true, 'Sau khi job cũ đã failed (stale) → PHẢI cho phép tạo job MỚI, không bị kẹt mãi (Test bắt buộc #6)');
    console.log('  ✅ Job stale tự phục hồi thành failed (kèm thông báo), user Run lại được bình thường ngay lần poll tiếp theo');

    await pool.query(`DELETE FROM fsrs_optimizer_jobs WHERE user_id = $1`, [TEST_USER]); // dọn trước khi qua các test heartbeat/race condition (V85-HEARTBEAT-FIX)

    // ════════════════════════════════════════════════════
    // V85-HEARTBEAT-FIX — "TEST TỐI THIỂU" A/C/D/E của yêu cầu sửa lần này. Các test này mô phỏng
    // TRỰC TIẾP ở tầng DB (claimQueuedJob/updateJobHeartbeat/finishJob/finishJobWithCandidate/
    // recoverStaleJobsForUser — đều export riêng cho test) thay vì chờ computeParameters() thật chạy
    // hàng chục giây, vì đây CHÍNH LÀ những hàm quyết định lifecycle/heartbeat/race condition, độc
    // lập với việc native optimizer có được cài trong môi trường chạy test hay không (Test B — cần
    // binding thật — nằm RIÊNG ở cuối file, sau phần full pipeline).
    // ════════════════════════════════════════════════════

    console.log('\n[Test A — Job "running" ĐÃ LÂU (started_at xa) nhưng heartbeat_at vừa được làm mới → KHÔNG bị coi stale]');
    const jobA2 = await optimizer.createOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
    await optimizer.claimQueuedJob(jobA2.job.id, TEST_USER);
    // Mô phỏng: đã "running" 10 phút (vượt xa OPTIMIZER_RUNNING_STALE_MS mặc định 180s) — NHƯ THỂ
    // computeParameters() chạy lâu không gọi progress() — NHƯNG heartbeat ĐỘC LẬP (setInterval trong
    // runOptimizerJob(), xem lib/fsrs/optimizer.js) vẫn tick đều, mô phỏng ĐÚNG 1 tick của nó bằng
    // cách gọi thẳng updateJobHeartbeat(jobId, {}) — không kèm stage/progress, giống hệt interval đó.
    await pool.query(`UPDATE fsrs_optimizer_jobs SET started_at = now() - interval '10 minutes', heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [jobA2.job.id]);
    await optimizer.updateJobHeartbeat(jobA2.job.id, {});
    const statusDuringLongRun = await optimizer.getOptimizerStatus(TEST_USER);
    assert.strictEqual(statusDuringLongRun.job.status, 'running', 'Job "running" đã 10 phút (started_at xa) nhưng heartbeat_at VỪA được làm mới → recoverStaleJobsForUser() KHÔNG được coi là stale (stale tính từ heartbeat_at, KHÔNG phải từ started_at) — đúng lỗi trong báo cáo (heartbeat tách khỏi progress)');
    console.log('  ✅ Job chạy lâu nhưng heartbeat độc lập vẫn tươi → KHÔNG bị đánh stale oan (Test bắt buộc A)');
    await optimizer.finishJob(jobA2.job.id, { status: 'completed', stage: 'completed' }); // dọn: kết thúc job này trước khi qua test khác

    console.log('\n[Test C — Worker "chết" thật (running, hết heartbeat lâu, KHÔNG có tick độc lập nào cứu) → stale recovery tự chuyển failed]');
    const jobC = await optimizer.createOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
    await optimizer.claimQueuedJob(jobC.job.id, TEST_USER);
    // V86: attempt = max_attempts — test này kiểm tra trạng thái CUỐI CÙNG (đã hết lượt retry), giống
    // ghi chú ở test "stale (queued quá lâu)" phía trên. Test F/G bên dưới kiểm tra riêng nhánh requeue.
    await pool.query(`UPDATE fsrs_optimizer_jobs SET heartbeat_at = now() - interval '4 minutes', attempt = max_attempts WHERE id = $1`, [jobC.job.id]); // > 180s mặc định, KHÔNG có updateJobHeartbeat() nào chạy tiếp sau đó — đúng mô phỏng "worker chết thật"
    const statusAfterDead = await optimizer.getOptimizerStatus(TEST_USER);
    assert.strictEqual(statusAfterDead.job.status, 'failed', 'Job "running" mất heartbeat > OPTIMIZER_RUNNING_STALE_MS, không có tick độc lập nào cứu → PHẢI tự chuyển failed (Test bắt buộc C)');
    assert.ok(statusAfterDead.lastError, 'Job "chết" phải có lastError (câu thông báo an toàn cho user)');
    console.log('  ✅ Worker chết thật (hết heartbeat, không hồi phục) → recoverStaleJobsForUser() tự chuyển failed (Test bắt buộc C)');

    console.log('\n[Test D — Race condition ĐÚNG NGUYÊN VĂN báo cáo lỗi: stale recovery đánh failed TRƯỚC, "Worker A" (chậm) hoàn tất SAU → KHÔNG được lật failed→completed, KHÔNG ghi candidate]');
    const jobD = await optimizer.createOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
    await optimizer.claimQueuedJob(jobD.job.id, TEST_USER); // Worker A claim job — queued → running
    // Stale recovery chạy TRƯỚC (vd do 1 lần poll status() của user) và phát hiện heartbeat quá cũ —
    // đánh dấu failed — TRONG KHI Worker A thật ra vẫn đang chạy và sắp hoàn tất (đúng race condition
    // nêu trong báo cáo: "Worker A = running → stale recovery đánh failed → Worker A sau đó hoàn thành").
    // V86: attempt = max_attempts để chắc chắn rơi vào nhánh failed HẲN (không phải requeue) — test
    // này kiểm tra race condition SAU KHI đã failed, không phải nhánh requeue (test riêng ở Test F/G).
    await pool.query(`UPDATE fsrs_optimizer_jobs SET heartbeat_at = now() - interval '10 minutes', started_at = now() - interval '10 minutes', attempt = max_attempts WHERE id = $1`, [jobD.job.id]);
    await optimizer.recoverStaleJobsForUser(pool, TEST_USER);
    let jobDStatus = await pool.query('SELECT status FROM fsrs_optimizer_jobs WHERE id = $1', [jobD.job.id]);
    assert.strictEqual(jobDStatus.rows[0].status, 'failed', '(setup) job phải đã bị stale recovery đánh failed TRƯỚC bước Worker A "hoàn tất" bên dưới');

    // Worker A (đã bị coi là chết) giờ mới thật sự train xong và cố gắng ghi kết quả — PHẢI bị chặn.
    const candidateBeforeRace = await pool.query('SELECT candidate_weights, candidate_trained_at FROM user_fsrs_weights WHERE user_id = $1', [TEST_USER]);
    const fakeRaceWeights = Array.from({ length: 21 }, (_, i) => 2 + i * 0.1);
    const finalizeResult = await optimizer.finishJobWithCandidate(jobD.job.id, TEST_USER, { weights: fakeRaceWeights, reviewCount: 111, meta: { raceTest: true } });
    assert.strictEqual(finalizeResult, false, 'finishJobWithCandidate() PHẢI trả về false khi job không còn "running" — Worker A (cũ) KHÔNG được phép hoàn tất 1 job đã failed (Test bắt buộc D)');
    jobDStatus = await pool.query('SELECT status FROM fsrs_optimizer_jobs WHERE id = $1', [jobD.job.id]);
    assert.strictEqual(jobDStatus.rows[0].status, 'failed', 'Job PHẢI giữ NGUYÊN "failed" — KHÔNG BAO GIỜ được lật ngược lại "completed" (Test bắt buộc D, đúng lỗi race condition trong báo cáo)');
    const candidateAfterRace = await pool.query('SELECT candidate_weights, candidate_trained_at FROM user_fsrs_weights WHERE user_id = $1', [TEST_USER]);
    assert.deepStrictEqual(
      candidateAfterRace.rows[0] && candidateAfterRace.rows[0].candidate_trained_at,
      candidateBeforeRace.rows[0] && candidateBeforeRace.rows[0].candidate_trained_at,
      'candidate_weights/candidate_trained_at KHÔNG được Worker A (đã failed) ghi đè — hoàn toàn không đổi (Test bắt buộc D/7/8)'
    );
    console.log('  ✅ Worker A (job đã failed) cố hoàn tất → bị chặn: KHÔNG lật failed→completed, KHÔNG ghi candidate weights (Test bắt buộc D)');

    console.log('\n[Test E — Sau khi job completed/failed, heartbeat/finishJob KHÔNG còn tác dụng gì nữa (worker/heartbeat trễ = no-op)]');
    const jobE = await optimizer.createOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
    await optimizer.claimQueuedJob(jobE.job.id, TEST_USER);
    await optimizer.finishJob(jobE.job.id, { status: 'completed', stage: 'completed' });
    const beforeLateTouch = await pool.query('SELECT heartbeat_at FROM fsrs_optimizer_jobs WHERE id = $1', [jobE.job.id]);
    await new Promise((r) => setTimeout(r, 20));
    await optimizer.updateJobHeartbeat(jobE.job.id, {}); // mô phỏng 1 tick TRỄ của heartbeat độc lập (worker/interval cũ chưa kịp dừng)
    const secondFinish = await optimizer.finishJob(jobE.job.id, { status: 'failed', stage: 'failed', errorMessage: 'lỗi trễ giả lập', errorPublic: 'x' }); // mô phỏng 1 lời gọi finishJob TRỄ khác
    const afterLateTouch = await pool.query('SELECT heartbeat_at, status FROM fsrs_optimizer_jobs WHERE id = $1', [jobE.job.id]);
    assert.strictEqual(secondFinish, false, 'finishJob() gọi TRỄ sau khi job đã completed PHẢI trả về false (no-op) — không có gì để "hoàn tất" thêm lần nữa (Test bắt buộc E)');
    assert.strictEqual(afterLateTouch.rows[0].status, 'completed', 'Job PHẢI giữ nguyên "completed" — lời gọi finishJob(\'failed\') trễ KHÔNG được phép lật lại (Test bắt buộc E)');
    assert.strictEqual(afterLateTouch.rows[0].heartbeat_at.getTime(), beforeLateTouch.rows[0].heartbeat_at.getTime(), 'updateJobHeartbeat() gọi TRỄ sau khi job đã completed PHẢI là no-op hoàn toàn — heartbeat_at không đổi (Test bắt buộc E)');
    console.log('  ✅ Job completed → mọi lời gọi heartbeat/finishJob TRỄ sau đó đều là no-op, không "hồi sinh" job (Test bắt buộc E)');

    // ════════════════════════════════════════════════════
    // V86 — ADDENDUM: "TEST TỐI THIỂU" F/G/H — retry có kiểm soát + resume qua checkpoint. Đây chính
    // là phần MỚI so với V85 (V85 chỉ phát hiện worker chết; V86 còn tự requeue-và-resume trước khi
    // failed hẳn — xem AUDIT-REPORT-V86-FSRS-OPTIMIZER-DURABILITY.md).
    // ════════════════════════════════════════════════════

    console.log('\n[Test F (V86) — Job "running" mất heartbeat NHƯNG còn lượt retry (attempt < max_attempts) → REQUEUE (không failed hẳn), attempt tăng, GIỮ training_payload để resume]');
    const jobF = await optimizer.createOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
    await optimizer.claimQueuedJob(jobF.job.id, TEST_USER);
    const fakePayload = { train: [{ cardId: 'x', reviews: [{ rating: 3, deltaT: 0 }] }], validation: [], report: { validReviews: 999 }, retention: 0.9, defaultWeights: new Array(21).fill(0.1) };
    await optimizer.persistTrainingPayload(jobF.job.id, fakePayload); // mô phỏng đã qua checkpoint 'prepared'
    await pool.query(`UPDATE fsrs_optimizer_jobs SET heartbeat_at = now() - interval '4 minutes' WHERE id = $1`, [jobF.job.id]); // stale, KHÔNG có tick nào cứu — nhưng attempt=1 < max_attempts=3 mặc định
    const statusAfterRequeue = await optimizer.getOptimizerStatus(TEST_USER); // gọi getOptimizerStatus() sẽ tự chạy recoverStaleJobsForUser() bên trong
    assert.strictEqual(statusAfterRequeue.job.status, 'queued', 'Còn lượt retry (attempt 1 < max_attempts 3) → PHẢI requeue, KHÔNG được failed hẳn ngay (khác V85: V85 luôn failed ngay ở lần stale đầu tiên; V86 chỉ failed hẳn khi HẾT lượt — xem Test G)');
    assert.strictEqual(statusAfterRequeue.job.attempt, 2, 'attempt phải tăng từ 1 lên 2 sau khi requeue');
    const rowAfterRequeue = await pool.query('SELECT stage, training_payload FROM fsrs_optimizer_jobs WHERE id = $1', [jobF.job.id]);
    assert.strictEqual(rowAfterRequeue.rows[0].stage, 'prepared', "Requeue phải GIỮ stage='prepared' (không lùi về 'queued' trơn) vì đã có training_payload — worker mới claim lại sẽ nhảy thẳng vào train, không load/validate lại (Phần VI)");
    assert.ok(rowAfterRequeue.rows[0].training_payload, 'training_payload PHẢI được giữ nguyên qua lượt requeue để resume được (Phần VI)');
    console.log('  ✅ Stale nhưng còn lượt retry → requeue (không failed), attempt tăng, GIỮ checkpoint để resume');

    // Claim lại (mô phỏng invocation MỚI tự kích hoạt qua triggerOptimizerWorker ở api/index.js) →
    // PHẢI nhảy thẳng vào 'prepared', KHÔNG phải 'loading_reviews' — đây CHÍNH LÀ cốt lõi của fix V86
    // (invocation mới không phải load/validate lại từ đầu, dành trọn ngân sách mới cho phần train).
    const reclaimedF = await optimizer.claimQueuedJob(jobF.job.id, TEST_USER);
    assert.strictEqual(reclaimedF.stage, 'prepared', "claimQueuedJob() PHẢI thấy training_payload và claim thẳng vào stage='prepared' — không load/validate lại từ đầu");
    assert.ok(reclaimedF.training_payload, 'Row vừa claim lại vẫn còn training_payload để runOptimizerJob() đọc và resume');
    console.log('  ✅ Claim lại job vừa requeue → nhảy thẳng \'prepared\', training_payload còn nguyên để resume (cốt lõi của fix V86)');
    await optimizer.finishJob(jobF.job.id, { status: 'completed', stage: 'completed' }); // dọn

    console.log('\n[Test G (V86) — Job stale ĐÃ HẾT lượt retry (attempt >= max_attempts) → failed HẲN (không requeue thêm lần nào nữa, không lặp vô hạn — Phần IX)]');
    const jobG = await optimizer.createOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
    await optimizer.claimQueuedJob(jobG.job.id, TEST_USER);
    await pool.query(`UPDATE fsrs_optimizer_jobs SET heartbeat_at = now() - interval '4 minutes', attempt = max_attempts WHERE id = $1`, [jobG.job.id]); // đã dùng hết lượt
    const statusAfterExhausted = await optimizer.getOptimizerStatus(TEST_USER);
    assert.strictEqual(statusAfterExhausted.job.status, 'failed', 'Hết lượt retry (attempt >= max_attempts) → PHẢI failed HẲN, không requeue thêm (Phần IX — "không retry vô hạn")');
    assert.ok(statusAfterExhausted.lastError && /thử lại tối đa/.test(statusAfterExhausted.lastError), 'Thông báo lỗi phải nói rõ đã thử lại tối đa (khác thông báo lần fail thường)');
    console.log('  ✅ Hết lượt retry → failed hẳn, thông báo rõ ràng đã thử tối đa (Phần IX)');

    console.log('\n[Test H (V86) — finishJob() với errorRetryable=false (mô phỏng lỗi NON_RETRYABLE mà failOrRequeue() sẽ tạo ra) → failed NGAY từ attempt 1, KHÔNG tự tăng attempt/requeue]');
    // Lưu ý: đây kiểm tra ĐÚNG những gì failOrRequeue() sẽ LÀM khi classifyOptimizerError() trả về
    // NON_RETRYABLE (gọi finishJob trực tiếp, không requeue) — bản thân classifyOptimizerError() đã
    // có bộ test thuần JS riêng, đầy đủ, không cần Postgres (xem test/fsrs-optimizer.test.js).
    const jobH = await optimizer.createOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
    await optimizer.claimQueuedJob(jobH.job.id, TEST_USER);
    const nonRetryableFail = await optimizer.finishJob(jobH.job.id, {
      status: 'failed', stage: 'failed',
      errorMessage: 'Optimizer chính thức trả về weights không hợp lệ (cần đúng 21 số hữu hạn). Nhận được: [NaN,...]',
      errorPublic: 'Optimizer thất bại. Vui lòng thử lại.', errorRetryable: false,
    });
    assert.strictEqual(nonRetryableFail, true);
    const statusAfterNonRetryable = await optimizer.getOptimizerStatus(TEST_USER);
    assert.strictEqual(statusAfterNonRetryable.job.status, 'failed');
    assert.strictEqual(statusAfterNonRetryable.job.attempt, 1, 'Lỗi NON_RETRYABLE → job kết thúc NGAY ở attempt 1, KHÔNG bị tự động tăng attempt/requeue như lỗi hạ tầng (Test F) — failOrRequeue() chỉ requeue khi classification=RETRYABLE');
    assert.strictEqual(statusAfterNonRetryable.job.errorRetryable, false, 'errorRetryable=false PHẢI được lưu đúng và trả lại qua getOptimizerStatus() — đây là metadata phân loại (không phải nội dung lỗi chi tiết) nên KHÔNG cần ẩn khỏi user thường, khác với errorMessage/workerId (Phần ERROR SECURITY chỉ áp dụng cho nội dung lỗi kỹ thuật chi tiết)');
    console.log('  ✅ NON_RETRYABLE fail ngay từ attempt 1, không bị requeue lãng phí (Phần IX)');

    await pool.query(`DELETE FROM fsrs_optimizer_jobs WHERE user_id = $1`, [TEST_USER]); // dọn trước khi test full pipeline

    console.log('\n[Job — full pipeline THẬT (createOptimizerJob → runOptimizerJob) trên dữ liệu tổng hợp (Test bắt buộc #1, #5, #9)]');
    // Sinh dữ liệu tổng hợp đủ điều kiện READY/OPTIMIZABLE (giống makeSyntheticRows() ở
    // test/fsrs-optimizer.test.js, nhưng ghi THẲNG vào Postgres vì integration test này cần
    // review_history THẬT để runOptimizerJob() đọc — không chỉ gọi hàm thuần JS như unit test kia).
    const SYN_CARDS = 60, SYN_REVIEWS_PER_CARD = 40; // 2.400 review / 60 thẻ — vượt xa ngưỡng tối thiểu 500 review / 30 thẻ (Phần 5)
    const ratings = ['good', 'good', 'good', 'easy', 'again', 'hard'];
    const now = Date.now();
    const values = [];
    const params = [];
    let p = 0;
    for (let c = 0; c < SYN_CARDS; c++) {
      for (let i = 0; i < SYN_REVIEWS_PER_CARD; i++) {
        const daysAgo = (SYN_REVIEWS_PER_CARD - i) * 2;
        const reviewedAt = new Date(now - daysAgo * 86400000);
        const rating = ratings[(c + i) % ratings.length];
        values.push(`($${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p})`);
        params.push(TEST_USER, `试${c}`, 1 + (c % 10), rating, rating !== 'again', reviewedAt.toISOString(), i === 0 ? 0 : 2);
      }
    }
    await pool.query(
      `INSERT INTO review_history (user_id, hz, l, rating, answer_correct, reviewed_at, elapsed_days) VALUES ${values.join(', ')}`,
      params
    );
    const beforeHistoryCountFull = await pool.query('SELECT COUNT(*)::int AS c FROM review_history WHERE user_id=$1', [TEST_USER]);

    const created = await optimizer.createOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
    assert.strictEqual(created.created, true);
    await optimizer.runOptimizerJob(created.job.id, TEST_USER); // gọi trực tiếp (test không có HTTP self-fetch của api/index.js)

    const statusAfterRun = await optimizer.getOptimizerStatus(TEST_USER);
    assert.ok(statusAfterRun.job, 'Phải có job sau khi runOptimizerJob() chạy xong');
    assert.strictEqual(statusAfterRun.job.status, 'completed', `Job phải completed, KHÔNG được kẹt ở running (Test bắt buộc #5) — nhận được "${statusAfterRun.job.status}"${statusAfterRun.lastError ? ' — lỗi: ' + statusAfterRun.lastError : ''}`);
    let bindingInstalledForFullRun = true;
    try { require('@open-spaced-repetition/binding'); } catch { bindingInstalledForFullRun = false; }
    if (bindingInstalledForFullRun) {
      assert.strictEqual(statusAfterRun.hasCandidate, true, 'Dataset đủ điều kiện (OPTIMIZABLE) + binding có cài → job completed PHẢI để lại candidate weights');
      assert.strictEqual(statusAfterRun.personalWeightsEnabled, false, 'Candidate KHÔNG được tự động Apply (Phần 9/Test bắt buộc #8)');
      console.log('  ✅ Full pipeline chạy xong qua job — completed, có candidate, CHƯA tự Apply');
    } else {
      console.log('     ℹ️  Package "@open-spaced-repetition/binding" chưa cài trong môi trường này — job vẫn phải completed dạng "failed" rõ ràng (không kẹt running), bỏ qua assertion về candidate.');
      assert.ok(['completed', 'failed'].includes(statusAfterRun.job.status));
    }

    const afterHistoryCountFull = await pool.query('SELECT COUNT(*)::int AS c FROM review_history WHERE user_id=$1', [TEST_USER]);
    assert.strictEqual(beforeHistoryCountFull.rows[0].c, afterHistoryCountFull.rows[0].c, 'runOptimizerJob() KHÔNG được thêm/xoá review_history (Phần 19/Test bắt buộc #9)');
    console.log('  ✅ review_history không đổi trước/sau khi chạy job thật (Test bắt buộc #9)');

    console.log('\n[Job — gọi runOptimizerJob() TRÙNG (job không còn "queued") → no-op an toàn, không chạy lại pipeline]');
    await optimizer.runOptimizerJob(created.job.id, TEST_USER); // job đã completed ở trên — claimQueuedJob() phải trả null
    const statusAfterDuplicateRun = await optimizer.getOptimizerStatus(TEST_USER);
    assert.strictEqual(statusAfterDuplicateRun.job.id, created.job.id, 'Vẫn là ĐÚNG job cũ, không tạo/chạy job mới nào khác');
    console.log('  ✅ Gọi runOptimizerJob() trùng trên job đã xong → no-op, an toàn (Phần "IDEMPOTENCY/CONCURRENCY")');

    // ════════════════════════════════════════════════════
    // Test B — application train-abort budget THẬT (binding thật, budget nhỏ) → job phải "failed" rõ ràng,
    // KHÔNG kẹt "running". `timeout` của official binding chỉ là progress-poll interval, nên test này
    // dùng FSRS_OPTIMIZER_TRAIN_ABORT_MS để ép abort có kiểm soát.
    // ════════════════════════════════════════════════════
    console.log('\n[Test B — application train-abort budget THẬT (binding thật, FSRS_OPTIMIZER_TRAIN_ABORT_MS=100) → job "failed", KHÔNG kẹt running, active weights không đổi]');
    let bindingInstalledForTimeoutTest = true;
    try { require('@open-spaced-repetition/binding'); } catch { bindingInstalledForTimeoutTest = false; }
    if (bindingInstalledForTimeoutTest) {
      const optimizerModulePath = require.resolve(path.join(__dirname, '..', 'lib', 'fsrs', 'optimizer'));
      const prevTrainAbortEnv = process.env.FSRS_OPTIMIZER_TRAIN_ABORT_MS;
      const prevProgressPollEnv = process.env.FSRS_OPTIMIZER_PROGRESS_POLL_MS;
      const enabledBeforeTimeout = (await optimizer.getOptimizerStatus(TEST_USER)).personalWeightsEnabled;
      const candidateBeforeTimeout = await pool.query('SELECT candidate_trained_at FROM user_fsrs_weights WHERE user_id = $1', [TEST_USER]);
      delete require.cache[optimizerModulePath];
      process.env.FSRS_OPTIMIZER_TRAIN_ABORT_MS = '100'; // 100ms — ép test đi qua đường abort có kiểm soát
      process.env.FSRS_OPTIMIZER_PROGRESS_POLL_MS = '1'; // poll nhanh để tín hiệu abort không chờ hàng trăm ms
      const optimizerWithTinyTimeout = require(optimizerModulePath);
      try {
        const jobTimeout = await optimizerWithTinyTimeout.createOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
        // V86: timeout compute nội bộ giờ được classifyOptimizerError() coi là RETRYABLE (có thể chỉ
        // do tải hệ thống — xem lib/fsrs/optimizer.js) → failOrRequeue() sẽ REQUEUE trước, không failed
        // ngay ở lần đầu như V85. Test B gốc chỉ muốn kiểm tra "timeout → kết thúc sạch, không kẹt
        // running" — ép max_attempts=1 để giữ ĐÚNG ý nghĩa gốc (timeout đầu tiên = hết lượt luôn).
        // Hành vi retry-trước-khi-fail được test riêng, đầy đủ, ở Test F/G phía trên.
        await pool.query('UPDATE fsrs_optimizer_jobs SET max_attempts = 1 WHERE id = $1', [jobTimeout.job.id]);
        await optimizerWithTinyTimeout.runOptimizerJob(jobTimeout.job.id, TEST_USER);
        const statusAfterTimeout = await optimizerWithTinyTimeout.getOptimizerStatus(TEST_USER);
        assert.strictEqual(statusAfterTimeout.job.status, 'failed', 'train-abort budget nhỏ → computeParameters() PHẢI dừng có kiểm soát → job "failed", KHÔNG kẹt "running" (Test B)');
        assert.ok(statusAfterTimeout.lastError, 'Job timeout phải có lastError (câu thông báo an toàn cho user)');
        assert.strictEqual(statusAfterTimeout.personalWeightsEnabled, enabledBeforeTimeout, 'Optimizer fail/timeout → active weights (enabled) PHẢI giữ nguyên, không đổi (Test bắt buộc F)');
        const candidateAfterTimeout = await pool.query('SELECT candidate_trained_at FROM user_fsrs_weights WHERE user_id = $1', [TEST_USER]);
        assert.deepStrictEqual(candidateAfterTimeout.rows[0], candidateBeforeTimeout.rows[0], 'Optimizer fail/timeout → candidate_weights cũ (từ lần chạy thành công trước đó) PHẢI giữ nguyên, KHÔNG bị đè bởi lần chạy fail (Test bắt buộc F)');
        console.log('  ✅ Train-abort budget thật → job "failed" đúng kỳ vọng, active/candidate weights không đổi (Test B/F)');

        console.log('\n[Test I — ĐÚNG kịch bản "train vượt application budget": abort có kiểm soát lặp lại nhiều lần → tự requeue-và-thử-lại, cuối cùng failed hẳn khi hết max_attempts]');
        const jobRetryLoop = await optimizerWithTinyTimeout.createOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
        assert.strictEqual(jobRetryLoop.job.attempt, 1);
        const maxAttemptsForLoop = jobRetryLoop.job.maxAttempts || 3;
        let lastLoopStatus = null;
        for (let i = 0; i < maxAttemptsForLoop + 1; i++) {
          // Mô phỏng ĐÚNG cơ chế thật: mỗi "lượt" ở đây tương ứng 1 invocation /worker MỚI tự kích
          // hoạt lại (api/index.js:triggerOptimizerWorker) sau khi lượt trước bị failOrRequeue()
          // requeue — ở integration test này gọi trực tiếp runOptimizerJob() lặp lại, KHÔNG qua HTTP
          // (giống toàn bộ file test này, không có server thật chạy).
          await optimizerWithTinyTimeout.runOptimizerJob(jobRetryLoop.job.id, TEST_USER);
          lastLoopStatus = await optimizerWithTinyTimeout.getOptimizerStatus(TEST_USER);
          if (lastLoopStatus.job.status === 'failed') break;
          assert.strictEqual(lastLoopStatus.job.status, 'queued', `Lượt ${i + 1}: timeout RETRYABLE, còn lượt → phải 'queued' (chờ claim lại), không phải trạng thái nào khác`);
        }
        assert.strictEqual(lastLoopStatus.job.status, 'failed', `Sau tối đa ${maxAttemptsForLoop + 1} lượt gọi runOptimizerJob(), job PHẢI kết thúc 'failed' HẲN — KHÔNG được lặp vô hạn (Phần IX "không retry vô hạn", đây chính là kịch bản "computeParameters() liên tục chậm/timeout" mà yêu cầu audit đặc biệt nhấn mạnh phải có test)`);
        assert.ok(lastLoopStatus.job.attempt >= maxAttemptsForLoop, `attempt cuối (${lastLoopStatus.job.attempt}) phải >= max_attempts (${maxAttemptsForLoop}) — chứng minh ĐÃ thử lại đủ số lần trước khi bỏ cuộc, không fail oan ở lần đầu`);
        console.log(`  ✅ train vượt application budget lặp lại ${maxAttemptsForLoop} lần → tự động requeue-và-thử-lại mỗi lần, CUỐI CÙNG failed hẳn đúng lúc hết lượt — không kẹt vô hạn`);
      } finally {
        if (prevTrainAbortEnv === undefined) delete process.env.FSRS_OPTIMIZER_TRAIN_ABORT_MS;
        else process.env.FSRS_OPTIMIZER_TRAIN_ABORT_MS = prevTrainAbortEnv;
        if (prevProgressPollEnv === undefined) delete process.env.FSRS_OPTIMIZER_PROGRESS_POLL_MS;
        else process.env.FSRS_OPTIMIZER_PROGRESS_POLL_MS = prevProgressPollEnv;
        delete require.cache[optimizerModulePath]; // dọn cache — module gốc không bị ảnh hưởng
      }
    } else {
      console.log('     ℹ️  Bỏ qua Test B — package "@open-spaced-repetition/binding" chưa cài trong môi trường này.');
    }

    // ════════════════════════════════════════════════════
    // Test K (V89) — BUG GỐC THẬT SỰ đã gây "mất heartbeat" dù dữ liệu bình thường: budget-guard
    // continuation (checkpoint 'prepared', xem runOptimizerJob()) TRẢ continuation:true nhưng KHÔNG
    // reset job về status='queued' trước — khiến invocation MỚI (do api/index.js tự kích hoạt ngay
    // sau đó) KHÔNG claim lại được (claimQueuedJob() đòi WHERE status='queued'), im lặng no-op, job
    // kẹt tới khi stale-recovery (180s) mới cứu được — tốn oan 1 attempt cho MỖI lần chuyển tiếp hoàn
    // toàn bình thường. KHÔNG cần binding thật cài được (guard trigger TRƯỚC khi gọi computeParameters
    // ()) — test này chạy được trong MỌI môi trường có Postgres, không phụ thuộc native binding.
    // ════════════════════════════════════════════════════
    console.log('\n[Test K (V89) — Budget-guard continuation PHẢI reset status=\'queued\' trước khi trả continuation:true (BUG GỐC gây "mất heartbeat" dù dữ liệu bình thường)]');
    const optimizerModulePathBudget = require.resolve(path.join(__dirname, '..', 'lib', 'fsrs', 'optimizer'));
    const prevBudgetEnv = process.env.FSRS_OPTIMIZER_WORKER_BUDGET_MS;
    const prevMinTrainEnv = process.env.FSRS_OPTIMIZER_MIN_TRAIN_BUDGET_MS;
    delete require.cache[optimizerModulePathBudget];
    process.env.FSRS_OPTIMIZER_WORKER_BUDGET_MS = '1'; // 1ms — ngân sách hết NGAY sau khi claim, đảm bảo guard trigger đúng lúc sau prepare (chưa kịp train)
    process.env.FSRS_OPTIMIZER_MIN_TRAIN_BUDGET_MS = '1000000'; // rất lớn — đảm bảo budgetLeftMs() luôn nhỏ hơn, chắc chắn trigger guard mỗi lần
    const optimizerWithTinyBudget = require(optimizerModulePathBudget);
    try {
      const jobBudget = await optimizerWithTinyBudget.createOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
      const result = await optimizerWithTinyBudget.runOptimizerJob(jobBudget.job.id, TEST_USER);
      assert.strictEqual(result.continuation, true, 'budget=1ms → phải trigger continuation NGAY sau prepare (chưa kịp chạm tới train)');

      // ĐÂY LÀ ASSERTION QUAN TRỌNG NHẤT của toàn bộ file test này — TRƯỚC khi sửa bug V89, status ở
      // đây vẫn là 'running' (BUG); SAU khi sửa, PHẢI là 'queued' để invocation tiếp theo claim lại được.
      const rowAfterContinuation = await pool.query(
        `SELECT status, stage, (training_payload IS NOT NULL) as has_payload FROM fsrs_optimizer_jobs WHERE id = $1`,
        [jobBudget.job.id]
      );
      assert.strictEqual(rowAfterContinuation.rows[0].status, 'queued', `BUG GỐC V89: sau continuation:true, job PHẢI ở status='queued' để invocation MỚI claim lại được — nếu vẫn 'running', continuation luôn no-op và job kẹt tới khi stale-recovery (180s) mới cứu, tốn oan 1 attempt/lần (ĐÚNG nguyên nhân "mất heartbeat" dù dữ liệu bình thường, dataset nhỏ)`);
      assert.strictEqual(rowAfterContinuation.rows[0].has_payload, true, 'training_payload phải còn nguyên để invocation mới resume, không load/validate lại từ đầu');

      // Mô phỏng ĐÚNG cơ chế thật: api/index.js tự kích hoạt lại /worker ngay khi thấy continuation:
      // true — ở đây gọi thẳng claimQueuedJob() lần 2 (không qua HTTP, giống style cả file test này).
      const claimedAgain = await optimizerWithTinyBudget.claimQueuedJob(jobBudget.job.id, TEST_USER);
      assert.ok(claimedAgain, 'invocation MỚI PHẢI claim lại được job (status đã đúng \'queued\') — trước khi sửa bug, đây sẽ là null (no-op hoàn toàn, đúng bug đã báo cáo)');
      assert.strictEqual(claimedAgain.stage, 'prepared', 'claim lại đúng vào stage \'prepared\' (đã có training_payload) — KHÔNG load/validate lại từ đầu');
      assert.strictEqual(claimedAgain.attempt, 1, 'attempt KHÔNG được tăng chỉ vì continuation bình thường (khác nhánh lỗi trong failOrRequeue) — đây là chuyển tiếp trong CÙNG 1 attempt, không phải 1 lần thử lại mới do lỗi');
      console.log('  ✅ Budget-guard continuation: status reset đúng về \'queued\', invocation mới claim lại thành công NGAY, KHÔNG tốn oan attempt (BUG GỐC V89 đã sửa)');
    } finally {
      if (prevBudgetEnv === undefined) delete process.env.FSRS_OPTIMIZER_WORKER_BUDGET_MS; else process.env.FSRS_OPTIMIZER_WORKER_BUDGET_MS = prevBudgetEnv;
      if (prevMinTrainEnv === undefined) delete process.env.FSRS_OPTIMIZER_MIN_TRAIN_BUDGET_MS; else process.env.FSRS_OPTIMIZER_MIN_TRAIN_BUDGET_MS = prevMinTrainEnv;
      delete require.cache[optimizerModulePathBudget]; // dọn cache — module gốc `optimizer` (budget mặc định 50s) không bị ảnh hưởng
    }

    console.log('\n════════════════════════════════════════════════════');
    console.log('\n[V87 (Postgres thật) — GET /status vẫn trả JSON hợp lệ, KHÔNG throw, KHÔNG chạm native optimizer, dù package @open-spaced-repetition/binding có cài được trên máy chạy test hay không]');
    // Đây là bản THỰC THI ĐẦY ĐỦ (có DB thật) của Test bắt buộc ở Phần XVI — khác bản trong
    // test/fsrs-optimizer.test.js (chỉ kiểm tra TĨNH source text, không cần Postgres). Ở đây gọi
    // getOptimizerStatus() THẬT, với DB THẬT, để chứng minh toàn bộ đường đi thật sự không throw dù
    // môi trường chạy test này có/không có native binding — vì bản thân hàm KHÔNG CÒN đụng tới nó nữa.
    let bindingInstalledForStatusTest = true;
    try { require('@open-spaced-repetition/binding'); } catch { bindingInstalledForStatusTest = false; }
    console.log(`     ℹ️  Package @open-spaced-repetition/binding ${bindingInstalledForStatusTest ? 'ĐÃ' : 'CHƯA'} cài trên máy chạy test này — cả 2 trường hợp GET /status đều PHẢI trả JSON hợp lệ như nhau.`);

    const statusForUser = await optimizer.getOptimizerStatus(TEST_USER, { isAdmin: false });
    assert.ok(statusForUser && typeof statusForUser === 'object', 'getOptimizerStatus() phải trả về 1 object, không throw');
    assert.strictEqual(statusForUser.optimizerEngineState, 'UNKNOWN', "Phần III — mặc định PHẢI là 'UNKNOWN' vì /status không còn tự thăm dò native nữa");
    assert.strictEqual(statusForUser.bindingAvailable, null, "Phần III — bindingAvailable PHẢI null (không phải true/false — true/false ngụ ý ĐÃ thăm dò, điều KHÔNG được xảy ra ở đây)");
    assert.strictEqual(typeof statusForUser.bindingVersion, 'string', 'bindingVersion (đọc package.json thuần — an toàn) vẫn nên có nếu package đã cài; ít nhất không throw');
    // Phải serialize được thành JSON sạch (đúng những gì GET /status thật sự trả cho browser qua res.json())
    assert.doesNotThrow(() => JSON.stringify(statusForUser), 'kết quả phải serialize JSON được — đúng cái browser sẽ nhận qua fetch().json()');
    console.log('  ✅ GET /status (qua getOptimizerStatus() thật, DB thật) trả JSON hợp lệ, optimizerEngineState=UNKNOWN, bindingAvailable=null — không còn phụ thuộc native (Test bắt buộc Phần XVI)');

    const statusForAdmin = await optimizer.getOptimizerStatus(TEST_USER, { isAdmin: true });
    assert.strictEqual(statusForAdmin.optimizerEngineState, 'UNKNOWN');
    assert.strictEqual(statusForAdmin.engineStatus, undefined, "Field 'engineStatus' cũ (V85) đã bị xoá hẳn khỏi response — không còn field nào chứa dữ liệu lấy từ native probe trong /status nữa, kể cả cho admin");
    console.log('  ✅ Admin gọi GET /status cũng KHÔNG kích hoạt native probe (field engineStatus cũ đã xoá hẳn, không chỉ ẩn)');

    console.log('\n[Test J (V87) — getOptimizerDiagnostics() Tầng 1 (mặc định) vs Tầng 2 (probe=true) — Postgres KHÔNG liên quan (hàm này không đụng DB), chạy lại ở đây để xác nhận nhất quán với bản pure-JS]');
    const diagSafe = optimizer.getOptimizerDiagnostics({ probe: false });
    assert.strictEqual(diagSafe.probed, false);
    assert.strictEqual(diagSafe.available, null);
    const diagProbed = optimizer.getOptimizerDiagnostics({ probe: true });
    assert.strictEqual(diagProbed.probed, true);
    assert.strictEqual(diagProbed.available, bindingInstalledForStatusTest, 'kết quả probe=true phải khớp ĐÚNG với thực tế package có cài được hay không trên máy này');
    console.log(`  ✅ getOptimizerDiagnostics: Tầng 1 an toàn (probed=false), Tầng 2 phản ánh đúng thực tế (available=${diagProbed.available})`);

    console.log('\n[AUDIT V91 – FIX FSRS OPTIMIZER DỨT ĐIỂM — browser-side training, full server flow THẬT trên Postgres]');
    await pool.query(`DELETE FROM fsrs_optimizer_jobs WHERE user_id = $1`, [TEST_USER]);
    // Dùng LẠI review_history tổng hợp đã insert ở trên (2.400 review/60 thẻ) — prepareOptimizerData()
    // dùng chung logic đọc/validate với đường server cũ, không cần sinh dữ liệu riêng.

    console.log('\n[Test browser-A — createBrowserOptimizerJob(): tạo job, KHÔNG train, trả về training payload]');
    const b1 = await optimizer.createBrowserOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
    assert.strictEqual(b1.created, true);
    assert.strictEqual(b1.job.status, 'running', 'job browser-training vào thẳng running (không có bước queued riêng — chuẩn bị dữ liệu vốn đã nhanh, Phần III)');
    assert.ok(b1.trainingPayload && Array.isArray(b1.trainingPayload.train) && Array.isArray(b1.trainingPayload.validation), 'phải trả về train/validation cho FE tự tạo Worker (Phần III bước 3-4)');
    assert.ok(Array.isArray(b1.trainingPayload.defaultWeights) && b1.trainingPayload.defaultWeights.length === 21);
    console.log('  ✅ Tạo job browser-training thành công, trả đủ payload cho FE — KHÔNG có lời gọi train nào ở server (xem test tĩnh ở fsrs-optimizer.test.js)');

    console.log('\n[Test browser-B — gọi lại createBrowserOptimizerJob() khi đang có job active → KHÔNG tạo job thứ 2 (Test bắt buộc #14/#15)]');
    const b2 = await optimizer.createBrowserOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
    assert.strictEqual(b2.created, false);
    assert.strictEqual(b2.job.id, b1.job.id);
    console.log('  ✅ Double-click Run / 2 tab cùng Run → chỉ 1 job, tái sử dụng đúng job đang active');

    console.log('\n[Test browser-C — updateBrowserJobHeartbeat(): đúng chủ mới cập nhật được, sai user_id thì KHÔNG]');
    const okHeartbeat = await optimizer.updateBrowserJobHeartbeat(b1.job.id, TEST_USER, { stage: 'training', progressCurrent: 5, progressTotal: 20 });
    assert.strictEqual(okHeartbeat, true);
    const wrongUserHeartbeat = await optimizer.updateBrowserJobHeartbeat(b1.job.id, '__someone_else__', { stage: 'training' });
    assert.strictEqual(wrongUserHeartbeat, false, 'user khác KHÔNG được phép cập nhật heartbeat của job này (Test bắt buộc #17)');
    console.log('  ✅ Keepalive đúng chủ mới thành công; user khác bị chặn ở tầng SQL');

    console.log('\n[Test browser-D — commitBrowserOptimizerResult(): sai chủ bị chặn (Test bắt buộc #18), weights hợp lệ + đúng chủ thì lưu thành công]');
    const fakeTrainedWeights = Array.from({ length: 21 }, (_, i) => 0.4 + i * 0.03);
    await assert.rejects(
      () => optimizer.commitBrowserOptimizerResult(b1.job.id, '__someone_else__', { weights: fakeTrainedWeights }),
      /không thuộc về bạn|không tồn tại/,
      'user khác KHÔNG được commit kết quả vào job không phải của mình'
    );
    const committed = await optimizer.commitBrowserOptimizerResult(b1.job.id, TEST_USER, { weights: fakeTrainedWeights });
    assert.ok(committed && typeof committed.improvement !== 'undefined');
    assert.strictEqual(committed.meta.optimizerEngine, 'browser-wasm', 'meta phải ghi rõ train trong trình duyệt, không phải native/wasi phía server');
    assert.strictEqual(committed.meta.trainedIn, 'browser');
    const statusAfterCommit = await optimizer.getOptimizerStatus(TEST_USER);
    assert.strictEqual(statusAfterCommit.job.status, 'completed');
    assert.strictEqual(statusAfterCommit.hasCandidate, true, 'candidate phải được lưu sau commit thành công, giống hệt đường server cũ (dùng chung finishJobWithCandidate)');
    console.log('  ✅ Commit thành công → candidate lưu đúng, đánh dấu rõ trainedIn=browser — Apply/Rollback/Reset ở bước sau KHÔNG cần biết gì khác (dùng lại nguyên vẹn)');

    console.log('\n[Test browser-E — commitBrowserOptimizerResult(): weights sai hình dạng KHÔNG làm hỏng job đang chạy (vẫn running sau khi bị từ chối)]');
    await pool.query(`DELETE FROM fsrs_optimizer_jobs WHERE user_id = $1`, [TEST_USER]);
    const b3 = await optimizer.createBrowserOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
    await assert.rejects(() => optimizer.commitBrowserOptimizerResult(b3.job.id, TEST_USER, { weights: [1, 2, 3] }));
    const statusAfterBadCommit = await optimizer.getOptimizerStatus(TEST_USER);
    assert.strictEqual(statusAfterBadCommit.job.status, 'running', 'weights sai hình dạng bị từ chối nhưng job KHÔNG bị đổi trạng thái — FE có thể thử commit lại với kết quả train khác nếu muốn');
    console.log('  ✅ Commit hỏng không làm hỏng job — vẫn running, có thể thử lại');

    console.log('\n[Test browser-F — cancelBrowserJob(): Hủy khi user đóng modal/bấm Hủy (Phần VII)]');
    const cancelled = await optimizer.cancelBrowserJob(b3.job.id, TEST_USER);
    assert.strictEqual(cancelled, true);
    const statusAfterCancel = await optimizer.getOptimizerStatus(TEST_USER);
    assert.strictEqual(statusAfterCancel.job.status, 'cancelled');
    await assert.rejects(() => optimizer.commitBrowserOptimizerResult(b3.job.id, TEST_USER, { weights: fakeTrainedWeights }), /không tồn tại|đã kết thúc/, 'không commit được vào job đã hủy');
    console.log('  ✅ Hủy đúng cách — job chuyển cancelled, không nhận commit trễ sau đó nữa');

    console.log('\n[Test browser-G — job bị "bỏ rơi" (đóng tab, không còn keepalive) → recoverStaleJobsForUser() đánh FAILED trực tiếp, KHÔNG requeue cho server train (Phần VI)]');
    await pool.query(`DELETE FROM fsrs_optimizer_jobs WHERE user_id = $1`, [TEST_USER]);
    const b4 = await optimizer.createBrowserOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
    // Giả lập "đã lâu không có keepalive" bằng cách lùi heartbeat_at ra sau ngưỡng stale, KHÔNG cần chờ thật.
    await pool.query(`UPDATE fsrs_optimizer_jobs SET heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [b4.job.id]);
    await optimizer.hasActiveJob(TEST_USER); // side-effect: gọi recoverStaleJobsForUser() nội bộ
    const statusAfterAbandoned = await optimizer.getOptimizerStatus(TEST_USER);
    assert.strictEqual(statusAfterAbandoned.job.status, 'failed', 'job browser bị bỏ rơi PHẢI thành failed trực tiếp — KHÔNG bao giờ quay lại queued (không có server worker nào sẽ claim/train tiếp)');
    console.log('  ✅ Job trình duyệt bị bỏ rơi → failed rõ ràng ngay, không kẹt vô thời hạn, không tốn oan chu trình requeue (đúng gốc rễ lỗi đã audit)');

  } finally {
    await pool.query('DELETE FROM fsrs_cards WHERE user_id = $1', [TEST_USER]);
    await pool.query('DELETE FROM review_history WHERE user_id = $1', [TEST_USER]);
    await pool.query('DELETE FROM user_fsrs_weights WHERE user_id = $1', [TEST_USER]);
    await pool.query('DELETE FROM fsrs_optimizer_jobs WHERE user_id = $1', [TEST_USER]);
    await pool.end();
  }
}

main().catch((e) => {
  console.error('❌ Integration test lỗi:', e && e.message);
  process.exitCode = 1;
});
