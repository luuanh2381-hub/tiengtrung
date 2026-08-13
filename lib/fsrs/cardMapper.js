// ════════════════════════════════════════════════════
// lib/fsrs/cardMapper.js — V69 kiến trúc chuẩn hóa
//
// CHỈ re-export rowToCard/cardToRow/emptyCard từ lib/fsrs.js. KHÔNG viết lại logic mapping ở đây
// — mọi thay đổi cấu trúc "1 FSRS card" (due/stability/difficulty/elapsed_days/scheduled_days/
// reps/lapses/state/last_review) chỉ sửa DUY NHẤT ở lib/fsrs.js, để tránh 2 nơi map lệch nhau.
// ════════════════════════════════════════════════════
const { rowToCard, cardToRow, emptyCard, State } = require('../fsrs');

// Danh sách 9 field bắt buộc mọi FSRS card phải có (Phần 3 của yêu cầu audit) — dùng để validate
// dữ liệu đọc từ DB / nhận từ nơi khác trước khi đưa vào ts-fsrs, phát hiện sớm nếu có chỗ nào
// (migration cũ, import lỗi, v.v.) tạo ra card thiếu field thay vì để ts-fsrs lỗi khó hiểu.
const REQUIRED_CARD_FIELDS = [
  'due', 'stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'reps', 'lapses', 'state', 'last_review',
];

function assertValidCardRow(row, context) {
  const missing = REQUIRED_CARD_FIELDS.filter((f) => f !== 'last_review' && (row[f] === undefined || row[f] === null));
  if (missing.length) {
    throw new Error(`FSRS card row thiếu field bắt buộc [${missing.join(', ')}]${context ? ' (' + context + ')' : ''}`);
  }
}

module.exports = {
  rowToCard, cardToRow, emptyCard, State,
  REQUIRED_CARD_FIELDS,
  assertValidCardRow,
};
