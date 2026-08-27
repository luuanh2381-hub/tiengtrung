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
      // status/run_started_at/last_error (V82) — GIỮ LẠI cột (không xoá, backward-safe), nhưng V85
      // KHÔNG còn ghi vào 3 cột này nữa (xem ADDENDUM V85 bên dưới) — nguồn sự thật cho trạng thái
      // "đang chạy" giờ là bảng fsrs_optimizer_jobs (1 job = 1 lượt Run, có lịch sử, có heartbeat).
      // Cột cũ vẫn còn trong schema để KHÔNG phá dữ liệu/migration cũ, chỉ đơn giản là không ai ghi
      // thêm vào đó nữa (đọc lại luôn ưu tiên fsrs_optimizer_jobs — xem getOptimizerStatus()).
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'idle'`);
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS run_started_at TIMESTAMPTZ`);
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS last_error TEXT`);
      await client.query(`ALTER TABLE user_fsrs_weights ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ`);

      // ════════════════════════════════════════════════════
      // V85 — ADDENDUM (kiến trúc bất đồng bộ) — bảng MỚI fsrs_optimizer_jobs.
      //
      // Vì sao cần bảng RIÊNG thay vì tiếp tục dùng 3 cột status/run_started_at/last_error ở trên:
      // user_fsrs_weights là bảng "weights đang có" (active/candidate/previous — versioning), còn
      // 1 LƯỢT CHẠY OPTIMIZER là 1 THỰC THỂ KHÁC hẳn (có vòng đời riêng: queued→running→completed/
      // failed, có stage/progress/heartbeat, và NÊN giữ được LỊCH SỬ nhiều lượt chạy để debug/audit
      // — 3 cột cũ chỉ giữ được ĐÚNG 1 lượt "gần nhất", ghi đè mất lượt trước). Tách riêng cũng giúp
      // khoá race-condition (Phần "IDEMPOTENCY/CONCURRENCY") nằm Ở TẦNG DATABASE thật (partial unique
      // index bên dưới), không chỉ dựa vào biến nhớ tạm trong 1 process (memoized) như trước.
      //
      // status: 'queued' | 'running' | 'completed' | 'failed'
      // stage:  'queued' | 'loading_reviews' | 'preparing_data' | 'training' | 'evaluating' |
      //         'saving' | 'completed' | 'failed'  — hiển thị TIẾN ĐỘ THẬT cho FE (không fake).
      // data_quality: cache JSONB của {report, readiness} — tính 1 LẦN ở stage preparing_data, để
      //   GET /api/fsrs-optimizer/status (polling liên tục) đọc THẲNG từ đây thay vì quét lại toàn
      //   bộ review_history mỗi lần poll (yêu cầu "status API không được nặng").
      // result_meta: JSONB kết quả cuối (default/personal score, improvement, recommend...) — CHỈ
      //   set khi completed VÀ thật sự có train (NULL nếu NOT_READY — không có gì để train).
      // error_message: lỗi ĐẦY ĐỦ (nội bộ) — CHỈ trả cho admin. error_public: câu lỗi AN TOÀN cho
      //   user thường (Phần "ERROR SECURITY" — không lộ stack/đường dẫn/chi tiết native module).
      // heartbeat_at: worker cập nhật định kỳ trong lúc chạy — dùng để phát hiện job "chết" giữa
      //   chừng (process bị Vercel thu hồi/redeploy/crash ngoài try-catch) mà KHÔNG BAO GIỜ tới được
      //   nhánh finally để tự đóng job — xem recoverStaleJobsForUser() bên dưới.
      // ════════════════════════════════════════════════════
      await client.query(`
        CREATE TABLE IF NOT EXISTS fsrs_optimizer_jobs (
          id BIGSERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          stage TEXT NOT NULL DEFAULT 'queued',
          desired_retention DOUBLE PRECISION,
          progress_current INT,
          progress_total INT,
          data_quality JSONB,
          result_meta JSONB,
          error_message TEXT,
          error_public TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          started_at TIMESTAMPTZ,
          heartbeat_at TIMESTAMPTZ,
          finished_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      // Partial unique index — CHÍNH LÀ khoá chống 2 job cùng chạy song song cho 1 user, thực thi ở
      // TẦNG DATABASE (không chỉ tin tưởng app-layer): tại 1 thời điểm, mỗi user CHỈ được có TỐI ĐA
      // 1 dòng có status IN ('queued','running'). INSERT thứ 2 khi đã có 1 dòng active sẽ tự động bị
      // Postgres từ chối (lỗi 23505 unique_violation) — createOptimizerJob() bắt lỗi này và trả lại
      // đúng job đang có, KHÔNG tạo job trùng (an toàn cả khi 2 request tới gần như cùng lúc, khác
      // hẳn kiểu lock "đọc rồi mới ghi" dễ dính race condition).
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_fsrs_optimizer_jobs_active_per_user
          ON fsrs_optimizer_jobs (user_id) WHERE status IN ('queued', 'running')
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_fsrs_optimizer_jobs_user_created
          ON fsrs_optimizer_jobs (user_id, created_at DESC)
      `);
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
// luồng optimizer tự phục vụ nếu có trong tương lai). Luồng optimizer tự phục vụ (runOptimizerJob →
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
// ⚠️ V83-FIX-v3 — đã xác minh lại với tài liệu THẬT (npm/GitHub/napi-rs docs) của package, không
// còn đoán API. 2 điểm quan trọng đã xác nhận:
//   1) require('@open-spaced-repetition/binding') LÀ đường vào chính thức cho Node.js server-side.
//      Loader do chính package sinh ra (napi-rs) tự thử native binary theo platform TRƯỚC, và nếu
//      native không load được thì TỰ ĐỘNG rơi xuống WASI — nhưng CHỈ KHI gói tài nguyên WASM
//      "@open-spaced-repetition/binding-wasm32-wasi" có mặt trong node_modules. Gói này KHÔNG nằm
//      trong optionalDependencies mặc định của package base (đã xác nhận qua tài liệu npm chính
//      thức: "Before using this setup, install the WASI asset package manually") — nghĩa là bản
//      trước của project này KHÔNG có fallback WASI nào cả dù comment cũ tưởng là có. Đã thêm gói
//      này vào "optionalDependencies" của package.json (không phải "dependencies" — để npm không
//      fail nếu 1 ngày nào đó gói ngừng publish, đúng tinh thần Phần 3 "npm không fail vì platform
//      mismatch").
//   2) "@open-spaced-repetition/binding/dynamic-wasi" (entry mà 1 số hướng dẫn hay nhắc tới) là API
//      DÀNH CHO BUNDLER TRÌNH DUYỆT (ví dụ Vite, cú pháp import ...?url/...?worker) — KHÔNG áp dụng
//      cho Node.js server thuần (Express trên Vercel Function). Dùng nó ở đây sẽ là tự viết loader
//      sai bản chất (Phần 4 cấm "tự viết WASM loader"). Vì vậy trainWithOfficialOptimizer() dưới
//      đây CHỈ require() đúng 1 entry point — cách chính thức, đơn giản nhất, đúng tài liệu.
// KHÔNG tự viết gradient descent/optimizer thay thế (Phần 3/21) — nếu dependency thiếu/lỗi/API
// không đúng, ném lỗi RÕ RÀNG kèm chẩn đoán đầy đủ, KHÔNG fallback approximation.
class OptimizerDependencyError extends Error {}

function getOptimizerBindingVersion() {
  try { return require('@open-spaced-repetition/binding/package.json').version; } catch { return null; }
}

// Tên gói native platform tương ứng runtime hiện tại — CHỈ dùng để CHẨN ĐOÁN (hiển thị cho admin/
// status API, xem getOptimizerEngineStatus), KHÔNG quyết định require() nào (loader của chính
// package tự làm việc đó ở bước trên). Giả định glibc trên Linux vì Vercel Node Functions chạy
// Amazon Linux (không phải musl/Alpine) — nếu sai, chỉ ảnh hưởng dòng chẩn đoán, không ảnh hưởng
// khả năng train thật.
function detectExpectedNativePackageName() {
  const { platform, arch } = process;
  if (platform === 'darwin') return `@open-spaced-repetition/binding-darwin-${arch === 'arm64' ? 'arm64' : 'x64'}`;
  if (platform === 'win32') return '@open-spaced-repetition/binding-win32-x64-msvc';
  if (platform === 'linux') return `@open-spaced-repetition/binding-linux-${arch}-gnu`;
  return null;
}

function safeGlibcVersion() {
  try {
    const report = process.report && process.report.getReport && process.report.getReport();
    return (report && report.header && report.header.glibcVersionRuntime) || null;
  } catch { return null; }
}

// Memoize trong vòng đời 1 process (1 Vercel Function instance) — require() gọi nhiều lần vẫn từ
// cache module của Node, nhưng phép thử "engine nào đang chạy" (best-effort) tốn thêm 1 require()
// phụ, không cần lặp lại mỗi request.
let cachedEngine = null;
function resetOptimizerEngineCache() { cachedEngine = null; } // chỉ dùng cho test, KHÔNG gọi từ API

// loadOfficialOptimizer() — Phần 6: loader production-safe, KHÔNG swallow lỗi. Trả về 1 object mô
// tả ĐẦY ĐỦ trạng thái (available/engine/runtime/error) — trainWithOfficialOptimizer() và
// getOptimizerEngineStatus() (Phần 11, GET /api/fsrs-optimizer/status) dùng CHUNG kết quả này, nên
// user luôn thấy đúng 1 sự thật dù hỏi trước hay sau khi bấm Run.
function loadOfficialOptimizer() {
  if (cachedEngine) return cachedEngine;
  const runtime = { node: process.version, platform: process.platform, arch: process.arch, glibc: safeGlibcVersion() };
  const expectedNative = detectExpectedNativePackageName();

  let binding = null, requireError = null;
  try {
    binding = require('@open-spaced-repetition/binding');
  } catch (e) {
    requireError = e;
  }

  if (!binding) {
    let wasmAssetPresent = false;
    try { require.resolve('@open-spaced-repetition/binding-wasm32-wasi/package.json'); wasmAssetPresent = true; } catch {}
    cachedEngine = {
      available: false, engine: null, packageVersion: null, ...runtime,
      nativeBinary: expectedNative, wasmAssetPresent,
      error: `Cannot require '@open-spaced-repetition/binding': ${requireError.message}`,
    };
    return cachedEngine;
  }

  const { computeParameters, FSRSBindingItem, FSRSBindingReview } = binding;
  if (typeof computeParameters !== 'function' || typeof FSRSBindingItem !== 'function' || typeof FSRSBindingReview !== 'function') {
    cachedEngine = {
      available: false, engine: null, packageVersion: getOptimizerBindingVersion(), ...runtime,
      nativeBinary: expectedNative, wasmAssetPresent: null,
      error: 'Package đã load nhưng KHÔNG export đúng computeParameters/FSRSBindingItem/FSRSBindingReview ' +
        '(API public beta có thể đã đổi — mở node_modules/@open-spaced-repetition/binding/README.md thật ' +
        'rồi cập nhật trainWithOfficialOptimizer(), KHÔNG tự viết optimizer thay thế).',
    };
    return cachedEngine;
  }

  // Best-effort: engine nào ĐANG chạy (native hay WASI)? Package không expose cờ này qua public
  // API — suy luận GIÁN TIẾP bằng cách thử require() gói native tương ứng platform hiện tại. Đây
  // CHỈ để hiển thị chẩn đoán (Phần 7: phân biệt OPTIMIZER_NATIVE_READY/OPTIMIZER_WASI_READY),
  // KHÔNG ảnh hưởng gì tới binding đã require() thành công ở trên.
  let engine = 'unknown';
  if (expectedNative) {
    try { require(expectedNative); engine = 'native'; } catch { engine = 'wasi'; }
  }

  cachedEngine = {
    available: true, engine, packageVersion: getOptimizerBindingVersion(), ...runtime,
    nativeBinary: expectedNative, wasmAssetPresent: null, error: null, binding,
  };
  return cachedEngine;
}

// getOptimizerEngineStatus() (Phần 11) — diagnostic công khai, dùng cho GET /api/fsrs-optimizer/
// status (xem getOptimizerStatus() bên dưới). KHÔNG expose thông tin nhạy cảm (không có stack
// trace/đường dẫn hệ thống — chỉ message ngắn gọn).
function getOptimizerEngineStatus() {
  const e = loadOfficialOptimizer();
  return {
    available: e.available,
    engine: e.engine,
    packageVersion: e.packageVersion,
    nodeVersion: e.node,
    platform: e.platform,
    arch: e.arch,
    glibcVersion: e.glibc || null,
    nativeBinary: e.nativeBinary || null,
    error: e.error || null,
  };
}

// V83-FIX-v4 — production giờ báo lỗi MỚI: client nhận response KHÔNG PHẢI JSON khi bấm Run trên
// dataset thật (4060 review/794 thẻ) — khác hẳn lỗi "Cannot find module" cũ (đã xác nhận FIX xong,
// "Engine: Native" đã lên xanh). Non-JSON response nghĩa là request KHÔNG hề chạm tới fail()/route
// handler của chính app (2 chỗ đó LUÔN trả JSON, xem api/index.js) — tức là process bị giết ở tầng
// HẠ TẦNG (Vercel timeout SIGKILL, hoặc native Rust code crash/panic không được N-API bắt lại), vượt
// ngoài khả năng try/catch của JS. Nghi ngờ nhiều nhất: train trên ~600+ thẻ thật (khác hẳn dataset
// tổng hợp nhỏ của smoke test) chạy LÂU hơn dự kiến trên Vercel Node Function.
// computeParameters() có option "timeout" CÓ THẬT (xác nhận qua ví dụ chính thức trên trang npm:
// `computeParameters(items, { enableShortTerm, numRelearningSteps, timeout: 500, progress })`) — cho
// phép Rust-side TỰ dừng và trả lỗi JS bắt được, THAY VÌ để Vercel platform SIGKILL cả process giữa
// chừng (đó là nguồn gốc response non-JSON). Đơn vị chính xác (ms hay giây) KHÔNG được xác nhận rõ
// trong tài liệu — đoán ms theo convention JS phổ biến (Date.now()/setTimeout/fetch timeout đều ms).
// Đặt an toàn dưới vercel.json:functions."api/index.js".maxDuration (60s) để timeout NÀY luôn kích
// hoạt TRƯỚC khi Vercel platform kill cả process — chỉ có ý nghĩa NẾU nguyên nhân thật là "chạy lâu",
// KHÔNG giúp được nếu nguyên nhân là native panic/crash không phụ thuộc thời gian (2 khả năng này chỉ
// phân biệt được chắc chắn qua Vercel Function Logs thật — xem TROUBLESHOOTING-FSRS-OPTIMIZER.md).
const OPTIMIZER_COMPUTE_TIMEOUT_MS = Number(process.env.FSRS_OPTIMIZER_TIMEOUT_MS) || 45_000;

async function trainWithOfficialOptimizer(trainItems, { enableShortTerm = true, onProgress = null } = {}) {
  const engine = loadOfficialOptimizer();
  if (!engine.available) {
    throw new OptimizerDependencyError(
      `Optimizer chính thức "@open-spaced-repetition/binding" KHÔNG load được trên môi trường hiện ` +
      `tại (node=${engine.node} platform=${engine.platform} arch=${engine.arch}` +
      `${engine.glibc ? ` glibc=${engine.glibc}` : ''}). Lỗi gốc: ${engine.error}. ` +
      `Gói WASM fallback ${engine.wasmAssetPresent ? 'CÓ mặt' : 'KHÔNG có mặt'} trong node_modules. ` +
      'Đây là lỗi triển khai (deployment) — xem scripts/verify-optimizer-binding.js trong Build Logs ' +
      'của Vercel để biết đây là lỗi cài đặt (npm install) hay lỗi đóng gói function (Node File Trace).'
    );
  }
  const { binding } = engine;
  const { computeParameters, FSRSBindingItem, FSRSBindingReview } = binding;
  const bindingItems = trainItems.map((item) =>
    new FSRSBindingItem(item.reviews.map((r) => new FSRSBindingReview(r.rating, r.deltaT)))
  );
  const trainStartedAt = Date.now();
  let lastProgressLogAt = 0;
  let result;
  try {
    result = await computeParameters(bindingItems, {
      enableShortTerm,
      timeout: OPTIMIZER_COMPUTE_TIMEOUT_MS,
      // CHỈ để log tiến độ vào Vercel Function Logs (chẩn đoán — KHÔNG ảnh hưởng kết quả train).
      // Throttle còn ~1 dòng/2s để không spam log thật với dataset nhiều iteration.
      progress: (current, total) => {
        const now = Date.now();
        // V85 — onProgress (nếu có) là đường để runOptimizerJob() ghi heartbeat/progress THẬT vào
        // fsrs_optimizer_jobs trong lúc train (Phần "PROGRESS" — không fake tiến độ). Throttle CHUNG
        // 1 mốc thời gian cho cả log console lẫn onProgress — KHÔNG gọi onProgress dày hơn mức cần
        // thiết (mỗi lần gọi là 1 UPDATE vào Postgres, xem updateJobHeartbeat()).
        if (now - lastProgressLogAt < 2000 && current !== total) return;
        lastProgressLogAt = now;
        console.log(`[fsrs-optimizer] computeParameters progress: ${current}/${total} (+${((now - trainStartedAt) / 1000).toFixed(1)}s)`);
        if (typeof onProgress === 'function') {
          try { onProgress(current, total); } catch { /* KHÔNG để lỗi ở callback phụ làm hỏng việc train chính */ }
        }
      },
    });
    console.log(`[fsrs-optimizer] computeParameters xong sau ${((Date.now() - trainStartedAt) / 1000).toFixed(1)}s — engine=${engine.engine}`);
  } catch (e) {
    throw new OptimizerDependencyError(
      `Optimizer chính thức chạy lỗi khi train (engine=${engine.engine}, sau ${((Date.now() - trainStartedAt) / 1000).toFixed(1)}s, ` +
      `timeout cấu hình=${OPTIMIZER_COMPUTE_TIMEOUT_MS}ms): ${e.message}`
    );
  }
  // computeParameters có thể trả thẳng mảng w, { parameters: [...] }, hoặc { w: [...] } tuỳ version
  // — chấp nhận cả 3 hình dạng nhưng KHÔNG đoán mò nếu không khớp cái nào (fail rõ ràng thay vì âm
  // thầm sai, đúng Phần 21).
  const weights = Array.isArray(result) ? result
    : (result && Array.isArray(result.parameters)) ? result.parameters
    : (result && Array.isArray(result.w)) ? result.w
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

// ════════════════════════════════════════════════════
// V85 — ADDENDUM: KIẾN TRÚC BẤT ĐỒNG BỘ (ASYNC JOB) cho "Run Optimizer"
//
// TẠI SAO: trước V85, toàn bộ pipeline (đọc review_history → validate → build training items →
// computeParameters() CHÍNH THỨC (có thể mất vài giây tới hàng chục giây tuỳ dataset) → evaluate 4
// lượt (default/personal × train/validation) → lưu candidate) chạy HẾT trong 1 request HTTP DUY
// NHẤT (POST /api/fsrs-optimizer/run). Trên Vercel, nếu tổng thời gian vượt quá thời gian sống của
// request đó, Vercel SIGKILL cả process giữa chừng — KHÔNG phải lỗi JS bắt được (vượt ngoài try/
// catch) → client không nhận được response nào, DB kẹt ở "status=running", UI đứng mãi "Đang chạy...".
//
// SAU V85: POST /run chỉ TẠO JOB (rẻ — vài query nhỏ, không đọc review_history) rồi trả về NGAY
// (202). Việc kích hoạt worker chạy job đó là 1 request HTTP MỚI, TÁCH RỜI, tự gọi tới chính route
// POST /api/fsrs-optimizer/worker của ứng dụng (xem api/index.js) — vì đó là 1 INVOCATION HOÀN TOÀN
// KHÁC (đồng hồ maxDuration riêng, không phải phần nối dài của request trình duyệt đang đợi), lỗi/
// timeout ở worker KHÔNG BAO GIỜ khiến trình duyệt phải chờ. Trình duyệt chỉ poll GET
// /api/fsrs-optimizer/status (rẻ — đọc job mới nhất theo index, KHÔNG quét lại review_history) để
// biết tiến độ THẬT: queued → running (kèm stage/progress) → completed/failed.
//
// waitUntil() (lib/runInBackground.js) CHỈ dùng ĐÚNG vai trò nó được thiết kế — giữ 1 invocation
// sống thêm SAU KHI đã trả response CHO CHÍNH INVOCATION ĐÓ — ở ĐÚNG 2 chỗ hẹp trong api/index.js:
//   1) POST /run bắn request kích hoạt worker, KHÔNG đợi worker chạy xong.
//   2) POST /worker tự trả 202 cho CHÍNH request đó rồi mới chạy runOptimizerJob() ở nền — waitUntil
//      ở đây giữ ĐÚNG invocation của WORKER sống, KHÔNG phải kéo dài invocation gốc mà trình duyệt
//      gọi. Đây KHÔNG phải "dùng waitUntil để né timeout cho 1 job dài" (bị cấm) — nếu làm vậy ngay
//      trong POST /run thì vẫn sai kiến trúc y hệt bản cũ; ở đây waitUntil chỉ trì hoãn việc đóng 1
//      invocation PHỤ mà không ai đang đợi phản hồi cuối cùng của nó.
//
// AN TOÀN KHI WORKER CHẾT GIỮA CHỪNG (hết maxDuration của CHÍNH worker, redeploy, cold kill…):
// heartbeat_at được cập nhật định kỳ (mỗi lần đổi stage + mỗi ~2s trong lúc train qua onProgress) —
// recoverStaleJobsForUser() tự chuyển job "queued quá lâu chưa được worker claim" hoặc "running
// nhưng hết heartbeat quá lâu" thành 'failed' kèm thông báo rõ ràng, KHÔNG kẹt vĩnh viễn. Được gọi ở
// ĐẦU createOptimizerJob() (trước khi quyết định có cho Run mới không) VÀ ở ĐẦU getOptimizerStatus()
// (user thấy "failed" + nút Retry ngay ở lần poll tiếp theo, không cần tự bấm Run lại mới phát hiện).
//
// GIỚI HẠN CÒN LẠI (nói thẳng — giống văn phong các audit report trước của project này): nếu 1 ngày
// nào đó dataset lớn tới mức pipeline vượt quá maxDuration của CHÍNH worker (đã nâng lên trong
// vercel.json — xem ghi chú ở đó), heartbeat/stale-recovery vẫn đảm bảo UI không kẹt (tự chuyển
// failed, cho Retry) — nhưng KHÔNG tự chia 1 lượt train thành nhiều invocation nối tiếp
// (computeParameters() của binding chính thức là 1 lệnh gọi nguyên khối, không có API checkpoint
// giữa chừng). Nếu tới ngưỡng đó, bước nâng cấp tự nhiên tiếp theo là Vercel Queues/Workflow (durable
// execution, chạy được nhiều phút/giờ) — KHÔNG nằm trong phạm vi sửa lần này vì đó là hạ tầng MỚI cần
// tự cấu hình trên Dashboard (ngoài khả năng tự làm thay trong 1 lượt sửa code).
// ════════════════════════════════════════════════════

const OPTIMIZER_QUEUED_STALE_MS = Number(process.env.FSRS_OPTIMIZER_QUEUED_STALE_MS) || 60_000; // job "queued" quá lâu mà chưa có worker claim (vd request kích hoạt worker bị mất) → coi như chết
const OPTIMIZER_RUNNING_STALE_MS = Number(process.env.FSRS_OPTIMIZER_RUNNING_STALE_MS) || 180_000; // job "running" nhưng mất heartbeat quá lâu → coi như worker đã chết giữa chừng
const GENERIC_OPTIMIZER_ERROR_MESSAGE = 'Optimizer thất bại. Vui lòng thử lại.'; // Phần "ERROR SECURITY" — user thường CHỈ thấy đúng câu này
const GENERIC_STALE_ERROR_MESSAGE = 'Optimizer bị gián đoạn do sự cố hạ tầng (worker không phản hồi). Vui lòng thử chạy lại.';

// Nhận 1 client Postgres ĐÃ MỞ SẴN (gọi từ trong createOptimizerJob/getOptimizerStatus/hasActiveJob
// — những hàm đó đã tự ensureOptimizerTables() + giữ client riêng) — KHÔNG tự mở thêm kết nối mới ở
// đây (Phần "PERFORMANCE" — tránh cạn connection pool nếu gọi lồng nhau).
async function recoverStaleJobsForUser(client, userId) {
  await client.query(
    `UPDATE fsrs_optimizer_jobs SET
       status = 'failed', stage = 'failed',
       error_message = 'Job không có heartbeat trong thời gian dài — coi như worker đã chết giữa chừng (bị Vercel thu hồi/redeploy/mất kết nối/crash ngoài try-catch).',
       error_public = $4,
       finished_at = now(), heartbeat_at = now(), updated_at = now()
     WHERE user_id = $1
       AND (
         (status = 'queued'  AND created_at                                     < now() - ($2 || ' milliseconds')::interval)
         OR
         (status = 'running' AND COALESCE(heartbeat_at, started_at, created_at) < now() - ($3 || ' milliseconds')::interval)
       )`,
    [userId, String(OPTIMIZER_QUEUED_STALE_MS), String(OPTIMIZER_RUNNING_STALE_MS), GENERIC_STALE_ERROR_MESSAGE]
  );
}

// Định dạng 1 dòng job cho FE — Phần "ERROR SECURITY": user thường CHỈ nhận errorPublic (câu chung
// chung, an toàn); admin mới thấy thêm errorMessage (lỗi nội bộ đầy đủ). Với non-admin, BỎ HẲN key
// errorMessage (không trả null) — tránh lộ thông tin qua việc CÓ MẶT field dù giá trị rỗng.
function mapJobRow(row, { isAdmin = false } = {}) {
  if (!row) return null;
  const hasProgress = Number.isFinite(row.progress_current) || Number.isFinite(row.progress_total);
  return {
    id: row.id,
    status: row.status, // 'queued' | 'running' | 'completed' | 'failed'
    stage: row.stage,
    progress: hasProgress ? { current: row.progress_current ?? null, total: row.progress_total ?? null } : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
    resultMeta: row.result_meta || null,
    errorPublic: row.error_public || null,
    ...(isAdmin ? { errorMessage: row.error_message || null } : {}),
  };
}

// ── Tạo job mới (Phần "Frontend → POST /run → Create optimizer job → return NGAY"). RẺ: vài query
//     nhỏ theo khoá chính/partial index, KHÔNG đọc review_history. An toàn với double-click/nhiều
//     tab/nhiều thiết bị nhờ partial unique index (uq_fsrs_optimizer_jobs_active_per_user, xem
//     ensureOptimizerTables) — INSERT thứ 2 khi đã có job active bị Postgres từ chối (23505), bắt lỗi
//     đó và trả lại job đã có, KHÔNG throw ra ngoài cho case bình thường này (Test bắt buộc #4). ──
async function createOptimizerJob(userId, { desiredRetention } = {}) {
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    await recoverStaleJobsForUser(client, userId);

    const existing = await client.query(
      `SELECT * FROM fsrs_optimizer_jobs WHERE user_id = $1 AND status IN ('queued', 'running')
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (existing.rows.length) {
      return { job: mapJobRow(existing.rows[0]), created: false };
    }

    try {
      const r = await client.query(
        `INSERT INTO fsrs_optimizer_jobs (user_id, status, stage, desired_retention, heartbeat_at)
         VALUES ($1, 'queued', 'queued', $2, now())
         RETURNING *`,
        [userId, Number.isFinite(desiredRetention) ? desiredRetention : null]
      );
      return { job: mapJobRow(r.rows[0]), created: true };
    } catch (e) {
      if (e && e.code === '23505') {
        // Race THẬT: 2 request tạo job gần như đồng thời — request KIA đã thắng, đọc lại job đó.
        const r2 = await client.query(
          `SELECT * FROM fsrs_optimizer_jobs WHERE user_id = $1 AND status IN ('queued', 'running')
           ORDER BY created_at DESC LIMIT 1`,
          [userId]
        );
        if (r2.rows.length) return { job: mapJobRow(r2.rows[0]), created: false };
      }
      throw e;
    }
  } finally {
    client.release();
  }
}

