// ════════════════════════════════════════════════════
// LỚP LƯU TRỮ DỮ LIỆU — dùng Postgres thay cho file JSON
// Lý do đổi: Vercel chạy serverless, ổ đĩa không lưu được lâu dài
// (mỗi lần deploy hoặc "ngủ" là mất hết dữ liệu file). Postgres thì
// dữ liệu tồn tại độc lập với server, không bị mất.
//
// Dữ liệu chia làm 2 phần:
//   - app_store (id=1): tài khoản, token, lượt truy cập — 1 khối JSON nhỏ, đọc/ghi liên tục.
//   - vocab_words: BẢNG SQL THẬT cho từ vựng (có thể hàng chục nghìn từ), có index theo
//     số bài (l) để chỉ truy vấn ĐÚNG PHẦN CẦN (vd chỉ lấy từ của Bài 34) thay vì phải
//     đọc/gửi cả khối dữ liệu khổng lồ mỗi lần — giúp app tải nhanh và nhẹ hơn nhiều.
// ════════════════════════════════════════════════════
const { Pool } = require('pg');

let pool;
function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('Chưa cấu hình biến môi trường DATABASE_URL (xem HUONG-DAN-VERCEL.md)');
    }
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 3, // mỗi lần function chạy chỉ cần ít kết nối
    });
  }
  return pool;
}

function emptyDB() {
  return { users: {}, tokens: {}, visits: { total: 0, byDate: {} } };
}

let tableReady = null;
async function ensureTable(client) {
  if (tableReady) return tableReady;
  tableReady = (async () => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_store (
        id INT PRIMARY KEY,
        data JSONB NOT NULL
      )
    `);
    await client.query(
      `INSERT INTO app_store (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(emptyDB())]
    );
  })();
  return tableReady;
}

function normalize(db) {
  if (!db.visits) db.visits = { total: 0, byDate: {} };
  if (!db.users) db.users = {};
  if (!db.tokens) db.tokens = {};
  return db;
}

// Đọc dữ liệu tài khoản, không khoá — dùng cho các thao tác chỉ đọc
async function readDB() {
  const client = await getPool().connect();
  try {
    await ensureTable(client);
    const r = await client.query('SELECT data FROM app_store WHERE id = 1');
    return normalize(r.rows[0] ? r.rows[0].data : emptyDB());
  } finally {
    client.release();
  }
}

