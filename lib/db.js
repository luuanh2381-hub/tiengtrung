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

// ── Bảng ví dụ THEO TỪNG TỪ CỤ THỂ — đảm bảo mỗi từ có sẵn vài câu ví dụ chắc chắn chứa đúng từ đó ──
let wordExTableReady = null;
async function ensureWordExampleTable(client) {
  if (wordExTableReady) return wordExTableReady;
  wordExTableReady = (async () => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS word_examples (
        id SERIAL PRIMARY KEY,
        hz TEXT NOT NULL,
        lesson INT NOT NULL,
        vi TEXT NOT NULL,
        zh TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS word_examples_hz_idx ON word_examples (hz)`);
    await client.query(`CREATE INDEX IF NOT EXISTS word_examples_lesson_idx ON word_examples (lesson)`);
  })();
  return wordExTableReady;
}

// Lấy TOÀN BỘ từ vựng trong database (mọi bài) — dùng để biết còn từ nào chưa đủ ví dụ
async function getAllVocabWords() {
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    const r = await client.query('SELECT hz, py, vi, l FROM vocab_words ORDER BY l, id');
    return r.rows;
  } finally {
    client.release();
  }
}

// Đếm số ví dụ đã có theo từng từ (khoá bằng hz+lesson vì cùng 1 chữ có thể xuất hiện ở nhiều bài)
async function getWordExampleCounts() {
  const client = await getPool().connect();
  try {
    await ensureWordExampleTable(client);
    const r = await client.query('SELECT hz, lesson, COUNT(*)::int AS count FROM word_examples GROUP BY hz, lesson');
    const map = {};
    for (const row of r.rows) map[row.hz + '-' + row.lesson] = row.count;
    return map;
  } finally {
    client.release();
  }
}

// Lưu thêm các câu ví dụ mới cho 1 từ (không xoá ví dụ cũ — cộng dồn tới khi đủ số lượng mục tiêu)
async function insertWordExamples(hz, lesson, examples) {
  const client = await getPool().connect();
  try {
    await ensureWordExampleTable(client);
    for (const ex of examples) {
      await client.query('INSERT INTO word_examples (hz, lesson, vi, zh) VALUES ($1,$2,$3,$4)', [hz, lesson, ex.vi, ex.zh]);
    }
  } finally {
    client.release();
  }
}

// Lấy toàn bộ ví dụ theo từ cho các bài đang học (client sẽ tự chọn ngẫu nhiên 1 câu mỗi từ)
async function getWordExamplesForLessons(lessons) {
  if (!lessons || lessons.length === 0) return [];
  const client = await getPool().connect();
  try {
    await ensureWordExampleTable(client);
    const r = await client.query('SELECT hz, vi, zh FROM word_examples WHERE lesson = ANY($1::int[])', [lessons]);
    return r.rows;
  } finally {
    client.release();
  }
}

// ── Bảng chiết tự bộ thủ — mỗi CHỮ HÁN ĐƠN LẺ (không phải cả từ) được AI phân tích thành phần cấu tạo ──
let hanziTableReady = null;
async function ensureHanziPartsTable(client) {
  if (hanziTableReady) return hanziTableReady;
  hanziTableReady = (async () => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS hanzi_parts (
        hz TEXT PRIMARY KEY,
        parts JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);
  })();
  return hanziTableReady;
}

// Lấy toàn bộ chiết tự đã có (dữ liệu nhỏ gọn — gửi hết 1 lần cho client, không cần lọc theo bài)
async function getAllHanziParts() {
  const client = await getPool().connect();
  try {
    await ensureHanziPartsTable(client);
    const r = await client.query('SELECT hz, parts FROM hanzi_parts');
    return r.rows;
  } finally {
    client.release();
  }
}

// Chỉ lấy danh sách chữ đã có (để biết còn chữ nào chưa xử lý)
async function getHanziPartsKeys() {
  const client = await getPool().connect();
  try {
    await ensureHanziPartsTable(client);
    const r = await client.query('SELECT hz FROM hanzi_parts');
    return new Set(r.rows.map(row => row.hz));
  } finally {
    client.release();
  }
}

async function insertHanziParts(entries) {
  const client = await getPool().connect();
  try {
    await ensureHanziPartsTable(client);
    for (const e of entries) {
      await client.query(
        'INSERT INTO hanzi_parts (hz, parts) VALUES ($1,$2::jsonb) ON CONFLICT (hz) DO NOTHING',
        [e.hz, JSON.stringify(e.parts)]
      );
    }
  } finally {
    client.release();
  }
}

// ── Nhật ký hoạt động — ghi lại các hoạt động quan trọng của web (đăng nhập/đăng ký, thao tác
// quản trị, thao tác từ vựng, việc tự động chạy cron...), gộp theo ngày. Tối ưu lưu trữ: mỗi lần
// ghi thêm 1 dòng mới, tự động dọn luôn các ngày cũ hơn — CHỈ GIỮ TỐI ĐA 10 NGÀY GẦN NHẤT. ──
const ACTIVITY_LOG_KEEP_DAYS = 10;
let activityLogTableReady = null;
async function ensureActivityLogTable(client) {
  if (activityLogTableReady) return activityLogTableReady;
  activityLogTableReady = (async () => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        day TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        username TEXT,
        role TEXT,
        action TEXT NOT NULL,
        detail TEXT NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS activity_logs_day_idx ON activity_logs (day)`);
  })();
  return activityLogTableReady;
}

// Ghi 1 dòng nhật ký + dọn dẹp ngay để không bao giờ tích luỹ quá 10 ngày dữ liệu
async function insertActivityLog({ username, role, action, detail }) {
  const client = await getPool().connect();
  try {
    await ensureActivityLogTable(client);
    const day = new Date().toISOString().slice(0, 10);
    await client.query(
      'INSERT INTO activity_logs (day, username, role, action, detail) VALUES ($1,$2,$3,$4,$5)',
      [day, username || null, role || null, action, detail]
    );
    // Chỉ giữ lại tối đa ACTIVITY_LOG_KEEP_DAYS ngày gần nhất — ngày nào cũ hơn bị xoá luôn khỏi bảng
    await client.query(
      `DELETE FROM activity_logs WHERE day NOT IN (
         SELECT day FROM (SELECT DISTINCT day FROM activity_logs ORDER BY day DESC LIMIT $1) t
       )`,
      [ACTIVITY_LOG_KEEP_DAYS]
    );
  } finally {
    client.release();
  }
}

// Lấy toàn bộ nhật ký còn giữ được (tối đa 10 ngày), mới nhất trước — dùng cho trang Nhật ký (chỉ admin)
async function getActivityLogs() {
  const client = await getPool().connect();
  try {
    await ensureActivityLogTable(client);
    const r = await client.query(
      `SELECT day, to_char(ts, 'HH24:MI:SS') AS time, username, role, action, detail
       FROM activity_logs ORDER BY day DESC, ts DESC LIMIT 5000`
    );
    return r.rows;
  } finally {
    client.release();
  }
}

module.exports = {
  readDB, updateDB, getVocabByLessons, getVocabCounts, importVocab, clearVocab, deleteVocabLesson, emptyDB,
  getAllVocabWords, getWordExampleCounts, insertWordExamples, getWordExamplesForLessons,
  getAllHanziParts, getHanziPartsKeys, insertHanziParts,
  insertActivityLog, getActivityLogs,
};
