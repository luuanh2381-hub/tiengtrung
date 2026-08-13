// ════════════════════════════════════════════════════
// lib/fsrs/optimizer.js — V69 kiến trúc chuẩn hóa
//
// 2 trách nhiệm (Phần 6/7 của audit — CHƯA train tự động, chỉ chuẩn bị dữ liệu + schema):
//   1) Xuất review_history theo format tương thích FSRS Optimizer (mỗi dòng = 1 lượt review, đủ
//      field: card_id, review_time, rating, response_time_ms, stability/difficulty trước-sau,
//      scheduled_days, elapsed_days).
//   2) Bảng "user_fsrs_weights" — lưu weights ĐÃ TRAIN riêng cho từng user (khi có script/job
//      train chạy trong tương lai). Nếu chưa có → fallback default weights của ts-fsrs.
//
// KHÔNG tự chạy thuật toán train ở đây (đúng yêu cầu "chưa cần train tự động").
// ════════════════════════════════════════════════════
const { getPool } = require('../db');
const { State, Rating, getSchedulerForRetention } = require('./scheduler');

// Rating string ('again'/'hard'/'good'/'easy') → số 1-4 đúng chuẩn format FSRS Optimizer
// (1=Again,2=Hard,3=Good,4=Easy — giống enum Rating của ts-fsrs, KHÔNG tự định nghĩa lại).
const RATING_TO_NUMBER = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };

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

// ── Personal weights (Phần 7): lấy weights riêng nếu có, fallback default nếu chưa train ──────
async function getUserWeights(userId) {
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    const r = await client.query('SELECT weights, trained_at, review_count FROM user_fsrs_weights WHERE user_id = $1', [userId]);
    if (r.rows.length) {
      return { weights: r.rows[0].weights, trainedAt: r.rows[0].trained_at, reviewCount: r.rows[0].review_count, isPersonal: true };
    }
    const { params } = getSchedulerForRetention(undefined); // default scheduler params (default w)
    return { weights: params.w, trainedAt: null, reviewCount: 0, isPersonal: false };
  } finally {
    client.release();
  }
}

// Lưu weights đã train (dùng bởi 1 job/script train trong tương lai — CHƯA gọi ở đâu trong hệ
// thống hiện tại). weights PHẢI có đúng 21 phần tử (FSRS-6) — validate trước khi ghi để không lưu
// nhầm weights của phiên bản FSRS khác.
async function saveUserWeights(userId, weights, reviewCount) {
  if (!Array.isArray(weights) || weights.length !== 21) {
    throw new Error(`user_fsrs_weights: weights phải có đúng 21 phần tử (FSRS-6), nhận được ${Array.isArray(weights) ? weights.length : typeof weights}`);
  }
  const client = await getPool().connect();
  try {
    await ensureOptimizerTables(client);
    await client.query(
      `INSERT INTO user_fsrs_weights (user_id, weights, trained_at, review_count, updated_at)
       VALUES ($1, $2, now(), $3, now())
       ON CONFLICT (user_id) DO UPDATE SET weights = $2, trained_at = now(), review_count = $3, updated_at = now()`,
      [userId, weights, Number.isFinite(reviewCount) ? reviewCount : 0]
    );
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
};