// ── Claim NGUYÊN TỬ: queued → running. Trả về null nếu job KHÔNG còn 'queued' (đã bị claim bởi 1
//     lần trigger khác, hoặc đã completed/failed) — worker return sớm nếu null, đảm bảo
//     runOptimizerJob() AN TOÀN khi bị gọi trùng (Phần "IDEMPOTENCY/CONCURRENCY"). ──
async function claimQueuedJob(jobId, userId) {
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    const r = await client.query(
      `UPDATE fsrs_optimizer_jobs
       SET status = 'running', stage = 'loading_reviews', started_at = now(), heartbeat_at = now(), updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'queued'
       RETURNING *`,
      [jobId, userId]
    );
    return r.rows[0] || null;
  } finally {
    client.release();
  }
}

// ── Heartbeat + stage/progress — worker gọi liên tục trong lúc chạy (Phần "PROGRESS": Queued/Loading
//     reviews/Preparing data/Training/Evaluating/Saving/Completed — KHÔNG hiện "Đang chạy..." mãi). ──
async function updateJobHeartbeat(jobId, { stage, progressCurrent, progressTotal } = {}) {
  const client = await getPool().connect();
  try {
    const sets = ['heartbeat_at = now()', 'updated_at = now()'];
    const params = [jobId];
    if (stage) { params.push(stage); sets.push(`stage = $${params.length}`); }
    if (Number.isFinite(progressCurrent)) { params.push(progressCurrent); sets.push(`progress_current = $${params.length}`); }
    if (Number.isFinite(progressTotal)) { params.push(progressTotal); sets.push(`progress_total = $${params.length}`); }
    await client.query(`UPDATE fsrs_optimizer_jobs SET ${sets.join(', ')} WHERE id = $1`, params);
  } finally {
    client.release();
  }
}

