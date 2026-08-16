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
const {
  getPool, reviewFsrsCard: dbReviewFsrsCard,
  countDueFsrsCards, getDueFsrsCards, getNewWordsByLessonOrder, countNewWordsInLessons,
  getTodayStudyCounts, getWeakFsrsCards, vnDateKey,
} = require('../db');
const { ALLOWED_RETENTIONS, isAllowedRetention, DEFAULT_RETENTION } = require('./scheduler');
const { recordStudyActivity } = require('./analytics');
const { runInBackground } = require('../runInBackground');
const {
  resolveStudyScope, resolveCurrentLesson, buildLessonPriorityOrder, studySettings,
  formatVocabWord, formatFsrsCard,
} = require('./studyScope');

// V72 (audit hiệu năng): getUserSettings() TRƯỚC ĐÂY mở 1 connection + 1 query MỚI cho MỖI LẦN
// review (kể cả khi user không hề đổi desired_retention giữa các lượt — gần như luôn luôn vậy).
// Cache theo userId, chỉ 4 giá trị hợp lệ có thể có (ALLOWED_RETENTIONS) nên footprint nhỏ, không
// cần LRU/giới hạn kích thước. Ghi-qua (write-through): setUserRetention cập nhật cache ngay sau
// khi ghi Postgres thành công, nên không có cửa sổ đọc-cache-cũ sau khi chính user đó vừa đổi
// setting trong CÙNG 1 serverless instance.
const userSettingsCache = new Map();

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
  if (userSettingsCache.has(userId)) return userSettingsCache.get(userId);
  const client = await getPool().connect();
  try {
    await ensureUserSettingsTable(client);
    const r = await client.query('SELECT desired_retention FROM user_settings WHERE user_id = $1', [userId]);
    const settings = {
      desiredRetention: r.rows.length ? Number(r.rows[0].desired_retention) : DEFAULT_RETENTION,
      allowedRetentions: ALLOWED_RETENTIONS,
    };
    userSettingsCache.set(userId, settings);
    return settings;
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
    // V72: ghi-qua cache ngay — lượt review tiếp theo của user này (kể cả trong cùng request kế
    // tiếp) thấy đúng giá trị mới, không cần đợi cache tự hết hạn (cache này không có TTL).
    userSettingsCache.set(userId, { desiredRetention: Number(desiredRetention), allowedRetentions: ALLOWED_RETENTIONS });
    return { desiredRetention: Number(desiredRetention) };
  } finally {
    client.release();
  }
}

// V76 (Yêu cầu 3 — dọn cache khi reset): API /api/fsrs/reset và /api/user/reset-learning-data gọi
// hàm này SAU KHI xoá xong DB, để lượt review kế tiếp không đọc trúng desired_retention đã cache
// từ TRƯỚC lúc reset (chỉ ảnh hưởng /api/user/reset-learning-data — nơi user_settings thực sự bị
// xoá; gọi ở cả 2 endpoint cho an toàn, không hại gì nếu retention không đổi).
function invalidateUserSettingsCache(userId) {
  userSettingsCache.delete(userId);
}

// ── Dashboard "Hôm nay học" (Yêu cầu 1 — chuyển từ api/index.js sang đây: mọi quyết định "còn bao
//     nhiêu thẻ/từ mới nào" phải nằm trong reviewService, api layer chỉ gọi + trả JSON). ──────────
async function getTodayOverview(userId, ui) {
  const { scopeLessons, allLessonsWithVocab } = await resolveStudyScope(ui || {});
  const currentLesson = resolveCurrentLesson(ui || {}, scopeLessons);
  const [dueCount, newInScope, weakCards] = await Promise.all([
    countDueFsrsCards(userId),
    countNewWordsInLessons(userId, scopeLessons),
    getWeakFsrsCards(userId, 200),
  ]);
  return {
    dueCount,
    newInCurrentLesson: newInScope,
    currentLesson,
    hasScope: scopeLessons.length > 0 || allLessonsWithVocab.length > 0,
    weakCount: weakCards.length,
  };
}

