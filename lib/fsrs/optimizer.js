// ════════════════════════════════════════════════════
// lib/fsrs/optimizer.js — V69 kiến trúc chuẩn hóa + V82 FSRS PERSONAL OPTIMIZER
//
// 3 nhóm trách nhiệm:
//   1) (V69, không đổi) Xuất review_history theo format tương thích FSRS Optimizer cho ADMIN xem —
//      exportReviewHistoryForOptimizer/getOptimizerReadiness/getUserWeights/saveUserWeights.
//   2) (V82 MỚI) Pipeline optimizer THẬT: đọc review_history → data-quality validate → chia
//      train/validation → train weights CÁ NHÂN bằng optimizer CHÍNH THỨC của ts-fsrs
//      ("@open-spaced-repetition/binding" — KHÔNG tự viết gradient descent, xem
//      trainWithOfficialOptimizer bên dưới) → đánh giá default vs personal weights trên tập
//      validation (log-loss, dùng scheduler THẬT qua lib/fsrs.js:getRetrievability — không tự viết
//      lại forgetting curve) → lưu kết quả làm "candidate" (CHƯA active).
//   3) (V82 MỚI) Versioning/rollback: applyPersonalWeights/rollbackPersonalWeights/
//      resetToDefaultWeights — CHỈ đụng bảng user_fsrs_weights, KHÔNG BAO GIỜ đụng
//      fsrs_cards/review_history (Phần 10: apply weights không được reset lịch ôn tập của user).
//
// getUserActiveWeights(userId) là hàm DUY NHẤT lib/fsrs/reviewService.js gọi trong luồng review
// THẬT — trả null (dùng default) trừ khi user đã bấm "Apply" (enabled=true trong DB).
// ════════════════════════════════════════════════════
const { getPool } = require('../db');
const {
  Rating, getSchedulerForRetention, DEFAULT_RETENTION, FSRS6_PARAM_COUNT,
  isValidWeightsArray, getRetrievability, reviewCard,
} = require('./scheduler');

// Rating string ('again'/'hard'/'good'/'easy') → số 1-4 đúng chuẩn format FSRS Optimizer
// (1=Again,2=Hard,3=Good,4=Easy — giống enum Rating của ts-fsrs, KHÔNG tự định nghĩa lại).
const RATING_TO_NUMBER = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };
const RATING_NAME_BY_NUMBER = Object.fromEntries(Object.entries(RATING_TO_NUMBER).map(([k, v]) => [v, k]));

