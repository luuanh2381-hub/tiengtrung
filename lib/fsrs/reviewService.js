// ════════════════════════════════════════════════════
// lib/fsrs/reviewService.js — V69 kiến trúc chuẩn hóa
//
// "Mọi review phải đi qua scheduler layer" (yêu cầu audit, Phần 4): đây là HÀM DUY NHẤT api layer
// (api/index.js) được gọi để ghi 1 lượt review. Nó điều phối:
//   1) Đọc desired_retention của user (bảng user_settings, Phần 5) — mặc định 0.90 nếu chưa set.
//   2) Gọi lib/db.js:reviewFsrsCard(...) — nơi DUY NHẤT ghi/đổi fsrs_cards + review_history, bên
//      trong đó lại gọi lib/fsrs.js (ts-fsrs) — vẫn chỉ 1 scheduler thật duy nhất.
//   3) Ghi nhận hoạt động học vào study_sessions (lib/fsrs/analytics.js) — KHÔNG đụng FSRS state.
// api/index.js KHÔNG được gọi thẳng db.reviewFsrsCard nữa (Phần 4: "mọi review phải đi qua
// scheduler layer") — chỉ gọi reviewService.reviewCard(...) ở đây.
// ════════════════════════════════════════════════════
const { getPool, reviewFsrsCard: dbReviewFsrsCard } = require('../db');
const { ALLOWED_RETENTIONS, isAllowedRetention, DEFAULT_RETENTION } = require('./scheduler');
const { recordStudyActivity } = require('./analytics');

let userSettingsTableReady = null;
async function ensureUserSettingsTable(client) {
  if (userSettingsTableReady) return userSettingsTableReady;
  userSettingsTableReady = (async () => {
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_settings (
          user_id TEXT PRIMARY KEY,
          desired_retention DOUBLE PRECISION NOT NULL DEFAULT 0.90
            CHECK (desired_retention IN (0.80, 0.85, 0.90, 0.95)),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
    } catch (e) {
      userSettingsTableReady = null;
      throw e;
    }
  })();
  return userSettingsTableReady;
}

async function getUserSettings(userId) {
  const client = await getPool().connect();
  try {
    await ensureUserSettingsTable(client);
    const r = await client.query('SELECT desired_retention FROM user_settings WHERE user_id = $1', [userId]);
    return {
      desiredRetention: r.rows.length ? Number(r.rows[0].desired_retention) : DEFAULT_RETENTION,
      allowedRetentions: ALLOWED_RETENTIONS,
    };
  } finally {
    client.release();
  }
}

async function setUserRetention(userId, desiredRetention) {
  if (!isAllowedRetention(desiredRetention)) {
    throw new Error(`desired_retention không hợp lệ — chỉ chấp nhận ${ALLOWED_RETENTIONS.join(', ')}`);
  }
  const client = await getPool().connect();
  try {
    await ensureUserSettingsTable(client);
    await client.query(
      `INSERT INTO user_settings (user_id, desired_retention, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET desired_retention = $2, updated_at = now()`,
      [userId, Number(desiredRetention)]
    );
    return { desiredRetention: Number(desiredRetention) };
  } finally {
    client.release();
  }
}

// ── HÀM DUY NHẤT api layer gọi để ghi 1 lượt review FSRS. ──────────────────────────────────
async function reviewCard({ userId, hz, l, answerCorrect, responseTimeMs, answerChanges }) {
  const { desiredRetention } = await getUserSettings(userId);
  const result = await dbReviewFsrsCard({
    userId, hz, l, answerCorrect, responseTimeMs, answerChanges, desiredRetention,
  });
  // Ghi nhận hoạt động học cho dashboard/streak/heatmap — KHÔNG được để lỗi ở bước này làm hỏng
  // kết quả review chính (FSRS đã ghi thành công là quan trọng nhất); log lỗi và tiếp tục.
  try {
    await recordStudyActivity(userId, { correct: !!answerCorrect, now: new Date() });
  } catch (e) {
    console.error('⚠️  [study_sessions] Không ghi được hoạt động học:', e && e.message);
  }
  return { ...result, desiredRetentionUsed: desiredRetention };
}

module.exports = {
  ensureUserSettingsTable,
  getUserSettings,
  setUserRetention,
  reviewCard,
};