// Đọc + sửa + ghi dữ liệu tài khoản trong 1 transaction có khoá dòng (FOR UPDATE),
// đảm bảo 2 request cùng lúc không ghi đè mất dữ liệu của nhau.
async function updateDB(mutateFn) {
  const client = await getPool().connect();
  try {
    await ensureTable(client);
    await client.query('BEGIN');
    const r = await client.query('SELECT data FROM app_store WHERE id = 1 FOR UPDATE');
    const db = normalize(r.rows[0] ? r.rows[0].data : emptyDB());
    const result = await mutateFn(db);
    await client.query('UPDATE app_store SET data = $1::jsonb WHERE id = 1', [JSON.stringify(db)]);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── Bảng từ vựng (SQL thật, có index theo bài) ──
let vocabTableReady = null;
async function ensureVocabTable(client) {
  if (vocabTableReady) return vocabTableReady;
  vocabTableReady = (async () => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS vocab_words (
        id SERIAL PRIMARY KEY,
        hz TEXT NOT NULL,
        py TEXT,
        vi TEXT NOT NULL,
        l INT NOT NULL
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS vocab_words_hz_l_idx ON vocab_words (hz, l)`);
    await client.query(`CREATE INDEX IF NOT EXISTS vocab_words_l_idx ON vocab_words (l)`);
    // Di chuyển 1 lần duy nhất dữ liệu từ vựng cũ (nếu app từng lưu dạng 1 khối JSON ở bản trước)
    const countRes = await client.query('SELECT COUNT(*)::int AS c FROM vocab_words');
    if (countRes.rows[0].c === 0) {
      const legacy = await client.query(`SELECT data FROM app_store WHERE id = 2`).catch(() => null);
      const legacyVocab = (legacy && legacy.rows[0] && Array.isArray(legacy.rows[0].data.vocab)) ? legacy.rows[0].data.vocab : [];
      if (legacyVocab.length) await bulkUpsertVocab(client, legacyVocab, false);
    }
  })();
  return vocabTableReady;
}

// Ghi hàng loạt theo từng lô 500 dòng/lần (nhanh hơn nhiều so với ghi từng dòng một)
async function bulkUpsertVocab(client, words, overwrite) {
  const CHUNK = 500;
  let added = 0, updated = 0, invalid = 0, skipped = 0;
  for (let i = 0; i < words.length; i += CHUNK) {
    const rawChunk = words.slice(i, i + CHUNK);
    const chunk = rawChunk.filter(w => w.hz && w.vi && Number.isFinite(w.l) && w.l >= 1);
    invalid += rawChunk.length - chunk.length;
    if (chunk.length === 0) continue;
    const values = [];
    const params = [];
    chunk.forEach((w, idx) => {
      const base = idx * 4;
      values.push(`($${base+1},$${base+2},$${base+3},$${base+4})`);
      params.push(w.hz, w.py || '', w.vi, w.l);
    });
    if (overwrite) {
      const r = await client.query(
        `INSERT INTO vocab_words (hz, py, vi, l) VALUES ${values.join(',')}
         ON CONFLICT (hz, l) DO UPDATE SET py = EXCLUDED.py, vi = EXCLUDED.vi
         RETURNING (xmax = 0) AS is_insert`,
        params
      );
      for (const row of r.rows) { if (row.is_insert) added++; else updated++; }
    } else {
      const r = await client.query(
        `INSERT INTO vocab_words (hz, py, vi, l) VALUES ${values.join(',')}
         ON CONFLICT (hz, l) DO NOTHING RETURNING id`,
        params
      );
      added += r.rows.length;
      skipped += chunk.length - r.rows.length;
    }
  }
  return { added, updated, invalid, skipped };
}

// Lấy từ vựng của đúng những bài được yêu cầu (dùng index, chỉ trả về đúng phần cần)
async function getVocabByLessons(lessons) {
  if (!lessons || lessons.length === 0) return [];
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    const r = await client.query('SELECT hz, py, vi, l FROM vocab_words WHERE l = ANY($1::int[]) ORDER BY l, id', [lessons]);
    return r.rows;
  } finally {
    client.release();
  }
}

// Đếm nhanh số từ theo từng bài (payload rất nhỏ) — dùng để hiện số từ ở màn chọn Quyển/level
// mà KHÔNG cần tải toàn bộ nội dung từ vựng về máy.
async function getVocabCounts() {
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    const r = await client.query('SELECT l, COUNT(*)::int AS count FROM vocab_words GROUP BY l');
    const counts = {};
    for (const row of r.rows) counts[row.l] = row.count;
    return counts;
  } finally {
    client.release();
  }
}

async function importVocab(words, overwrite) {
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    const result = await bulkUpsertVocab(client, words, overwrite);
    const totalRes = await client.query('SELECT COUNT(*)::int AS c FROM vocab_words');
    result.total = totalRes.rows[0].c;
    return result;
  } finally {
    client.release();
  }
}

async function clearVocab() {
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    const countRes = await client.query('SELECT COUNT(*)::int AS c FROM vocab_words');
    await client.query('DELETE FROM vocab_words');
    return countRes.rows[0].c;
  } finally {
    client.release();
  }
}

// Xoá toàn bộ từ vựng của MỘT bài cụ thể (giữ nguyên các bài khác)
async function deleteVocabLesson(l) {
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    const r = await client.query('DELETE FROM vocab_words WHERE l = $1', [l]);
    return r.rowCount;
  } finally {
    client.release();
  }
}

// ── Bảng câu luyện dịch được AI sinh sẵn hàng ngày (kèm đáp án mẫu để web tự chấm) ──
let sentTableReady = null;
async function ensureSentTable(client) {
  if (sentTableReady) return sentTableReady;
  sentTableReady = (async () => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS practice_sentences (
        id SERIAL PRIMARY KEY,
        lesson INT NOT NULL,
        vi TEXT NOT NULL,
        hint TEXT,
        answer TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS practice_sentences_lesson_idx ON practice_sentences (lesson)`);
  })();
  return sentTableReady;
}

// Thay toàn bộ câu của 1 bài bằng lô câu mới (dùng khi sinh lại hàng ngày, tránh phình to mãi)
async function replaceLessonSentences(lesson, sentences) {
  const client = await getPool().connect();
  try {
    await ensureSentTable(client);
    await client.query('BEGIN');
    await client.query('DELETE FROM practice_sentences WHERE lesson = $1', [lesson]);
    for (const s of sentences) {
      if (!s.vi || !s.answer) continue;
      await client.query(
        'INSERT INTO practice_sentences (lesson, vi, hint, answer) VALUES ($1,$2,$3,$4)',
        [lesson, s.vi, s.hint || '', s.answer]
      );
    }
    await client.query('COMMIT');
    return sentences.length;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Lấy ngẫu nhiên N câu đã sinh sẵn cho các bài đang học (không cần gọi AI, trả về ngay)
async function getPracticeSentences(lessons, limit) {
  if (!lessons || lessons.length === 0) return [];
  const client = await getPool().connect();
  try {
    await ensureSentTable(client);
    const r = await client.query(
      'SELECT id, vi, hint, answer FROM practice_sentences WHERE lesson = ANY($1::int[]) ORDER BY random() LIMIT $2',
      [lessons, limit]
    );
    return r.rows;
  } finally {
    client.release();
  }
}

// Tra đáp án mẫu theo id để tự chấm điểm (không gọi AI)
async function getPracticeSentenceById(id) {
  const client = await getPool().connect();
  try {
    await ensureSentTable(client);
    const r = await client.query('SELECT id, vi, hint, answer FROM practice_sentences WHERE id = $1', [id]);
    return r.rows[0] || null;
  } finally {
    client.release();
  }
}

// Đếm số câu đã sinh sẵn theo từng bài (để hiện trạng thái trong trang Quản trị)
async function getPracticeSentenceCounts() {
  const client = await getPool().connect();
  try {
    await ensureSentTable(client);
    const r = await client.query('SELECT lesson, COUNT(*)::int AS count FROM practice_sentences GROUP BY lesson');
    const counts = {};
    for (const row of r.rows) counts[row.lesson] = row.count;
    return counts;
  } finally {
    client.release();
  }
}

module.exports = {
  readDB, updateDB, getVocabByLessons, getVocabCounts, importVocab, clearVocab, deleteVocabLesson, emptyDB,
  replaceLessonSentences, getPracticeSentences, getPracticeSentenceById, getPracticeSentenceCounts,
};