// Ghi data_quality (report+readiness) NGAY sau khi validate xong — GET /status đọc CACHE này thay vì
// quét lại review_history mỗi lần poll (Phần "STATUS API" — không được nặng).
async function setJobDataQuality(jobId, dataQuality) {
  const client = await getPool().connect();
  try {
    await client.query(
      `UPDATE fsrs_optimizer_jobs SET data_quality = $2::jsonb, heartbeat_at = now(), updated_at = now() WHERE id = $1`,
      [jobId, JSON.stringify(dataQuality)]
    );
  } finally {
    client.release();
  }
}

async function finishJob(jobId, { status, stage, resultMeta, errorMessage, errorPublic } = {}) {
  const client = await getPool().connect();
  try {
    await client.query(
      `UPDATE fsrs_optimizer_jobs SET
         status = $2, stage = $3,
         result_meta = COALESCE($4::jsonb, result_meta),
         error_message = $5, error_public = $6,
         finished_at = now(), heartbeat_at = now(), updated_at = now()
       WHERE id = $1`,
      [jobId, status, stage, resultMeta ? JSON.stringify(resultMeta) : null, errorMessage || null, errorPublic || null]
    );
  } finally {
    client.release();
  }
}

// ── Có job nào đang queued/running cho user này không — dùng để CHẶN Apply/Rollback/Reset trong lúc
//     optimizer đang chạy (thay cho cột user_fsrs_weights.status cũ — xem ghi chú ở ensureOptimizerTables). ──
async function hasActiveJob(userId) {
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    await recoverStaleJobsForUser(client, userId);
    const r = await client.query(
      `SELECT 1 FROM fsrs_optimizer_jobs WHERE user_id = $1 AND status IN ('queued', 'running') LIMIT 1`,
      [userId]
    );
    return r.rows.length > 0;
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
      `INSERT INTO user_fsrs_weights (user_id, weights, enabled, candidate_weights, candidate_trained_at, candidate_review_count, candidate_meta, updated_at)
       VALUES ($1, $2, false, $3, now(), $4, $5::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE SET
         candidate_weights = $3, candidate_trained_at = now(), candidate_review_count = $4,
         candidate_meta = $5::jsonb, updated_at = now()`,
      [userId, params.w, weights, Number.isFinite(reviewCount) ? reviewCount : 0, JSON.stringify(meta || {})]
    );
  } finally {
    client.release();
  }
}

