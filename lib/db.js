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
      // V72 (audit hiệu năng — "học chậm"): mặc định pg đóng connection rảnh sau 10s. Vì hầu hết
      // request cách nhau vài giây (user đọc câu hỏi rồi mới trả lời), 10s khiến pool liên tục phải
      // mở lại kết nối mới (bắt tay TCP+TLS+Postgres) ngay trong 1 phiên học đang diễn ra — tốn
      // thêm round-trip không cần thiết. Nâng lên 30s cho khớp nhịp thao tác thật của user; vẫn đủ
      // ngắn để không giữ kết nối vô ích khi instance rảnh hẳn.
      idleTimeoutMillis: 30000,
      keepAlive: true,
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
    try {
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
    } catch (e) {
      // FIX (audit V68, Phần 17): KHÔNG cache vĩnh viễn 1 promise bị reject — nếu init lỗi
      // (DB tạm thời unavailable / cold start lỗi mạng), reset về null để request TIẾP THEO
      // được thử lại, thay vì mọi request sau đó trong cùng serverless instance đều fail mãi
      // mãi dù DB đã hồi phục.
      tableReady = null;
      throw e;
    }
  })();
  return tableReady;
}

function normalize(db) {
  if (!db.visits) db.visits = { total: 0, byDate: {} };
  if (!db.users) db.users = {};
  if (!db.tokens) db.tokens = {};
  return db;
}

// ── V72 (audit hiệu năng — nguyên nhân chính khiến "học chậm"): TRƯỚC ĐÂY mọi route có auth (kể
//     cả MỖI LƯỢT trả lời 1 câu khi đang học) đều gọi readDB() → tải NGUYÊN KHỐI JSONB app_store
//     (toàn bộ users + toàn bộ tokens + lịch sử visits theo từng ngày, phình to dần mãi mãi vì
//     token không hết hạn) chỉ để tra 1 token. Thêm cache in-memory cấp module: readDB() phục vụ
//     từ cache nếu còn "nóng" (cùng 1 serverless instance, chưa cold start lại); updateDB() cập
//     nhật cache NGAY bằng chính object vừa mutate (không cần đọc lại DB) sau khi ghi Postgres
//     thành công — đảm bảo không bao giờ trả dữ liệu cũ hơn lần ghi gần nhất của CHÍNH instance
//     này. Không mutate object đã cache ở bất kỳ đâu ngoài updateDB/updateDBWithFsrsCleanup (đã
//     rà soát toàn bộ api/index.js — chỉ đọc `authed.db.*`, không có chỗ nào gán lại) nên an toàn
//     để nhiều request DÙNG CHUNG 1 reference thay vì clone.
//     GIỚI HẠN cần biết: cache này theo TỪNG serverless instance — nhiều instance chạy song song
//     (nhiều user cùng lúc) sẽ KHÔNG thấy write của nhau qua cache (vẫn đúng vì mọi instance đều
//     ghi thẳng xuống Postgres, chỉ là instance khác phải tự đọc lại DB 1 lần khi cache của nó
//     trống/lệch). Đây là cache tăng tốc trong 1 phiên học liên tục của 1 user, KHÔNG thay thế cho
//     việc tách users/tokens ra bảng quan hệ riêng (xem mục Scale trong báo cáo audit). ──
let cachedAppStore = null;