let optimizerTablesReady = null;
async function ensureOptimizerTables(client) {
  if (optimizerTablesReady) return optimizerTablesReady;
  optimizerTablesReady = (async () => {
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_fsrs_weights (
          user_id TEXT PRIMARY KEY,
          weights DOUBLE PRECISION[] NOT NULL,
          trained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          review_count INT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      // V82 (FSRS Personal Optimizer, Phần 8/9/11) — MỞ RỘNG AN TOÀN bảng đã có, KHÔNG đổi nghĩa 5
      // cột cũ ở trên (weights/trained_at/review_count vẫn là "weights ĐANG active NẾU enabled =
      // true" — trước V82 thì "có dòng = active", giờ thêm cột enabled tường minh vì bảng này CHƯA
      // TỪNG được ghi ở đâu trong hệ thống thật (saveUserWeights cũ chưa ai gọi), nên đổi điều kiện
      // "active" từ "có dòng" sang "enabled=true" không làm hỏng dữ liệu thật nào đang có).
      // ADD COLUMN IF NOT EXISTS: chạy lại nhiều lần vẫn an toàn, không mất dữ liệu (giống pattern
      // vocab_words.tag/hanviet ở lib/db.js:ensureVocabTable).
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT false`);
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS previous_weights DOUBLE PRECISION[]`);
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS previous_enabled BOOLEAN`);
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS previous_trained_at TIMESTAMPTZ`);
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS previous_review_count INT`);
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS candidate_weights DOUBLE PRECISION[]`);
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS candidate_trained_at TIMESTAMPTZ`);
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS candidate_review_count INT`);
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS candidate_meta JSONB`);
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'idle'`);
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS run_started_at TIMESTAMPTZ`);
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS last_error TEXT`);
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ`);
    } catch (e) {
      optimizerTablesReady = null;
      throw e;
    }
  })();
  return optimizerTablesReady;
}

// ── Xuất lịch sử review cho FSRS Optimizer (Phần 6) ─────────────────────────────────────────
// card_id dùng "hz::l" (khớp khóa duy nhất user_id+hz+l của fsrs_cards) — vì bảng dùng khóa
// composite (hz, l) thay vì 1 cột "card_id" số nguyên, ghép thành 1 chuỗi ổn định thay vì đổi
// schema fsrs_cards chỉ để có 1 cột id giả (Optimizer chỉ cần 1 định danh ổn định cho mỗi thẻ).
async function exportReviewHistoryForOptimizer(userId, { limit, beforeId } = {}) {
  const client = await getPool().connect();
  try {
    const params = [userId];
    let where = 'user_id = $1';
    if (Number.isFinite(beforeId)) { params.push(beforeId); where += ` AND id < $${params.length}`; }
    params.push(Number.isFinite(limit) ? Math.min(limit, 5000) : 2000);
    const r = await client.query(
      `SELECT id, user_id, hz, l, rating, answer_correct, reviewed_at,
              previous_state, new_state, previous_stability, new_stability,
              previous_difficulty, new_difficulty, scheduled_days, elapsed_days, response_time_ms
       FROM review_history
       WHERE ${where}
       ORDER BY id DESC
       LIMIT $${params.length}`,
      params
    );
    return r.rows.map((row) => ({
      user_id: row.user_id,
      card_id: `${row.hz}::${row.l}`,
      review_time: row.reviewed_at,
      rating: RATING_TO_NUMBER[row.rating] ?? null,
      response_time_ms: row.response_time_ms,
      stability_before: row.previous_stability,
      stability_after: row.new_stability,
      difficulty_before: row.previous_difficulty,
      difficulty_after: row.new_difficulty,
      scheduled_days: row.scheduled_days,
      elapsed_days: row.elapsed_days,
      state_before: row.previous_state,
      state_after: row.new_state,
    }));
  } finally {
    client.release();
  }
}

// Đếm số lượt review đã có của 1 user — dùng để quyết định "đã đủ dữ liệu để train riêng chưa"
// (quy ước phổ biến của FSRS Optimizer: cần tối thiểu ~200 review mới train ổn định; đây CHỈ là
// hằng số tham khảo hiển thị cho admin, KHÔNG tự động trigger train).
const MIN_REVIEWS_FOR_PERSONAL_TRAINING = 200;

async function getOptimizerReadiness(userId) {
  const client = await getPool().connect();
  try {
    const r = await client.query('SELECT COUNT(*)::int AS c FROM review_history WHERE user_id = $1', [userId]);
    const count = r.rows[0].c;
    return { reviewCount: count, readyForTraining: count >= MIN_REVIEWS_FOR_PERSONAL_TRAINING, threshold: MIN_REVIEWS_FOR_PERSONAL_TRAINING };
  } finally {
    client.release();
  }
}

// ── Personal weights (Phần 7, V82: gate theo cột enabled thay vì "có dòng là active") ──────────
// isPersonal=true CHỈ khi user đã bấm Apply (enabled=true) VÀ weights lưu vẫn hợp lệ (defense in
// depth — phòng dữ liệu cũ/hỏng lọt qua, KHÔNG BAO GIỜ trả weights hỏng ra ngoài, Phần 4).
async function getUserWeights(userId) {
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    const r = await client.query('SELECT weights, trained_at, review_count, enabled FROM user_fsrs_weights WHERE user_id = $1', [userId]);
    if (r.rows.length && r.rows[0].enabled && isValidWeightsArray(r.rows[0].weights)) {
      return { weights: r.rows[0].weights, trainedAt: r.rows[0].trained_at, reviewCount: r.rows[0].review_count, isPersonal: true };
    }
    const { params } = getSchedulerForRetention(undefined); // default scheduler params (default w)
    return { weights: params.w, trainedAt: null, reviewCount: 0, isPersonal: false };
  } finally {
    client.release();
  }
}

// V82: getUserWeights() ở trên đọc thẳng DB mỗi lần — phù hợp cho trang Cài đặt/admin (không gọi
// thường xuyên). Luồng review THẬT (mỗi lượt trả lời — reviewService.reviewCard) cần rẻ hơn nhiều:
// cache TTL theo userId, CÙNG pattern với userSettingsCache (lib/fsrs/reviewService.js) — ghi-qua
// (write-through) ngay sau apply/rollback/reset để không có cửa sổ đọc-cache-cũ trong CÙNG instance.
// Trả về: null (dùng default weights) hoặc mảng 21 số (weights cá nhân đang active).
const activeWeightsCache = new Map();
const ACTIVE_WEIGHTS_CACHE_TTL_MS = 30000;

async function getUserActiveWeights(userId) {
  const cached = activeWeightsCache.get(userId);
  if (cached && (Date.now() - cached.at) < ACTIVE_WEIGHTS_CACHE_TTL_MS) return cached.value;
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    const r = await client.query('SELECT weights, enabled FROM user_fsrs_weights WHERE user_id = $1', [userId]);
    const row = r.rows[0];
    const value = (row && row.enabled && isValidWeightsArray(row.weights)) ? row.weights.map(Number) : null;
    activeWeightsCache.set(userId, { value, at: Date.now() });
    return value;
  } finally {
    client.release();
  }
}
function invalidateActiveWeightsCache(userId) {
  activeWeightsCache.delete(userId);
}
function writeThroughActiveWeightsCache(userId, value) {
  activeWeightsCache.set(userId, { value, at: Date.now() });
}

// Lưu THẲNG weights làm active NGAY (giữ nguyên hành vi/chữ ký gốc — dùng cho script/job ngoài
// luồng optimizer tự phục vụ nếu có trong tương lai). Luồng optimizer tự phục vụ (runOptimizer →
// applyPersonalWeights bên dưới) KHÔNG dùng hàm này — optimizer luôn ghi vào candidate_* trước
// (Phần 9: "KHÔNG tự động apply"), chỉ applyPersonalWeights() mới đưa candidate → active.
async function saveUserWeights(userId, weights, reviewCount) {
  if (!isValidWeightsArray(weights)) {
    throw new Error(`user_fsrs_weights: weights phải có đúng ${FSRS6_PARAM_COUNT} số hữu hạn (FSRS-6), nhận được ${Array.isArray(weights) ? weights.length : typeof weights}`);
  }
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    await client.query(
      `INSERT INTO user_fsrs_weights (user_id, weights, enabled, trained_at, review_count, updated_at)
       VALUES ($1, $2, true, now(), $3, now())
       ON CONFLICT (user_id) DO UPDATE SET weights = $2, enabled = true, trained_at = now(), review_count = $3, updated_at = now()`,
      [userId, weights, Number.isFinite(reviewCount) ? reviewCount : 0]
    );
    writeThroughActiveWeightsCache(userId, weights.map(Number));
  } finally {
    client.release();
  }
}

// ════════════════════════════════════════════════════
// V82 — FSRS PERSONAL OPTIMIZER: data quality → train (chính thức) → evaluate → candidate
// ════════════════════════════════════════════════════

// ── Bước 1: đọc TOÀN BỘ review_history của user để làm dữ liệu train (KHÔNG cap 5000 như
//     exportReviewHistoryForOptimizer — hàm đó dành cho admin export/xem, có phân trang riêng).
//     Sắp theo card rồi theo thời gian — vừa tiện group theo thẻ, vừa tiện phát hiện review lệch
//     thứ tự thời gian (Phần 2). hardCap chỉ để chặn trường hợp cực đoan (hàng trăm nghìn dòng),
//     không phải giới hạn thực tế cho quy mô ~4.000 review hiện tại. ──
async function fetchAllReviewRowsForTraining(userId, hardCap = 50000) {
  const client = await getPool().connect();
  try {
    const r = await client.query(
      `SELECT id, hz, l, rating, answer_correct, reviewed_at, elapsed_days
       FROM review_history
       WHERE user_id = $1
       ORDER BY hz ASC, l ASC, reviewed_at ASC, id ASC
       LIMIT $2`,
      [userId, hardCap]
    );
    return r.rows;
  } finally {
    client.release();
  }
}

// ── Bước 2: DATA QUALITY CHECK (Phần 2) — validate TỪNG dòng, group theo thẻ, KHÔNG xoá gì trong
//     DB thật (chỉ loại khỏi tập dùng cho optimizer). Trả về report để hiển thị cho user (Phần 20)
//     + byCard (Map card_id → mảng review hợp lệ, ĐÃ sắp đúng thời gian) để build training items. ──
function validateReviewHistory(rawRows, { now } = {}) {
  const nowMs = (now || new Date()).getTime();
  const FUTURE_TOLERANCE_MS = 60000; // dung sai lệch đồng hồ client 60s, tránh false-positive
  const byCard = new Map();
  const seenKey = new Set(); // "cardId|reviewedAtMs" — phát hiện duplicate (double submit/dữ liệu cũ)
  let invalidCount = 0;
  let duplicateCount = 0;
  const issues = [];
  const ratingDistribution = { again: 0, hard: 0, good: 0, easy: 0 };
  let minTime = null, maxTime = null;

  const pushIssue = (msg) => { if (issues.length < 20) issues.push(msg); };

  for (const row of rawRows) {
    const hz = row.hz, l = row.l;
    if (!hz || !Number.isFinite(Number(l))) { invalidCount++; pushIssue(`Thiếu hz/l ở review #${row.id}`); continue; }
    const ratingStr = String(row.rating || '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(RATING_TO_NUMBER, ratingStr)) {
      invalidCount++; pushIssue(`Rating không hợp lệ ("${row.rating}") ở review #${row.id}`); continue;
    }
    const reviewedAt = row.reviewed_at ? new Date(row.reviewed_at) : null;
    if (!reviewedAt || Number.isNaN(reviewedAt.getTime())) {
      invalidCount++; pushIssue(`Timestamp không đọc được ở review #${row.id}`); continue;
    }
    if (reviewedAt.getTime() > nowMs + FUTURE_TOLERANCE_MS) {
      invalidCount++; pushIssue(`Timestamp ở tương lai ở review #${row.id}`); continue;
    }
    const elapsedDays = Number(row.elapsed_days);
    if (!Number.isFinite(elapsedDays) || elapsedDays < 0) {
      invalidCount++; pushIssue(`elapsed_days không hợp lệ (${row.elapsed_days}) ở review #${row.id}`); continue;
    }

    const cardId = `${hz}::${l}`;
    const dupKey = `${cardId}|${reviewedAt.getTime()}`;
    if (seenKey.has(dupKey)) { duplicateCount++; continue; }
    seenKey.add(dupKey);

    if (!byCard.has(cardId)) byCard.set(cardId, []);
    byCard.get(cardId).push({ rating: RATING_TO_NUMBER[ratingStr], reviewedAt, answerCorrect: !!row.answer_correct });
    ratingDistribution[ratingStr]++;
    if (minTime === null || reviewedAt.getTime() < minTime) minTime = reviewedAt.getTime();
    if (maxTime === null || reviewedAt.getTime() > maxTime) maxTime = reviewedAt.getTime();
  }

  // SQL đã ORDER BY reviewed_at, nhưng re-sort tường minh ở đây — KHÔNG phụ thuộc ngầm vào thứ tự
  // trả về của Postgres (Phần 2: "sequence hợp lý của review").
  for (const rows of byCard.values()) rows.sort((a, b) => a.reviewedAt - b.reviewedAt);

  const validReviews = [...byCard.values()].reduce((sum, rows) => sum + rows.length, 0);
  const report = {
    totalReviews: rawRows.length,
    validReviews,
    invalidReviews: invalidCount,
    duplicates: duplicateCount,
    uniqueCards: byCard.size,
    dateRange: (minTime !== null && maxTime !== null) ? {
      from: new Date(minTime).toISOString(),
      to: new Date(maxTime).toISOString(),
      days: Math.max(1, Math.round((maxTime - minTime) / 86400000)),
    } : null,
    ratingDistribution,
    issues,
    issuesTruncated: (invalidCount + duplicateCount) > issues.length,
  };
  return { byCard, report };
}