const MIN_IMPROVEMENT_TO_RECOMMEND = 0.01; // ≥1% cải thiện log-loss tương đối trên validation mới đề xuất Apply (Phần 6/7/21)

// ── WORKER — hàm DUY NHẤT làm việc NẶNG thật sự (đọc review_history → validate → build training
//     items → train CHÍNH THỨC → evaluate → lưu candidate). CHỈ được gọi từ route nội bộ POST
//     /api/fsrs-optimizer/worker (api/index.js), KHÔNG BAO GIỜ từ route mà trình duyệt đang chờ phản
//     hồi (đó chính là bug kiến trúc của bản trước V85). An toàn khi bị gọi trùng (idempotent) nhờ
//     claimQueuedJob() ở đầu — nếu job không còn 'queued', return sớm, KHÔNG chạy lại pipeline. KHÔNG
//     BAO GIỜ đụng fsrs_cards/review_history (chỉ ĐỌC, không ghi — Phần 19). ──
async function runOptimizerJob(jobId, userId) {
  const claimedRow = await claimQueuedJob(jobId, userId);
  if (!claimedRow) return; // đã bị claim/hoàn tất bởi lượt gọi khác — no-op an toàn, KHÔNG chạy trùng

  console.log(`[fsrs-optimizer] job #${jobId} bắt đầu — user=${String(userId).slice(0, 3)}*** retention=${claimedRow.desired_retention ?? 'default'}`);

  try {
    await updateJobHeartbeat(jobId, { stage: 'loading_reviews' });
    const rawRows = await fetchAllReviewRowsForTraining(userId);

    await updateJobHeartbeat(jobId, { stage: 'preparing_data' });
    const { byCard, report } = validateReviewHistory(rawRows);
    const readiness = classifyReadiness(report);
    await setJobDataQuality(jobId, { report, readiness });

    if (readiness.status === 'NOT_READY') {
      await finishJob(jobId, { status: 'completed', stage: 'completed' });
      console.log(`[fsrs-optimizer] job #${jobId} hoàn tất — NOT_READY, không train (${report.validReviews} review hợp lệ).`);
      return;
    }

    const items = buildTrainingItems(byCard);
    const { train, validation } = splitTrainValidation(items, 0.8);
    if (train.length < 10 || validation.length < 3) {
      await setJobDataQuality(jobId, {
        report,
        readiness: { status: 'NOT_READY', reason: 'Không đủ SỐ THẺ khác nhau để chia tập train/validation đáng tin cậy (nhiều review nhưng dồn vào quá ít thẻ).' },
      });
      await finishJob(jobId, { status: 'completed', stage: 'completed' });
      return;
    }

    const retention = Number.isFinite(claimedRow.desired_retention) ? claimedRow.desired_retention : DEFAULT_RETENTION;
    const { params: defaultParams } = getSchedulerForRetention(undefined);
    const defaultWeights = defaultParams.w;

    await updateJobHeartbeat(jobId, { stage: 'training', progressCurrent: 0, progressTotal: train.length });
    let personalWeights;
    try {
      personalWeights = await trainWithOfficialOptimizer(train, {
        enableShortTerm: true,
        onProgress: (current, total) => {
          // Fire-and-forget CÓ CHỦ ĐÍCH — KHÔNG await trong callback đồng bộ của computeParameters()
          // (tránh làm chậm chính vòng lặp train chỉ vì 1 UPDATE heartbeat phụ); lỗi ghi heartbeat
          // (nếu có) không được phép làm hỏng việc train chính, chỉ log để biết.
          updateJobHeartbeat(jobId, { stage: 'training', progressCurrent: current, progressTotal: total })
            .catch((e) => console.error(`[fsrs-optimizer] job #${jobId} lỗi ghi heartbeat (bỏ qua, không ảnh hưởng train):`, e && e.message));
        },
      });
    } catch (e) {
      await finishJob(jobId, {
        status: 'failed', stage: 'failed',
        errorMessage: e.message,
        errorPublic: GENERIC_OPTIMIZER_ERROR_MESSAGE,
      });
      return; // Phần 21: KHÔNG fallback tự viết approximation — job kết thúc ở 'failed', active weights giữ nguyên.
    }

    await updateJobHeartbeat(jobId, { stage: 'evaluating' });
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
    // Phần 21 (mục 6, QUAN TRỌNG): dù recommend=false ("chưa chứng minh tốt hơn default trên
    // validation"), VẪN lưu candidate để user tự xem chi tiết vì sao (KHÔNG tự APPLY — Apply là hành
    // động RIÊNG, chỉ user bấm mới chạy). UI chỉ đơn giản không tô nút [Apply] như đề xuất mặc định.

    await updateJobHeartbeat(jobId, { stage: 'saving' });
    await saveOptimizerCandidate(userId, { weights: personalWeights, reviewCount: report.validReviews, meta });

    await finishJob(jobId, { status: 'completed', stage: 'completed', resultMeta: meta });
    console.log(`[fsrs-optimizer] job #${jobId} hoàn tất — recommend=${recommend} improvement=${improvement}`);
  } catch (e) {
    console.error(`[fsrs-optimizer] job #${jobId} lỗi ngoài dự kiến:`, e && e.message);
    await finishJob(jobId, {
      status: 'failed', stage: 'failed',
      errorMessage: e && e.message,
      errorPublic: GENERIC_OPTIMIZER_ERROR_MESSAGE,
    }).catch((e2) => console.error(`[fsrs-optimizer] job #${jobId} — LỖI KÉP: không ghi được finishJob:`, e2 && e2.message));
  }
}

