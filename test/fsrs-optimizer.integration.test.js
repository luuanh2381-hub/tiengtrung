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
    await pool.query(
      `UPDATE fsrs_optimizer_jobs SET created_at = now() - interval '10 minutes', heartbeat_at = now() - interval '10 minutes' WHERE id = $1`,
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
    await pool.query(`UPDATE fsrs_optimizer_jobs SET heartbeat_at = now() - interval '4 minutes' WHERE id = $1`, [jobC.job.id]); // > 180s mặc định, KHÔNG có updateJobHeartbeat() nào chạy tiếp sau đó — đúng mô phỏng "worker chết thật"
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
    await pool.query(`UPDATE fsrs_optimizer_jobs SET heartbeat_at = now() - interval '10 minutes', started_at = now() - interval '10 minutes' WHERE id = $1`, [jobD.job.id]);
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
    // Test B (V85-HEARTBEAT-FIX, "TEST TỐI THIỂU") — computeParameters() timeout THẬT (binding thật,
    // timeout cực nhỏ) → job phải "failed" rõ ràng, KHÔNG kẹt "running". Cần binding thật cài được
    // (SKIP nếu chưa cài, giống style "full pipeline THẬT" ở trên) — CHỈ ĐỌC lại module với
    // FSRS_OPTIMIZER_TIMEOUT_MS cực nhỏ (OPTIMIZER_COMPUTE_TIMEOUT_MS là hằng số đọc 1 LẦN lúc
    // require() — muốn đổi giá trị PHẢI xoá cache rồi require() lại, KHÔNG sửa được bằng cách set
    // process.env sau khi module gốc đã load).
    // ════════════════════════════════════════════════════
    console.log('\n[Test B — computeParameters() timeout THẬT (binding thật, FSRS_OPTIMIZER_TIMEOUT_MS=1) → job "failed", KHÔNG kẹt running, active weights không đổi]');
    let bindingInstalledForTimeoutTest = true;
    try { require('@open-spaced-repetition/binding'); } catch { bindingInstalledForTimeoutTest = false; }
    if (bindingInstalledForTimeoutTest) {
      const optimizerModulePath = require.resolve(path.join(__dirname, '..', 'lib', 'fsrs', 'optimizer'));
      const prevTimeoutEnv = process.env.FSRS_OPTIMIZER_TIMEOUT_MS;
      const enabledBeforeTimeout = (await optimizer.getOptimizerStatus(TEST_USER)).personalWeightsEnabled;
      const candidateBeforeTimeout = await pool.query('SELECT candidate_trained_at FROM user_fsrs_weights WHERE user_id = $1', [TEST_USER]);
      delete require.cache[optimizerModulePath];
      process.env.FSRS_OPTIMIZER_TIMEOUT_MS = '1'; // 1ms — chắc chắn không đủ cho computeParameters() thật trên dataset đã sinh ở trên
      const optimizerWithTinyTimeout = require(optimizerModulePath);
      try {
        const jobTimeout = await optimizerWithTinyTimeout.createOptimizerJob(TEST_USER, { desiredRetention: 0.9 });
        await optimizerWithTinyTimeout.runOptimizerJob(jobTimeout.job.id, TEST_USER);
        const statusAfterTimeout = await optimizerWithTinyTimeout.getOptimizerStatus(TEST_USER);
        assert.strictEqual(statusAfterTimeout.job.status, 'failed', 'timeout cực nhỏ (1ms) → computeParameters() PHẢI bị timeout → job "failed", KHÔNG kẹt "running" (Test bắt buộc B)');
        assert.ok(statusAfterTimeout.lastError, 'Job timeout phải có lastError (câu thông báo an toàn cho user)');
        assert.strictEqual(statusAfterTimeout.personalWeightsEnabled, enabledBeforeTimeout, 'Optimizer fail/timeout → active weights (enabled) PHẢI giữ nguyên, không đổi (Test bắt buộc F)');
        const candidateAfterTimeout = await pool.query('SELECT candidate_trained_at FROM user_fsrs_weights WHERE user_id = $1', [TEST_USER]);
        assert.deepStrictEqual(candidateAfterTimeout.rows[0], candidateBeforeTimeout.rows[0], 'Optimizer fail/timeout → candidate_weights cũ (từ lần chạy thành công trước đó) PHẢI giữ nguyên, KHÔNG bị đè bởi lần chạy fail (Test bắt buộc F)');
        console.log('  ✅ Timeout thật (FSRS_OPTIMIZER_TIMEOUT_MS=1) → job "failed" đúng kỳ vọng, active/candidate weights không đổi (Test bắt buộc B/F)');
      } finally {
        if (prevTimeoutEnv === undefined) delete process.env.FSRS_OPTIMIZER_TIMEOUT_MS;
        else process.env.FSRS_OPTIMIZER_TIMEOUT_MS = prevTimeoutEnv;
        delete require.cache[optimizerModulePath]; // dọn cache — module gốc `optimizer` (timeout mặc định 45s) không bị ảnh hưởng
      }
    } else {
      console.log('     ℹ️  Bỏ qua Test B — package "@open-spaced-repetition/binding" chưa cài trong môi trường này.');
    }

    console.log('\n════════════════════════════════════════════════════');
    console.log('Tất cả integration test (FSRS Personal Optimizer) PASS');
    console.log('════════════════════════════════════════════════════');
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
