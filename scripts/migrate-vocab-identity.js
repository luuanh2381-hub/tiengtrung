#!/usr/bin/env node
// ════════════════════════════════════════════════════
// scripts/migrate-vocab-identity.js  (V93)
//
// Mục tiêu (audit "thống nhất từ vựng giữa các bài — KHÔNG được làm mất dữ liệu hiện tại"):
//   - Gộp các vocab_words trùng CHỮ HÁN (hz) — trước đây "hz + lesson" bị coi là identity nên 1 chữ
//     xuất hiện ở N bài tạo ra N dòng vocab_words tách biệt — về ĐÚNG 1 bản ghi canonical/hz (GIỮ
//     canonical ID = id NHỎ NHẤT trong nhóm trùng).
//   - Merge metadata (pinyin/nghĩa/tag/hanviet) của các bản ghi trùng — KHÔNG BAO GIỜ làm mất dữ
//     liệu hợp lệ (xem lib/vocab-merge.js, có unit test riêng ở test/vocab-merge.test.js — script
//     này CHỈ gọi lại đúng logic đó, không viết lại lần 2).
//   - Tạo bảng quan hệ vocab_lessons (word_id, lesson) — gộp lesson assignment của mọi bản ghi
//     trùng vào canonical, KHÔNG làm mất bất kỳ lesson nào.
//   - Với mỗi user đang có NHIỀU fsrs_cards trùng hz (do bug cũ, mỗi lesson tạo 1 thẻ riêng): chọn 1
//     thẻ "sống sót" deterministic (lib/vocab-merge.js:pickSurvivingFsrsCard — ưu tiên reps cao nhất,
//     rồi last_review gần nhất, rồi id nhỏ nhất), gắn word_id=canonical cho thẻ sống sót, XOÁ CÁC
//     THẺ THUA (chỉ xoá dòng "trạng thái hiện tại" fsrs_cards — KHÔNG đụng review_history của
//     chúng). Backfill word_id cho MỌI dòng review_history theo hz -> canonical (kể cả của thẻ đã
//     xoá) — review_history KHÔNG BAO GIỜ bị xoá/sửa nội dung, chỉ thêm 1 cột liên kết.
//   - Chỉ SAU KHI dọn sạch duplicate mới tạo UNIQUE INDEX (hz) trên vocab_words (đúng thứ tự: tìm
//     duplicate -> merge -> repair reference -> verify -> rồi mới tạo constraint).
//   - KHÔNG đụng gì tới app_store (user accounts/token), word_examples, hanzi_parts — các bảng này
//     vốn đã khoá theo hz (không theo vocab_words.id) nên KHÔNG bị ảnh hưởng bởi việc gộp id.
//
// TOÀN BỘ nằm trong 1 transaction DUY NHẤT (BEGIN...COMMIT) — lỗi bất kỳ đâu giữa chừng sẽ
// ROLLBACK SẠCH, không để lại trạng thái nửa vời.
//
// IDEMPOTENT: chạy lại lần 2 khi đã sạch duplicate sẽ không tìm thấy nhóm nào cần merge, các bước
// backfill/tạo index đều dùng IF NOT EXISTS / WHERE ... IS NULL nên không đổi/tạo thêm gì.
//
// Chạy thử KHÔNG ghi gì (xem trước sẽ merge những gì):
//   DATABASE_URL=... DRY_RUN=1 node scripts/migrate-vocab-identity.js
// Chạy thật:
//   DATABASE_URL=... node scripts/migrate-vocab-identity.js
// ════════════════════════════════════════════════════
const { Pool } = require('pg');
const vocabMerge = require('../lib/vocab-merge');

