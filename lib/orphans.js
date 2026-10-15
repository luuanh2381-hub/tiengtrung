// lib/orphans.js — Dọn "bản ghi ôn tập MỒ CÔI" (Loại A): thẻ FSRS và lịch sử ôn của từ ĐÃ BỊ XOÁ.
//
// Định nghĩa (khớp đúng cách app nhận diện 1 từ — xem reviewFsrsCard/getDueFsrsCards): một dòng của
// fsrs_cards / review_history là MỒ CÔI khi
//     word_id IS NULL                      (dòng cũ chưa được nối với vocab_words; dòng có word_id thì
//                                           khoá ngoại V93 đảm bảo từ còn tồn tại → không thể mồ côi)
//     VÀ không còn vocab_words nào có cùng hz (so theo chữ Hán, KHÔNG xét bài — từ đã chuyển bài hoặc
//                                           nhập lại vẫn còn → dòng đó KHÔNG mồ côi, sẽ được nối lại khi ôn).
// Vì sao có loại này: deleteVocabLesson/deleteVocabWord chỉ kiểm tra thẻ có word_id trước khi xoá dòng từ,
// nên thẻ cũ chưa có word_id không cản được việc xoá → từ mất, thẻ còn.
//
// An toàn: xem trước (chỉ đọc) → tải bản sao lưu → xoá trong 1 transaction CHỈ khi số dòng thực tế khớp số
// đã xem trước (ngược lại ROLLBACK). Chỉ DELETE trên đúng 2 bảng này, đúng điều kiện trên. Không đụng
// vocab_words/vocab_lessons/câu ví dụ/Hán Việt/dữ liệu của từ còn tồn tại.
'use strict';

const CARDS_ORPHAN = `f.word_id IS NULL AND NOT EXISTS (SELECT 1 FROM vocab_words v WHERE v.hz = f.hz)`;
const HISTORY_ORPHAN = `rh.word_id IS NULL AND NOT EXISTS (SELECT 1 FROM vocab_words v WHERE v.hz = rh.hz)`;
const EXPORT_LIMIT = 50000;

function dbm() { return require('./db'); }

async function withClient(fn) {
  const client = await dbm().getPool().connect();
  try {
    await dbm().ensureFsrsTables(client);
    return await fn(client);
  } finally {
    client.release();
  }
}

