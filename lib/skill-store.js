// lib/skill-store.js — Lưu trữ + truy vấn HỒ SƠ KỸ NĂNG theo từng (người dùng, từ vựng, kỹ năng).
//
// Kiểu dữ liệu ĐÃ XÁC MINH từ schema thật (lib/db.js + migrations/V69, V93):
//   user_id  = TEXT   (username, không phải số)
//   word_id  = INT    (vocab_words.id, SERIAL — KHÔNG phải BIGINT)
// Không có migration runner riêng: giống V69/V93, bảng/cột tự tạo idempotent ở lần dùng đầu
// (ensureSkillTables), file migrations/V104_skill_profile.sql chỉ để đối chiếu/chạy tay.
//
// Thiết kế:
//   * word_skill_stats  — thống kê gộp (1 dòng / user / từ / kỹ năng). Cập nhật bằng MỘT câu UPSERT
//                         có phép tính ngay trong SQL → không đọc-rồi-ghi, không tính lại toàn bộ.
//   * review_history    — TẬN DỤNG bảng lịch sử FSRS sẵn có: chỉ thêm 2 cột nullable (skill,
//                         exercise_type). Các dòng cũ giữ NULL (không biết kỹ năng → không đoán).
//   * skill_practice_log— CHỈ cho bài luyện kỹ năng BỔ SUNG (không phải lượt ôn FSRS). Không được
//                         ghi vào review_history vì optimizer FSRS coi mọi dòng ở đó là 1 lượt review.
// Idempotency: lượt FSRS → dựa vào review_history.idempotency_key (đã có); lượt luyện bổ sung →
// UNIQUE (user_id, attempt_key). Chỉ khi dòng log được INSERT mới thật sự cộng vào word_skill_stats.

'use strict';

const {
  DECAY, MIN_ATTEMPTS, WEAK_THRESHOLD, MEASURABLE_SKILLS, EXERCISES, isCountableAnswer,
  PRACTICE_SOURCES, SHOWN_ANSWER_SOURCES, RETENTION_BUCKETS, summarizeRetention,
} = require('./skills');


// V110: làm sạch dữ liệu client gửi lên trước khi lưu (không tin tuyệt đối).
function cleanSessionId(v) { return (typeof v === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(v)) ? v : null; }
function cleanWrongAnswer(v) {
  if (typeof v !== 'string') return null;
  const t = v.normalize('NFC').trim();
  if (!t || !isCountableAnswer(t)) return null;
  return [...t].slice(0, 60).join('');
}