// ── Bước 3: READINESS (Phần 5) — dựa trên data quality, KHÔNG chỉ đếm số lượng. ──
function classifyReadiness(report) {
  const { validReviews, uniqueCards, invalidReviews, totalReviews, ratingDistribution } = report;
  const invalidRatio = totalReviews > 0 ? invalidReviews / totalReviews : 0;
  const ratingsSeen = Object.values(ratingDistribution).filter((n) => n > 0).length;

  if (validReviews < 500 || uniqueCards < 30) {
    return {
      status: 'NOT_READY',
      reason: `Chỉ có ${validReviews} review hợp lệ trên ${uniqueCards} thẻ khác nhau — cần tối thiểu 500 review hợp lệ trên ít nhất 30 thẻ để optimizer có đủ tín hiệu (Phần 5).`,
    };
  }
  if (invalidRatio > 0.3) {
    return {
      status: 'NOT_READY',
      reason: `Tỉ lệ dữ liệu lỗi quá cao (${(invalidRatio * 100).toFixed(1)}% trên tổng ${totalReviews} review) — nên kiểm tra lại chất lượng dữ liệu trước khi optimize.`,
    };
  }
  if (ratingsSeen < 3) {
    return {
      status: 'NOT_READY',
      reason: 'Lịch sử review thiếu đa dạng rating (cần thấy ít nhất 3/4 loại Again/Hard/Good/Easy) — optimizer khó học được pattern thật của bạn.',
    };
  }
  if (validReviews >= 2000 && invalidRatio <= 0.1 && uniqueCards >= 100) {
    return {
      status: 'OPTIMIZABLE',
      reason: `${validReviews} review hợp lệ trên ${uniqueCards} thẻ, dữ liệu sạch (${(invalidRatio * 100).toFixed(1)}% lỗi) — đủ điều kiện train weights cá nhân.`,
    };
  }
  return {
    status: 'READY',
    reason: `${validReviews} review hợp lệ trên ${uniqueCards} thẻ — đủ để thử train nhưng nên THẬN TRỌNG, đối chiếu kỹ điểm validation trước khi Apply.`,
  };
}