// ── APPLY / ROLLBACK / RESET (Phần 8/9/10) — CHỈ đụng bảng user_fsrs_weights, KHÔNG BAO GIỜ đụng
//     fsrs_cards/review_history/stability/difficulty/reps/lapses (Phần 10). previous_* lưu ĐÚNG 1
//     cấp undo (không phải full version stack — đủ dùng, đúng tinh thần "không cần kiến trúc phức
//     tạp" của Phần 16) — Reset cũng ghi previous_* nên Reset tự nó CŨNG undo được qua Rollback. ──
async function applyPersonalWeights(userId) {
  // V85: guard "đang chạy" giờ đọc từ fsrs_optimizer_jobs (nguồn sự thật duy nhất cho trạng thái
  // chạy), KHÔNG còn đọc cột user_fsrs_weights.status cũ (đã ngừng ghi — xem ensureOptimizerTables).
  if (await hasActiveJob(userId)) throw new Error('Optimizer đang chạy — đợi hoàn tất trước khi Apply (Phần 15).');
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    const r = await client.query('SELECT * FROM user_fsrs_weights WHERE user_id = $1', [userId]);
    if (!r.rows.length) throw new Error('Chưa có kết quả Optimizer nào để Apply — hãy chạy Run Optimizer trước.');
    const row = r.rows[0];
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
  if (await hasActiveJob(userId)) throw new Error('Optimizer đang chạy — đợi hoàn tất trước khi Rollback (Phần 15).');
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    const r = await client.query('SELECT previous_weights, previous_enabled FROM user_fsrs_weights WHERE user_id = $1', [userId]);
    if (!r.rows.length || r.rows[0].previous_weights === null) {
      throw new Error('Không có trạng thái trước đó để khôi phục (chưa từng Apply/Reset, hoặc đã Rollback rồi).');
    }
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
    const r = await client.query('SELECT weights, enabled, trained_at, review_count FROM user_fsrs_weights WHERE user_id = $1', [userId]);
    if (!r.rows.length || !r.rows[0].enabled) {
      return { reset: true, alreadyDefault: true };
    }
    if (await hasActiveJob(userId)) throw new Error('Optimizer đang chạy — đợi hoàn tất trước khi Reset (Phần 15).');
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

// ── Ước tính readiness RẺ (Phần "STATUS API — không được nặng"): dùng khi user CHƯA TỪNG chạy
//     Optimizer lần nào (chưa có job → chưa có data_quality cache) — 1 query AGGREGATE duy nhất
//     (COUNT/MIN/MAX/COUNT FILTER, Postgres tự làm bằng index scan, KHÔNG kéo hàng nghìn dòng về
//     Node rồi validate từng dòng như validateReviewHistory()). Đây là ƯỚC TÍNH LẠC QUAN (chưa loại
//     trùng lặp/timestamp tương lai/elapsed_days âm — những lỗi đó CHỈ lộ ra khi thật sự Run, lúc đó
//     data_quality thật sẽ ghi đè cache này) — đủ dùng để quyết định BẬT/TẮT nút Run trước khi chạy,
//     KHÔNG dùng để hiển thị "kết quả cuối cùng chính xác tuyệt đối". Cache ngắn (TTL nhỏ) theo
//     userId để không tính lại mỗi lần poll liên tục trong vài giây. ──
const quickReadinessCache = new Map();
const QUICK_READINESS_TTL_MS = 15000;

async function getQuickReadinessSnapshot(userId) {
  const cached = quickReadinessCache.get(userId);
  if (cached && (Date.now() - cached.at) < QUICK_READINESS_TTL_MS) return cached.value;
  const client = await getPool().connect();
  try {
    const r = await client.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(DISTINCT (hz, l))::int AS cards,
         MIN(reviewed_at) AS min_at, MAX(reviewed_at) AS max_at,
         COUNT(*) FILTER (WHERE rating = 'again')::int AS n_again,
         COUNT(*) FILTER (WHERE rating = 'hard')::int  AS n_hard,
         COUNT(*) FILTER (WHERE rating = 'good')::int  AS n_good,
         COUNT(*) FILTER (WHERE rating = 'easy')::int  AS n_easy
       FROM review_history WHERE user_id = $1`,
      [userId]
    );
    const row = r.rows[0];
    const total = row.total || 0;
    const ratingDistribution = { again: row.n_again || 0, hard: row.n_hard || 0, good: row.n_good || 0, easy: row.n_easy || 0 };
    const knownRatingTotal = ratingDistribution.again + ratingDistribution.hard + ratingDistribution.good + ratingDistribution.easy;
    const report = {
      totalReviews: total,
      validReviews: knownRatingTotal, // ước tính — xem ghi chú ở trên
      invalidReviews: Math.max(0, total - knownRatingTotal),
      duplicates: 0, // chưa tính được bằng aggregate query — chỉ biết chính xác SAU khi Run
      uniqueCards: row.cards || 0,
      dateRange: (row.min_at && row.max_at) ? {
        from: new Date(row.min_at).toISOString(),
        to: new Date(row.max_at).toISOString(),
        days: Math.max(1, Math.round((new Date(row.max_at) - new Date(row.min_at)) / 86400000)),
      } : null,
      ratingDistribution,
      issues: [], issuesTruncated: false,
      approximate: true, // FE có thể hiện ghi chú "ước tính — số chính xác sau khi Run"
    };
    const readiness = classifyReadiness(report);
    const value = { report, readiness };
    quickReadinessCache.set(userId, { value, at: Date.now() });
    return value;
  } finally {
    client.release();
  }
}

// Bỏ các field kỹ thuật nhạy cảm (lỗi gốc/node/platform/arch/glibc/tên package native kỳ vọng) khỏi
// engineStatus trước khi trả cho user THƯỜNG — Phần "ERROR SECURITY": chỉ admin mới thấy chẩn đoán
// đầy đủ. Thực thi Ở TẦNG SERVER (không chỉ ẩn ở UI như bản trước V85 — trước đó FE nhận đủ field
// qua JSON rồi mới tự ẩn, vẫn xem được nếu mở DevTools/Network).
function sanitizeEngineStatusForUser(e) {
  return { available: e.available, engine: e.engine, packageVersion: e.packageVersion };
}

// ── Trạng thái đầy đủ cho FE (GET /api/fsrs-optimizer/status) — Phần "STATUS API": KHÔNG được kéo
//     toàn bộ review_history mỗi lần poll. Data quality lấy từ CACHE của job gần nhất (tính 1 lần ở
//     stage preparing_data) nếu đã có job; nếu CHƯA từng chạy job nào, dùng ước tính rẻ
//     (getQuickReadinessSnapshot). isAdmin do route truyền vào (dựa trên role thật của user đang gọi
//     — Phần "ERROR SECURITY"). ──
async function getOptimizerStatus(userId, { isAdmin = false } = {}) {
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    await recoverStaleJobsForUser(client, userId);

    const [weightsRes, jobRes] = await Promise.all([
      client.query('SELECT * FROM user_fsrs_weights WHERE user_id = $1', [userId]),
      client.query('SELECT * FROM fsrs_optimizer_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userId]),
    ]);

    // Diagnostic (Phần 11): cho FE biết NGAY optimizer chính thức có load được trên server hay
    // không, VÀ đang chạy bằng engine nào (native/wasi) — TRƯỚC khi user bấm Run (tránh chờ rồi mới
    // thấy lỗi). Chỉ đọc trạng thái loadOfficialOptimizer() (memoized), KHÔNG train/không đụng gì
    // tới weights/scheduler.
    const engineStatus = getOptimizerEngineStatus();
    // Phần 7: 4 trạng thái tường minh — KHÔNG gộp chung 1 chữ "chưa sẵn sàng" mơ hồ giữa lỗi
    // deployment (native/WASI đều không load được) và lỗi dữ liệu (readiness.status = NOT_READY).
    const optimizerEngineState = !engineStatus.available ? 'OPTIMIZER_UNAVAILABLE'
      : engineStatus.engine === 'native' ? 'OPTIMIZER_NATIVE_READY'
      : engineStatus.engine === 'wasi' ? 'OPTIMIZER_WASI_READY'
      : 'OPTIMIZER_READY'; // package load OK nhưng không suy luận được engine cụ thể (best-effort)

    const jobRow = jobRes.rows[0] || null;
    const { report, readiness } = (jobRow && jobRow.data_quality)
      ? jobRow.data_quality
      : await getQuickReadinessSnapshot(userId);

    const base = {
      report, readiness,
      bindingAvailable: engineStatus.available, // giữ nguyên tên field cũ — KHÔNG phá tương thích UI hiện tại
      bindingVersion: engineStatus.packageVersion,
      optimizerEngineState,
      engineStatus: isAdmin ? engineStatus : sanitizeEngineStatusForUser(engineStatus), // Phần "ERROR SECURITY"
      job: mapJobRow(jobRow, { isAdmin }), // V85 — chi tiết job mới nhất: status/stage/progress/timestamps
    };
    // status/lastError/runStartedAt: GIỮ NGUYÊN TÊN field cũ để không phá tương thích ngược, nhưng
    // giờ phản ánh JOB gần nhất (nguồn sự thật mới) thay vì 3 cột user_fsrs_weights.status/
    // run_started_at/last_error đã ngừng dùng.
    const status = jobRow ? jobRow.status : 'idle'; // 'queued'|'running'|'completed'|'failed'|'idle' (chưa từng chạy)
    const lastError = jobRow ? (isAdmin ? jobRow.error_message : jobRow.error_public) : null;
    const runStartedAt = jobRow ? jobRow.started_at : null;

    if (!weightsRes.rows.length) {
      return { ...base, personalWeightsEnabled: false, hasCandidate: false, canRollback: false, status, lastError, runStartedAt };
    }
    const row = weightsRes.rows[0];
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
      status, lastError, runStartedAt,
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
  getOptimizerBindingVersion,
  // V83-FIX-v3 — engine loader diagnostics (Phần 2/6/11)
  loadOfficialOptimizer,
  getOptimizerEngineStatus,
  resetOptimizerEngineCache,
  // V85 — kiến trúc job bất đồng bộ (Phần "YÊU CẦU KIẾN TRÚC")
  createOptimizerJob,
  runOptimizerJob,
  hasActiveJob,
  saveOptimizerCandidate,
  getQuickReadinessSnapshot,
};