let skillTablesReady = null;
// Trả về true khi bảng/cột sẵn sàng. Lỗi → KHÔNG cache promise lỗi (lần sau thử lại), và ném lỗi để
// caller quyết định (reviewFsrsCard bắt lỗi và bỏ qua phần skill, không làm hỏng lượt FSRS).
async function ensureSkillTables(client) {
  if (skillTablesReady) return skillTablesReady;
  skillTablesReady = (async () => {
    try {
      // Bảng/cột mà phần dưới tham chiếu (vocab_words cho FK, review_history cho ALTER) phải tồn tại
      // trước — cả 2 hàm ensure này đều có cache riêng nên gọi lại gần như miễn phí.
      const dbm = require('./db');
      await dbm.ensureVocabTable(client);
      await dbm.ensureFsrsTables(client);
      await client.query(`
        CREATE TABLE IF NOT EXISTS word_skill_stats (
          user_id TEXT NOT NULL,
          word_id INT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
          skill TEXT NOT NULL CHECK (skill IN ('recognition','recall','listening','pinyin','pronunciation','context')),
          attempts INT NOT NULL DEFAULT 0,
          correct INT NOT NULL DEFAULT 0,
          w_attempts DOUBLE PRECISION NOT NULL DEFAULT 0,
          w_correct DOUBLE PRECISION NOT NULL DEFAULT 0,
          last_attempt_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, word_id, skill)
        )`);
      // V106: bảng có thể đã được tạo ở V104 với CHECK chưa có 'pinyin' → nới ràng buộc (không đụng dữ liệu).
      await client.query(`ALTER TABLE word_skill_stats DROP CONSTRAINT IF EXISTS word_skill_stats_skill_check`);
      await client.query(`ALTER TABLE word_skill_stats ADD CONSTRAINT word_skill_stats_skill_check
        CHECK (skill IN ('recognition','recall','listening','pinyin','pronunciation','context'))`);
      await client.query(`CREATE INDEX IF NOT EXISTS word_skill_stats_user_skill_idx ON word_skill_stats (user_id, skill)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_practice_log (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          attempt_key TEXT NOT NULL,
          word_id INT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
          skill TEXT NOT NULL,
          exercise_type TEXT NOT NULL,
          answer_correct BOOLEAN NOT NULL,
          response_time_ms INT,
          attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS skill_practice_log_key_idx ON skill_practice_log (user_id, attempt_key)`);
      await client.query(`CREATE INDEX IF NOT EXISTS skill_practice_log_user_time_idx ON skill_practice_log (user_id, attempted_at)`);
      // Tận dụng review_history sẵn có (thêm cột nullable — không phá dữ liệu/optimizer cũ).
      await client.query(`ALTER TABLE review_history ADD COLUMN IF NOT EXISTS skill TEXT`);
      await client.query(`ALTER TABLE review_history ADD COLUMN IF NOT EXISTS exercise_type TEXT`);
      // V110 (xem migrations/V110_retention_tracking.sql) — CHỈ THÊM cột nullable, không đụng dữ liệu cũ:
      //   session_id   : id phiên học phía client (gom các câu cùng phiên; tránh phải suy đoán).
      //   source       : nguồn kết quả của bài LUYỆN BỔ SUNG (check/redo/extra/...). review_history = luôn lượt FSRS chính thức.
      //   wrong_answer : đáp án người học đã chọn/gõ NẾU SAI (cắt 60 ký tự) — để phát hiện từ hay bị nhầm. NULL khi đúng.
      await client.query(`ALTER TABLE skill_practice_log ADD COLUMN IF NOT EXISTS session_id TEXT`);
      await client.query(`ALTER TABLE skill_practice_log ADD COLUMN IF NOT EXISTS source TEXT`);
      await client.query(`ALTER TABLE skill_practice_log ADD COLUMN IF NOT EXISTS wrong_answer TEXT`);
      await client.query(`ALTER TABLE review_history ADD COLUMN IF NOT EXISTS session_id TEXT`);
      await client.query(`ALTER TABLE review_history ADD COLUMN IF NOT EXISTS wrong_answer TEXT`);
      await client.query(`CREATE INDEX IF NOT EXISTS skill_practice_log_user_word_idx ON skill_practice_log (user_id, word_id, attempted_at)`);
      return true;
    } catch (e) {
      skillTablesReady = null;
      throw e;
    }
  })();
  return skillTablesReady;
}

// Một câu UPSERT, chạy TRONG transaction của caller (cùng `client`). KHÔNG chạm fsrs_cards.
async function upsertSkillStatTx(client, { userId, wordId, skill, correct, at }) {
  const ok = correct ? 1 : 0;
  await client.query(
    `INSERT INTO word_skill_stats (user_id, word_id, skill, attempts, correct, w_attempts, w_correct, last_attempt_at)
     VALUES ($1, $2, $3, 1, $4::int, 1, $4::int, $5::timestamptz)
     ON CONFLICT (user_id, word_id, skill) DO UPDATE SET
       attempts = word_skill_stats.attempts + 1,
       correct = word_skill_stats.correct + $4::int,
       w_attempts = word_skill_stats.w_attempts * $6::double precision + 1,
       w_correct = word_skill_stats.w_correct * $6::double precision + $4::int,
       last_attempt_at = GREATEST(COALESCE(word_skill_stats.last_attempt_at, $5::timestamptz), $5::timestamptz),
       updated_at = now()`,
    [userId, wordId, skill, ok, at || new Date(), DECAY]
  );
}

function getPool() { return require('./db').getPool(); } // lazy: tránh vòng require db ↔ skill-store

