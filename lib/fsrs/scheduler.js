// ════════════════════════════════════════════════════
// lib/fsrs/scheduler.js — V69 kiến trúc chuẩn hóa
//
// ĐÂY KHÔNG PHẢI 1 SCHEDULER THỨ HAI. File này chỉ re-export scheduler thật (ts-fsrs, khởi tạo
// trong lib/fsrs.js) ra dưới đúng "hình dạng module" mà audit yêu cầu (lib/fsrs/scheduler.js).
// TUYỆT ĐỐI không import trực tiếp "ts-fsrs" ở đây và không tự gọi generatorParameters()/fsrs() —
// nếu cần, sửa lib/fsrs.js. Mục tiêu: toàn bộ codebase (kể cả các module V69 mới) chỉ có 1 con
// đường duy nhất chạm vào thư viện ts-fsrs, để "Không cho phép tồn tại hai scheduler song song".
// ════════════════════════════════════════════════════
const {
  State, Rating,
  DEFAULT_RETENTION, ALLOWED_RETENTIONS, isAllowedRetention,
  FSRS6_PARAM_COUNT,
  ratingFromString,
  reviewCard,
  previewSchedule,
  getSchedulerForRetention,
  getFsrsVerificationInfo,
} = require('../fsrs');

module.exports = {
  State, Rating,
  DEFAULT_RETENTION, ALLOWED_RETENTIONS, isAllowedRetention,
  FSRS6_PARAM_COUNT,
  ratingFromString,
  reviewCard,
  previewSchedule,
  getSchedulerForRetention,
  getFsrsVerificationInfo,
};