// Đọc dữ liệu tài khoản, không khoá — dùng cho các thao tác chỉ đọc
async function readDB() {
  if (cachedAppStore) return cachedAppStore;
  const client = await getPool().connect();
  try {
    await ensureTable(client);
    const r = await client.query('SELECT data FROM app_store WHERE id = 1');
    const db = normalize(r.rows[0] ? r.rows[0].data : emptyDB());
    cachedAppStore = db;
    return db;
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
    cachedAppStore = db; // V72: chỉ cập nhật cache SAU KHI COMMIT thành công (không cache dữ liệu lỡ bị rollback)
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── FIX (audit V68, Phần 4/5): reset/xoá tài khoản TRƯỚC ĐÂY chỉ sửa "progress" trong app_store
//     (khối JSON), KHÔNG đụng tới "fsrs_cards"/"review_history" (2 bảng SQL riêng) → sau khi
//     reset/xoá user, dữ liệu FSRS cũ vẫn còn (reset: user "sạch" tiến độ cũ nhưng FSRS card vẫn
//     due/stability cũ; xoá: fsrs_cards + review_history trở thành orphan trỏ tới user không còn
//     tồn tại). Hàm này sửa "app_store" (qua mutateFn) VÀ xoá fsrs_cards/review_history của đúng
//     "targetUserId" trong CÙNG 1 transaction Postgres (cùng 1 client) — nếu bất kỳ bước nào lỗi,
//     toàn bộ rollback, không để lại trạng thái nửa vời. Chỉ xoá dữ liệu FSRS khi mutateFn trả về
//     { ok: true } (vd targetKey không tồn tại / không đủ quyền thì mutateFn trả ok:false, không
//     xoá gì cả).
async function updateDBWithFsrsCleanup(targetUserId, mutateFn, options) {
  const alsoDeleteAnalytics = !!(options && options.alsoDeleteAnalytics);
  const client = await getPool().connect();
  try {
    await ensureTable(client);
    await ensureFsrsTables(client);
    // V69: nếu alsoDeleteAnalytics=true (chỉ dùng khi XOÁ TÀI KHOẢN hẳn), dọn luôn
    // study_sessions/user_settings/user_fsrs_weights trong CÙNG transaction — tránh dữ liệu "mồ
    // côi" ở 3 bảng mới, giống lỗi orphan fsrs_cards/review_history mà audit V68 đã sửa trước đó.
    // "Reset tiến độ" (KHÔNG xoá tài khoản) CỐ Ý không đụng 3 bảng này: streak/heatmap/thời gian
    // học là lịch sử THÓI QUEN học tập của user, khác với "tiến độ từ vựng" (fsrs_cards) — reset
    // từ vựng không có lý do gì phải xoá luôn thành tích chuyên cần của họ.
    if (alsoDeleteAnalytics) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS study_sessions (
          id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, start_time TIMESTAMPTZ NOT NULL,
          end_time TIMESTAMPTZ NOT NULL, duration_seconds INT NOT NULL DEFAULT 0,
          cards_reviewed INT NOT NULL DEFAULT 0, correct_count INT NOT NULL DEFAULT 0,
          wrong_count INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_settings (
          user_id TEXT PRIMARY KEY,
          desired_retention DOUBLE PRECISION NOT NULL DEFAULT 0.90
            CHECK (desired_retention IN (0.80, 0.85, 0.90, 0.95)),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_fsrs_weights (
          user_id TEXT PRIMARY KEY, weights DOUBLE PRECISION[] NOT NULL,
          trained_at TIMESTAMPTZ NOT NULL DEFAULT now(), review_count INT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    }
    await client.query('BEGIN');
    const r = await client.query('SELECT data FROM app_store WHERE id = 1 FOR UPDATE');
    const db = normalize(r.rows[0] ? r.rows[0].data : emptyDB());
    const result = await mutateFn(db);
    if (result && result.ok) {
      const delCards = await client.query('DELETE FROM fsrs_cards WHERE user_id = $1', [targetUserId]);
      const delHistory = await client.query('DELETE FROM review_history WHERE user_id = $1', [targetUserId]);
      result.fsrsCardsDeleted = delCards.rowCount;
      result.reviewHistoryDeleted = delHistory.rowCount;
      if (alsoDeleteAnalytics) {
        await client.query('DELETE FROM study_sessions WHERE user_id = $1', [targetUserId]);
        await client.query('DELETE FROM user_settings WHERE user_id = $1', [targetUserId]);
        await client.query('DELETE FROM user_fsrs_weights WHERE user_id = $1', [targetUserId]);
      }
    }
    await client.query('UPDATE app_store SET data = $1::jsonb WHERE id = 1', [JSON.stringify(db)]);
    await client.query('COMMIT');
    cachedAppStore = db; // V72: đồng bộ cache in-memory với lần ghi vừa commit thành công
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
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
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS vocab_words (
          id SERIAL PRIMARY KEY,
          hz TEXT NOT NULL,
          py TEXT,
          vi TEXT NOT NULL,
          l INT NOT NULL
        )
      `);
      // Thêm cột "tag" để khai báo loại từ đặc biệt (vd: động từ ly hợp) — dùng ADD COLUMN IF NOT
      // EXISTS để an toàn cho bảng đã có sẵn dữ liệu ngoài production, không mất dữ liệu cũ.
      await client.query(`ALTER TABLE vocab_words ADD COLUMN IF NOT EXISTS tag TEXT`);
      // Thêm cột "hanviet" — âm/nghĩa Hán Việt của từ (vd: 学习 → "Học tập"), do AI tự sinh hàng loạt
      // (xem runHanVietGeneration trong api/index.js), giống cơ chế chiết tự bộ thủ / ví dụ theo từ.
      await client.query(`ALTER TABLE vocab_words ADD COLUMN IF NOT EXISTS hanviet TEXT`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS vocab_words_hz_l_idx ON vocab_words (hz, l)`);
      await client.query(`CREATE INDEX IF NOT EXISTS vocab_words_l_idx ON vocab_words (l)`);
      // Di chuyển 1 lần duy nhất dữ liệu từ vựng cũ (nếu app từng lưu dạng 1 khối JSON ở bản trước)
      const countRes = await client.query('SELECT COUNT(*)::int AS c FROM vocab_words');
      if (countRes.rows[0].c === 0) {
        const legacy = await client.query(`SELECT data FROM app_store WHERE id = 2`).catch(() => null);
        const legacyVocab = (legacy && legacy.rows[0] && Array.isArray(legacy.rows[0].data.vocab)) ? legacy.rows[0].data.vocab : [];
        if (legacyVocab.length) await bulkUpsertVocab(client, legacyVocab, false);
      }
    } catch (e) {
      // FIX (audit V68, Phần 17): KHÔNG cache vĩnh viễn 1 promise bị reject — nếu init lỗi
      // (DB tạm thời unavailable / cold start lỗi mạng), reset về null để request TIẾP THEO
      // được thử lại, thay vì mọi request sau đó trong cùng serverless instance đều fail mãi
      // mãi dù DB đã hồi phục.
      vocabTableReady = null;
      throw e;
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
      const base = idx * 5;
      values.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5})`);
      params.push(w.hz, w.py || '', w.vi, w.l, w.tag || null);
    });
    if (overwrite) {
      const r = await client.query(
        `INSERT INTO vocab_words (hz, py, vi, l, tag) VALUES ${values.join(',')}
         ON CONFLICT (hz, l) DO UPDATE SET py = EXCLUDED.py, vi = EXCLUDED.vi, tag = EXCLUDED.tag
         RETURNING (xmax = 0) AS is_insert`,
        params
      );
      for (const row of r.rows) { if (row.is_insert) added++; else updated++; }
    } else {
      const r = await client.query(
        `INSERT INTO vocab_words (hz, py, vi, l, tag) VALUES ${values.join(',')}
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
    const r = await client.query('SELECT hz, py, vi, l, tag, hanviet FROM vocab_words WHERE l = ANY($1::int[]) ORDER BY l, id', [lessons]);
    return r.rows;
  } finally {
    client.release();
  }
}

// V72 (audit hiệu năng): resolveStudyScope() (api/index.js) gọi getVocabCounts() ở CẢ
// /api/study/today LẪN /api/study/session — tức mỗi lần mở tab "Hôm nay" hay bắt đầu 1 phiên học
// đều phải quét/GROUP BY toàn bộ vocab_words, dù bảng từ vựng gần như KHÔNG đổi giữa các lần học
// (chỉ đổi khi admin import/xoá từ). Cache in-memory, invalidate đúng 3 chỗ THỰC SỰ làm đổi số đếm
// theo bài (importVocab/clearVocab/deleteVocabLesson) — updateVocabHanviet KHÔNG đổi số lượng từ
// nên không cần invalidate.
let cachedVocabCounts = null;

// Đếm nhanh số từ theo từng bài (payload rất nhỏ) — dùng để hiện số từ ở màn chọn Quyển/level
// mà KHÔNG cần tải toàn bộ nội dung từ vựng về máy.
async function getVocabCounts() {
  if (cachedVocabCounts) return cachedVocabCounts;
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    const r = await client.query('SELECT l, COUNT(*)::int AS count FROM vocab_words GROUP BY l');
    const counts = {};
    for (const row of r.rows) counts[row.l] = row.count;
    cachedVocabCounts = counts;
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
    cachedVocabCounts = null; // V72: số từ theo bài vừa đổi — bỏ cache, lần đọc sau tự tính lại
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
    cachedVocabCounts = null; // V72
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
    cachedVocabCounts = null; // V72
    return r.rowCount;
  } finally {
    client.release();
  }
}

