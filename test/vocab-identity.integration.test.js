#!/usr/bin/env node
// ════════════════════════════════════════════════════
// test/vocab-identity.integration.test.js  (V93)
//
// Cover đầy đủ các case CẦN Postgres thật (không thể test bằng pure function) — Phần 14 audit:
//   Case 1  — Thêm từ hoàn toàn mới.
//   Case 2  — Thêm từ đã tồn tại nhưng khác lesson (không tạo bản ghi mới, chỉ thêm quan hệ).
//   Case 5  — Import 1 lô có 2 dòng CÙNG hz khác lesson (mô phỏng Excel) -> chỉ 1 vocab_words.
//   Case 7  — Một từ xuất hiện ở 5 lesson.
//   Case 8  — User review 1 từ -> fsrs_cards/review_history.word_id được gán đúng canonical.
//   Case 9  — Giả lập 2 vocab_words trùng hz (dữ liệu kiểu "trước migration") + mỗi bên có FSRS
//             riêng của CÙNG 1 user -> chạy scripts/migrate-vocab-identity.js -> verify gộp đúng,
//             KHÔNG mất review_history, giữ canonical ID, thẻ "tiến bộ hơn" (reps cao hơn) sống sót.
//   Case 10 — Review history tồn tại trước migration -> sau migration KHÔNG giảm.
//   Case 12 — Chạy migration LẦN THỨ HAI (idempotent) -> không đổi/tạo thêm gì.
// + Kiểm tra "FSRS reference integrity": không tạo card thứ 2 khi cùng 1 từ được review qua 2
//   lesson khác nhau (đúng yêu cầu cốt lõi của audit).
//
// (Case 3/4/6/11 — quy tắc merge field/pinyin/meaning/tag — đã có unit test ĐẦY ĐỦ, chạy được
// không cần DB, ở test/vocab-merge.test.js; ở đây chỉ verify lại 1 lần nữa qua đường API thật
// importVocab() để đảm bảo tích hợp đúng, không lặp lại toàn bộ ma trận test.)
//
// CẦN Postgres thật (DATABASE_URL) — tự SKIP an toàn (exit 0) nếu chưa cấu hình, đúng convention
// test/fsrs.concurrency.integration.js. TOÀN BỘ dữ liệu test dùng tiền tố __itest_v93__ riêng,
// KHÔNG đụng dữ liệu thật, tự dọn dẹp trước và sau (kể cả khi test fail giữa chừng).
//
// ⚠️ Chạy trên bản sao/staging trước khi chạy trên DATABASE_URL production, vì test này TỰ CHẠY
// scripts/migrate-vocab-identity.js thật (dù script đó tự transaction + tự verify + tự rollback
// nếu bất thường, và test chỉ tạo dữ liệu riêng có tiền tố __itest_v93__).
//
// Chạy: DATABASE_URL=postgres://... node test/vocab-identity.integration.test.js
// ════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const HZ_PREFIX = '__itest93_';
const TEST_USER = '__integration_test_user_v93__';
const L1 = 999101, L2 = 999102, L3 = 999103, L4 = 999104, L5 = 999105;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('⏭️  SKIP: chưa cấu hình DATABASE_URL — test này cần Postgres thật.');
    console.log('   Chạy lại với: DATABASE_URL=postgres://... node test/vocab-identity.integration.test.js');
    return;
  }

  const db = require(path.join(__dirname, '..', 'lib', 'db'));
  const pool = db.getPool();

  console.log('════════════════════════════════════════════════════');
  console.log('V93 — vocab identity: integration test (cần Postgres thật)');
  console.log('════════════════════════════════════════════════════');

  async function cleanup() {
    // Thứ tự QUAN TRỌNG: fsrs_cards/review_history có FK -> vocab_words.id (không CASCADE), phải
    // xoá TRƯỚC vocab_words, nếu không sẽ dính lỗi vi phạm khoá ngoại.
    await pool.query('DELETE FROM fsrs_cards WHERE user_id = $1', [TEST_USER]);
    await pool.query('DELETE FROM review_history WHERE user_id = $1', [TEST_USER]);
    await pool.query(`DELETE FROM vocab_lessons WHERE word_id IN (SELECT id FROM vocab_words WHERE hz LIKE $1)`, [HZ_PREFIX + '%']);
    await pool.query('DELETE FROM vocab_words WHERE hz LIKE $1', [HZ_PREFIX + '%']);
  }

  let passed = 0, failed = 0;
  async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
  }

  await cleanup(); // dọn rác từ lần chạy trước bị ngắt giữa chừng (nếu có)

  try {
    console.log('\n[Case 1 — Thêm từ hoàn toàn mới]');
    const hz1 = HZ_PREFIX + 'A';
    await test('importVocab từ mới -> added=1, tạo đúng 1 vocab_words', async () => {
      const r = await db.importVocab([{ hz: hz1, py: 'py-a', vi: 'nghĩa A', l: L1 }], false);
      assert.strictEqual(r.added, 1);
      const found = await db.findVocabWordByHz(hz1);
      assert.ok(found, 'phải tìm thấy từ vừa thêm');
      assert.deepStrictEqual(found.lessons, [L1]);
    });

    console.log('\n[Case 2 — Thêm từ đã tồn tại nhưng khác lesson]');
    await test('import lại CÙNG hz, khác lesson, overwrite=false -> KHÔNG tạo bản ghi mới, chỉ thêm quan hệ', async () => {
      const r = await db.importVocab([{ hz: hz1, py: 'py-a-khac', vi: 'nghĩa khác', l: L2 }], false);
      assert.strictEqual(r.added, 0, 'không được tạo vocab_words mới');
      assert.strictEqual(r.lessonLinked, 1, 'phải ghi nhận đã gắn thêm 1 lesson');
      const found = await db.findVocabWordByHz(hz1);
      assert.strictEqual(found.vi, 'nghĩa A', 'overwrite=false phải GIỮ NGUYÊN nghĩa cũ');
      assert.deepStrictEqual(found.lessons, [L1, L2], 'phải có đủ cả 2 lesson');
      const countRows = await pool.query('SELECT COUNT(*)::int AS c FROM vocab_words WHERE hz=$1', [hz1]);
      assert.strictEqual(countRows.rows[0].c, 1, 'TUYỆT ĐỐI không được có 2 dòng vocab_words cho cùng 1 hz');
    });

    console.log('\n[Case 3/4 (verify tích hợp, chi tiết đã test ở vocab-merge.test.js) — overwrite ON cập nhật đúng]');
    await test('overwrite=true -> cập nhật metadata theo quy tắc merge, vẫn giữ canonical id', async () => {
      const before = await db.findVocabWordByHz(hz1);
      const r = await db.importVocab([{ hz: hz1, py: 'py-a-day-du-hon', vi: 'nghĩa A; nghĩa khác; nghĩa mới', l: L2 }], true);
      assert.strictEqual(r.updated, 1);
      const after = await db.findVocabWordByHz(hz1);
      assert.strictEqual(after.id, before.id, 'canonical ID phải GIỮ NGUYÊN qua các lần update');
      assert.ok(after.vi.includes('nghĩa mới'));
    });

    console.log('\n[Case 5 — Import 1 lô có 2 dòng CÙNG hz khác lesson (mô phỏng file Excel)]');
    const hz2 = HZ_PREFIX + 'B';
    await test('1 lần importVocab với 2 dòng trùng hz -> chỉ tạo 1 vocab_words, cả 2 lesson đều được gắn', async () => {
      const r = await db.importVocab([
        { hz: hz2, py: 'py-b', vi: 'nghĩa B', l: L1 },
        { hz: hz2, py: 'py-b', vi: 'nghĩa B mở rộng', l: L3 },
      ], true);
      assert.strictEqual(r.added, 1);
      const found = await db.findVocabWordByHz(hz2);
      assert.deepStrictEqual(found.lessons, [L1, L3]);
    });

    console.log('\n[Case 7 — Một từ xuất hiện ở 5 lesson]');
    const hz3 = HZ_PREFIX + 'C';
    await test('thêm cùng 1 từ vào 5 lesson khác nhau -> 1 vocab_words, 5 quan hệ vocab_lessons', async () => {
      for (const l of [L1, L2, L3, L4, L5]) {
        await db.importVocab([{ hz: hz3, py: 'py-c', vi: 'nghĩa C', l }], false);
      }
      const found = await db.findVocabWordByHz(hz3);
      assert.deepStrictEqual(found.lessons, [L1, L2, L3, L4, L5]);
      const rows = await pool.query('SELECT COUNT(*)::int AS c FROM vocab_words WHERE hz=$1', [hz3]);
      assert.strictEqual(rows.rows[0].c, 1);
      // Mỗi lesson riêng lẻ đều phải thấy đúng từ này (không "biến mất" khỏi bài phụ)
      for (const l of [L1, L2, L3, L4, L5]) {
        const byLesson = await db.getVocabByLessons([l]);
        assert.ok(byLesson.some(w => w.hz === hz3), `từ phải xuất hiện khi lọc theo lesson ${l}`);
      }
    });

    console.log('\n[FSRS reference integrity — review cùng 1 từ qua 2 lesson khác nhau KHÔNG tạo 2 thẻ]');
    const hz4 = HZ_PREFIX + 'D';
    await test('review qua lesson khác nhau vẫn dùng chung đúng 1 fsrs_card (Case 8)', async () => {
      await db.importVocab([{ hz: hz4, py: 'py-d', vi: 'nghĩa D', l: L1 }], false);
      await db.importVocab([{ hz: hz4, py: 'py-d', vi: 'nghĩa D', l: L2 }], false);
      const word = await db.findVocabWordByHz(hz4);

      const r1 = await db.reviewFsrsCard({ userId: TEST_USER, hz: hz4, l: L1, answerCorrect: true, responseTimeMs: 1000, answerChanges: 0, desiredRetention: 0.9, idempotencyKey: 'v93-case8-a' });
      assert.strictEqual(r1.ok, true);
      // Giả lập user quay lại ôn từ NÀY nhưng thông qua context Bài L2 (như thể client fetch theo
      // lesson khác) — reviewFsrsCard vẫn PHẢI resolve về đúng CÙNG 1 canonical word, không tạo thẻ mới.
      const r2 = await db.reviewFsrsCard({ userId: TEST_USER, hz: hz4, l: L2, answerCorrect: true, responseTimeMs: 1100, answerChanges: 0, desiredRetention: 0.9, idempotencyKey: 'v93-case8-b' });
      assert.strictEqual(r2.ok, true);

      const cards = await pool.query('SELECT * FROM fsrs_cards WHERE user_id=$1 AND word_id=$2', [TEST_USER, word.id]);
      assert.strictEqual(cards.rows.length, 1, 'CHỈ được có đúng 1 fsrs_card cho (user, word) dù review qua 2 lesson khác nhau');
      assert.strictEqual(cards.rows[0].reps, 2, 'cả 2 lượt review đều phải cộng dồn vào ĐÚNG 1 thẻ (reps=2)');

      const hist = await pool.query('SELECT COUNT(*)::int AS c FROM review_history WHERE user_id=$1 AND word_id=$2', [TEST_USER, word.id]);
      assert.strictEqual(hist.rows[0].c, 2, 'phải có đủ 2 dòng lịch sử, đều gắn đúng word_id');
    });

    console.log('\n[Case 9 + 10 — Giả lập duplicate "kiểu trước migration" + chạy scripts/migrate-vocab-identity.js]');
    const hzDup = HZ_PREFIX + 'DUP';
    let idOld, idNew, beforeReviewHistoryTotal;
    await test('setup: 2 vocab_words trùng hz (giả lập dữ liệu CŨ), mỗi bên có FSRS riêng của CÙNG 1 user', async () => {
      // Tạo trực tiếp bằng SQL thô (bỏ qua lớp ứng dụng) để mô phỏng ĐÚNG dữ liệu "trước V93": 2 dòng
      // vocab_words cùng hz, khác lesson — điều mà bulkUpsertVocab mới KHÔNG BAO GIỜ tự tạo ra nữa.
      const insOld = await pool.query(`INSERT INTO vocab_words (hz,py,vi,l,tag) VALUES ($1,'py-old','học',$2,NULL) RETURNING id`, [hzDup, L1]);
      idOld = insOld.rows[0].id;
      const insNew = await pool.query(`INSERT INTO vocab_words (hz,py,vi,l,tag) VALUES ($1,'py-new','học tập; học hỏi',$2,NULL) RETURNING id`, [hzDup, L4]);
      idNew = insNew.rows[0].id;
      await pool.query(`INSERT INTO vocab_lessons (word_id, lesson) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [idOld, L1]);
      await pool.query(`INSERT INTO vocab_lessons (word_id, lesson) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [idNew, L4]);

      // Card 1 (gắn với bản ghi CŨ, id nhỏ hơn) — ÍT reps hơn, review lâu rồi.
      await pool.query(
        `INSERT INTO fsrs_cards (user_id,hz,l,state,due,stability,difficulty,elapsed_days,scheduled_days,reps,lapses,last_review)
         VALUES ($1,$2,$3,2,now(),5,5,10,10,3,0, now() - interval '10 days')`,
        [TEST_USER, hzDup, L1]
      );
      // Card 2 (gắn với bản ghi MỚI) — NHIỀU reps hơn, review gần đây hơn -> phải THẮNG (sống sót).
      await pool.query(
        `INSERT INTO fsrs_cards (user_id,hz,l,state,due,stability,difficulty,elapsed_days,scheduled_days,reps,lapses,last_review)
         VALUES ($1,$2,$3,2,now(),8,4,3,3,9,1, now() - interval '1 days')`,
        [TEST_USER, hzDup, L4]
      );
      for (const l of [L1, L4]) {
        await pool.query(
          `INSERT INTO review_history (user_id,hz,l,rating,answer_correct,reviewed_at,previous_state,new_state,previous_due,new_due,previous_stability,new_stability,previous_difficulty,new_difficulty,scheduled_days)
           VALUES ($1,$2,$3,'good',true,now(),0,2,now(),now(),0,5,0,5,1)`,
          [TEST_USER, hzDup, l]
        );
      }
      beforeReviewHistoryTotal = (await pool.query('SELECT COUNT(*)::int AS c FROM review_history WHERE user_id=$1 AND hz=$2', [TEST_USER, hzDup])).rows[0].c;
      assert.strictEqual(beforeReviewHistoryTotal, 2);
    });

    await test('chạy scripts/migrate-vocab-identity.js thật (DRY_RUN=1) -> không ghi gì, không lỗi', () => {
      const scriptPath = path.join(__dirname, '..', 'scripts', 'migrate-vocab-identity.js');
      const out = execFileSync('node', [scriptPath], { env: { ...process.env, DRY_RUN: '1' }, encoding: 'utf8' });
      assert.ok(out.includes('DRY RUN'), 'phải chạy đúng chế độ dry-run');
      assert.ok(out.includes('ROLLBACK'), 'dry-run phải kết thúc bằng rollback, không commit');
    });

    await test('DRY_RUN không ghi gì thật -> vẫn còn đúng 2 dòng vocab_words trùng hzDup như setup', async () => {
      const rows = await pool.query('SELECT COUNT(*)::int AS c FROM vocab_words WHERE hz=$1', [hzDup]);
      assert.strictEqual(rows.rows[0].c, 2);
    });

    await test('chạy scripts/migrate-vocab-identity.js THẬT -> gộp đúng, không lỗi', () => {
      const scriptPath = path.join(__dirname, '..', 'scripts', 'migrate-vocab-identity.js');
      const out = execFileSync('node', [scriptPath], { env: process.env, encoding: 'utf8' });
      assert.ok(out.includes('COMMIT thành công'), 'migration thật phải commit thành công');
    });

    await test('SAU migration: chỉ còn 1 vocab_words cho hzDup, GIỮ canonical ID nhỏ hơn (idOld)', async () => {
      const rows = await pool.query('SELECT * FROM vocab_words WHERE hz=$1', [hzDup]);
      assert.strictEqual(rows.rows.length, 1, 'phải gộp về đúng 1 bản ghi');
      assert.strictEqual(rows.rows[0].id, idOld, 'phải GIỮ canonical ID = id nhỏ nhất (Phần 3/4 audit)');
      assert.ok(rows.rows[0].vi.includes('học') && rows.rows[0].vi.includes('học tập'), 'phải merge đủ nghĩa, không mất dữ liệu');
    });

    await test('SAU migration: vocab_lessons có đủ cả 2 lesson (L1, L4) trỏ về canonical', async () => {
      const rows = await pool.query('SELECT lesson FROM vocab_lessons WHERE word_id=$1 ORDER BY lesson', [idOld]);
      assert.deepStrictEqual(rows.rows.map(r => r.lesson), [L1, L4]);
    });

    await test('Case 9 — FSRS: chỉ còn ĐÚNG 1 thẻ sống sót, là thẻ có reps CAO HƠN (deterministic)', async () => {
      const rows = await pool.query('SELECT * FROM fsrs_cards WHERE user_id=$1 AND hz=$2', [TEST_USER, hzDup]);
      assert.strictEqual(rows.rows.length, 1, 'phải gộp về đúng 1 thẻ FSRS');
      assert.strictEqual(rows.rows[0].reps, 9, 'thẻ sống sót phải là thẻ có reps CAO HƠN (9, không phải 3) — không được tùy tiện reset');
      assert.strictEqual(rows.rows[0].word_id, idOld, 'thẻ sống sót phải gắn đúng canonical word_id');
    });

    await test('Case 10 — review_history KHÔNG bị mất (cả 2 dòng vẫn còn, đều gắn word_id=canonical)', async () => {
      const rows = await pool.query('SELECT word_id FROM review_history WHERE user_id=$1 AND hz=$2', [TEST_USER, hzDup]);
      assert.strictEqual(rows.rows.length, beforeReviewHistoryTotal, 'KHÔNG được mất bất kỳ dòng review_history nào');
      assert.ok(rows.rows.every(r => r.word_id === idOld), 'MỌI dòng lịch sử (kể cả của thẻ đã gộp) phải trỏ về canonical word_id');
    });

    await test('Case 12 — chạy migration LẦN THỨ HAI (idempotent) -> không đổi/tạo thêm gì', async () => {
      const beforeCounts = {
        vocabWords: (await pool.query('SELECT COUNT(*)::int AS c FROM vocab_words WHERE hz=$1', [hzDup])).rows[0].c,
        fsrsCards: (await pool.query('SELECT COUNT(*)::int AS c FROM fsrs_cards WHERE user_id=$1 AND hz=$2', [TEST_USER, hzDup])).rows[0].c,
        reviewHistory: (await pool.query('SELECT COUNT(*)::int AS c FROM review_history WHERE user_id=$1 AND hz=$2', [TEST_USER, hzDup])).rows[0].c,
      };
      const scriptPath = path.join(__dirname, '..', 'scripts', 'migrate-vocab-identity.js');
      const out = execFileSync('node', [scriptPath], { env: process.env, encoding: 'utf8' });
      assert.ok(out.includes('COMMIT thành công'), 'chạy lại lần 2 vẫn phải kết thúc thành công, không lỗi');
      const afterCounts = {
        vocabWords: (await pool.query('SELECT COUNT(*)::int AS c FROM vocab_words WHERE hz=$1', [hzDup])).rows[0].c,
        fsrsCards: (await pool.query('SELECT COUNT(*)::int AS c FROM fsrs_cards WHERE user_id=$1 AND hz=$2', [TEST_USER, hzDup])).rows[0].c,
        reviewHistory: (await pool.query('SELECT COUNT(*)::int AS c FROM review_history WHERE user_id=$1 AND hz=$2', [TEST_USER, hzDup])).rows[0].c,
      };
      assert.deepStrictEqual(afterCounts, beforeCounts, 'chạy lại migration lần 2 KHÔNG được đổi bất kỳ con số nào (idempotent)');
    });

    console.log('\n════════════════════════════════════════════════════');
    console.log(`Kết quả: ${passed} PASS, ${failed} FAIL`);
    console.log('════════════════════════════════════════════════════');
    if (failed > 0) process.exitCode = 1;
  } finally {
    await cleanup();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('❌ Integration test lỗi ngoài dự kiến:', e && e.message);
  process.exitCode = 1;
});
