// ════════════════════════════════════════════════════
// lib/fsrs/analytics.js — V69 kiến trúc chuẩn hóa
//
// 2 nhóm trách nhiệm:
//   1) FSRS analytics thuần (GET /api/fsrs/stats): retention thực tế, due/mature/young cards,
//      average stability/difficulty, daily reviews, review accuracy — TÍNH TỪ fsrs_cards +
//      review_history, KHÔNG tự suy luận/ước lượng ngoài dữ liệu FSRS thật.
//   2) Study Session Tracker + Streak + Heatmap: "study_sessions" là bảng MỚI, tách biệt hoàn
//      toàn khỏi fsrs_cards/review_history — KHÔNG đụng/đổi FSRS state, chỉ ghi nhận thời lượng
//      học để phục vụ dashboard.
//
// KHÔNG import "ts-fsrs" trực tiếp ở đây — mọi thứ liên quan tới lịch ôn tập vẫn đi qua
// lib/fsrs/scheduler.js. File này chỉ ĐỌC dữ liệu đã có sẵn trong Postgres.
// ════════════════════════════════════════════════════
const { getPool } = require('../db');
const { State } = require('./scheduler');

const VN_TZ = 'Asia/Ho_Chi_Minh';

// Một ngày được tính là "có học" nếu đạt 1 trong 2 ngưỡng này (đúng yêu cầu Phần 11 — Streak System).
const STREAK_MIN_MINUTES = 5;
const STREAK_MIN_REVIEWS = 10;

// Nếu lượt hoạt động (review) mới cách session đang mở dưới ngưỡng này thì coi là CÙNG 1 phiên học
// (nối dài session thay vì tạo phiên mới) — người dùng dừng đọc/suy nghĩ giữa 2 lượt review vẫn
// tính là đang học liên tục. Quá ngưỡng này (vd bỏ đi >15 phút) thì tính phiên học MỚI.
const SESSION_GAP_MS = 15 * 60 * 1000;