// Gộp bước 1+2+3 — dùng CHUNG cho cả GET status (chỉ xem, không train) và runOptimizer (Phần 20:
// "trước khi thực sự apply optimizer, hãy cho tôi biết..." — user phải xem được báo cáo NÀY trước).
async function assessDataQuality(userId) {
  const rawRows = await fetchAllReviewRowsForTraining(userId);
  const { byCard, report } = validateReviewHistory(rawRows);
  const readiness = classifyReadiness(report);
  return { byCard, report, readiness };
}

// ── Bước 4: build training items đúng format optimizer cần — mỗi thẻ là 1 chuỗi (rating, deltaT)
//     theo đúng thời gian thật, deltaT=0 cho lượt đầu tiên của thẻ đó (thẻ New). ──
function buildTrainingItems(byCard) {
  const items = [];
  for (const [cardId, rows] of byCard.entries()) {
    let prevTime = null;
    const reviews = rows.map((r) => {
      const deltaT = prevTime === null ? 0 : Math.max(0, Math.round((r.reviewedAt - prevTime) / 86400000));
      prevTime = r.reviewedAt;
      return { rating: r.rating, deltaT, answerCorrect: r.answerCorrect };
    });
    items.push({ cardId, reviews });
  }
  return items;
}

// ── Bước 5: chia train/validation (Phần 7 — 80/20, tránh overfitting). Chia theo THẺ (không phải
//     theo từng dòng review riêng lẻ — các review trong CÙNG 1 thẻ phụ thuộc thời gian lẫn nhau,
//     xáo trộn theo từng dòng sẽ làm rò rỉ dữ liệu giữa train/validation). Hash ổn định theo
//     cardId → CÙNG 1 dataset luôn chia ra đúng 1 kết quả (dễ test, dễ debug), không cần lưu seed. ──
function stableHash(str) {
  let h = 0x811c9dc5; // FNV-1a 32-bit — chỉ cần ổn định + phân bố đều, KHÔNG cần bảo mật
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function splitTrainValidation(items, ratio = 0.8) {
  const train = [], validation = [];
  const cut = Math.round(ratio * 100);
  for (const item of items) {
    (stableHash(item.cardId) % 100 < cut ? train : validation).push(item);
  }
  return { train, validation };
}

// ── Bước 6: TRAIN bằng optimizer CHÍNH THỨC của ts-fsrs — "@open-spaced-repetition/binding"
//     (companion package chính thức, dùng native NAPI/Rust "fsrs-rs" — xem package.json). KHÔNG tự
//     viết gradient descent thay thế (Phần 3/21) — nếu dependency thiếu/lỗi/API không đúng như tài
//     liệu công khai, ném lỗi RÕ RÀNG ra ngoài, KHÔNG fallback approximation.
//
// ⚠️ LƯU Ý QUAN TRỌNG: package này ở bản "public beta" (API có thể đổi giữa các version — theo
// chính tài liệu của package). Sandbox phát triển code này KHÔNG có network để `npm install` +
// chạy thử thật — hãy chạy `npm install && npm run test:optimizer` sau khi tải project về, và nếu
// hình dạng API thực tế khác với dưới đây (tên hàm/class, hình dạng kết quả trả về), CHỈ cần sửa
// đúng hàm trainWithOfficialOptimizer() này — toàn bộ phần còn lại (validate/readiness/split/
// evaluate/versioning/API/UI) không phụ thuộc vào chi tiết implementation của package. ──
class OptimizerDependencyError extends Error {}

function getOptimizerBindingVersion() {
  try { return require('@open-spaced-repetition/binding/package.json').version; } catch { return null; }
}

async function trainWithOfficialOptimizer(trainItems, { enableShortTerm = true } = {}) {
  let binding;
  try {
    binding = require('@open-spaced-repetition/binding');
  } catch (e) {
    throw new OptimizerDependencyError(
      'Chưa cài được "@open-spaced-repetition/binding" (optimizer chính thức, companion package của ' +
      'ts-fsrs). Kiểm tra: (1) đã chạy "npm install" sau khi thêm dependency vào package.json chưa, ' +
      '(2) nền tảng deploy (Vercel Node runtime — thường linux-x64-gnu) có bản native binary NAPI ' +
      `tương ứng không (package dùng optionalDependencies theo platform). Lỗi gốc: ${e.message}`
    );
  }
  const { computeParameters, FSRSBindingItem, FSRSBindingReview } = binding;
  if (typeof computeParameters !== 'function' || typeof FSRSBindingItem !== 'function' || typeof FSRSBindingReview !== 'function') {
    throw new OptimizerDependencyError(
      'Package "@open-spaced-repetition/binding" đã cài nhưng KHÔNG export đúng computeParameters/' +
      'FSRSBindingItem/FSRSBindingReview như tài liệu công khai lúc viết code này — package đang ở ' +
      'bản public beta nên API có thể đã đổi. KHÔNG tự viết optimizer thay thế (Phần 21) — hãy mở ' +
      'node_modules/@open-spaced-repetition/binding/README.md thực tế rồi cập nhật đúng hàm ' +
      'trainWithOfficialOptimizer() trong file này.'
    );
  }
  const bindingItems = trainItems.map((item) =>
    new FSRSBindingItem(item.reviews.map((r) => new FSRSBindingReview(r.rating, r.deltaT)))
  );
  let result;
  try {
    result = await computeParameters(bindingItems, { enableShortTerm });
  } catch (e) {
    throw new OptimizerDependencyError(`Optimizer chính thức chạy lỗi khi train: ${e.message}`);
  }
  // computeParameters có thể trả thẳng mảng w hoặc { parameters: [...] } tuỳ version — chấp nhận cả
  // 2 hình dạng nhưng KHÔNG đoán mò nếu không khớp cái nào (fail rõ ràng thay vì âm thầm sai).
  const weights = Array.isArray(result) ? result
    : (result && Array.isArray(result.parameters)) ? result.parameters
    : null;
  if (!isValidWeightsArray(weights)) {
    throw new OptimizerDependencyError(
      `Optimizer chính thức trả về weights không hợp lệ (cần đúng ${FSRS6_PARAM_COUNT} số hữu hạn). ` +
      `Nhận được: ${JSON.stringify(result).slice(0, 200)}`
    );
  }
  return weights.map(Number);
}

// ── Bước 7: ĐÁNH GIÁ 1 bộ weights trên tập review THẬT — log-loss (binary cross-entropy) giữa xác
//     suất nhớ lại DỰ ĐOÁN (get_retrievability, tính bằng scheduler THẬT qua lib/fsrs.js) và kết
//     quả THẬT (answer_correct). Loss THẤP hơn = weights dự đoán đúng hành vi ghi nhớ của user hơn
//     — đây CHÍNH LÀ tiêu chí "Default vs Personal" (Phần 6/7), không tự bịa công thức nào khác.
//     Chỉ tính loss từ lượt review THỨ HAI của mỗi thẻ trở đi (lượt đầu thẻ đang New, chưa có gì để
//     dự đoán) — Replay dùng ĐÚNG reviewCard/getRetrievability thật (KHÔNG tự viết công thức FSRS). ──
function binaryCrossEntropy(predicted, actual) {
  const p = Math.min(Math.max(predicted, 1e-7), 1 - 1e-7); // tránh log(0)
  return -(actual * Math.log(p) + (1 - actual) * Math.log(1 - p));
}

function evaluateWeights(weights, items, { desiredRetention } = {}) {
  let totalLoss = 0, n = 0;
  for (const item of items) {
    let card = null;
    let cursor = null;
    for (const rev of item.reviews) {
      // Mốc thời gian TUYỆT ĐỐI không quan trọng cho việc đánh giá (chỉ khoảng CÁCH deltaT giữa 2
      // lượt review liên tiếp mới ảnh hưởng tới elapsed_days mà ts-fsrs tính) — dùng "now" làm neo
      // cho lượt đầu tiên của thẻ, rồi cộng dồn deltaT thật cho các lượt sau, tái tạo ĐÚNG khoảng
      // cách thời gian gốc.
      const reviewTime = cursor ? new Date(cursor.getTime() + rev.deltaT * 86400000) : new Date();
      if (card) {
        const predicted = getRetrievability(card, reviewTime, desiredRetention, weights);
        totalLoss += binaryCrossEntropy(predicted, rev.answerCorrect ? 1 : 0);
        n++;
      }
      const { newCard } = reviewCard(card, RATING_NAME_BY_NUMBER[rev.rating], reviewTime, desiredRetention, weights);
      card = newCard;
      cursor = reviewTime;
    }
  }
  return { avgLogLoss: n > 0 ? totalLoss / n : null, sampleCount: n };
}

// ── Bước 8: RUN LOCK (Phần 15 — không cho 2 optimizer chạy song song cho CÙNG 1 user) — 1 UPDATE
//     ATOMIC duy nhất (INSERT ... ON CONFLICT DO UPDATE ... WHERE), không cần Redis/hàng đợi riêng
//     (Phần 16). Run "running" quá 10 phút coi như đã treo/crash giữa chừng — cho phép chạy lại. ──
async function claimOptimizerRun(userId) {
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    const { params } = getSchedulerForRetention(undefined);
    const r = await client.query(
      `INSERT INTO user_fsrs_weights (user_id, weights, enabled, status, run_started_at, last_error, updated_at)
       VALUES ($1, $2, false, 'running', now(), NULL, now())
       ON CONFLICT (user_id) DO UPDATE
         SET status = 'running', run_started_at = now(), last_error = NULL, updated_at = now()
         WHERE user_fsrs_weights.status IS DISTINCT FROM 'running'
            OR user_fsrs_weights.run_started_at < now() - interval '10 minutes'
       RETURNING status`,
      [userId, params.w]
    );
    return r.rowCount > 0;
  } finally {
    client.release();
  }
}