const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ Thiếu biến môi trường DATABASE_URL.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  try {
    console.log('════════════════════════════════════════════════════');
    console.log('V93 MIGRATION: thống nhất vocabulary identity (hz) — ' + (DRY_RUN ? 'DRY RUN (không ghi gì)' : 'CHẠY THẬT'));
    console.log('════════════════════════════════════════════════════\n');

    const before = await snapshot(client, false);
    console.log('── Trạng thái TRƯỚC migration ──');
    printSnapshot(before);

    await client.query('BEGIN');

    // ── Bước 1: đảm bảo schema mới tồn tại (idempotent — an toàn nếu code app chưa kịp deploy) ──
    console.log('\n── Bước 1: đảm bảo schema (vocab_lessons, fsrs_cards.word_id, review_history.word_id) ──');
    await ensureSchema(client);
    console.log('  ✓ OK');

    // ── Bước 2: tìm nhóm duplicate theo hz ──
    console.log('\n── Bước 2: tìm vocab_words trùng hz ──');
    const allWords = (await client.query('SELECT id, hz, py, vi, tag, hanviet, l FROM vocab_words ORDER BY id')).rows;
    const groups = vocabMerge.groupBy(allWords, w => w.hz);
    const dupGroups = [...groups.values()].filter(g => g.length > 1);
    console.log(`  Tổng vocab_words: ${allWords.length} | Số chữ (hz) duy nhất: ${groups.size} | Số nhóm trùng: ${dupGroups.length}`);

    // ── Bước 3: merge từng nhóm trùng ──
    console.log('\n── Bước 3: merge từng nhóm (giữ canonical ID = id nhỏ nhất) ──');
    let mergedGroups = 0, deletedVocabRows = 0, linkedLessons = 0, survivingCardsFixed = 0, deletedDupCards = 0, backfilledHistory = 0;
    for (const rows of dupGroups) {
      const result = vocabMerge.mergeManyVocabRecords(rows);
      const { canonicalId, merged, lessons, loserIds } = result;
      console.log(`  • "${merged.hz}" — canonical=${canonicalId}, gộp ${rows.length} bản ghi (${rows.map(r => r.id).join(', ')}), lesson=[${lessons.join(',')}]`);

      // 3a. Update metadata canonical (không đụng hz — đó chính là khoá match của nhóm)
      await client.query(
        `UPDATE vocab_words SET py=$1, vi=$2, tag=$3, hanviet=$4 WHERE id=$5`,
        [merged.py, merged.vi, merged.tag, merged.hanviet, canonicalId]
      );

      // 3b. Gộp lesson assignment — mọi lesson của MỌI bản ghi trong nhóm đều phải có mặt
      for (const lesson of lessons) {
        const r = await client.query(
          `INSERT INTO vocab_lessons (word_id, lesson) VALUES ($1,$2) ON CONFLICT (word_id, lesson) DO NOTHING RETURNING word_id`,
          [canonicalId, lesson]
        );
        if (r.rows.length) linkedLessons++;
      }

      // 3c. Với MỌI user đang có fsrs_cards cho hz này (bất kể l) — gộp về 1 thẻ sống sót
      const cardsRes = await client.query('SELECT * FROM fsrs_cards WHERE hz = $1', [merged.hz]);
      const byUser = vocabMerge.groupBy(cardsRes.rows, c => c.user_id);
      for (const [userId, userCards] of byUser) {
        if (userCards.length > 1) {
          const { winner, losers } = vocabMerge.pickSurvivingFsrsCard(userCards);
          console.log(`      user=${userId}: ${userCards.length} thẻ trùng -> giữ id=${winner.id} (reps=${winner.reps}), xoá id=${losers.map(x => x.id).join(',')}`);
          await client.query('UPDATE fsrs_cards SET word_id=$1 WHERE id=$2', [canonicalId, winner.id]);
          for (const loser of losers) {
            await client.query('DELETE FROM fsrs_cards WHERE id=$1', [loser.id]);
            deletedDupCards++;
          }
          survivingCardsFixed++;
        } else if (userCards.length === 1) {
          await client.query('UPDATE fsrs_cards SET word_id=$1 WHERE id=$2', [canonicalId, userCards[0].id]);
          survivingCardsFixed++;
        }
      }

      // 3d. Backfill word_id cho TOÀN BỘ review_history của hz này (mọi user, mọi l, kể cả của các
      //     thẻ vừa xoá ở 3c — review_history KHÔNG bị xoá/sửa nội dung, chỉ gắn thêm liên kết).
      const histRes = await client.query('UPDATE review_history SET word_id=$1 WHERE hz=$2 AND word_id IS NULL', [canonicalId, merged.hz]);
      backfilledHistory += histRes.rowCount;

      // 3e. CHỈ SAU KHI đã chuyển hết reference (lesson + fsrs + history) mới xoá các bản ghi thua
      //     (Phần 4.12 audit: "Sau khi chuyển toàn bộ reference thành công mới xử lý duplicate record").
      if (loserIds.length) {
        const delRes = await client.query('DELETE FROM vocab_words WHERE id = ANY($1::int[])', [loserIds]);
        deletedVocabRows += delRes.rowCount;
      }
      mergedGroups++;
    }
    console.log(`  Đã merge ${mergedGroups} nhóm — xoá ${deletedVocabRows} bản ghi vocab_words trùng, gắn ${linkedLessons} quan hệ lesson mới.`);
    console.log(`  FSRS: gộp xong ${survivingCardsFixed} thẻ sống sót, xoá ${deletedDupCards} thẻ trùng, backfill word_id cho ${backfilledHistory} dòng review_history (thuộc các nhóm vừa merge).`);

    // ── Bước 4: backfill vocab_lessons cho các từ KHÔNG trùng (đã unique từ đầu — nếu chưa có) ──
    console.log('\n── Bước 4: backfill vocab_lessons cho từ không trùng + backfill word_id còn thiếu ──');
    const linkRes = await client.query(
      `INSERT INTO vocab_lessons (word_id, lesson) SELECT id, l FROM vocab_words ON CONFLICT (word_id, lesson) DO NOTHING`
    );
    const fCardRes = await client.query(
      `UPDATE fsrs_cards f SET word_id = v.id FROM vocab_words v WHERE v.hz = f.hz AND f.word_id IS NULL`
    );
    const fHistRes = await client.query(
      `UPDATE review_history r SET word_id = v.id FROM vocab_words v WHERE v.hz = r.hz AND r.word_id IS NULL`
    );
    console.log(`  vocab_lessons thêm mới: ${linkRes.rowCount} | fsrs_cards backfill: ${fCardRes.rowCount} | review_history backfill: ${fHistRes.rowCount}`);

    // ── Bước 5: verify KHÔNG còn duplicate trước khi tạo UNIQUE INDEX ──
    console.log('\n── Bước 5: verify sạch duplicate trước khi tạo constraint ──');
    const remainDup = await client.query(
      `SELECT hz, COUNT(*)::int AS c FROM vocab_words GROUP BY hz HAVING COUNT(*) > 1`
    );
    if (remainDup.rows.length > 0) {
      throw new Error(
        `Vẫn còn ${remainDup.rows.length} nhóm hz trùng SAU khi merge (không nên xảy ra) — ` +
        `KHÔNG tạo UNIQUE INDEX, rollback toàn bộ để không mất dữ liệu. Ví dụ: ${JSON.stringify(remainDup.rows.slice(0, 5))}`
      );
    }
    console.log('  ✓ Không còn hz trùng — an toàn để tạo UNIQUE INDEX.');

    // ── Bước 6: tạo UNIQUE INDEX(hz) — Phần 12 audit: chỉ tạo SAU KHI tìm+merge+repair+verify ──
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS vocab_words_hz_idx ON vocab_words (hz)');
    console.log('  ✓ Đã tạo UNIQUE INDEX vocab_words_hz_idx (hz)');

    // ── Bước 7: verify cuối — số liệu SAU migration, so sánh với TRƯỚC ──
    const after = await snapshot(client, true);
    console.log('\n── Trạng thái SAU migration (trong transaction, chưa commit) ──');
    printSnapshot(after);

    const problems = [];
    if (after.reviewHistory < before.reviewHistory) problems.push(`review_history GIẢM (${before.reviewHistory} -> ${after.reviewHistory}) — TUYỆT ĐỐI không được xảy ra!`);
    if (after.appStoreUsers !== before.appStoreUsers) problems.push(`số user trong app_store đổi (${before.appStoreUsers} -> ${after.appStoreUsers}) — migration này không được đụng tới users!`);
    if (after.fsrsCards > before.fsrsCards) problems.push(`fsrs_cards TĂNG (${before.fsrsCards} -> ${after.fsrsCards}) — không hợp lý, migration chỉ có thể gộp (giảm hoặc giữ nguyên).`);
    const expectedFsrsCards = before.fsrsCards - deletedDupCards;
    if (after.fsrsCards !== expectedFsrsCards) {
      problems.push(`fsrs_cards sau merge (${after.fsrsCards}) khác với kỳ vọng (${before.fsrsCards} - ${deletedDupCards} thẻ trùng đã gộp = ${expectedFsrsCards}).`);
    }
    if (after.distinctHz !== after.vocabWords) problems.push(`vocab_words vẫn còn hz trùng sau migration (không nên xảy ra, đã kiểm ở Bước 5).`);

    if (problems.length) {
      console.log('\n❌ PHÁT HIỆN BẤT THƯỜNG — ROLLBACK TOÀN BỘ, KHÔNG GHI GÌ:');
      problems.forEach(p => console.log('   - ' + p));
      throw new Error('Data safety check thất bại, xem chi tiết ở trên.');
    }

    console.log('\n✓ Data safety check OK:');
    console.log(`   vocab_words: ${before.vocabWords} -> ${after.vocabWords} (giảm ${before.vocabWords - after.vocabWords} bản ghi TRÙNG đã gộp — KHÔNG phải mất từ, mọi lesson/nghĩa đã được merge vào canonical)`);
    console.log(`   fsrs_cards: ${before.fsrsCards} -> ${after.fsrsCards} (giảm đúng ${deletedDupCards} thẻ TRÙNG của cùng 1 user/từ đã gộp — review_history của các thẻ này VẪN CÒN NGUYÊN, chỉ gắn lại về đúng 1 từ)`);
    console.log(`   review_history: ${before.reviewHistory} -> ${after.reviewHistory} (không đổi — không dòng lịch sử nào bị xoá/sửa nội dung)`);
    console.log(`   app_store users: ${before.appStoreUsers} -> ${after.appStoreUsers} (không đổi — migration này không đụng tới tài khoản)`);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\n🔍 DRY_RUN=1 — đã ROLLBACK, KHÔNG có gì được ghi thật. Bỏ DRY_RUN để chạy thật.');
    } else {
      await client.query('COMMIT');
      console.log('\n✅ COMMIT thành công — migration hoàn tất.');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌ Lỗi migration — ĐÃ ROLLBACK, dữ liệu KHÔNG bị thay đổi:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

// Idempotent — y hệt các câu ensureVocabTable/ensureFsrsTables trong lib/db.js (copy lại ở đây để
// script độc lập, chạy được ngay cả TRƯỚC khi deploy code app mới).
async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS vocab_lessons (
      word_id INT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
      lesson INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (word_id, lesson)
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS vocab_lessons_lesson_idx ON vocab_lessons (lesson)');
  await client.query('ALTER TABLE fsrs_cards ADD COLUMN IF NOT EXISTS word_id INT REFERENCES vocab_words(id)');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS fsrs_cards_user_word_idx ON fsrs_cards (user_id, word_id) WHERE word_id IS NOT NULL');
  await client.query('ALTER TABLE review_history ADD COLUMN IF NOT EXISTS word_id INT REFERENCES vocab_words(id)');
  await client.query('CREATE INDEX IF NOT EXISTS review_history_user_word_idx ON review_history (user_id, word_id)');
}

async function snapshot(client, inTransaction) {
  // An toàn tuyệt đối: mỗi câu đếm bọc riêng 1 SAVEPOINT khi đang chạy TRONG transaction migration
  // chính — snapshot() chỉ để BÁO CÁO (không phải logic cốt lõi), lỗi ở đây (vd 1 bảng phụ có cấu
  // trúc bất thường) KHÔNG ĐƯỢC làm hỏng lây sang transaction chính (xem giải thích chi tiết ở
  // SAVEPOINT heal_word_id trong lib/db.js:reviewFsrsCard — cùng 1 nguyên do: 1 câu lỗi trong
  // Postgres transaction đánh dấu CẢ transaction "aborted" nếu không rollback đúng savepoint).
  const c = async (sql, params) => {
    if (inTransaction) await client.query('SAVEPOINT snap_count');
    try {
      const r = await client.query(sql, params);
      if (inTransaction) await client.query('RELEASE SAVEPOINT snap_count');
      return (r.rows[0] && r.rows[0].c) || 0;
    } catch (e) {
      if (inTransaction) await client.query('ROLLBACK TO SAVEPOINT snap_count').catch(() => {});
      return 0;
    }
  };
  const hasVocabLessons = await c(`SELECT (to_regclass('public.vocab_lessons') IS NOT NULL)::int AS c`);
  return {
    vocabWords: await c('SELECT COUNT(*)::int AS c FROM vocab_words'),
    distinctHz: await c('SELECT COUNT(DISTINCT hz)::int AS c FROM vocab_words'),
    dupGroups: await c(`SELECT COUNT(*)::int AS c FROM (SELECT hz FROM vocab_words GROUP BY hz HAVING COUNT(*) > 1) x`),
    vocabLessons: hasVocabLessons ? await c('SELECT COUNT(*)::int AS c FROM vocab_lessons') : 0,
    distinctLessons: await c('SELECT COUNT(DISTINCT l)::int AS c FROM vocab_words'),
    fsrsCards: await c('SELECT COUNT(*)::int AS c FROM fsrs_cards'),
    reviewHistory: await c('SELECT COUNT(*)::int AS c FROM review_history'),
    appStoreUsers: await c(`SELECT COALESCE(jsonb_object_length((data->'users')), 0)::int AS c FROM app_store WHERE id = 1`),
  };
}

function printSnapshot(s) {
  console.log(`   Tổng vocab_words:        ${s.vocabWords}`);
  console.log(`   Số chữ (hz) duy nhất:    ${s.distinctHz}`);
  console.log(`   Số nhóm hz đang trùng:   ${s.dupGroups}`);
  console.log(`   Tổng quan hệ vocab_lessons: ${s.vocabLessons}`);
  console.log(`   Tổng fsrs_cards:         ${s.fsrsCards}`);
  console.log(`   Tổng review_history:     ${s.reviewHistory}`);
  console.log(`   Số user (app_store):     ${s.appStoreUsers}`);
}

main();