// Ghi âm/nghĩa Hán Việt cho hàng loạt từ (khớp theo đúng cặp hz+l vì cùng 1 chữ có thể xuất hiện
// ở nhiều bài với nghĩa khác nhau). Dùng 1 câu lệnh UPDATE...FROM(UNNEST) để cập nhật cả lô 1 lần,
// nhanh hơn nhiều so với chạy từng UPDATE riêng lẻ.
async function updateVocabHanviet(entries) {
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    const valid = entries.filter(e => e && e.hz && e.hanviet && Number.isFinite(e.l));
    if (!valid.length) return 0;
    const r = await client.query(
      `UPDATE vocab_words v SET hanviet = u.hanviet
       FROM UNNEST($1::text[], $2::int[], $3::text[]) AS u(hz, l, hanviet)
       WHERE v.hz = u.hz AND v.l = u.l`,
      [valid.map(e => e.hz), valid.map(e => e.l), valid.map(e => e.hanviet)]
    );
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
    try {
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
    } catch (e) {
      // FIX (audit V68, Phần 17): KHÔNG cache vĩnh viễn 1 promise bị reject — nếu init lỗi
      // (DB tạm thời unavailable / cold start lỗi mạng), reset về null để request TIẾP THEO
      // được thử lại, thay vì mọi request sau đó trong cùng serverless instance đều fail mãi
      // mãi dù DB đã hồi phục.
      wordExTableReady = null;
      throw e;
    }
  })();
  return wordExTableReady;
}

// Lấy TOÀN BỘ từ vựng trong database (mọi bài) — dùng để biết còn từ nào chưa đủ ví dụ
async function getAllVocabWords() {
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    const r = await client.query('SELECT hz, py, vi, l, tag, hanviet FROM vocab_words ORDER BY l, id');
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
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS hanzi_parts (
          hz TEXT PRIMARY KEY,
          parts JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now()
        )
      `);
    } catch (e) {
      // FIX (audit V68, Phần 17): KHÔNG cache vĩnh viễn 1 promise bị reject — nếu init lỗi
      // (DB tạm thời unavailable / cold start lỗi mạng), reset về null để request TIẾP THEO
      // được thử lại, thay vì mọi request sau đó trong cùng serverless instance đều fail mãi
      // mãi dù DB đã hồi phục.
      hanziTableReady = null;
      throw e;
    }
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
    try {
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
    } catch (e) {
      // FIX (audit V68, Phần 17): KHÔNG cache vĩnh viễn 1 promise bị reject — nếu init lỗi
      // (DB tạm thời unavailable / cold start lỗi mạng), reset về null để request TIẾP THEO
      // được thử lại, thay vì mọi request sau đó trong cùng serverless instance đều fail mãi
      // mãi dù DB đã hồi phục.
      activityLogTableReady = null;
      throw e;
    }
  })();
  return activityLogTableReady;
}

// Luôn tính "ngày" của nhật ký hoạt động theo GIỜ VIỆT NAM (UTC+7), không theo giờ UTC của server,
// để mốc sang ngày mới khớp với lịch thực tế của người dùng ở Việt Nam.
function vnDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date || new Date());
}

// Ghi 1 dòng nhật ký + dọn dẹp ngay để không bao giờ tích luỹ quá 10 ngày dữ liệu
async function insertActivityLog({ username, role, action, detail }) {
  const client = await getPool().connect();
  try {
    await ensureActivityLogTable(client);
    const day = vnDateKey();
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
      `SELECT day, to_char(ts AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI:SS') AS time, username, role, action, detail
       FROM activity_logs ORDER BY day DESC, ts DESC LIMIT 5000`
    );
    return r.rows;
  } finally {
    client.release();
  }
}

// ── Hàng đợi giãn cách gọi Gemini API DÙNG CHUNG cho toàn hệ thống ──
// Vấn đề: nếu chỉ giãn cách bằng biến trong RAM (mỗi tiến trình/serverless instance tự đếm riêng),
// thì khi CÙNG LÚC có cron tự động chạy VÀ admin bấm tay (hoặc mở nhiều tab), mỗi bên tự nghĩ mình
// đang giãn cách đúng, nhưng CỘNG DỒN lại vẫn vượt quota thật của tài khoản Google.
// Giải pháp: lưu "lượt gọi tiếp theo được phép" vào 1 dòng DUY NHẤT trong Postgres, dùng
// SELECT ... FOR UPDATE để khoá dòng đó lại — đảm bảo dù bao nhiêu tiến trình gọi cùng lúc,
// chúng vẫn phải xếp hàng lần lượt, cách nhau đúng khoảng thời gian tối thiểu, không ai giẫm chân ai.
let geminiRateTableReady = null;
async function ensureGeminiRateTable(client) {
  if (geminiRateTableReady) return geminiRateTableReady;
  geminiRateTableReady = (async () => {
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS gemini_rate_limit (
          id INT PRIMARY KEY,
          next_slot_at TIMESTAMPTZ NOT NULL
        )
      `);
      await client.query(`
        INSERT INTO gemini_rate_limit (id, next_slot_at) VALUES (1, now())
        ON CONFLICT (id) DO NOTHING
      `);
    } catch (e) {
      // FIX (audit V68, Phần 17): KHÔNG cache vĩnh viễn 1 promise bị reject — nếu init lỗi
      // (DB tạm thời unavailable / cold start lỗi mạng), reset về null để request TIẾP THEO
      // được thử lại, thay vì mọi request sau đó trong cùng serverless instance đều fail mãi
      // mãi dù DB đã hồi phục.
      geminiRateTableReady = null;
      throw e;
    }
  })();
  return geminiRateTableReady;
}