// ── Lấy 1 session học: REVIEW (due) trước, NEW sau; FSRS luôn ưu tiên hơn NEW. Đây là hàm DUY
//     NHẤT quyết định "từ tiếp theo là từ nào" cho mọi tab luyện tập (Hôm nay học/Flashcard/Trắc
//     nghiệm/Gõ chữ/Nghe-chọn đều gọi chung /api/study/session, xem js/study-queue.js). ───────────
async function getStudySession(userId, ui) {
  const safeUi = ui || {};
  const { dailyReviewLimit, dailyNewLimit, newOnlyAfterDue } = studySettings(safeUi);

  const [{ scopeLessons, allLessonsWithVocab }, { newToday, reviewToday }, totalDue] = await Promise.all([
    resolveStudyScope(safeUi),
    getTodayStudyCounts(userId, vnDateKey()),
    countDueFsrsCards(userId),
  ]);
  const currentLesson = resolveCurrentLesson(safeUi, scopeLessons);

  const remainingReviewSlots = Math.max(0, dailyReviewLimit - reviewToday);
  const remainingNewSlots = Math.max(0, dailyNewLimit - newToday);

  const blockedByBacklog = newOnlyAfterDue && totalDue > remainingReviewSlots;
  const { inScopeOrder, outside } = buildLessonPriorityOrder(currentLesson, scopeLessons, allLessonsWithVocab);
  const [dueCards, firstPassNewCards] = await Promise.all([
    remainingReviewSlots > 0 ? getDueFsrsCards(userId, remainingReviewSlots) : Promise.resolve([]),
    (remainingNewSlots > 0 && !blockedByBacklog)
      ? getNewWordsByLessonOrder(userId, inScopeOrder, remainingNewSlots)
      : Promise.resolve([]),
  ]);

  let newCards = firstPassNewCards;
  if (remainingNewSlots > 0 && !blockedByBacklog && newCards.length < remainingNewSlots && outside.length) {
    const more = await getNewWordsByLessonOrder(userId, outside, remainingNewSlots - newCards.length);
    newCards = newCards.concat(more);
  }

  const session = [
    ...dueCards.map(c => ({ type: 'review', word: formatFsrsCard(c) })),
    ...newCards.map(w => ({ type: 'new', word: formatVocabWord(w) })),
  ];
  // Khử trùng lặp theo hz — phòng trường hợp CÙNG 1 chữ Hán được coi là 2 "thẻ" khác nhau ở 2 bài
  // (l) khác nhau. Với người học, thấy đúng 1 chữ Hán 2 lần trong 1 phiên VẪN LÀ lặp — gộp về 1
  // thẻ/hz, ưu tiên giữ thẻ due (review) trước thẻ new nếu trùng.
  const seenHz = new Set();
  const dedupedSession = session.filter(it => {
    if (seenHz.has(it.word.hz)) return false;
    seenHz.add(it.word.hz);
    return true;
  });
  return {
    session: dedupedSession,
    reviewCount: dueCards.length, newCount: newCards.length,
    currentLesson, totalDue,
    blockedByBacklog,
  };
}

// ── HÀM DUY NHẤT api layer gọi để ghi 1 lượt review FSRS. ──────────────────────────────────
async function reviewCard({ userId, hz, l, answerCorrect, responseTimeMs, answerChanges, idempotencyKey }) {
  const { desiredRetention } = await getUserSettings(userId);
  const result = await dbReviewFsrsCard({
    userId, hz, l, answerCorrect, responseTimeMs, answerChanges, desiredRetention, idempotencyKey,
  });
  // V72 (audit hiệu năng — Phần "học chậm"): ghi nhận hoạt động học (study_sessions, cho
  // dashboard/streak/heatmap) TRƯỚC ĐÂY `await` ngay tại đây — nghĩa là user phải CHỜ THÊM 1
  // transaction Postgres riêng (mở connection + BEGIN + SELECT...FOR UPDATE + UPDATE/INSERT +
  // COMMIT) trước khi thấy kết quả câu vừa trả lời, dù kết quả đó KHÔNG hề phụ thuộc vào
  // study_sessions (response không trả field nào từ đây — xem app.post('/api/study/review')).
  // Đẩy ra chạy nền (waitUntil) — điểm FSRS (due/stability/…) vẫn ghi XONG THẬT SỰ (await ở
  // dbReviewFsrsCard phía trên) trước khi hàm này return, chỉ riêng phần thống kê phụ này không
  // còn nằm trên đường user phải chờ. Lỗi ở đây (nếu có) vẫn chỉ log, không throw ra ngoài.
  runInBackground(() => recordStudyActivity(userId, { correct: !!answerCorrect, now: new Date() }),
    (e) => console.error('⚠️  [study_sessions] Không ghi được hoạt động học:', e && e.message));
  return { ...result, desiredRetentionUsed: desiredRetention };
}

module.exports = {
  ensureUserSettingsTable,
  getUserSettings,
  setUserRetention,
  invalidateUserSettingsCache,
  getTodayOverview,
  getStudySession,
  reviewCard,
};
