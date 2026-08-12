// ════════════════════════════════════════════════════
// LỚP BỌC FSRS — dùng thẳng thư viện thật "ts-fsrs" (KHÔNG tự viết thuật toán SRS).
// Toàn bộ tính toán due/stability/difficulty/state đều do ts-fsrs quyết định.
// Đây là nơi DUY NHẤT trong project được phép gọi ts-fsrs — mọi chỗ khác (API, DB) chỉ
// truyền dữ liệu qua lại, không tự tính lịch ôn tập.
// ════════════════════════════════════════════════════
const { fsrs, generatorParameters, Rating, State, createEmptyCard } = require('ts-fsrs');

// Desired retention mặc định = 0.90 (Phần 4). Dùng default weights của thư viện — KHÔNG tự
// tối ưu "w". Kiến trúc cho phép sau này đọc desired_retention từ setting riêng của từng user
// (progress.ui.desiredRetention) — hiện tại luôn dùng mặc định 0.90 cho mọi user.
const DEFAULT_RETENTION = 0.9;

function buildScheduler(desiredRetention) {
  const params = generatorParameters({
    request_retention: Number.isFinite(desiredRetention) ? desiredRetention : DEFAULT_RETENTION,
    enable_fuzz: true,
  });
  return fsrs(params);
}

// Scheduler dùng chung (desired retention mặc định) — đủ cho v1, không cần tạo lại mỗi request.
const defaultScheduler = buildScheduler(DEFAULT_RETENTION);

// Rating string (client gửi) → FSRS Rating enum. Client CHỈ được gửi 1 trong 4 giá trị này.
const RATING_STRINGS = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };
const RATING_NAMES = { [Rating.Again]: 'again', [Rating.Hard]: 'hard', [Rating.Good]: 'good', [Rating.Easy]: 'easy' };

function ratingFromString(r) {
  const key = String(r || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(RATING_STRINGS, key) ? RATING_STRINGS[key] : null;
}

// Tạo 1 FSRS card trống (word hoàn toàn mới) — dùng khi user review 1 NEW word lần đầu tiên.
function emptyCard(now) {
  return createEmptyCard(now || new Date());
}

// Chuyển 1 dòng trong bảng fsrs_cards (Postgres) → Card object đúng format ts-fsrs cần.
function rowToCard(row) {
  if (!row) return null;
  return {
    due: new Date(row.due),
    stability: Number(row.stability),
    difficulty: Number(row.difficulty),
    elapsed_days: Number(row.elapsed_days),
    scheduled_days: Number(row.scheduled_days),
    reps: Number(row.reps),
    lapses: Number(row.lapses),
    state: Number(row.state),
    last_review: row.last_review ? new Date(row.last_review) : undefined,
  };
}

// Chuyển Card object (kết quả ts-fsrs) → object phẳng để ghi vào Postgres.
function cardToRow(card) {
  return {
    state: card.state,
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    last_review: card.last_review || null,
  };
}

// ── HÀM DUY NHẤT tính lịch ôn tập mới. SERVER là nguồn sự thật duy nhất — client không bao giờ
//     được tự tính due/stability/difficulty/interval/state (Phần 3). ──
// existingCard: Card object hiện tại (null nếu word hoàn toàn mới → tự tạo empty card).
// ratingStr: 'again' | 'hard' | 'good' | 'easy'
// Trả về: { newCard, ratingUsed, ratingName, log }
function reviewCard(existingCard, ratingStr, now) {
  const rating = ratingFromString(ratingStr);
  if (rating === null) {
    throw new Error('Rating không hợp lệ — chỉ chấp nhận again/hard/good/easy');
  }
  const reviewTime = now || new Date();
  const card = existingCard || emptyCard(reviewTime);
  // repeat() là API ổn định nhất của ts-fsrs qua các version: trả về scheduling cho cả 4 rating,
  // ta chỉ lấy đúng nhánh ứng với rating user chọn.
  const schedulingCards = defaultScheduler.repeat(card, reviewTime);
  const picked = schedulingCards[rating];
  return {
    newCard: picked.card,
    ratingUsed: rating,
    ratingName: RATING_NAMES[rating],
    log: picked.log,
  };
}

module.exports = {
  State, Rating,
  DEFAULT_RETENTION,
  ratingFromString,
  emptyCard,
  rowToCard,
  cardToRow,
  reviewCard,
};