let analyticsTablesReady = null;
async function ensureAnalyticsTables(client) {
  if (analyticsTablesReady) return analyticsTablesReady;
  analyticsTablesReady = (async () => {
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS study_sessions (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          start_time TIMESTAMPTZ NOT NULL,
          end_time TIMESTAMPTZ NOT NULL,
          duration_seconds INT NOT NULL DEFAULT 0,
          cards_reviewed INT NOT NULL DEFAULT 0,
          correct_count INT NOT NULL DEFAULT 0,
          wrong_count INT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS study_sessions_user_start_idx ON study_sessions (user_id, start_time)`);
      // Truy vấn "session đang mở gần nhất của user" (để nối dài) cần sort theo end_time DESC nhanh.
      await client.query(`CREATE INDEX IF NOT EXISTS study_sessions_user_end_idx ON study_sessions (user_id, end_time DESC)`);
    } catch (e) {
      analyticsTablesReady = null;
      throw e;
    }
  })();
  return analyticsTablesReady;
}

// ── Ghi nhận 1 lượt hoạt động học (gọi từ reviewService sau MỖI lượt review) ──────────────
// Tự động nối dài session đang mở nếu lượt trước đó cách < SESSION_GAP_MS, ngược lại mở session
// mới. Đây là cơ chế "ngầm" (implicit tracking) — không bắt buộc frontend phải tự gọi start/end,
// nhưng vẫn có 2 hàm startExplicitSession/closeExplicitSession bên dưới cho frontend nào muốn
// tracking chủ động chính xác hơn (kể cả thời gian không review, ví dụ đang đọc ví dụ câu).
async function recordStudyActivity(userId, { correct, now }) {
  const client = await getPool().connect();
  const ts = now || new Date();
  try {
    await ensureAnalyticsTables(client);
    await client.query('BEGIN');
    const openRes = await client.query(
      `SELECT * FROM study_sessions WHERE user_id = $1 ORDER BY end_time DESC LIMIT 1 FOR UPDATE`,
      [userId]
    );
    const open = openRes.rows[0];
    const canExtend = open && (ts.getTime() - new Date(open.end_time).getTime()) <= SESSION_GAP_MS
      && (ts.getTime() - new Date(open.start_time).getTime()) >= 0;
    if (canExtend) {
      const newDuration = Math.max(open.duration_seconds, Math.round((ts.getTime() - new Date(open.start_time).getTime()) / 1000));
      await client.query(
        `UPDATE study_sessions SET end_time = $1, duration_seconds = $2,
           cards_reviewed = cards_reviewed + 1,
           correct_count = correct_count + $3, wrong_count = wrong_count + $4,
           updated_at = now()
         WHERE id = $5`,
        [ts, newDuration, correct ? 1 : 0, correct ? 0 : 1, open.id]
      );
    } else {
      await client.query(
        `INSERT INTO study_sessions (user_id, start_time, end_time, duration_seconds, cards_reviewed, correct_count, wrong_count)
         VALUES ($1, $2, $2, 0, 1, $3, $4)`,
        [userId, ts, correct ? 1 : 0, correct ? 0 : 1]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── Tracking chủ động (tùy chọn, cho frontend gọi trực tiếp nếu muốn đo cả thời gian không
//     review — vd đang nghe phát âm / đọc ví dụ). Không bắt buộc phải dùng; recordStudyActivity ở
//     trên đã tự đủ để có dữ liệu dashboard cơ bản từ review activity. ──
async function startExplicitSession(userId, now) {
  const client = await getPool().connect();
  try {
    await ensureAnalyticsTables(client);
    const ts = now || new Date();
    const r = await client.query(
      `INSERT INTO study_sessions (user_id, start_time, end_time, duration_seconds, cards_reviewed, correct_count, wrong_count)
       VALUES ($1, $2, $2, 0, 0, 0, 0) RETURNING id`,
      [userId, ts]
    );
    return r.rows[0].id;
  } finally {
    client.release();
  }
}

async function heartbeatExplicitSession(userId, sessionId, now) {
  const client = await getPool().connect();
  try {
    await ensureAnalyticsTables(client);
    const ts = now || new Date();
    const r = await client.query(
      `UPDATE study_sessions SET end_time = $1,
         duration_seconds = GREATEST(duration_seconds, EXTRACT(EPOCH FROM ($1 - start_time))::int),
         updated_at = now()
       WHERE id = $2 AND user_id = $3 RETURNING *`,
      [ts, sessionId, userId]
    );
    return r.rows[0] || null;
  } finally {
    client.release();
  }
}

// ── Dashboard: Hôm nay / 7 ngày / Toàn bộ (Phần 10) ────────────────────────────────────────
async function getDashboardSummary(userId) {
  const client = await getPool().connect();
  try {
    await ensureAnalyticsTables(client);
    const todayRes = await client.query(
      `SELECT
         COALESCE(SUM(duration_seconds), 0)::int AS duration_seconds,
         COALESCE(SUM(cards_reviewed), 0)::int AS cards_reviewed,
         COALESCE(SUM(correct_count), 0)::int AS correct_count,
         COALESCE(SUM(wrong_count), 0)::int AS wrong_count
       FROM study_sessions
       WHERE user_id = $1 AND (start_time AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
      [userId, VN_TZ]
    );
    const sevenRes = await client.query(
      `SELECT
         COALESCE(SUM(duration_seconds), 0)::int AS duration_seconds,
         COALESCE(SUM(cards_reviewed), 0)::int AS cards_reviewed
       FROM study_sessions
       WHERE user_id = $1 AND start_time >= now() - interval '7 days'`,
      [userId]
    );
    const allTimeRes = await client.query(
      `SELECT
         COALESCE(SUM(duration_seconds), 0)::int AS duration_seconds,
         COALESCE(SUM(cards_reviewed), 0)::int AS cards_reviewed
       FROM study_sessions WHERE user_id = $1`,
      [userId]
    );
    const wordsLearnedRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM fsrs_cards WHERE user_id = $1 AND reps > 0`,
      [userId]
    );
    const busiestDayRes = await client.query(
      `SELECT (start_time AT TIME ZONE $2)::date AS day, SUM(duration_seconds)::int AS secs
       FROM study_sessions WHERE user_id = $1
       GROUP BY day ORDER BY secs DESC LIMIT 1`,
      [userId, VN_TZ]
    );
    const today = todayRes.rows[0];
    const sevenDays = sevenRes.rows[0];
    const allTime = allTimeRes.rows[0];
    const totalAnswers = today.correct_count + today.wrong_count;
    return {
      today: {
        durationSeconds: today.duration_seconds,
        cardsReviewed: today.cards_reviewed,
        correctCount: today.correct_count,
        wrongCount: today.wrong_count,
        accuracy: totalAnswers > 0 ? +(today.correct_count / totalAnswers * 100).toFixed(1) : null,
      },
      last7Days: {
        totalDurationSeconds: sevenDays.duration_seconds,
        avgDurationSecondsPerDay: +(sevenDays.duration_seconds / 7).toFixed(0),
        cardsReviewed: sevenDays.cards_reviewed,
      },
      allTime: {
        totalDurationSeconds: allTime.duration_seconds,
        totalReviews: allTime.cards_reviewed,
        totalWordsLearned: wordsLearnedRes.rows[0].c,
        busiestDay: busiestDayRes.rows[0] ? { date: busiestDayRes.rows[0].day, durationSeconds: busiestDayRes.rows[0].secs } : null,
      },
    };
  } finally {
    client.release();
  }
}

// ── Streak (Phần 11): current + longest, dựa trên các NGÀY (giờ VN) đạt ngưỡng ──────────────
async function getStreak(userId) {
  const client = await getPool().connect();
  try {
    await ensureAnalyticsTables(client);
    const r = await client.query(
      `SELECT (start_time AT TIME ZONE $2)::date AS day,
              SUM(duration_seconds)::int AS secs,
              SUM(cards_reviewed)::int AS reviews
       FROM study_sessions
       WHERE user_id = $1
       GROUP BY day
       ORDER BY day DESC`,
      [userId, VN_TZ]
    );
    const qualifyingDays = r.rows
      .filter((row) => row.secs >= STREAK_MIN_MINUTES * 60 || row.reviews >= STREAK_MIN_REVIEWS)
      .map((row) => row.day.toISOString().slice(0, 10));

    if (qualifyingDays.length === 0) return { currentStreak: 0, longestStreak: 0 };

    const todayVn = new Intl.DateTimeFormat('en-CA', { timeZone: VN_TZ }).format(new Date());
    const daySet = new Set(qualifyingDays);

    // Current streak: đếm lùi từ HÔM NAY (hoặc HÔM QUA nếu hôm nay chưa học) — cho phép hôm nay
    // chưa kịp học mà vẫn giữ streak tới hết ngày, không bị "gãy" sớm khi đang xem dashboard.
    function addDays(dateStr, delta) {
      const d = new Date(dateStr + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + delta);
      return d.toISOString().slice(0, 10);
    }
    let cursor = daySet.has(todayVn) ? todayVn : addDays(todayVn, -1);
    let current = 0;
    while (daySet.has(cursor)) {
      current++;
      cursor = addDays(cursor, -1);
    }

    // Longest streak: quét toàn bộ các ngày đạt chuẩn, tìm dải liên tiếp dài nhất.
    const sortedAsc = [...qualifyingDays].sort();
    let longest = 1, run = 1;
    for (let i = 1; i < sortedAsc.length; i++) {
      if (addDays(sortedAsc[i - 1], 1) === sortedAsc[i]) { run++; } else { run = 1; }
      longest = Math.max(longest, run);
    }
    return { currentStreak: current, longestStreak: Math.max(longest, current) };
  } finally {
    client.release();
  }
}

// ── Heatmap kiểu GitHub (Phần 12): số phút học mỗi ngày trong N ngày gần nhất ──────────────
async function getHeatmap(userId, days) {
  const client = await getPool().connect();
  try {
    await ensureAnalyticsTables(client);
    const numDays = Number.isFinite(days) && days > 0 ? Math.min(days, 366) : 365;
    const r = await client.query(
      `SELECT (start_time AT TIME ZONE $2)::date AS day, SUM(duration_seconds)::int AS secs
       FROM study_sessions
       WHERE user_id = $1 AND start_time >= now() - ($3 || ' days')::interval
       GROUP BY day ORDER BY day ASC`,
      [userId, VN_TZ, numDays]
    );
    return r.rows.map((row) => ({
      date: row.day.toISOString().slice(0, 10),
      minutes: Math.round(row.secs / 60),
    }));
  } finally {
    client.release();
  }
}

// ── GET /api/fsrs/stats (Phần 8) ───────────────────────────────────────────────────────────
async function getFsrsStats(userId) {
  const client = await getPool().connect();
  try {
    const cardStatsRes = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE due <= now())::int AS due_cards,
         COUNT(*) FILTER (WHERE state = $2 AND stability >= 21)::int AS mature_cards,
         COUNT(*) FILTER (WHERE state = $2 AND stability < 21)::int AS young_cards,
         COALESCE(AVG(stability) FILTER (WHERE reps > 0), 0)::float AS average_stability,
         COALESCE(AVG(difficulty) FILTER (WHERE reps > 0), 0)::float AS average_difficulty,
         COUNT(*) FILTER (WHERE reps > 0)::int AS total_cards_studied
       FROM fsrs_cards WHERE user_id = $1`,
      [userId, State.Review]
    );
    // Retention thực tế: tỉ lệ review ĐÚNG trên các thẻ ĐANG Ở state Review TRƯỚC lượt review đó
    // (previous_state = Review) — đúng định nghĩa "retention" của FSRS (khả năng nhớ lại đúng lúc
    // đến hạn ôn), KHÔNG tính chung với New/Learning (là 2 state answerCorrect gần như luôn cao,
    // sẽ làm retention ảo cao hơn thực tế).
    const retentionRes = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE answer_correct)::int AS correct,
         COUNT(*)::int AS total
       FROM review_history WHERE user_id = $1 AND previous_state = $2`,
      [userId, State.Review]
    );
    const accuracyRes = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE answer_correct)::int AS correct,
         COUNT(*)::int AS total
       FROM review_history WHERE user_id = $1`,
      [userId]
    );
    const dailyRes = await client.query(
      `SELECT (reviewed_at AT TIME ZONE $2)::date AS day, COUNT(*)::int AS count
       FROM review_history
       WHERE user_id = $1 AND reviewed_at >= now() - interval '30 days'
       GROUP BY day ORDER BY day ASC`,
      [userId, VN_TZ]
    );
    // Dashboard V74: "Từ mới hôm nay" = lượt review đầu tiên của thẻ đang ở state New (chưa từng học);
    // "Số lần review hôm nay" = lượt review của thẻ đã học trước đó (Learning/Review/Relearning).
    // Cùng định nghĩa với getTodayStudyCounts() ở lib/db.js, tính lại tại đây để /api/fsrs/stats trả
    // đủ số cho dashboard trong 1 lần gọi, không phải gọi thêm route khác.
    const todayRes = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE previous_state = 0)::int AS new_today,
         COUNT(*) FILTER (WHERE previous_state != 0)::int AS review_today
       FROM review_history
       WHERE user_id = $1 AND (reviewed_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
      [userId, VN_TZ]
    );
    // Dashboard V80 (Thống kê — biểu đồ phân bổ trạng thái FSRS): đếm SỐ THẺ THẬT theo từng state
    // (New/Learning/Review/Relearning) — 1 query GROUP BY nhẹ, CHỈ ĐỌC, không đụng schema/thuật
    // toán FSRS. Lưu ý: state=New hầu như luôn ≈0 vì fsrs_cards chỉ được tạo dòng ngay khi user
    // review lần đầu (xem reviewFsrsCard trong lib/db.js) — đây là phản ánh ĐÚNG hệ thống hiện tại,
    // không phải lỗi.
    const stateRes = await client.query(
      `SELECT state, COUNT(*)::int AS c FROM fsrs_cards WHERE user_id = $1 GROUP BY state`,
      [userId]
    );
    const stateBreakdown = { newCount: 0, learningCount: 0, reviewCount: 0, relearningCount: 0 };
    for (const row of stateRes.rows) {
      if (row.state === State.New) stateBreakdown.newCount = row.c;
      else if (row.state === State.Learning) stateBreakdown.learningCount = row.c;
      else if (row.state === State.Review) stateBreakdown.reviewCount = row.c;
      else if (row.state === State.Relearning) stateBreakdown.relearningCount = row.c;
    }

    const cs = cardStatsRes.rows[0];
    const ret = retentionRes.rows[0];
    const acc = accuracyRes.rows[0];
    const td = todayRes.rows[0];
    return {
      dueCards: cs.due_cards,
      matureCards: cs.mature_cards,
      youngCards: cs.young_cards,
      averageStability: +cs.average_stability.toFixed(3),
      averageDifficulty: +cs.average_difficulty.toFixed(3),
      totalCardsStudied: cs.total_cards_studied,
      retention: ret.total > 0 ? +(ret.correct / ret.total * 100).toFixed(1) : null,
      reviewAccuracy: acc.total > 0 ? +(acc.correct / acc.total * 100).toFixed(1) : null,
      totalReviews: acc.total,
      dailyReviews: dailyRes.rows.map((r) => ({ date: r.day.toISOString().slice(0, 10), count: r.count })),
      newToday: td.new_today,
      reviewToday: td.review_today,
      stateBreakdown,
    };
  } finally {
    client.release();
  }
}

module.exports = {
  ensureAnalyticsTables,
  recordStudyActivity,
  startExplicitSession,
  heartbeatExplicitSession,
  getDashboardSummary,
  getStreak,
  getHeatmap,
  getFsrsStats,
  STREAK_MIN_MINUTES,
  STREAK_MIN_REVIEWS,
};