async function finishOptimizerRun(userId, { error } = {}) {
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    await client.query(
      `UPDATE user_fsrs_weights SET status = $2, last_error = $3, updated_at = now() WHERE user_id = $1`,
      [userId, error ? 'error' : 'idle', error || null]
    );
  } finally {
    client.release();
  }
}

// Lưu kết quả optimizer làm CANDIDATE — Phần 9: "KHÔNG tự động apply". weights hỏng thì KHÔNG lưu
// (throw, giữ nguyên active weights cũ — Phần 4/6 "current weights unchanged" nếu optimizer lỗi).
async function saveOptimizerCandidate(userId, { weights, reviewCount, meta }) {
  if (!isValidWeightsArray(weights)) {
    throw new Error(`saveOptimizerCandidate: weights không hợp lệ — KHÔNG lưu (Phần 4). Nhận được: ${Array.isArray(weights) ? weights.length : typeof weights} phần tử.`);
  }
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    const { params } = getSchedulerForRetention(undefined);
    await client.query(
      `INSERT INTO user_fsrs_weights (user_id, weights, enabled, candidate_weights, candidate_trained_at, candidate_review_count, candidate_meta, status, updated_at)
       VALUES ($1, $2, false, $3, now(), $4, $5::jsonb, 'idle', now())
       ON CONFLICT (user_id) DO UPDATE SET
         candidate_weights = $3, candidate_trained_at = now(), candidate_review_count = $4,
         candidate_meta = $5::jsonb, status = 'idle', last_error = NULL, updated_at = now()`,
      [userId, params.w, weights, Number.isFinite(reviewCount) ? reviewCount : 0, JSON.stringify(meta || {})]
    );
  } finally {
    client.release();
  }
}

