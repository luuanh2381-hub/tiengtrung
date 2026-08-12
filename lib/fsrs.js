// ════════════════════════════════════════════════════
// LỚP BỌC FSRS — dùng thẳng thư viện thật "ts-fsrs" (KHÔNG tự viết thuật toán SRS).
// Toàn bộ tính toán due/stability/difficulty/state đều do ts-fsrs quyết định.
// Đây là nơi DUY NHẤT trong project được phép gọi ts-fsrs — mọi chỗ khác (API, DB) chỉ
// truyền dữ liệu qua lại, không tự tính lịch ôn tập.
//
// FSRS-6 MIGRATION (xem báo cáo cuối câu trả lời): project đã nâng "ts-fsrs" lên
// ^5.4.1 — bản chính thức hiện tại của open-spaced-repetition/ts-fsrs, mặc định implement
// FSRS-6 (bộ w gồm 21 phần tử, có thêm tham số "decay" w[20]). API repeat()/generatorParameters()/
// createEmptyCard()/Rating/State không đổi giữa 4.x → 5.x nên không cần migrate cách gọi.
// KHÔNG tự viết lại công thức FSRS-6 — toàn bộ vẫn do package "ts-fsrs" tính.
// ════════════════════════════════════════════════════
const { fsrs, generatorParameters, Rating, State, createEmptyCard } = require('ts-fsrs');

// Desired retention mặc định = 0.90 (Phần 4/10). Dùng default weights (w) của thư viện — KHÔNG
// tự tối ưu "w" và KHÔNG tự hard-code lại bộ weights FSRS-6 (Phần 10/11). Kiến trúc cho phép sau
// này đọc desired_retention từ setting riêng của từng user (progress.ui.desiredRetention) — hiện
// tại luôn dùng mặc định 0.90 cho mọi user.
const DEFAULT_RETENTION = 0.9;

// FSRS-6 dùng đúng 21 parameters (w[0]..w[20], trong đó w[20] là "decay" mới thêm ở v6 — Phần 3).
// Hằng số này CHỈ dùng để xác minh (assert) rằng dependency đang thực sự chạy FSRS-6, không dùng
// để tự tính toán hay ghi đè bộ weights của thư viện.
const FSRS6_PARAM_COUNT = 21;

function buildScheduler(desiredRetention) {
  const params = generatorParameters({
    request_retention: Number.isFinite(desiredRetention) ? desiredRetention : DEFAULT_RETENTION,
    enable_fuzz: true,
    // enable_short_term mặc định = true trong ts-fsrs v5 — giữ nguyên hành vi mặc định của thư
    // viện cho learning-steps / same-day reviews (Phần 12), không tự override.
  });
  // Xác minh ngay khi khởi tạo: nếu dependency không trả về đúng 21 weights thì đây KHÔNG phải
  // FSRS-6 thật — fail sớm và rõ ràng thay vì âm thầm chạy sai version (Phần 3).
  if (!Array.isArray(params.w) || params.w.length !== FSRS6_PARAM_COUNT) {
    throw new Error(
      `FSRS-6 verification failed: expected ${FSRS6_PARAM_COUNT} parameters (w), got ` +
      `${Array.isArray(params.w) ? params.w.length : typeof params.w}. ` +
      `Kiểm tra lại version "ts-fsrs" trong package.json (cần ^5.x trở lên).`
    );
  }
  return { scheduler: fsrs(params), params };
}

// Scheduler dùng chung (desired retention mặc định) — đủ cho v1, không cần tạo lại mỗi request.
const { scheduler: defaultScheduler, params: defaultParams } = buildScheduler(DEFAULT_RETENTION);

// Thông tin xác minh FSRS-6 (Phần 17/20) — dùng cho verification script + test, KHÔNG dùng trong
// luồng tính lịch ôn tập thật.
function getFsrsVerificationInfo() {
  return {
    paramCount: Array.isArray(defaultParams.w) ? defaultParams.w.length : 0,
    isFsrs6: Array.isArray(defaultParams.w) && defaultParams.w.length === FSRS6_PARAM_COUNT,
    requestRetention: defaultParams.request_retention,
    enableFuzz: defaultParams.enable_fuzz,
    enableShortTerm: defaultParams.enable_short_term,
    w: defaultParams.w,
  };
}

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
//
// Dùng scheduler.next(card, now, rating) — không dùng repeat() ở đây. Tại thời điểm gọi hàm này,
// AUTO-RATING (lib/fsrs-auto-rating.js) đã xác định XONG rating cuối cùng, nên không cần ts-fsrs
// tính preview cho cả 4 rating rồi mình tự lọc ra 1 — next() đi thẳng vào đúng nhánh cần, đúng
// với API dành cho "đã biết rating" của ts-fsrs. repeat() vẫn được export riêng (previewSchedule)
// cho trường hợp trong tương lai cần hiển thị preview cả 4 lựa chọn cho user trước khi họ chọn.
function reviewCard(existingCard, ratingStr, now) {
  const rating = ratingFromString(ratingStr);
  if (rating === null) {
    throw new Error('Rating không hợp lệ — chỉ chấp nhận again/hard/good/easy');
  }
  const reviewTime = now || new Date();
  const card = existingCard || emptyCard(reviewTime);
  const result = defaultScheduler.next(card, reviewTime, rating);
  return {
    newCard: result.card,
    ratingUsed: rating,
    ratingName: RATING_NAMES[rating],
    log: result.log,
  };
}

// Preview cả 4 rating (Again/Hard/Good/Easy) cho 1 thẻ — dùng repeat() đúng mục đích của nó, CHỈ
// khi rating CHƯA được biết trước (vd muốn hiển thị "nếu Easy thì bao lâu nữa ôn lại" cho UI).
// Hiện tại project KHÔNG gọi hàm này ở đâu (auto-rating luôn xác định rating trước khi gọi FSRS),
// giữ lại để không phải xoá khả năng preview của ts-fsrs khỏi lớp bọc này.
function previewSchedule(existingCard, now) {
  const reviewTime = now || new Date();
  const card = existingCard || emptyCard(reviewTime);
  const schedulingCards = defaultScheduler.repeat(card, reviewTime);
  const out = {};
  for (const [ratingName, ratingValue] of Object.entries(RATING_STRINGS)) {
    const picked = schedulingCards[ratingValue];
    out[ratingName] = { newCard: picked.card, log: picked.log };
  }
  return out;
}

module.exports = {
  State, Rating,
  DEFAULT_RETENTION,
  FSRS6_PARAM_COUNT,
  ratingFromString,
  emptyCard,
  rowToCard,
  cardToRow,
  reviewCard,
  previewSchedule,
  getFsrsVerificationInfo,
};