// Chỉ đọc: tổng số, số thẻ mồ côi ĐANG đến hạn (nguồn gây sai số "thẻ cần ôn"), theo người dùng, chữ Hán hay gặp, mẫu.
async function previewOrphans() {
  return withClient(async (client) => {
    const cards = await client.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE f.due <= now())::int AS due
         FROM fsrs_cards f WHERE ${CARDS_ORPHAN}`);
    const history = await client.query(`SELECT COUNT(*)::int AS total FROM review_history rh WHERE ${HISTORY_ORPHAN}`);
    const byUser = await client.query(
      `SELECT f.user_id, COUNT(*)::int AS cards, COUNT(*) FILTER (WHERE f.due <= now())::int AS due
         FROM fsrs_cards f WHERE ${CARDS_ORPHAN} GROUP BY f.user_id ORDER BY cards DESC LIMIT 200`);
    const topHz = await client.query(
      `SELECT f.hz, COUNT(*)::int AS cards FROM fsrs_cards f WHERE ${CARDS_ORPHAN} GROUP BY f.hz ORDER BY cards DESC, f.hz LIMIT 30`);
    const sample = await client.query(
      `SELECT f.user_id, f.hz, f.l, f.state, f.due, f.reps, f.lapses FROM fsrs_cards f WHERE ${CARDS_ORPHAN} ORDER BY f.due ASC LIMIT 20`);
    return {
      cards: cards.rows[0].total, dueCards: cards.rows[0].due, history: history.rows[0].total,
      byUser: byUser.rows, topHz: topHz.rows, sample: sample.rows,
    };
  });
}

// Chỉ đọc: toàn bộ dòng SẼ bị xoá, để admin tải về làm bản sao lưu (giới hạn EXPORT_LIMIT mỗi bảng).
async function exportOrphans() {
  return withClient(async (client) => {
    const cards = await client.query(`SELECT f.* FROM fsrs_cards f WHERE ${CARDS_ORPHAN} ORDER BY f.user_id, f.hz LIMIT ${EXPORT_LIMIT}`);
    const history = await client.query(`SELECT rh.* FROM review_history rh WHERE ${HISTORY_ORPHAN} ORDER BY rh.user_id, rh.hz, rh.reviewed_at LIMIT ${EXPORT_LIMIT}`);
    return { exportedAt: new Date().toISOString(), limit: EXPORT_LIMIT, cards: cards.rows, history: history.rows };
  });
}

// Xoá. expectedCards/expectedHistory = số đã thấy ở bước xem trước; thực tế khác → ROLLBACK, không xoá gì.
async function cleanupOrphans({ expectedCards, expectedHistory }) {
  const okInt = (n) => Number.isInteger(n) && n >= 0;
  if (!okInt(expectedCards) || !okInt(expectedHistory)) return { ok: false, error: 'Thiếu số liệu xem trước hợp lệ — hãy bấm "Kiểm tra" trước' };
  return withClient(async (client) => {
    try {
      await client.query('BEGIN');
      const h = await client.query(`DELETE FROM review_history rh WHERE ${HISTORY_ORPHAN}`);
      const c = await client.query(`DELETE FROM fsrs_cards f WHERE ${CARDS_ORPHAN}`);
      if (h.rowCount !== expectedHistory || c.rowCount !== expectedCards) {
        await client.query('ROLLBACK');
        return { ok: false, error: `Dữ liệu đã thay đổi kể từ lúc xem trước (thực tế ${c.rowCount} thẻ, ${h.rowCount} lượt ôn). Chưa xoá gì — hãy kiểm tra lại.` };
      }
      await client.query('COMMIT');
      return { ok: true, removedCards: c.rowCount, removedHistory: h.rowCount };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });
}

// Chỉ đọc: phân loại thẻ ĐẾN HẠN của 1 người dùng — để biết "thẻ cần ôn" (đếm toàn tài khoản) gồm những gì.
//   khongConTu      : thẻ không còn từ nào (mồ côi thật)
//   tuKhongThuocBai : từ còn tồn tại nhưng không thuộc bài nào (không bao giờ vào phiên học)
//   tuConTrongBai   : từ còn trong ít nhất 1 bài
// byLesson: số thẻ đến hạn theo từng bài (từ thuộc nhiều bài được đếm ở mỗi bài, nên tổng có thể lớn hơn tuConTrongBai).
const WORD_MATCH = `(f.word_id IS NOT NULL AND v.id = f.word_id) OR (f.word_id IS NULL AND v.hz = f.hz AND v.l = f.l)`;
async function dueBreakdown(userId) {
  if (typeof userId !== 'string' || !userId) throw new Error('Thiếu người dùng');
  return withClient(async (client) => {
    const total = await client.query(
      `SELECT COUNT(*)::int AS tong,
              COUNT(*) FILTER (WHERE NOT co_tu)::int AS khong_con_tu,
              COUNT(*) FILTER (WHERE co_tu AND NOT co_bai)::int AS tu_khong_thuoc_bai,
              COUNT(*) FILTER (WHERE co_tu AND co_bai)::int AS tu_con_trong_bai
         FROM (
           SELECT EXISTS (SELECT 1 FROM vocab_words v WHERE ${WORD_MATCH}) AS co_tu,
                  EXISTS (SELECT 1 FROM vocab_words v JOIN vocab_lessons vl ON vl.word_id = v.id WHERE ${WORD_MATCH}) AS co_bai
             FROM fsrs_cards f WHERE f.user_id = $1 AND f.due <= now()
         ) t`, [userId]);
    const byLesson = await client.query(
      `SELECT vl.lesson, COUNT(*)::int AS cards
         FROM fsrs_cards f
         JOIN vocab_words v ON ${WORD_MATCH}
         JOIN vocab_lessons vl ON vl.word_id = v.id
        WHERE f.user_id = $1 AND f.due <= now()
        GROUP BY vl.lesson ORDER BY vl.lesson`, [userId]);
    const t = total.rows[0];
    return { userId, total: t.tong, noWord: t.khong_con_tu, wordNoLesson: t.tu_khong_thuoc_bai, wordInLesson: t.tu_con_trong_bai, byLesson: byLesson.rows };
  });
}

module.exports = { CARDS_ORPHAN, HISTORY_ORPHAN, previewOrphans, exportOrphans, cleanupOrphans, dueBreakdown };