const MIN_IMPROVEMENT_TO_RECOMMEND = 0.01; // ≥1% cải thiện log-loss tương đối trên validation mới đề xuất Apply (Phần 6/7/21)

// ── ORCHESTRATION — hàm DUY NHẤT api layer gọi để "Run Optimizer" (Phần 14: nút [Run Optimizer]).
//     Trả về SỚM (không train) nếu NOT_READY — đúng Phần 5/20: không ép chạy optimizer khi dữ liệu
//     chưa đủ tốt, báo rõ lý do. KHÔNG BAO GIỜ đụng fsrs_cards/review_history (Phần 19). ──
async function runOptimizer(userId, { desiredRetention } = {}) {
  const claimed = await claimOptimizerRun(userId);
  if (!claimed) {
    return { started: false, reason: 'ALREADY_RUNNING', message: 'Optimizer đang chạy cho tài khoản này — đợi hoàn tất rồi thử lại (Phần 15).' };
  }
  try {
    const { byCard, report, readiness } = await assessDataQuality(userId);

    if (readiness.status === 'NOT_READY') {
      await finishOptimizerRun(userId);
      return { started: true, completed: false, report, readiness };
    }

    const items = buildTrainingItems(byCard);
    const { train, validation } = splitTrainValidation(items, 0.8);
    if (train.length < 10 || validation.length < 3) {
      await finishOptimizerRun(userId);
      return {
        started: true, completed: false, report,
        readiness: { status: 'NOT_READY', reason: 'Không đủ SỐ THẺ khác nhau để chia tập train/validation đáng tin cậy (nhiều review nhưng dồn vào quá ít thẻ).' },
      };
    }

    const retention = Number.isFinite(desiredRetention) ? desiredRetention : DEFAULT_RETENTION;
    const { params: defaultParams } = getSchedulerForRetention(undefined);
    const defaultWeights = defaultParams.w;

    let personalWeights;
    try {
      personalWeights = await trainWithOfficialOptimizer(train, { enableShortTerm: true });
    } catch (e) {
      await finishOptimizerRun(userId, { error: e.message });
      throw e; // Phần 21: KHÔNG fallback tự viết approximation — báo lỗi rõ ràng ra ngoài, giữ nguyên active weights cũ.
    }

    const defaultValEval = evaluateWeights(defaultWeights, validation, { desiredRetention: retention });
    const personalValEval = evaluateWeights(personalWeights, validation, { desiredRetention: retention });
    const defaultTrainEval = evaluateWeights(defaultWeights, train, { desiredRetention: retention });
    const personalTrainEval = evaluateWeights(personalWeights, train, { desiredRetention: retention });

    const improvement = (defaultValEval.avgLogLoss !== null && personalValEval.avgLogLoss !== null && defaultValEval.avgLogLoss > 0)
      ? (defaultValEval.avgLogLoss - personalValEval.avgLogLoss) / defaultValEval.avgLogLoss
      : null;
    const recommend = improvement !== null && improvement >= MIN_IMPROVEMENT_TO_RECOMMEND;

    const meta = {
      dataQuality: report,
      trainCards: train.length,
      validationCards: validation.length,
      trainReviews: defaultTrainEval.sampleCount,
      validationReviews: defaultValEval.sampleCount,
      defaultScore: defaultValEval.avgLogLoss,
      personalScore: personalValEval.avgLogLoss,
      defaultTrainScore: defaultTrainEval.avgLogLoss,
      personalTrainScore: personalTrainEval.avgLogLoss,
      improvement,
      recommend,
      desiredRetention: retention,
      optimizerVersion: getOptimizerBindingVersion(),
      fsrsParamCount: FSRS6_PARAM_COUNT,
      computedAt: new Date().toISOString(),
    };

    if (!recommend) {
      // Phần 21 (mục 6, QUAN TRỌNG): "Nếu personal weights chưa chứng minh tốt hơn default weights
      // trên validation data → KHÔNG APPLY". Vẫn LƯU candidate để user tự xem chi tiết vì sao (KHÔNG
      // tự APPLY — applyPersonalWeights() là hành động RIÊNG, chỉ user bấm mới chạy), nhưng đánh dấu
      // rõ recommend=false để UI (Phần 14) không tô nút [Apply] như đề xuất mặc định.
    }

    await saveOptimizerCandidate(userId, { weights: personalWeights, reviewCount: report.validReviews, meta });
    await finishOptimizerRun(userId);
    return { started: true, completed: true, report, readiness, meta };
  } catch (e) {
    await finishOptimizerRun(userId, { error: e.message }).catch(() => {});
    throw e;
  }
}