// ── Bài luyện kỹ năng BỔ SUNG (không phải lượt FSRS). Idempotent theo attemptKey. ─────────────
async function recordPractice({ userId, hz, exerciseType, answerCorrect, selectedAnswer, responseTimeMs, attemptKey, sessionId, source }) {
  const def = EXERCISES[exerciseType];
  if (!def || def.fsrs) return { ok: false, error: 'Dạng bài luyện không hợp lệ' };
  if (typeof attemptKey !== 'string' || attemptKey.length < 8 || attemptKey.length > 100) {
    return { ok: false, error: 'Thiếu attemptKey hợp lệ' };
  }
  if (!isCountableAnswer(selectedAnswer)) return { ok: true, recorded: false, reason: 'blank' };
  const { resolveCanonicalWordId } = require('./db');
  const client = await getPool().connect();
  try {
    await ensureSkillTables(client);
    await client.query('BEGIN');
    const wordId = await resolveCanonicalWordId(client, hz);
    if (wordId == null) { await client.query('ROLLBACK'); return { ok: false, error: 'Không tìm thấy từ vựng' }; }
    const rt = Number.isFinite(responseTimeMs) ? Math.round(responseTimeMs) : null;
    const ins = await client.query(
      `INSERT INTO skill_practice_log (user_id, attempt_key, word_id, skill, exercise_type, answer_correct, response_time_ms, session_id, source, wrong_answer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, attempt_key) DO NOTHING RETURNING id`,
      [userId, attemptKey, wordId, def.skill, exerciseType, !!answerCorrect, rt,
        cleanSessionId(sessionId), PRACTICE_SOURCES.includes(source) ? source : 'practice',
        answerCorrect ? null : cleanWrongAnswer(selectedAnswer)]
    );
    if (ins.rows.length === 0) { await client.query('COMMIT'); return { ok: true, recorded: false, duplicate: true }; }
    await upsertSkillStatTx(client, { userId, wordId, skill: def.skill, correct: !!answerCorrect, at: new Date() });
    await client.query('COMMIT');
    return { ok: true, recorded: true, skill: def.skill };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── Truy vấn THEO LÔ cho cả phiên học: 1 query cho mọi từ (không N+1). ────────────────────────
async function getProfilesForWords(userId, wordIds) {
  const ids = [...new Set((wordIds || []).filter(n => Number.isInteger(n)))];
  const map = new Map();
  if (!ids.length) return map;
  const client = await getPool().connect();
  try {
    await ensureSkillTables(client);
    const r = await client.query(
      `SELECT word_id, skill, attempts, correct, w_attempts, w_correct, last_attempt_at
         FROM word_skill_stats WHERE user_id = $1 AND word_id = ANY($2::int[])`,
      [userId, ids]
    );
    for (const row of r.rows) {
      if (!map.has(row.word_id)) map.set(row.word_id, {});
      map.get(row.word_id)[row.skill] = row;
    }
    return map;
  } finally {
    client.release();
  }
}

const SCORE_SQL = '((s.w_correct + 1) / (s.w_attempts + 2))';

// ── Tổng quan (1 query gộp; số từ cần ôn FSRS do caller truyền vào từ countDueFsrsCards) ──────
async function getOverview(userId) {
  const client = await getPool().connect();
  try {
    await ensureSkillTables(client);
    const r = await client.query(
      `SELECT
         COUNT(DISTINCT s.word_id)::int AS tested_words,
         ${MEASURABLE_SKILLS.map(sk => `
         COUNT(*) FILTER (WHERE s.skill='${sk}' AND s.attempts >= $2)::int AS ${sk}_enough,
         COUNT(*) FILTER (WHERE s.skill='${sk}' AND s.attempts >= $2 AND ${SCORE_SQL} < $3)::int AS ${sk}_weak`).join(',')}
       FROM word_skill_stats s WHERE s.user_id = $1`,
      [userId, MIN_ATTEMPTS, WEAK_THRESHOLD]
    );
    const row = r.rows[0] || {};
    const skills = {};
    for (const sk of MEASURABLE_SKILLS) skills[sk] = { enough: row[`${sk}_enough`] || 0, weak: row[`${sk}_weak`] || 0 };
    return { testedWords: row.tested_words || 0, skills };
  } finally {
    client.release();
  }
}

// ── Danh sách "cần cải thiện": mỗi dòng = (từ, kỹ năng yếu). Phân trang bằng limit/offset. ─────
async function listWeakWords(userId, { skill, limit = 20, offset = 0 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const skillFilter = MEASURABLE_SKILLS.includes(skill) ? skill : null;
  const client = await getPool().connect();
  try {
    await ensureSkillTables(client);
    const r = await client.query(
      `SELECT s.word_id, v.hz, v.py, v.vi, v.l, s.skill, s.attempts, s.correct, ${SCORE_SQL} AS score
         FROM word_skill_stats s JOIN vocab_words v ON v.id = s.word_id
        WHERE s.user_id = $1 AND s.attempts >= $2 AND ${SCORE_SQL} < $3
          AND ($4::text IS NULL OR s.skill = $4)
        ORDER BY score ASC, s.attempts DESC, s.word_id ASC
        LIMIT $5 OFFSET $6`,
      [userId, MIN_ATTEMPTS, WEAK_THRESHOLD, skillFilter, lim + 1, off]
    );
    const hasMore = r.rows.length > lim;
    return { items: r.rows.slice(0, lim), hasMore };
  } finally {
    client.release();
  }
}

// ── Chọn từ cho bài luyện kỹ năng bổ sung. CHỈ lấy từ người học ĐÃ từng ôn (fsrs_cards.reps>0):
//     (1) từ yếu ở kỹ năng đó trước; (2) rồi từ chưa đủ dữ liệu ở kỹ năng đó (để thu thêm thông tin).
//     skill = 'mixed' → lấy từ yếu ở BẤT KỲ kỹ năng nào còn bài tập chạy được. ────────────────────
async function getPracticeWords(userId, { skill, limit = 10, allowedSkills, weakOnly = false }) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 30);
  const allowed = (allowedSkills || MEASURABLE_SKILLS).filter(s => MEASURABLE_SKILLS.includes(s));
  const target = skill === 'mixed' ? allowed : allowed.filter(s => s === skill);
  if (!target.length) return [];
  const client = await getPool().connect();
  try {
    await ensureSkillTables(client);
    // Với mỗi từ ĐÃ ôn, ghép với từng kỹ năng đích; "weak" ưu tiên 0, "thiếu dữ liệu" ưu tiên 1.
    const r = await client.query(
      `WITH known AS (
         SELECT DISTINCT v.id AS word_id, v.hz, v.py, v.vi, v.l
           FROM fsrs_cards f JOIN vocab_words v ON (f.word_id = v.id OR (f.word_id IS NULL AND f.hz = v.hz))
          WHERE f.user_id = $1 AND f.reps > 0
       ), cand AS (
         SELECT k.word_id, k.hz, k.py, k.vi, k.l, t.skill,
                COALESCE(s.attempts, 0) AS attempts,
                CASE WHEN s.attempts >= $3 THEN ((s.w_correct + 1) / (s.w_attempts + 2)) END AS score
           FROM known k CROSS JOIN unnest($2::text[]) AS t(skill)
           LEFT JOIN word_skill_stats s ON s.user_id = $1 AND s.word_id = k.word_id AND s.skill = t.skill
       )
       SELECT word_id, hz, py, vi, l, skill, attempts, score,
              CASE WHEN score IS NOT NULL AND score < $4 THEN 0
                   WHEN attempts < $3 THEN 1 ELSE 2 END AS priority
         FROM cand
        WHERE (score IS NOT NULL AND score < $4) OR ($6::boolean IS NOT TRUE AND attempts < $3)
        ORDER BY priority ASC, score ASC NULLS LAST, attempts ASC, random()
        LIMIT $5`,
      [userId, target, MIN_ATTEMPTS, WEAK_THRESHOLD, lim * 3, !!weakOnly]
    );
    const seen = new Set();
    const out = [];
    for (const row of r.rows) {
      if (seen.has(row.word_id)) continue; // mỗi từ chỉ 1 câu trong một lượt luyện
      seen.add(row.word_id);
      out.push(row);
      if (out.length >= lim) break;
    }
    return out;
  } finally {
    client.release();
  }
}

// ── Xu hướng theo ngày/tuần, TÁCH RIÊNG từng kỹ năng (không có điểm tổng hợp). ──────────────────
async function getTrend(userId, { days = 30, bucket = 'day' } = {}) {
  const d = Math.min(Math.max(parseInt(days, 10) || 30, 7), 180);
  const unit = bucket === 'week' ? 'week' : 'day';
  const client = await getPool().connect();
  try {
    await ensureSkillTables(client);
    const r = await client.query(
      `SELECT to_char(date_trunc('${unit}', t.at AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD') AS bucket,
              t.skill, COUNT(*)::int AS attempts, COUNT(*) FILTER (WHERE t.ok)::int AS correct
         FROM (
           SELECT reviewed_at AS at, skill, answer_correct AS ok FROM review_history
            WHERE user_id = $1 AND skill IS NOT NULL AND reviewed_at >= now() - ($2 || ' days')::interval
           UNION ALL
           SELECT attempted_at AS at, skill, answer_correct AS ok FROM skill_practice_log
            WHERE user_id = $1 AND attempted_at >= now() - ($2 || ' days')::interval
         ) t
        GROUP BY 1, 2 ORDER BY 1 ASC, 2 ASC`,
      [userId, String(d)]
    );
    return r.rows;
  } finally {
    client.release();
  }
}


// ════════════════════════════════════════════════════════════════════════════════════════════
// V110 — TRÍ NHỚ DÀI HẠN: kết quả theo KHOẢNG CÁCH kể từ lần gặp từ trước.
// Không có bảng tổng hợp mới: tính trực tiếp từ nhật ký sẵn có (review_history + skill_practice_log), CHỈ trong cửa
// sổ `days` (mặc định 90, tối đa 180) và chỉ khi người dùng mở màn Phân tích — không chạy mỗi lần render.
//   gap = giờ kể từ lần gặp TRƯỚC của cùng từ (bất kể kỹ năng; gồm cả dòng review_history cũ chưa có nhãn kỹ năng).
//   Lần gặp đầu tiên của từ TRONG cửa sổ không có "lần trước" → không xếp nhóm (không đoán), trừ khi vừa xem đáp án.
//   Mẫu số của từng nhóm = số lượt THỰC SỰ được kiểm tra trong nhóm đó; từ chưa kiểm tra lại không bị tính là quên.
// ════════════════════════════════════════════════════════════════════════════════════════════
function bucketCaseSql(gapCol, shownCol) {
  const whens = RETENTION_BUCKETS.filter(b => Number.isFinite(b.maxH)).map(b => `WHEN ${gapCol} < ${b.maxH} THEN '${b.id}'`);
  const last = RETENTION_BUCKETS[RETENTION_BUCKETS.length - 1].id;
  return `CASE WHEN ${shownCol} THEN 'immediate' ${whens.join(' ')} ELSE '${last}' END`;
}
async function getRetention(userId, { days = 90 } = {}) {
  const d = Math.min(Math.max(parseInt(days, 10) || 90, 7), 180);
  const client = await getPool().connect();
  try {
    await ensureSkillTables(client);
    const r = await client.query(
      `WITH ev AS (
         SELECT word_id, reviewed_at AS ts, skill, answer_correct AS ok, 'fsrs'::text AS kind, false AS shown
           FROM review_history
          WHERE user_id = $1 AND word_id IS NOT NULL AND reviewed_at >= now() - ($2 || ' days')::interval
         UNION ALL
         SELECT word_id, attempted_at, skill, answer_correct, 'practice'::text, COALESCE(source = ANY($3::text[]), false)
           FROM skill_practice_log
          WHERE user_id = $1 AND attempted_at >= now() - ($2 || ' days')::interval
       ), g AS (
         SELECT *, EXTRACT(EPOCH FROM (ts - LAG(ts) OVER (PARTITION BY word_id ORDER BY ts))) / 3600.0 AS gap_h FROM ev
       )
       SELECT kind, ${bucketCaseSql('gap_h', 'shown')} AS bucket,
              COUNT(*)::int AS n, COUNT(*) FILTER (WHERE ok)::int AS correct
         FROM g
        WHERE skill IS NOT NULL AND (shown OR gap_h IS NOT NULL)
        GROUP BY 1, 2`,
      [userId, String(d), SHOWN_ANSWER_SOURCES]
    );
    return { windowDays: d, buckets: summarizeRetention(r.rows) };
  } finally {
    client.release();
  }
}

// ── Kết quả theo DẠNG BÀI (exercise_type) — để biết dạng nào hay sai. Cùng cửa sổ thời gian. ─────────────
async function getTypeBreakdown(userId, { days = 90 } = {}) {
  const d = Math.min(Math.max(parseInt(days, 10) || 90, 7), 180);
  const client = await getPool().connect();
  try {
    await ensureSkillTables(client);
    const r = await client.query(
      `SELECT exercise_type, kind, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE ok)::int AS correct FROM (
         SELECT exercise_type, answer_correct AS ok, 'fsrs'::text AS kind FROM review_history
          WHERE user_id = $1 AND exercise_type IS NOT NULL AND reviewed_at >= now() - ($2 || ' days')::interval
         UNION ALL
         SELECT exercise_type, answer_correct, 'practice'::text FROM skill_practice_log
          WHERE user_id = $1 AND attempted_at >= now() - ($2 || ' days')::interval
       ) t GROUP BY 1, 2 ORDER BY n DESC`,
      [userId, String(d)]
    );
    return r.rows;
  } finally {
    client.release();
  }
}

// ── Chi tiết 1 từ: thông tin từ, trạng thái FSRS, điểm từng kỹ năng, lịch sử gần đây, dạng hay sai,
//     đáp án sai lặp lại (từ hay bị nhầm). Tất cả ĐỀU có LIMIT; không quét toàn bộ lịch sử. ───────────────────
async function getWordDetail(userId, hz, { historyLimit = 30 } = {}) {
  const lim = Math.min(Math.max(parseInt(historyLimit, 10) || 30, 5), 60);
  const { resolveCanonicalWordId } = require('./db');
  const client = await getPool().connect();
  try {
    await ensureSkillTables(client);
    const wordId = await resolveCanonicalWordId(client, hz);
    if (wordId == null) return null;
    const [wordR, cardR, statR, histR, typeR, confR] = await Promise.all([
      client.query('SELECT id, hz, py, vi, l, hanviet FROM vocab_words WHERE id = $1', [wordId]),
      client.query(
        `SELECT state, due, stability, difficulty, reps, lapses, last_review, scheduled_days
           FROM fsrs_cards WHERE user_id = $1 AND (word_id = $2 OR (word_id IS NULL AND hz = $3))
          ORDER BY reps DESC LIMIT 1`, [userId, wordId, hz]),
      client.query(
        `SELECT skill, attempts, correct, w_attempts, w_correct, last_attempt_at FROM word_skill_stats
          WHERE user_id = $1 AND word_id = $2`, [userId, wordId]),
      client.query(
        `SELECT ts, skill, exercise_type, ok, kind, response_time_ms FROM (
           SELECT reviewed_at AS ts, skill, exercise_type, answer_correct AS ok, 'fsrs'::text AS kind, response_time_ms
             FROM review_history WHERE user_id = $1 AND hz = $3 AND skill IS NOT NULL
           UNION ALL
           SELECT attempted_at, skill, exercise_type, answer_correct, COALESCE(source, 'practice'), response_time_ms
             FROM skill_practice_log WHERE user_id = $1 AND word_id = $2
         ) t ORDER BY ts DESC LIMIT $4`, [userId, wordId, hz, lim]),
      client.query(
        `SELECT exercise_type, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE NOT ok)::int AS wrong FROM (
           SELECT exercise_type, answer_correct AS ok FROM review_history WHERE user_id = $1 AND hz = $3 AND exercise_type IS NOT NULL
           UNION ALL
           SELECT exercise_type, answer_correct FROM skill_practice_log WHERE user_id = $1 AND word_id = $2
         ) t GROUP BY 1`, [userId, wordId, hz]),
      client.query(
        `SELECT wrong_answer, COUNT(*)::int AS n FROM (
           SELECT wrong_answer FROM review_history WHERE user_id = $1 AND hz = $3 AND wrong_answer IS NOT NULL
           UNION ALL
           SELECT wrong_answer FROM skill_practice_log WHERE user_id = $1 AND word_id = $2 AND wrong_answer IS NOT NULL
         ) t GROUP BY 1 HAVING COUNT(*) >= 2 ORDER BY n DESC LIMIT 3`, [userId, wordId, hz]),
    ]);
    const stats = {};
    for (const row of statR.rows) stats[row.skill] = row;
    return {
      word: wordR.rows[0] || null,
      card: cardR.rows[0] || null,
      stats,
      history: histR.rows,
      typeStats: typeR.rows,
      repeatedWrong: confR.rows,
    };
  } finally {
    client.release();
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// V110 — SỐ LIỆU "HÔM NAY HỌC": các nhóm từ ĐÃ HỌC (có thẻ FSRS, reps > 0), đếm theo TỪ DUY NHẤT (gộp theo hz).
// Một từ có thể thuộc nhiều nhóm → trả kèm số giao nhau và TỔNG TỪ DUY NHẤT để giao diện không cộng trùng.
//   due       : thẻ đến hạn ôn theo FSRS (chưa trừ giới hạn ngày — phần giới hạn do reviewService xử lý).
//   reinforce : thẻ đang ở trạng thái Learning/Relearning (state 1 hoặc 3) — cần củng cố.
//   weakSkill : ≥1 kỹ năng ĐỦ dữ liệu (≥ MIN_ATTEMPTS) và điểm < ngưỡng yếu.
//   delayed   : CHƯA đến hạn, đã học ổn định (state 2) và lần gặp gần nhất (ôn hoặc luyện) cách đây ≥ 7 ngày
//               → ứng viên "kiểm tra sau một khoảng nghỉ" (luyện bổ sung, KHÔNG đổi lịch FSRS).
// Cùng điều kiện phạm vi bài (scopeLessons) như countDueFsrsCards để các số khớp nhau.
// ════════════════════════════════════════════════════════════════════════════════════════════
const DELAYED_CHECK_DAYS = 7;
async function getTodayBreakdown(userId, scopeLessons) {
  const client = await getPool().connect();
  try {
    await ensureSkillTables(client);
    const hasScope = Array.isArray(scopeLessons);
    const params = [userId, MIN_ATTEMPTS, WEAK_THRESHOLD, String(DELAYED_CHECK_DAYS)];
    if (hasScope) params.push(scopeLessons);
    const scopeClause = hasScope
      ? ` AND EXISTS (SELECT 1 FROM vocab_words v JOIN vocab_lessons vl ON vl.word_id = v.id
            WHERE ((f.word_id IS NOT NULL AND v.id = f.word_id) OR (f.word_id IS NULL AND v.hz = f.hz AND v.l = f.l))
              AND vl.lesson = ANY($5::int[]))`
      : '';
    const r = await client.query(
      `WITH cards AS (
         SELECT f.hz, MIN(f.due) AS due, BOOL_OR(f.state IN (1, 3)) AS reinforce, MAX(f.state) AS max_state,
                MIN(f.word_id) AS word_id, MAX(f.last_review) AS last_review
           FROM fsrs_cards f
          WHERE f.user_id = $1 AND f.reps > 0${scopeClause}
          GROUP BY f.hz
       ), ws AS (
         SELECT s.word_id, MAX(s.last_attempt_at) AS last_attempt,
                BOOL_OR(s.attempts >= $2 AND ((s.w_correct + 1) / (s.w_attempts + 2)) < $3) AS weak
           FROM word_skill_stats s WHERE s.user_id = $1 GROUP BY s.word_id
       ), k AS (
         SELECT c.hz, (c.due <= now()) AS is_due, c.reinforce, COALESCE(ws.weak, false) AS weak,
                (c.due > now() AND c.max_state = 2
                  AND GREATEST(c.last_review, ws.last_attempt) <= now() - ($4 || ' days')::interval) AS delayed
           FROM cards c LEFT JOIN ws ON ws.word_id = c.word_id
       )
       SELECT
         COUNT(*)::int AS known,
         COUNT(*) FILTER (WHERE is_due)::int AS due,
         COUNT(*) FILTER (WHERE reinforce)::int AS reinforce,
         COUNT(*) FILTER (WHERE weak)::int AS weak_skill,
         COUNT(*) FILTER (WHERE COALESCE(delayed, false))::int AS delayed,
         COUNT(*) FILTER (WHERE weak AND is_due)::int AS weak_and_due,
         COUNT(*) FILTER (WHERE reinforce AND is_due)::int AS reinforce_and_due,
         COUNT(*) FILTER (WHERE is_due OR reinforce OR weak OR COALESCE(delayed, false))::int AS unique_words
       FROM k`,
      params
    );
    const x = r.rows[0] || {};
    return {
      knownWords: x.known || 0, due: x.due || 0, reinforce: x.reinforce || 0,
      weakSkill: x.weak_skill || 0, delayed: x.delayed || 0,
      overlap: { weakAndDue: x.weak_and_due || 0, reinforceAndDue: x.reinforce_and_due || 0 },
      uniqueWords: x.unique_words || 0, delayedAfterDays: DELAYED_CHECK_DAYS,
    };
  } finally {
    client.release();
  }
}


// Từ cho chế độ "Kiểm tra sau một khoảng nghỉ" (luyện bổ sung, KHÔNG đổi lịch FSRS). CÙNG định nghĩa `delayed` và CÙNG phạm vi bài
// với getTodayBreakdown để số hiển thị trên bảng Hôm nay học khớp đúng số từ lấy ra ở đây. Lâu chưa gặp nhất lên trước.
async function getDelayedWords(userId, { limit = 10, scopeLessons } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 30);
  const client = await getPool().connect();
  try {
    await ensureSkillTables(client);
    const hasScope = Array.isArray(scopeLessons);
    const params = [userId, String(DELAYED_CHECK_DAYS), lim];
    if (hasScope) params.push(scopeLessons);
    const scopeClause = hasScope
      ? ` AND EXISTS (SELECT 1 FROM vocab_words v2 JOIN vocab_lessons vl ON vl.word_id = v2.id
            WHERE ((f.word_id IS NOT NULL AND v2.id = f.word_id) OR (f.word_id IS NULL AND v2.hz = f.hz AND v2.l = f.l))
              AND vl.lesson = ANY($4::int[]))`
      : '';
    const r = await client.query(
      `WITH cards AS (
         SELECT f.hz, MIN(f.due) AS due, MAX(f.state) AS max_state, MIN(f.word_id) AS word_id, MAX(f.last_review) AS last_review
           FROM fsrs_cards f WHERE f.user_id = $1 AND f.reps > 0${scopeClause} GROUP BY f.hz
       ), ws AS (
         SELECT word_id, MAX(last_attempt_at) AS last_attempt FROM word_skill_stats WHERE user_id = $1 GROUP BY word_id
       )
       SELECT v.id AS word_id, v.hz, v.py, v.vi, v.l, GREATEST(c.last_review, ws.last_attempt) AS last_seen
         FROM cards c
         JOIN vocab_words v ON v.id = COALESCE(c.word_id, (SELECT id FROM vocab_words vw WHERE vw.hz = c.hz ORDER BY vw.id LIMIT 1))
         LEFT JOIN ws ON ws.word_id = v.id
        WHERE c.due > now() AND c.max_state = 2
          AND GREATEST(c.last_review, ws.last_attempt) <= now() - ($2 || ' days')::interval
        ORDER BY last_seen ASC
        LIMIT $3`,
      params
    );
    return r.rows;
  } finally {
    client.release();
  }
}

// Tiến độ HÔM NAY (giờ Việt Nam): số lượt ôn FSRS chính thức, số lượt luyện bổ sung, thời lượng học thực tế (study_sessions).
async function getTodayProgress(userId) {
  const client = await getPool().connect();
  try {
    await ensureSkillTables(client);
    const TZ = 'Asia/Ho_Chi_Minh';
    const r = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM review_history WHERE user_id = $1 AND reviewed_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2) AS official,
         (SELECT COUNT(*)::int FROM skill_practice_log WHERE user_id = $1 AND attempted_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2) AS practice,
         (SELECT COALESCE(SUM(duration_seconds), 0)::int FROM study_sessions WHERE user_id = $1 AND (start_time AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date) AS seconds`,
      [userId, TZ]
    );
    const x = r.rows[0] || {};
    return { officialAnswers: x.official || 0, practiceAnswers: x.practice || 0, durationSeconds: x.seconds || 0 };
  } finally {
    client.release();
  }
}

// Dọn hồ sơ kỹ năng của 1 user TRONG transaction của caller (dùng khi reset/xoá tài khoản).
async function deleteUserSkillDataTx(client, userId) {
  await ensureSkillTables(client);
  await client.query('DELETE FROM word_skill_stats WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM skill_practice_log WHERE user_id = $1', [userId]);
}

module.exports = {
  ensureSkillTables, upsertSkillStatTx, recordPractice,
  getProfilesForWords, getOverview, listWeakWords, getPracticeWords, getTrend,
  getRetention, getTypeBreakdown, getWordDetail, getTodayBreakdown, getTodayProgress, getDelayedWords, cleanSessionId, cleanWrongAnswer,
  deleteUserSkillDataTx,
};
