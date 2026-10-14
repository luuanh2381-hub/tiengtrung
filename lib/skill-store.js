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

const { DECAY, MIN_ATTEMPTS, WEAK_THRESHOLD, MEASURABLE_SKILLS, EXERCISES, isCountableAnswer } = require('./skills');

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
async function recordPractice({ userId, hz, exerciseType, answerCorrect, selectedAnswer, responseTimeMs, attemptKey }) {
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
      `INSERT INTO skill_practice_log (user_id, attempt_key, word_id, skill, exercise_type, answer_correct, response_time_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, attempt_key) DO NOTHING RETURNING id`,
      [userId, attemptKey, wordId, def.skill, exerciseType, !!answerCorrect, rt]
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
      `SELECT word_id, skill, attempts, correct, w_attempts, w_correct
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

// Dọn hồ sơ kỹ năng của 1 user TRONG transaction của caller (dùng khi reset/xoá tài khoản).
async function deleteUserSkillDataTx(client, userId) {
  await ensureSkillTables(client);
  await client.query('DELETE FROM word_skill_stats WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM skill_practice_log WHERE user_id = $1', [userId]);
}

module.exports = {
  ensureSkillTables, upsertSkillStatTx, recordPractice,
  getProfilesForWords, getOverview, listWeakWords, getPracticeWords, getTrend,
  deleteUserSkillDataTx,
};