// ── APPLY / ROLLBACK / RESET (Phần 8/9/10) — CHỈ đụng bảng user_fsrs_weights, KHÔNG BAO GIỜ đụng
//     fsrs_cards/review_history/stability/difficulty/reps/lapses (Phần 10). previous_* lưu ĐÚNG 1
//     cấp undo (không phải full version stack — đủ dùng, đúng tinh thần "không cần kiến trúc phức
//     tạp" của Phần 16) — Reset cũng ghi previous_* nên Reset tự nó CŨNG undo được qua Rollback. ──
async function applyPersonalWeights(userId) {
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    const r = await client.query('SELECT * FROM user_fsrs_weights WHERE user_id = $1', [userId]);
    if (!r.rows.length) throw new Error('Chưa có kết quả Optimizer nào để Apply — hãy chạy Run Optimizer trước.');
    const row = r.rows[0];
    if (row.status === 'running') throw new Error('Optimizer đang chạy — đợi hoàn tất trước khi Apply (Phần 15).');
    if (!isValidWeightsArray(row.candidate_weights)) {
      throw new Error('Chưa có candidate weights hợp lệ để Apply — hãy chạy Run Optimizer trước (Phần 4/9).');
    }
    await client.query(
      `UPDATE user_fsrs_weights SET
         previous_weights = weights, previous_enabled = enabled,
         previous_trained_at = trained_at, previous_review_count = review_count,
         weights = candidate_weights, enabled = true,
         trained_at = candidate_trained_at, review_count = candidate_review_count,
         applied_at = now(), updated_at = now()
       WHERE user_id = $1`,
      [userId]
    );
    invalidateActiveWeightsCache(userId);
    return { applied: true };
  } finally {
    client.release();
  }
}