// Xin 1 "lượt gọi" — trả về thời điểm (Date) mà lần gọi này được phép thực hiện.
// Bên gọi tự chờ (sleep) tới đúng thời điểm đó rồi mới thực sự gửi request lên Gemini.
async function reserveGeminiSlot(minIntervalMs) {
  const client = await getPool().connect();
  try {
    await ensureGeminiRateTable(client);
    await client.query('BEGIN');
    const sel = await client.query('SELECT next_slot_at FROM gemini_rate_limit WHERE id = 1 FOR UPDATE');
    const prevSlot = sel.rows[0].next_slot_at;
    const now = new Date();
    const mySlot = prevSlot > now ? prevSlot : now;
    const nextSlot = new Date(mySlot.getTime() + minIntervalMs);
    await client.query('UPDATE gemini_rate_limit SET next_slot_at = $1 WHERE id = 1', [nextSlot]);
    await client.query('COMMIT');
    return mySlot;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Khi Gemini trả lỗi "hết quota, thử lại sau Ns" (429), Google thường cho biết CHÍNH XÁC cần đợi
// bao lâu — hàm này đẩy mốc "lượt gọi tiếp theo" của HÀNG ĐỢI CHUNG ra xa hơn hiện tại đúng bằng
// khoảng đó, để MỌI tiến trình khác (kể cả từ lượt cron/GitHub Actions khác đang chạy song song)
// cũng tự động đợi theo, thay vì mỗi tiến trình tự đoán riêng rồi vẫn dồn dập gọi tiếp và ăn lỗi.
async function bumpGeminiRateLimit(delayMs) {
  const client = await getPool().connect();
  try {
    await ensureGeminiRateTable(client);
    const target = new Date(Date.now() + delayMs);
    await client.query(
      `UPDATE gemini_rate_limit SET next_slot_at = $1 WHERE id = 1 AND next_slot_at < $1`,
      [target]
    );
  } finally {
    client.release();
  }
}

// ════════════════════════════════════════════════════
// FSRS — bảng thẻ ôn tập (mỗi user + mỗi từ (hz+bài) có đúng 1 thẻ) và bảng lịch sử review.
// Định danh 1 "từ" giữ đúng theo schema vocab_words hiện có: cặp (hz, l), vì cùng 1 chữ Hán có
// thể xuất hiện ở nhiều bài với nghĩa khác nhau — KHÔNG dùng riêng "hz" để tránh đụng độ giữa
// các bài (khác với progress.srs kiểu cũ vốn chỉ khoá theo hz).
// ════════════════════════════════════════════════════
const { reviewCard: fsrsReviewCard, rowToCard, cardToRow, emptyCard } = require('./fsrs');
const { getAutomaticFSRSRating } = require('./fsrs-auto-rating');

let fsrsTablesReady = null;
async function ensureFsrsTables(client) {
  if (fsrsTablesReady) return fsrsTablesReady;
  fsrsTablesReady = (async () => {
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS fsrs_cards (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          hz TEXT NOT NULL,
          l INT NOT NULL,
          state INT NOT NULL DEFAULT 0,
          due TIMESTAMPTZ NOT NULL DEFAULT now(),
          stability DOUBLE PRECISION NOT NULL DEFAULT 0,
          difficulty DOUBLE PRECISION NOT NULL DEFAULT 0,
          elapsed_days DOUBLE PRECISION NOT NULL DEFAULT 0,
          scheduled_days DOUBLE PRECISION NOT NULL DEFAULT 0,
          reps INT NOT NULL DEFAULT 0,
          lapses INT NOT NULL DEFAULT 0,
          last_review TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS fsrs_cards_user_hz_l_idx ON fsrs_cards (user_id, hz, l)`);
      await client.query(`CREATE INDEX IF NOT EXISTS fsrs_cards_user_due_idx ON fsrs_cards (user_id, due)`);
      await client.query(`CREATE INDEX IF NOT EXISTS fsrs_cards_user_l_idx ON fsrs_cards (user_id, l)`);
      // V76 (Yêu cầu 3 — optimistic locking đồng bộ đa thiết bị): mỗi UPDATE fsrs_cards phải tăng
      // version + kiểm tra WHERE version = <version đã đọc>. SELECT...FOR UPDATE (bên dưới,
      // reviewFsrsCard) đã chống ghi đè giữa 2 request Postgres song song, nhưng KHÔNG chống được
      // trường hợp 1 client giữ dữ liệu cũ lâu (offline, tab đứng yên) rồi ghi lại sau — version là
      // lớp bảo vệ TƯỜNG MINH cho đúng trường hợp đó: conflict → đọc lại mới nhất + tính lại + retry,
      // KHÔNG BAO GIỜ last-write-wins (xem reviewFsrsCard).
      await client.query(`ALTER TABLE fsrs_cards ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0`);
      // V69 (Phần 8 — GET /api/fsrs/stats): mature/young cards đếm theo state=Review — filter
      // riêng theo state chưa có index nào phủ trước đây (chỉ có composite (user_id,due) và
      // (user_id,l)), sẽ phải quét toàn bộ card của user để lọc state (Phần 13 hiệu năng).
      await client.query(`CREATE INDEX IF NOT EXISTS fsrs_cards_user_state_idx ON fsrs_cards (user_id, state)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS review_history (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          hz TEXT NOT NULL,
          l INT NOT NULL,
          rating TEXT NOT NULL,
          answer_correct BOOLEAN NOT NULL,
          reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          previous_state INT,
          new_state INT,
          previous_due TIMESTAMPTZ,
          new_due TIMESTAMPTZ,
          previous_stability DOUBLE PRECISION,
          new_stability DOUBLE PRECISION,
          previous_difficulty DOUBLE PRECISION,
          new_difficulty DOUBLE PRECISION,
          scheduled_days DOUBLE PRECISION
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS review_history_user_time_idx ON review_history (user_id, reviewed_at)`);
      // ── V67: cột bổ sung cho auto-rating (Phần 21) — migrate bằng ALTER ... IF NOT EXISTS để
      //     không phá dữ liệu review_history cũ từ v66 (vốn không có các cột này). ──
      await client.query(`ALTER TABLE review_history ADD COLUMN IF NOT EXISTS response_time_ms INT`);
      await client.query(`ALTER TABLE review_history ADD COLUMN IF NOT EXISTS answer_changes INT NOT NULL DEFAULT 0`);
      await client.query(`ALTER TABLE review_history ADD COLUMN IF NOT EXISTS auto_rating TEXT`);
      // V69 (Phần 6 — FSRS Optimizer export): "elapsed_days" (số ngày kể từ lần review trước tới
      // lần review này) là input BẮT BUỘC để train weights riêng, nhưng trước đây không được lưu
      // vào review_history (chỉ có trên fsrs_cards, bị ghi đè ở lượt review kế tiếp — mất lịch sử).
      // ADD COLUMN IF NOT EXISTS để không phá dữ liệu review_history cũ (các dòng cũ sẽ có giá trị
      // NULL cho cột này — không đủ dữ liệu optimizer cho các lượt review TRƯỚC khi nâng cấp).
      await client.query(`ALTER TABLE review_history ADD COLUMN IF NOT EXISTS elapsed_days DOUBLE PRECISION`);
      // FIX (Ưu tiên 6 — chống spam review): cột idempotency_key cho phép server nhận diện 2 lần
      // gửi CÙNG 1 lượt trả lời (double-click, double-submit do mạng chậm, hoặc outbox gửi lại
      // sau khi request TRƯỚC ĐÓ thực ra đã thành công nhưng phản hồi bị mất giữa đường) — không
      // được phép tạo 2 dòng review_history / chạy FSRS 2 lần cho cùng 1 lượt trả lời thật.
      await client.query(`ALTER TABLE review_history ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS review_history_idem_key_idx ON review_history (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
      // Index phục vụ truy vấn baseline cá nhân theo đúng 1 thẻ (user+hz+l), mới nhất trước.
      await client.query(`CREATE INDEX IF NOT EXISTS review_history_card_idx ON review_history (user_id, hz, l, reviewed_at DESC)`);
      // V69 (Phần 8 — retention thực tính theo previous_state=Review, Phần 6 — optimizer export
      // phân trang theo id): thêm index phủ previous_state, tránh full-scan review_history theo
      // user khi bảng này lớn dần theo thời gian (tăng nhanh nhất trong toàn hệ thống — 1 dòng/lượt
      // review, Phần 13 hiệu năng).
      await client.query(`CREATE INDEX IF NOT EXISTS review_history_user_prevstate_idx ON review_history (user_id, previous_state)`);
    } catch (e) {
      // FIX (audit V68, Phần 17): KHÔNG cache vĩnh viễn 1 promise bị reject — nếu init lỗi
      // (DB tạm thời unavailable / cold start lỗi mạng), reset về null để request TIẾP THEO
      // được thử lại, thay vì mọi request sau đó trong cùng serverless instance đều fail mãi
      // mãi dù DB đã hồi phục.
      fsrsTablesReady = null;
      throw e;
    }
  })();
  return fsrsTablesReady;
}

// ── V67 (Phần 15/16): lấy tối đa `limit` lượt review GẦN NHẤT của ĐÚNG 1 thẻ (user+hz+l), dùng
//     để dựng baseline responseTime cá nhân + đếm answerChanges lịch sử cho getAutomaticFSRSRating.
//     Nhận `client` để có thể gọi TRONG CÙNG transaction với reviewFsrsCard (đọc nhất quán với
//     dòng đang bị khoá FOR UPDATE); nếu không truyền client thì tự mở kết nối riêng (vd. debug). ──
async function getRecentReviewHistoryForCard(userId, hz, l, limit, existingClient) {
  const run = async (client) => {
    await ensureFsrsTables(client);
    const r = await client.query(
      `SELECT answer_correct, response_time_ms, answer_changes, auto_rating, rating, reviewed_at
       FROM review_history
       WHERE user_id = $1 AND hz = $2 AND l = $3
       ORDER BY reviewed_at DESC
       LIMIT $4`,
      [userId, hz, l, limit || 10]
    );
    return r.rows;
  };
  if (existingClient) return run(existingClient);
  const client = await getPool().connect();
  try { return await run(client); } finally { client.release(); }
}

// Đếm tổng số thẻ đã đến hạn (due <= now) — dùng để biết có đang backlog quá daily review limit
// hay không (Phần 9), tách riêng khỏi việc LẤY thẻ vì chỉ cần con số.
async function countDueFsrsCards(userId) {
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const r = await client.query('SELECT COUNT(*)::int AS c FROM fsrs_cards WHERE user_id = $1 AND due <= now()', [userId]);
    return r.rows[0].c;
  } finally {
    client.release();
  }
}

// Lấy các thẻ đến hạn (due <= now), Learning/Relearning (state 1,3) ưu tiên trước Review (state 2),
// trong mỗi nhóm sắp theo due sớm nhất trước (Phần 5, Phần 33 bước "điều chỉnh theo đúng FSRS").
async function getDueFsrsCards(userId, limit) {
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const r = await client.query(
      `SELECT f.*, v.py, v.vi, v.tag, v.hanviet
       FROM fsrs_cards f
       JOIN vocab_words v ON v.hz = f.hz AND v.l = f.l
       WHERE f.user_id = $1 AND f.due <= now()
       ORDER BY (f.state = 1 OR f.state = 3) DESC, f.due ASC
       LIMIT $2`,
      [userId, limit]
    );
    return r.rows;
  } finally {
    client.release();
  }
}

// Lấy NEW words (chưa có fsrs_card) theo đúng thứ tự ưu tiên bài học truyền vào (Phần 7/10/23) —
// dùng array_position để giữ nguyên thứ tự ưu tiên ngay trong 1 câu SQL, không cần sort ở JS.
async function getNewWordsByLessonOrder(userId, lessonOrder, limit) {
  if (!lessonOrder || lessonOrder.length === 0 || limit <= 0) return [];
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const r = await client.query(
      `SELECT v.hz, v.py, v.vi, v.l, v.tag, v.hanviet
       FROM vocab_words v
       LEFT JOIN fsrs_cards f ON f.user_id = $2 AND f.hz = v.hz AND f.l = v.l
       WHERE v.l = ANY($1::int[]) AND f.id IS NULL
       ORDER BY array_position($1::int[], v.l), v.id
       LIMIT $3`,
      [lessonOrder, userId, limit]
    );
    return r.rows;
  } finally {
    client.release();
  }
}

// Đếm nhanh số NEW word còn lại trong 1 tập lesson (không cần thứ tự ưu tiên, chỉ cần con số cho
// dashboard "Hôm nay học").
async function countNewWordsInLessons(userId, lessons) {
  if (!lessons || lessons.length === 0) return 0;
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const r = await client.query(
      `SELECT COUNT(*)::int AS c
       FROM vocab_words v
       LEFT JOIN fsrs_cards f ON f.user_id = $2 AND f.hz = v.hz AND f.l = v.l
       WHERE v.l = ANY($1::int[]) AND f.id IS NULL`,
      [lessons, userId]
    );
    return r.rows[0].c;
  } finally {
    client.release();
  }
}

// Số lượt review/new đã thực hiện "hôm nay" theo giờ Việt Nam — dùng để trừ dần daily limit
// (Phần 22), tính trực tiếp từ review_history nên không cần thêm state riêng dễ lệch.
async function getTodayStudyCounts(userId, vnDayKey) {
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const r = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE previous_state = 0)::int AS new_count,
         COUNT(*) FILTER (WHERE previous_state != 0)::int AS review_count
       FROM review_history
       WHERE user_id = $1
         AND (reviewed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $2::date`,
      [userId, vnDayKey]
    );
    return { newToday: r.rows[0].new_count, reviewToday: r.rows[0].review_count };
  } finally {
    client.release();
  }
}

// Lấy weak words (Phần 17): dựa trên lapses cao và/hoặc difficulty cao — CHỈ là view/filter,
// không đụng vào FSRS state của thẻ.
async function getWeakFsrsCards(userId, limit) {
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const r = await client.query(
      `SELECT f.*, v.py, v.vi, v.tag, v.hanviet, COALESCE(rh.wrong_count, 0)::int AS wrong_count
       FROM fsrs_cards f
       JOIN vocab_words v ON v.hz = f.hz AND v.l = f.l
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS wrong_count FROM review_history r
         WHERE r.user_id = f.user_id AND r.hz = f.hz AND r.l = f.l AND r.answer_correct = false
       ) rh ON true
       WHERE f.user_id = $1 AND f.reps > 0 AND (f.lapses >= 2 OR f.difficulty >= 6)
       ORDER BY f.difficulty DESC, f.lapses DESC
       LIMIT $2`,
      [userId, limit]
    );
    return r.rows;
  } finally {
    client.release();
  }
}

// ── GHI 1 LƯỢT REVIEW (V67: AUTO RATING) — giao dịch có khoá dòng (FOR UPDATE) để chống
//     double-click / nhiều tab ghi đè sai lịch FSRS của cùng 1 thẻ (Phần 27). Đây là nơi DUY NHẤT
//     ghi/đổi 1 fsrs_card. Server tự suy ra rating từ hành vi trả lời (Phần 6/20) — KHÔNG còn nhận
//     rating trực tiếp từ client (khác v66: v66 nhận `ratingStr` do UI 4 nút gửi lên).
//     answerCorrect ở đây PHẢI đã được xác định bởi server (so khớp với DB) trước khi gọi hàm này
//     — xem app.post('/api/study/review') trong api/index.js (Phần 3/20). ──
async function reviewFsrsCard({ userId, hz, l, answerCorrect, responseTimeMs, answerChanges, desiredRetention, idempotencyKey, _retriesLeft = 3 }) {
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    await client.query('BEGIN');
    // FIX (Ưu tiên 6 — API submit phải idempotent): nếu client gửi idempotencyKey và ĐÃ CÓ 1 dòng
    // review_history với đúng key này cho user, đây chắc chắn là lượt gửi TRÙNG (double-click,
    // retry mạng, hoặc outbox gửi lại lượt đã thành công trước đó) — trả lại ĐÚNG kết quả đã lưu,
    // KHÔNG chạy lại FSRS / KHÔNG ghi thêm dòng review_history / KHÔNG update fsrs_cards lần nữa.
    if (idempotencyKey) {
      const dup = await client.query(
        'SELECT * FROM review_history WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1',
        [userId, idempotencyKey]
      );
      if (dup.rows.length) {
        const h = dup.rows[0];
        const cardRow = await client.query('SELECT * FROM fsrs_cards WHERE user_id=$1 AND hz=$2 AND l=$3', [userId, hz, l]);
        await client.query('COMMIT');
        return {
          ok: true,
          card: cardRow.rows.length ? { ...rowToCard(cardRow.rows[0]), hz, l, version: cardRow.rows[0].version } : null,
          wasNew: false,
          autoRating: h.rating,
          duplicate: true,
          debug: { answerCorrect: h.answer_correct, responseTimeMs: h.response_time_ms, answerChanges: h.answer_changes, autoRating: h.rating },
        };
      }
    }
    // Đảm bảo có sẵn 1 dòng để khoá (nếu word hoàn toàn mới, tạo card trống trước — Phần 12: chỉ
    // tạo khi user THỰC SỰ review, không tạo khi chỉ mở session).
    await client.query(
      `INSERT INTO fsrs_cards (user_id, hz, l, state, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, last_review)
       VALUES ($1,$2,$3,0, now(), 0, 0, 0, 0, 0, 0, NULL)
       ON CONFLICT (user_id, hz, l) DO NOTHING`,
      [userId, hz, l]
    );
    const sel = await client.query(
      'SELECT * FROM fsrs_cards WHERE user_id = $1 AND hz = $2 AND l = $3 FOR UPDATE',
      [userId, hz, l]
    );
    if (sel.rows.length === 0) throw new Error('Không tìm thấy thẻ FSRS sau khi tạo (không nên xảy ra)');
    const before = sel.rows[0];
    const wasNew = before.reps === 0 && before.state === 0 && !before.last_review;
    const beforeCard = wasNew ? null : rowToCard(before);

    // ── Phần 6/9/10/15/16: suy ra rating tự động từ answerCorrect + responseTime (so với baseline
    //     CÁ NHÂN của chính thẻ này) + state/stability/difficulty hiện tại + answerChanges. Lấy
    //     lịch sử NGAY TRONG transaction (cùng client) để nhất quán với dòng đang khoá FOR UPDATE. ──
    const reviewHistory = await getRecentReviewHistoryForCard(userId, hz, l, 10, client);
    const ratingStr = getAutomaticFSRSRating({
      answerCorrect: !!answerCorrect,
      responseTimeMs: Number.isFinite(responseTimeMs) ? responseTimeMs : null,
      card: before, // có đủ state/stability/difficulty/reps/last_review dù là dòng mới tạo (state=0)
      reviewHistory,
      answerChanges: Number.isFinite(answerChanges) ? answerChanges : 0,
    });

    const now = new Date();
    // V69: desiredRetention theo user (bảng user_settings, xem lib/fsrs/reviewService.js) — nếu
    // không truyền vào (caller cũ / chưa có setting) thì lib/fsrs.js tự fallback DEFAULT_RETENTION.
    const { newCard } = fsrsReviewCard(beforeCard, ratingStr, now, desiredRetention);
    const row = cardToRow(newCard);
    // V76 (Yêu cầu 3 — optimistic locking): WHERE kèm version cũ, tăng version lên 1. SELECT...FOR
    // UPDATE ở trên đã khoá đúng dòng này nên về lý thuyết rowCount luôn = 1 ở đây; kiểm tra dù vậy
    // để KHÔNG BAO GIỜ có đường ghi đè mù (last-write-wins) nếu sau này có code khác lỡ update
    // fsrs_cards mà không qua hàm này / không giữ lock.
    const beforeVersion = Number(before.version) || 0;
    const updateResult = await client.query(
      `UPDATE fsrs_cards SET state=$1, due=$2, stability=$3, difficulty=$4, elapsed_days=$5,
         scheduled_days=$6, reps=$7, lapses=$8, last_review=$9, version=$10, updated_at=now()
       WHERE id = $11 AND version = $12`,
      [row.state, row.due, row.stability, row.difficulty, row.elapsed_days, row.scheduled_days,
        row.reps, row.lapses, row.last_review, beforeVersion + 1, before.id, beforeVersion]
    );
    if (updateResult.rowCount === 0) {
      // Conflict thật (version đã đổi so với lúc đọc) — KHÔNG merge mù, KHÔNG mất review: rollback
      // toàn bộ giao dịch này rồi TỰ GỌI LẠI chính hàm này từ đầu, để đọc lại dữ liệu MỚI NHẤT
      // (SELECT...FOR UPDATE lần nữa) và tính lại rating/FSRS trên đúng state mới nhất đó, thay vì
      // ghi đè lên trên. Giới hạn số lần retry để không lặp vô hạn nếu có lỗi khác thường trực.
      await client.query('ROLLBACK');
      if (_retriesLeft <= 0) {
        throw new Error('Xung đột phiên bản khi ghi điểm FSRS (version conflict) sau nhiều lần thử lại');
      }
      return reviewFsrsCard({
        userId, hz, l, answerCorrect, responseTimeMs, answerChanges, desiredRetention, idempotencyKey,
        _retriesLeft: _retriesLeft - 1,
      });
    }
    try {
      await client.query(
        `INSERT INTO review_history
           (user_id, hz, l, rating, answer_correct, reviewed_at,
            previous_state, new_state, previous_due, new_due,
            previous_stability, new_stability, previous_difficulty, new_difficulty, scheduled_days,
            response_time_ms, answer_changes, auto_rating, elapsed_days, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9,$10, $11,$12,$13,$14, $15, $16,$17,$18, $19, $20)`,
        [userId, hz, l, ratingStr, !!answerCorrect, now,
          before.state, row.state, before.due, row.due,
          before.stability, row.stability, before.difficulty, row.difficulty, row.scheduled_days,
          Number.isFinite(responseTimeMs) ? Math.round(responseTimeMs) : null,
          Number.isFinite(answerChanges) ? answerChanges : 0, ratingStr, row.elapsed_days,
          idempotencyKey || null]
      );
    } catch (insErr) {
      // FIX (Ưu tiên 6): 2 request TRÙNG idempotencyKey lọt qua được cả 2 tới đây (race hiếm gặp
      // giữa lúc SELECT dedupe ở trên và lúc INSERT) — unique index sẽ chặn 1 trong 2 ở tầng DB
      // (mã lỗi 23505). Coi như trùng lặp: rollback thao tác của request này, KHÔNG throw ra ngoài
      // như lỗi thật, để caller không hiểu nhầm là mất dữ liệu.
      if (insErr && insErr.code === '23505' && idempotencyKey) {
        await client.query('ROLLBACK');
        return reviewFsrsCard({ userId, hz, l, answerCorrect, responseTimeMs, answerChanges, desiredRetention, idempotencyKey });
      }
      throw insErr;
    }
    await client.query('COMMIT');
    return {
      ok: true,
      card: { ...row, hz, l, version: beforeVersion + 1 },
      wasNew,
      autoRating: ratingStr,
      debug: {
        answerCorrect: !!answerCorrect,
        responseTimeMs: Number.isFinite(responseTimeMs) ? responseTimeMs : null,
        answerChanges: Number.isFinite(answerChanges) ? answerChanges : 0,
        autoRating: ratingStr,
        previousState: before.state, newState: row.state,
        previousStability: before.stability, newStability: row.stability,
        previousDifficulty: before.difficulty, newDifficulty: row.difficulty,
        previousDue: before.due, newDue: row.due,
      },
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── [DEBUG — dev] Xem toàn bộ thẻ FSRS của 1 user trong phạm vi bài chỉ định (Phần 30) ──
async function getFsrsCardsDebug(userId, lessons) {
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const params = [userId];
    let where = 'f.user_id = $1';
    if (lessons && lessons.length) { params.push(lessons); where += ' AND f.l = ANY($2::int[])'; }
    const r = await client.query(
      `SELECT f.*, v.py, v.vi FROM fsrs_cards f JOIN vocab_words v ON v.hz=f.hz AND v.l=f.l
       WHERE ${where} ORDER BY f.due ASC LIMIT 500`,
      params
    );
    return r.rows;
  } finally {
    client.release();
  }
}

// ── V67 (Phần 3/20): server tự xác định đáp án đúng từ DB — dùng để so khớp selectedAnswer của
//     client trong app.post('/api/study/review'), KHÔNG tin answerCorrect do client tự gửi. ──
async function getWordForAnswerCheck(hz, l) {
  const client = await getPool().connect();
  try {
    const r = await client.query(
      'SELECT hz, py, vi, l, tag, hanviet FROM vocab_words WHERE hz = $1 AND l = $2 LIMIT 1',
      [hz, l]
    );
    return r.rows[0] || null;
  } finally {
    client.release();
  }
}

// ── V69 (Phần 2 audit — loại bỏ SRS cũ): "known/mature word" giờ tính TỪ fsrs_cards thật (state
//     Review = đã ôn qua ít nhất 1 chu kỳ trọn vẹn), KHÔNG còn dựa vào "progress.srs[hz].step" (hệ
//     SRS cũ, đã bị xoá khỏi progress — xem emptyProgress() trong api/index.js). ──
async function countKnownFsrsWords(userId) {
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const r = await client.query('SELECT COUNT(*)::int AS c FROM fsrs_cards WHERE user_id = $1 AND state = 2', [userId]);
    return r.rows[0].c;
  } finally {
    client.release();
  }
}

// ── V70 (Task 2 audit — hợp nhất FSRS): số từ "đã thuộc" (state=2/Review) GOM THEO TỪNG BÀI,
//     dùng cho tab HSK4 và tab Thống kê — thay cho "progress.srs[hz].step>=3" (SRS cũ đã bị xoá
//     khỏi client ở V70). CHỈ đọc fsrs_cards thật, không suy luận/ước lượng gì thêm. ──
async function getKnownCountsByLesson(userId, lessons) {
  if (!lessons || lessons.length === 0) return {};
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const r = await client.query(
      `SELECT l, COUNT(*)::int AS c FROM fsrs_cards
       WHERE user_id = $1 AND l = ANY($2::int[]) AND state = 2
       GROUP BY l`,
      [userId, lessons]
    );
    const out = {};
    r.rows.forEach(row => { out[row.l] = row.c; });
    return out;
  } finally {
    client.release();
  }
}

// Bulk version cho leaderboard/admin list — 1 query GROUP BY thay vì N query riêng lẻ (tránh N+1
// khi có hàng nghìn user, Phần 13 của audit).
async function getKnownCountsForUsers(userIds) {
  if (!userIds || userIds.length === 0) return {};
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const r = await client.query(
      `SELECT user_id, COUNT(*)::int AS c FROM fsrs_cards WHERE user_id = ANY($1::text[]) AND state = 2 GROUP BY user_id`,
      [userIds]
    );
    const map = {};
    for (const row of r.rows) map[row.user_id] = row.c;
    return map;
  } finally {
    client.release();
  }
}

module.exports = {
  getPool, // V69: cần cho lib/fsrs/analytics.js + lib/fsrs/optimizer.js (dùng chung 1 pool duy nhất).
  countKnownFsrsWords, getKnownCountsForUsers, getKnownCountsByLesson,
  readDB, updateDB, updateDBWithFsrsCleanup, getVocabByLessons, getVocabCounts, importVocab, clearVocab, deleteVocabLesson, emptyDB,
  getAllVocabWords, updateVocabHanviet, getWordExampleCounts, insertWordExamples, getWordExamplesForLessons,
  getAllHanziParts, getHanziPartsKeys, insertHanziParts,
  insertActivityLog, getActivityLogs,
  reserveGeminiSlot, bumpGeminiRateLimit,
  countDueFsrsCards, getDueFsrsCards, getNewWordsByLessonOrder, countNewWordsInLessons,
  getTodayStudyCounts, getWeakFsrsCards, reviewFsrsCard, getFsrsCardsDebug,
  getRecentReviewHistoryForCard, getWordForAnswerCheck,
  vnDateKey, // V76: dùng chung cho reviewService.getStudySession() + api/index.js, tránh 2 nơi tự định nghĩa lệch nhau
};