async function rollbackPersonalWeights(userId) {
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    const r = await client.query('SELECT status, previous_weights, previous_enabled FROM user_fsrs_weights WHERE user_id = $1', [userId]);
    if (!r.rows.length || r.rows[0].previous_weights === null) {
      throw new Error('Không có trạng thái trước đó để khôi phục (chưa từng Apply/Reset, hoặc đã Rollback rồi).');
    }
    if (r.rows[0].status === 'running') throw new Error('Optimizer đang chạy — đợi hoàn tất trước khi Rollback (Phần 15).');
    const prevWeights = r.rows[0].previous_weights;
    const prevEnabled = !!r.rows[0].previous_enabled;
    await client.query(
      `UPDATE user_fsrs_weights SET
         weights = $2, enabled = $3,
         previous_weights = NULL, previous_enabled = NULL, previous_trained_at = NULL, previous_review_count = NULL,
         updated_at = now()
       WHERE user_id = $1`,
      [userId, prevWeights, prevEnabled]
    );
    invalidateActiveWeightsCache(userId);
    return { rolledBack: true, personalWeightsEnabled: prevEnabled };
  } finally {
    client.release();
  }
}

async function resetToDefaultWeights(userId) {
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    const r = await client.query('SELECT status, weights, enabled, trained_at, review_count FROM user_fsrs_weights WHERE user_id = $1', [userId]);
    if (!r.rows.length || !r.rows[0].enabled) {
      return { reset: true, alreadyDefault: true };
    }
    if (r.rows[0].status === 'running') throw new Error('Optimizer đang chạy — đợi hoàn tất trước khi Reset (Phần 15).');
    const cur = r.rows[0];
    await client.query(
      `UPDATE user_fsrs_weights SET
         enabled = false,
         previous_weights = $2, previous_enabled = $3, previous_trained_at = $4, previous_review_count = $5,
         updated_at = now()
       WHERE user_id = $1`,
      [userId, cur.weights, cur.enabled, cur.trained_at, cur.review_count]
    );
    invalidateActiveWeightsCache(userId);
    return { reset: true, alreadyDefault: false };
  } finally {
    client.release();
  }
}

// ── Trạng thái đầy đủ cho FE (Phần 14: GET /api/fsrs-optimizer/status) — luôn kèm readiness MỚI
//     NHẤT (tính lại từ review_history hiện tại, không cache — Phần 20: user cần thấy đúng số liệu
//     TRƯỚC khi quyết định bấm Run). ──
async function getOptimizerStatus(userId) {
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    const [r, { report, readiness }] = await Promise.all([
      client.query('SELECT * FROM user_fsrs_weights WHERE user_id = $1', [userId]),
      assessDataQuality(userId),
    ]);
    const base = { report, readiness };
    if (!r.rows.length) {
      return { ...base, personalWeightsEnabled: false, hasCandidate: false, canRollback: false, status: 'idle' };
    }
    const row = r.rows[0];
    return {
      ...base,
      personalWeightsEnabled: !!row.enabled,
      appliedAt: row.applied_at,
      activeTrainedAt: row.enabled ? row.trained_at : null,
      activeReviewCount: row.enabled ? row.review_count : null,
      hasCandidate: isValidWeightsArray(row.candidate_weights),
      candidateTrainedAt: row.candidate_trained_at,
      candidateReviewCount: row.candidate_review_count,
      candidateMeta: row.candidate_meta || null,
      canRollback: row.previous_weights !== null,
      status: row.status || 'idle',
      lastError: row.last_error || null,
      runStartedAt: row.run_started_at,
    };
  } finally {
    client.release();
  }
}

module.exports = {
  ensureOptimizerTables,
  exportReviewHistoryForOptimizer,
  getOptimizerReadiness,
  getUserWeights,
  saveUserWeights,
  MIN_REVIEWS_FOR_PERSONAL_TRAINING,
  // V82 — FSRS Personal Optimizer
  getUserActiveWeights,
  invalidateActiveWeightsCache,
  getOptimizerStatus,
  runOptimizer,
  applyPersonalWeights,
  rollbackPersonalWeights,
  resetToDefaultWeights,
  // exported thêm cho unit test (Phần 18) — thuần JS, không cần Postgres
  validateReviewHistory,
  classifyReadiness,
  buildTrainingItems,
  splitTrainValidation,
  evaluateWeights,
  binaryCrossEntropy,
  trainWithOfficialOptimizer,
  OptimizerDependencyError,
};
