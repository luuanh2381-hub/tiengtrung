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
// V93 (audit "thống nhất từ vựng giữa các bài"): toàn bộ quyết định "field nào thắng khi merge",
// "bản ghi nào là canonical", "thẻ FSRS nào sống sót khi có duplicate" nằm trong lib/vocab-merge.js
// (pure function, có unit test riêng ở test/vocab-merge.test.js) — ở ĐÂY chỉ gọi lại, không viết
// lại logic quyết định lần 2 (tránh 2 nơi lệch nhau theo thời gian, đúng tinh thần cardMapper.js).
const vocabMerge = require('./vocab-merge');

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
//
// FIX (audit V79 — đồng bộ Neon đa thiết bị): bản V72 KHÔNG có TTL — 1 khi "nóng", cache sống tới
// khi CHÍNH instance đó tự ghi (updateDB) hoặc bị cold start lại, tức có thể "nóng" hàng chục phút
// nếu Vercel tái sử dụng instance liên tục. requireAuth() gọi readDB() ở MỌI request có auth
// (token, progress.ui — Quyển/bài đang chọn, currentLesson...) — nên trong khoảng thời gian đó,
// 1 instance có thể trả lời BẰNG dữ liệu CŨ dù 1 thiết bị/tab khác (chạm instance khác) đã ghi mới
// hơn từ lâu: user đổi bài học ở máy A không thấy áp dụng khi học tiếp ở máy B, hoặc tệ hơn là
// tưởng như "mất tiến trình"/"bị reset" dù dữ liệu thật trên Postgres vẫn đúng. Thêm TTL ngắn để
// giới hạn độ trễ tối đa giữa các instance ở vài giây thay vì vô hạn — vẫn giữ gần trọn lợi ích
// hiệu năng gốc (đa số request trong 1 phiên học cách nhau vài giây, vẫn ăn cache).
let cachedAppStore = null;
let cachedAppStoreAt = 0;
const APP_STORE_CACHE_TTL_MS = 5000;

// Đọc dữ liệu tài khoản, không khoá — dùng cho các thao tác chỉ đọc
async function readDB() {
  if (cachedAppStore && (Date.now() - cachedAppStoreAt) < APP_STORE_CACHE_TTL_MS) return cachedAppStore;
  const client = await getPool().connect();
  try {
    await ensureTable(client);
    const r = await client.query('SELECT data FROM app_store WHERE id = 1');
    const db = normalize(r.rows[0] ? r.rows[0].data : emptyDB());
    cachedAppStore = db;
    cachedAppStoreAt = Date.now();
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
    cachedAppStoreAt = Date.now(); // V79: làm mới mốc TTL — ghi của CHÍNH instance này luôn coi là "mới nhất"
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
    cachedAppStoreAt = Date.now(); // V79: làm mới mốc TTL, giống updateDB()
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
      // V93: KHÔNG còn coi (hz, l) là index DUY NHẤT/định danh — giữ lại index này (không unique
      // nữa về mặt Ý NGHĨA nghiệp vụ, nhưng để nguyên KHÔNG ĐỔI cấu trúc index đang có, tránh 1 thao
      // tác ALTER không cần thiết trên bảng production) chỉ để tương thích các câu query cũ còn sót
      // và làm lưới an toàn phụ. Định danh THẬT của 1 từ giờ là (id)/(hz) — xem vocab_words_hz_idx,
      // CHỈ được tạo bởi scripts/migrate-vocab-identity.js SAU KHI đã dọn hết duplicate (Phần 12 của
      // audit: "trước khi tạo constraint phải tìm duplicate, merge, repair, verify, rồi mới tạo").
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS vocab_words_hz_l_idx ON vocab_words (hz, l)`);
      await client.query(`CREATE INDEX IF NOT EXISTS vocab_words_l_idx ON vocab_words (l)`);
      await client.query(`CREATE INDEX IF NOT EXISTS vocab_words_hz_nonunique_idx ON vocab_words (hz)`);
      // ── V93: bảng quan hệ NHIỀU-NHIỀU từ ↔ bài (Phần 2 audit: "Một từ = một vocabulary record duy
      //     nhất; Bài học chỉ là quan hệ của từ với lesson"). word_id tham chiếu vocab_words.id —
      //     CASCADE khi xoá hẳn 1 từ (Phần 16: xoá từ khỏi 1 bài CHỈ xoá đúng dòng quan hệ này, không
      //     đụng vocab_words; chỉ khi vocab_words bị xoá thật — đã hết mọi lesson — mới cascade). ──
      await client.query(`
        CREATE TABLE IF NOT EXISTS vocab_lessons (
          word_id INT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
          lesson INT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (word_id, lesson)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS vocab_lessons_lesson_idx ON vocab_lessons (lesson)`);
      // Di chuyển 1 lần duy nhất dữ liệu từ vựng cũ (nếu app từng lưu dạng 1 khối JSON ở bản trước)
      const countRes = await client.query('SELECT COUNT(*)::int AS c FROM vocab_words');
      if (countRes.rows[0].c === 0) {
        const legacy = await client.query(`SELECT data FROM app_store WHERE id = 2`).catch(() => null);
        const legacyVocab = (legacy && legacy.rows[0] && Array.isArray(legacy.rows[0].data.vocab)) ? legacy.rows[0].data.vocab : [];
        if (legacyVocab.length) await bulkUpsertVocab(client, legacyVocab, false);
      }
      // ── V93 — CẦU NỐI tự động, AN TOÀN, chỉ THÊM không XOÁ: nếu vocab_lessons còn rỗng nhưng
      //     vocab_words đã có dữ liệu (app nâng cấp lên bản code mới nhưng CHƯA kịp chạy
      //     scripts/migrate-vocab-identity.js thủ công), tự tạo quan hệ (word_id=id, lesson=l) 1-1
      //     cho ĐÚNG dữ liệu hiện có — để các câu query theo vocab_lessons (getVocabByLessons,
      //     getVocabCounts, ...) hoạt động ĐÚNG NGAY LẬP TỨC dù chưa dedupe. Việc dedupe THẬT (gộp
      //     các dòng trùng hz thành 1 canonical) vẫn PHẢI chạy scripts/migrate-vocab-identity.js —
      //     bước này chỉ đảm bảo app không "gãy" trong lúc chờ admin chạy migration, KHÔNG thay thế
      //     migration. Idempotent: chỉ chạy khi vocab_lessons rỗng, ON CONFLICT DO NOTHING an toàn
      //     nếu 2 instance cùng cold start 1 lúc.
      const linkCountRes = await client.query('SELECT COUNT(*)::int AS c FROM vocab_lessons');
      if (linkCountRes.rows[0].c === 0 && countRes.rows[0].c > 0) {
        await client.query(`
          INSERT INTO vocab_lessons (word_id, lesson)
          SELECT id, l FROM vocab_words
          ON CONFLICT (word_id, lesson) DO NOTHING
        `);
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

// ── V93 (Phần 3 audit — identity ổn định): tra "word_id" chuẩn (canonical) của 1 chữ Hán/từ theo
//     hz — id NHỎ NHẤT trong số các dòng cùng hz thắng (ĐÚNG quy tắc pickCanonical ở
//     lib/vocab-merge.js; ORDER BY id thay vì MIN(id) để lỡ vẫn còn duplicate CHƯA kịp chạy
//     scripts/migrate-vocab-identity.js thì vẫn ra kết quả nhất quán, ổn định, không random). Trả
//     null nếu hz chưa tồn tại trong vocab_words (từ đã bị xoá hẳn / dữ liệu bất thường) — MỌI nơi
//     gọi hàm này đều PHẢI tự xử lý null bằng cách fallback về hành vi hz+l cũ (KHÔNG BAO GIỜ để
//     null làm vỡ luồng học/luồng review của user). Nhận `client` để chạy TRONG CÙNG transaction
//     với nơi gọi (nhất quán, không đọc dữ liệu từ 1 kết nối khác đang có thể lệch). ────────────
async function resolveCanonicalWordId(client, hz) {
  if (!hz) return null;
  const r = await client.query('SELECT id FROM vocab_words WHERE hz = $1 ORDER BY id ASC LIMIT 1', [hz]);
  return r.rows.length ? r.rows[0].id : null;
}

// ── V93.1 (fix "Failed to fetch" khi import Excel — xem AUDIT-REPORT-V93.1) ─────────────────────
// Xử lý theo LÔ (CHUNK=500 dòng input/lô, như bản gốc trước V93) nhưng MỖI LÔ chỉ cần ~5 round-trip
// DB CỐ ĐỊNH (không phụ thuộc số dòng trong lô) thay vì round-trip riêng cho từng dòng: (1) SELECT
// toàn bộ vocab_words khớp các hz trong lô, (2) tính "kế hoạch" thuần trong bộ nhớ
// (vocabMerge.planBulkUpsert — có unit test riêng, xem test/vocab-merge.test.js), (3) bulk INSERT
// từ mới, (4) bulk UPDATE metadata cần đổi, (5) SELECT + bulk INSERT quan hệ vocab_lessons. Giữ
// NGUYÊN 100% quy tắc nghiệp vụ của Phần 6/7/8/9 audit gốc (merge field theo overwrite, không tạo
// trùng, LUÔN thêm lesson relationship dù overwrite bật hay tắt) — chỉ đổi CÁCH THỰC THI, không đổi
// KẾT QUẢ (test/vocab-identity.integration.test.js verify qua hành vi bên ngoài, không phụ thuộc
// cách cài đặt bên trong).
async function bulkUpsertVocab(client, words, overwrite) {
  const CHUNK = 500;
  let added = 0, updated = 0, invalid = 0, skipped = 0, lessonLinked = 0;

  for (let i = 0; i < words.length; i += CHUNK) {
    const rawChunk = words.slice(i, i + CHUNK);
    const rows = [];
    for (const raw of rawChunk) {
      const w = raw || {};
      const hz = String(w.hz || '').trim();
      const vi = String(w.vi || '').trim();
      const l = Number(w.l);
      if (!hz || !vi || !Number.isFinite(l) || l < 1) { invalid++; continue; }
      rows.push({ hz, py: w.py != null ? String(w.py).trim() : '', vi, l, tag: w.tag || null });
    }
    if (rows.length === 0) continue;

    // (1) 1 round-trip: toàn bộ vocab_words hiện có khớp các hz trong lô này.
    const uniqueHz = [...new Set(rows.map(r => r.hz))];
    const existingRes = await client.query(
      `SELECT id, hz, py, vi, tag, hanviet FROM vocab_words WHERE hz = ANY($1::text[])`,
      [uniqueHz]
    );
    // Nếu hz CHƯA unique hoàn toàn (chưa chạy scripts/migrate-vocab-identity.js) — chọn canonical =
    // id nhỏ nhất, đúng quy tắc resolveCanonicalWordId/pickCanonical, để không tạo thêm trùng.
    const existingByHz = new Map();
    for (const r of existingRes.rows) {
      const cur = existingByHz.get(r.hz);
      if (!cur || r.id < cur.id) existingByHz.set(r.hz, r);
    }

    // (2) Thuần trong bộ nhớ — không đụng DB.
    const plan = vocabMerge.planBulkUpsert(existingByHz, rows, !!overwrite);
    added += plan.counts.added;
    updated += plan.counts.updated;

    // (3) 1 round-trip: bulk INSERT từ mới, lấy lại id thật vừa tạo.
    const hzToNewId = new Map();
    if (plan.newWords.length) {
      const values = [], params = [];
      plan.newWords.forEach((w, idx) => {
        const b = idx * 5;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
        params.push(w.hz, w.py, w.vi, w.l, w.tag);
      });
      const insRes = await client.query(
        `INSERT INTO vocab_words (hz, py, vi, l, tag) VALUES ${values.join(',')} RETURNING id, hz`,
        params
      );
      for (const row of insRes.rows) hzToNewId.set(row.hz, row.id);
    }

    // (4) 1 round-trip: bulk UPDATE metadata cho từ đã tồn tại thực sự cần đổi.
    if (plan.updates.length) {
      const values = [], params = [];
      plan.updates.forEach((u, idx) => {
        const b = idx * 4;
        values.push(`($${b + 1}::int,$${b + 2}::text,$${b + 3}::text,$${b + 4}::text)`);
        params.push(u.id, u.py, u.vi, u.tag);
      });
      await client.query(
        `UPDATE vocab_words AS vw SET py = v.py, vi = v.vi, tag = v.tag
         FROM (VALUES ${values.join(',')}) AS v(id, py, vi, tag)
         WHERE vw.id = v.id`,
        params
      );
    }

    // (5a) 1 round-trip: biết trước cặp (word_id, lesson) nào ĐÃ có sẵn cho các từ CŨ — để tính
    //      đúng lessonLinked/skipped (từ MỚI thì chắc chắn 100% lesson đều là "mới").
    const existingWordIds = plan.existingLessonNeeds.map(n => n.wordId);
    const priorLessonsRes = existingWordIds.length
      ? await client.query(`SELECT word_id, lesson FROM vocab_lessons WHERE word_id = ANY($1::int[])`, [existingWordIds])
      : { rows: [] };
    const priorLessonSet = new Set(priorLessonsRes.rows.map(r => r.word_id + ':' + r.lesson));
    const updatedIdSet = new Set(plan.updates.map(u => u.id));

    const allPairs = [];
    for (const w of plan.newWords) {
      const wordId = hzToNewId.get(w.hz);
      for (const l of w.lessons) allPairs.push([wordId, l]);
    }
    for (const need of plan.existingLessonNeeds) {
      for (const l of need.lessons) {
        allPairs.push([need.wordId, l]);
        const key = need.wordId + ':' + l;
        if (priorLessonSet.has(key)) { if (!updatedIdSet.has(need.wordId)) skipped++; }
        else lessonLinked++;
      }
    }

    // (5b) 1 round-trip: bulk INSERT toàn bộ quan hệ vocab_lessons cần đảm bảo (cả từ mới lẫn từ cũ).
    if (allPairs.length) {
      const values = [], params = [];
      allPairs.forEach(([wordId, lesson], idx) => {
        const b = idx * 2;
        values.push(`($${b + 1},$${b + 2})`);
        params.push(wordId, lesson);
      });
      await client.query(
        `INSERT INTO vocab_lessons (word_id, lesson) VALUES ${values.join(',')} ON CONFLICT (word_id, lesson) DO NOTHING`,
        params
      );
    }
  }
  return { added, updated, invalid, skipped, lessonLinked };
}

// Lấy từ vựng của đúng những bài được yêu cầu (dùng index, chỉ trả về đúng phần cần)
// V93: JOIN qua vocab_lessons thay vì lọc thẳng vocab_words.l — 1 từ thuộc NHIỀU bài (vd 学习 ở cả
// Bài 1 lẫn Bài 8) giờ trả về ĐÚNG khi lọc theo BẤT KỲ bài nào trong số đó (trước đây chỉ trả về
// đúng lesson "gốc" của dòng vocab_words tương ứng, các bài khác của CÙNG chữ đó — nếu do duplicate
// — coi như 2 từ tách biệt). CỐ Ý vẫn trả 1 dòng cho MỖI (word, lesson) khớp yêu cầu (giữ nguyên
// SHAPE dữ liệu — Phần 11 "không được phá các màn hình học hiện tại": js/app.js:ensureVocabLoaded
// dùng `hz + '-' + l` làm khoá và lọc WORDS theo đúng `l` ở nhiều màn hình, đổi shape sẽ làm từ
// "biến mất" khỏi các bài phụ). Khác biệt THẬT so với trước: metadata (py/vi/tag/hanviet) của
// CÙNG 1 chữ Hán giờ LUÔN GIỐNG NHAU dù đang xem ở bài nào — đây chính là điều Phần audit yêu cầu
// giải quyết ("từ vựng giữa các bài không được thống nhất").
async function getVocabByLessons(lessons) {
  if (!lessons || lessons.length === 0) return [];
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    const r = await client.query(
      `SELECT v.hz, v.py, v.vi, vl.lesson AS l, v.tag, v.hanviet
       FROM vocab_lessons vl
       JOIN vocab_words v ON v.id = vl.word_id
       WHERE vl.lesson = ANY($1::int[])
       ORDER BY vl.lesson, v.id`,
      [lessons]
    );
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
// FIX (audit V79 — cùng lớp bug với cachedAppStore): invalidate ở 3 chỗ trên chỉ có hiệu lực cho
// CHÍNH instance vừa ghi — 1 instance KHÁC (admin import từ vựng ở 1 lượt request chạm instance
// khác) vẫn có thể giữ số đếm CŨ vô thời hạn cho tới khi tự cold start lại. Ít nghiêm trọng hơn
// cachedAppStore (không gây mất dữ liệu, chỉ hiện sai số từ/bài vài phút), nhưng vẫn thêm TTL cho
// nhất quán và để tự phục hồi đúng mà không cần đợi redeploy/cold start.
let cachedVocabCounts = null;
let cachedVocabCountsAt = 0;
const VOCAB_COUNTS_CACHE_TTL_MS = 60000;

// Đếm nhanh số từ theo từng bài (payload rất nhỏ) — dùng để hiện số từ ở màn chọn Quyển/level
// mà KHÔNG cần tải toàn bộ nội dung từ vựng về máy.
async function getVocabCounts() {
  if (cachedVocabCounts && (Date.now() - cachedVocabCountsAt) < VOCAB_COUNTS_CACHE_TTL_MS) return cachedVocabCounts;
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    // V93: đếm theo vocab_lessons (quan hệ thật) thay vì vocab_words.l — 1 từ thuộc nhiều bài được
    // tính vào TỪNG bài nó thuộc về, đúng ngữ nghĩa "bài X có bao nhiêu từ" sau khi hết duplicate.
    const r = await client.query('SELECT lesson AS l, COUNT(*)::int AS count FROM vocab_lessons GROUP BY lesson');
    const counts = {};
    for (const row of r.rows) counts[row.l] = row.count;
    cachedVocabCounts = counts;
    cachedVocabCountsAt = Date.now();
    return counts;
  } finally {
    client.release();
  }
}

// ── V93 (Phần 7 audit — "Manual Add Word phải detect duplicate TRƯỚC KHI INSERT") — tra 1 từ theo
//     hz, kèm ĐẦY ĐỦ danh sách bài nó đang thuộc về. Dùng cho endpoint
//     GET /api/admin/vocab/find-by-hz — admin gõ xong 1 từ, FE gọi hàm này TRƯỚC khi submit để biết
//     có cần hiện dialog "Giữ dữ liệu hiện tại / Ghi đè" hay không (chỉ ĐỌC, không insert/update gì). ──
async function findVocabWordByHz(hz) {
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    const r = await client.query(
      `SELECT v.id, v.hz, v.py, v.vi, v.tag, v.hanviet,
              COALESCE(
                (SELECT array_agg(vl.lesson ORDER BY vl.lesson) FROM vocab_lessons vl WHERE vl.word_id = v.id),
                ARRAY[]::int[]
              ) AS lessons
       FROM vocab_words v WHERE v.hz = $1 ORDER BY v.id ASC LIMIT 1`,
      [hz]
    );
    return r.rows[0] || null;
  } finally {
    client.release();
  }
}

async function importVocab(words, overwrite) {
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    // V93 (Phần 4.13 audit — "Có transaction nếu database hỗ trợ"): bọc TOÀN BỘ lượt import trong 1
    // transaction — hàng trăm/nghìn dòng của 1 file Excel HOẶC thành công hết HOẶC rollback sạch,
    // không để lại trạng thái nửa vời (vd nửa số từ đã update metadata, nửa còn lại lỗi giữa chừng).
    await client.query('BEGIN');
    const result = await bulkUpsertVocab(client, words, overwrite);
    const totalRes = await client.query('SELECT COUNT(*)::int AS c FROM vocab_words');
    result.total = totalRes.rows[0].c;
    await client.query('COMMIT');
    cachedVocabCounts = null; // V72: số từ theo bài vừa đổi — bỏ cache, lần đọc sau tự tính lại
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
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
// V93 (Phần 16 audit — quy tắc delete): TRƯỚC ĐÂY xoá thẳng vocab_words WHERE l=$1 — giờ 1 từ có
// thể thuộc NHIỀU bài, nên "xoá bài X" CHỈ được gỡ đúng quan hệ (word_id, X) khỏi vocab_lessons;
// vocab_words CHỈ thực sự bị xoá cho những từ KHÔNG còn thuộc bài nào khác nữa (hết dependency).
// Bọc transaction để 2 bước (gỡ quan hệ + dọn từ mồ côi) luôn nhất quán.
async function deleteVocabLesson(l) {
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    await client.query('BEGIN');
    const affected = await client.query('SELECT word_id FROM vocab_lessons WHERE lesson = $1', [l]);
    const wordIds = affected.rows.map(r => r.word_id);
    const del = await client.query('DELETE FROM vocab_lessons WHERE lesson = $1', [l]);
    if (wordIds.length) {
      // Chỉ xoá hẳn vocab_words nếu KHÔNG còn quan hệ nào khác (Phần 16: "chỉ xóa vocabulary thực sự
      // khi đảm bảo không còn dependency") — từ vẫn thuộc bài khác thì GIỮ NGUYÊN, chỉ mất đúng 1 quan hệ.
      await client.query(
        `DELETE FROM vocab_words WHERE id = ANY($1::int[])
           AND NOT EXISTS (SELECT 1 FROM vocab_lessons WHERE word_id = vocab_words.id)`,
        [wordIds]
      );
    }
    await client.query('COMMIT');
    cachedVocabCounts = null; // V72
    return del.rowCount; // số quan hệ từ-bài đã gỡ = số từ "biến mất khỏi danh sách bài X" cho admin xem, giữ đúng ý nghĩa cũ
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── V93 (Phần 16 audit) — xoá 1 TỪ khỏi 1 BÀI cụ thể (khác deleteVocabWord bên dưới vốn xoá hẳn
//     theo id không phân biệt bài). Đây là hành vi ĐÚNG khi admin bấm xoá 1 từ trong khi đang xem
//     danh sách của 1 bài: chỉ gỡ quan hệ (id, lesson); vocab_words CHỈ bị xoá hẳn nếu đây là bài
//     CUỐI CÙNG mà từ đó còn thuộc về (không còn dependency lesson nào khác — không tự ý kiểm tra
//     thêm FSRS/progress vì đó vốn không phải điều kiện chặn xoá trong app hiện tại — giữ đúng
//     semantics cũ của deleteVocabWord, chỉ thu hẹp phạm vi ảnh hưởng xuống đúng 1 lesson). ────────
async function removeVocabWordFromLesson(id, lesson) {
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    await client.query('BEGIN');
    const del = await client.query(
      'DELETE FROM vocab_lessons WHERE word_id = $1 AND lesson = $2 RETURNING word_id',
      [id, lesson]
    );
    if (del.rows.length === 0) {
      await client.query('COMMIT');
      return { ok: false };
    }
    const remain = await client.query('SELECT lesson FROM vocab_lessons WHERE word_id = $1 ORDER BY lesson', [id]);
    let fullyDeleted = false;
    if (remain.rows.length === 0) {
      await client.query('DELETE FROM vocab_words WHERE id = $1', [id]);
      fullyDeleted = true;
    }
    await client.query('COMMIT');
    cachedVocabCounts = null;
    return { ok: true, fullyDeleted, remainingLessons: remain.rows.map(r => r.lesson) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Lấy toàn bộ từ vựng của MỘT bài, KÈM id — dùng cho màn admin sửa/xoá từng từ riêng lẻ
// (khác getVocabByLessons/getAllVocabWords vốn không trả id vì client-side app không cần đến nó).
// V93: JOIN qua vocab_lessons (Phần 15 UI: hiện thêm "Bài: 1, 5, 8" nếu 1 từ thuộc nhiều bài) —
// kèm field `lessons` (mảng ĐẦY ĐỦ mọi bài mà từ này thuộc về, không chỉ riêng bài đang xem).
async function getVocabWordsByLesson(l) {
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    const r = await client.query(
      `SELECT v.id, v.hz, v.py, v.vi, vl.lesson AS l, v.tag, v.hanviet,
              COALESCE(
                (SELECT array_agg(vl2.lesson ORDER BY vl2.lesson) FROM vocab_lessons vl2 WHERE vl2.word_id = v.id),
                ARRAY[vl.lesson]
              ) AS lessons
       FROM vocab_lessons vl
       JOIN vocab_words v ON v.id = vl.word_id
       WHERE vl.lesson = $1
       ORDER BY v.id`,
      [l]
    );
    return r.rows;
  } finally {
    client.release();
  }
}

// Sửa 1 từ theo id (đổi chữ Hán/pinyin/nghĩa/nhãn). Trả về dòng mới sau khi sửa, hoặc null nếu
// không tìm thấy id. Không đụng tới cột hanviet (giữ nguyên nghĩa Hán Việt đã sinh, nếu có) — trừ
// khi đổi sang chữ Hán khác thì hanviet cũ (gắn với chữ cũ) không còn đúng nữa nên phải xoá đi.
// V93 (Phần 15 audit — "một vocabulary chỉ có một bộ metadata"): `l`, nếu có truyền, giờ mang
// nghĩa MỚI — "đảm bảo từ này có thuộc bài l" (THÊM quan hệ nếu chưa có), KHÔNG còn "di chuyển"
// từ này khỏi các bài khác (tránh sửa nhầm 1 chữ làm mất liên kết với bài đang dùng ở nơi khác,
// đúng tinh thần "Lesson chỉ xác định từ này xuất hiện trong bài nào", không phải identity). Muốn
// thay thế TOÀN BỘ tập bài của 1 từ, dùng setVocabWordLessons() bên dưới (form multi-lesson).
async function updateVocabWord(id, { hz, py, vi, l, tag }) {
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    const cur = await client.query('SELECT hz FROM vocab_words WHERE id = $1', [id]);
    if (cur.rows.length === 0) return null;
    const hzChanged = cur.rows[0].hz !== hz;
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE vocab_words
       SET hz = $1, py = $2, vi = $3, tag = $4, hanviet = CASE WHEN $5 THEN NULL ELSE hanviet END
       WHERE id = $6
       RETURNING id, hz, py, vi, tag, hanviet`,
      [hz, py || '', vi, tag || null, hzChanged, id]
    );
    if (Number.isFinite(l) && l >= 1) {
      await client.query(
        `INSERT INTO vocab_lessons (word_id, lesson) VALUES ($1,$2) ON CONFLICT (word_id, lesson) DO NOTHING`,
        [id, l]
      );
    }
    const lessonsRes = await client.query('SELECT lesson FROM vocab_lessons WHERE word_id = $1 ORDER BY lesson', [id]);
    await client.query('COMMIT');
    cachedVocabCounts = null; // V72: số bài có thể đổi nếu admin thêm bài mới cho từ này
    const row = r.rows[0];
    if (!row) return null;
    const lessons = lessonsRes.rows.map(x => x.lesson);
    return { ...row, l: Number.isFinite(l) && l >= 1 ? l : lessons[0], lessons };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── V93 (Phần 15 audit — form "Lessons: ☑ Bài 1 ☑ Bài 5 ☑ Bài 8") — THAY THẾ toàn bộ tập bài của
//     1 từ bằng đúng danh sách `lessons` truyền vào (thêm bài mới có trong danh sách nhưng chưa
//     liên kết; gỡ bài đang liên kết nhưng KHÔNG còn trong danh sách mới). KHÔNG BAO GIỜ xoá
//     vocab_words dù danh sách rỗng — 1 từ tồn tại nhưng chưa gắn bài nào vẫn là dữ liệu hợp lệ
//     (an toàn hơn xoá nhầm mất metadata/FSRS liên quan); admin muốn xoá hẳn dùng deleteVocabWord. ──
async function setVocabWordLessons(id, lessons) {
  const clean = [...new Set((lessons || []).map(Number).filter(n => Number.isFinite(n) && n >= 1))];
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    await client.query('BEGIN');
    const cur = await client.query('SELECT id FROM vocab_words WHERE id = $1', [id]);
    if (cur.rows.length === 0) { await client.query('ROLLBACK'); return null; }
    await client.query(
      `DELETE FROM vocab_lessons WHERE word_id = $1 AND NOT (lesson = ANY($2::int[]))`,
      [id, clean]
    );
    for (const l of clean) {
      await client.query(
        `INSERT INTO vocab_lessons (word_id, lesson) VALUES ($1,$2) ON CONFLICT (word_id, lesson) DO NOTHING`,
        [id, l]
      );
    }
    await client.query('COMMIT');
    cachedVocabCounts = null;
    return { id, lessons: clean.sort((a, b) => a - b) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Xoá HẲN 1 từ theo id — không phân biệt đang thuộc bài nào (CASCADE tự dọn mọi quan hệ
// vocab_lessons liên quan, xem ON DELETE CASCADE lúc tạo bảng). V93: dùng làm fallback khi KHÔNG
// có lesson context (tương thích ngược — Phần 11 audit); khi admin xoá 1 từ NGAY TỪ danh sách của
// 1 bài cụ thể, api/index.js ưu tiên gọi removeVocabWordFromLesson(id, lesson) ở trên để CHỈ gỡ
// đúng quan hệ với bài đó (Phần 16: "chỉ xóa relationship... không được xóa vocabulary nếu nó vẫn
// thuộc bài khác"). Trả về true/false tuỳ có xoá được dòng nào không.
async function deleteVocabWord(id) {
  const client = await getPool().connect();
  try {
    await ensureVocabTable(client);
    const r = await client.query('DELETE FROM vocab_words WHERE id = $1', [id]);
    cachedVocabCounts = null; // V72
    return r.rowCount > 0;
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
      // ── V93 (Phần 3/10 audit — FSRS phải tham chiếu vocabulary identity ỔN ĐỊNH, không còn hz+l):
      //     cột MỚI, NULLABLE, ADD COLUMN IF NOT EXISTS — 100% an toàn với dữ liệu hiện có (không đổi/
      //     xoá cột nào cũ). scripts/migrate-vocab-identity.js backfill word_id cho MỌI dòng đã có;
      //     reviewFsrsCard() (bên dưới) tự resolve + ghi word_id cho MỌI thẻ mới từ giờ trở đi. Unique
      //     index partial WHERE word_id IS NOT NULL — AN TOÀN tạo ngay cả TRƯỚC khi migration script
      //     chạy (lúc đó mọi word_id đều NULL, predicate không khớp dòng nào nên CREATE UNIQUE INDEX
      //     không thể vi phạm gì). Đây chính là ràng buộc THỰC THI Ở TẦNG DATABASE cho "không tạo FSRS
      //     card thứ hai chỉ vì lesson khác" — 1 user chỉ có thể có TỐI ĐA 1 dòng fsrs_cards cho mỗi
      //     word_id, do chính Postgres đảm bảo, không chỉ dựa vào code tầng ứng dụng. ──
      await client.query(`ALTER TABLE fsrs_cards ADD COLUMN IF NOT EXISTS word_id INT REFERENCES vocab_words(id)`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS fsrs_cards_user_word_idx ON fsrs_cards (user_id, word_id) WHERE word_id IS NOT NULL`);
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
      // V93: xem giải thích đầy đủ ở cột word_id của fsrs_cards phía trên — review_history KHÔNG cần
      // UNIQUE (1 từ có thể có RẤT NHIỀU dòng lịch sử theo thời gian, đây là bản chất của bảng lịch
      // sử), chỉ cần index thường để truy vấn "toàn bộ lịch sử của 1 từ" nhanh theo word_id thay vì
      // phải khớp CHÍNH XÁC hz+l (vốn có thể bị phân mảnh nếu từ đó từng có nhiều thẻ trùng trước
      // migration — word_id gộp lại thành 1 lịch sử liền mạch mà KHÔNG cần sửa lại giá trị hz/l gốc
      // của từng dòng lịch sử cũ, giữ nguyên bản ghi lịch sử THẬT tại đúng thời điểm nó xảy ra).
      await client.query(`ALTER TABLE review_history ADD COLUMN IF NOT EXISTS word_id INT REFERENCES vocab_words(id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS review_history_user_word_idx ON review_history (user_id, word_id)`);
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
// V93: nhận thêm `wordId` (canonical, có thể null) — CÓ wordId thì lọc theo word_id (lấy ĐẦY ĐỦ
// lịch sử thật của từ này, kể cả các dòng review CŨ trước migration từng bị phân mảnh theo nhiều
// `l` khác nhau do bug duplicate — KHÔNG sửa lại hz/l gốc của các dòng lịch sử cũ, chỉ gộp GÓC NHÌN
// truy vấn qua word_id, giữ nguyên bản ghi lịch sử THẬT tại đúng thời điểm nó xảy ra). KHÔNG có
// wordId (hz chưa từng/ không còn tồn tại trong vocab_words) -> fallback ĐÚNG hành vi cũ theo hz+l,
// không bao giờ để luồng auto-rating vỡ vì thiếu identity mới.
async function getRecentReviewHistoryForCard(userId, hz, l, limit, existingClient, wordId) {
  const run = async (client) => {
    await ensureFsrsTables(client);
    const r = wordId
      ? await client.query(
          `SELECT answer_correct, response_time_ms, answer_changes, auto_rating, rating, reviewed_at
           FROM review_history
           WHERE user_id = $1 AND word_id = $2
           ORDER BY reviewed_at DESC
           LIMIT $3`,
          [userId, wordId, limit || 10]
        )
      : await client.query(
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
// FIX (chọn bài học không lọc đúng): thêm tham số scopeLessons TUỲ CHỌN — không truyền (undefined)
// thì giữ nguyên hành vi cũ (đếm TOÀN TÀI KHOẢN, dùng cho blockedByBacklog ở getStudySession —
// backlog phải tính trên toàn bộ thẻ, không riêng phạm vi đang chọn). Có truyền (mảng, kể cả rỗng)
// thì chỉ đếm thẻ thuộc đúng các bài đó — dùng cho dueCount ở "Hôm nay học" để khớp với đúng số thẻ
// thật sự sẽ hiện ra khi bắt đầu học (getDueFsrsCards bên dưới, cũng đã lọc theo scope).
async function countDueFsrsCards(userId, scopeLessons) {
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const hasScope = Array.isArray(scopeLessons);
    // V93: đồng bộ với getDueFsrsCards — scope theo bài phải tra qua vocab_lessons (từ thuộc nhiều
    // bài), KHÔNG so trực tiếp f.l nữa, để 2 hàm đếm/lấy KHÔNG lệch nhau (dueCount hiển thị đúng
    // bằng đúng số thẻ thật sự sẽ hiện ra khi bắt đầu học).
    const params = hasScope ? [userId, scopeLessons] : [userId];
    const scopeClause = hasScope
      ? ` AND EXISTS (
            SELECT 1 FROM vocab_words v
            JOIN vocab_lessons vl ON vl.word_id = v.id
            WHERE ((f.word_id IS NOT NULL AND v.id = f.word_id) OR (f.word_id IS NULL AND v.hz = f.hz AND v.l = f.l))
              AND vl.lesson = ANY($2::int[])
          )`
      : '';
    const r = await client.query(
      `SELECT COUNT(*)::int AS c FROM fsrs_cards f WHERE f.user_id = $1 AND f.due <= now()${scopeClause}`,
      params
    );
    return r.rows[0].c;
  } finally {
    client.release();
  }
}

// Lấy các thẻ đến hạn (due <= now), Learning/Relearning (state 1,3) ưu tiên trước Review (state 2),
// trong mỗi nhóm sắp theo due sớm nhất trước (Phần 5, Phần 33 bước "điều chỉnh theo đúng FSRS").
// FIX (chọn bài học không lọc đúng — "Chọn bài 1 nhưng vẫn học từ của các bài khác"): TRƯỚC ĐÂY
// hàm này lấy due card TOÀN TÀI KHOẢN, không hề lọc theo Quyển/bài đang chọn (scopeLessons) — nên
// dù user chỉ chọn Bài 1, mọi thẻ due từ CÁC BÀI KHÁC đã học trước đó vẫn hiện ra trong phiên học.
// scopeLessons TUỲ CHỌN: không truyền = giữ hành vi cũ (không lọc, dùng nội bộ nếu cần); truyền vào
// (mảng, kể cả rỗng) = chỉ lấy thẻ thuộc đúng các bài đó.
// V93: (a) JOIN vocab_words qua f.word_id khi đã resolve (chính xác, ổn định dù hz bị admin sửa
// sau này), fallback hz+l khi thẻ CHƯA kịp backfill word_id; (b) scope theo BÀI giờ tra qua
// vocab_lessons thay vì so trực tiếp f.l — 1 thẻ có canonical l=1 nhưng từ đó CŨNG thuộc Bài 8 (qua
// vocab_lessons) vẫn phải hiện ra khi user ôn riêng Bài 8, nếu không từ đó sẽ "biến mất" khỏi Bài 8.
async function getDueFsrsCards(userId, limit, scopeLessons) {
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const hasScope = Array.isArray(scopeLessons);
    const params = hasScope ? [userId, limit, scopeLessons] : [userId, limit];
    const scopeClause = hasScope
      ? ' AND EXISTS (SELECT 1 FROM vocab_lessons vl WHERE vl.word_id = v.id AND vl.lesson = ANY($3::int[]))'
      : '';
    const r = await client.query(
      `SELECT f.*, v.py, v.vi, v.tag, v.hanviet
       FROM fsrs_cards f
       JOIN vocab_words v ON (f.word_id IS NOT NULL AND v.id = f.word_id)
                          OR (f.word_id IS NULL AND v.hz = f.hz AND v.l = f.l)
       WHERE f.user_id = $1 AND f.due <= now()${scopeClause}
       ORDER BY (f.state = 1 OR f.state = 3) DESC, f.due ASC
       LIMIT $2`,
      params
    );
    return r.rows;
  } finally {
    client.release();
  }
}

// Lấy NEW words (chưa có fsrs_card) theo đúng thứ tự ưu tiên bài học truyền vào (Phần 7/10/23) —
// dùng array_position để giữ nguyên thứ tự ưu tiên ngay trong 1 câu SQL, không cần sort ở JS.
// V93: "thuộc bài nào" giờ tra qua vocab_lessons (1 từ có thể thuộc NHIỀU bài trong lessonOrder) —
// PHẢI dùng DISTINCT ON (v.id) ở subquery để KHÔNG liệt kê trùng cùng 1 từ 2 lần chỉ vì nó vừa
// thuộc bài ưu tiên cao vừa thuộc bài ưu tiên thấp hơn trong CÙNG scope (nếu không, từ đó sẽ hiện
// ra 2 lần trong danh sách "từ mới cần học" của phiên — sai UX dù không tạo 2 fsrs_card thật, vì
// unique index (user_id, word_id) đã chặn ở tầng DB). Outer query sort lại theo đúng priority sau
// khi đã distinct (DISTINCT ON tự sắp theo cột distinct trước, cần sort lại ở ngoài).
async function getNewWordsByLessonOrder(userId, lessonOrder, limit) {
  if (!lessonOrder || lessonOrder.length === 0 || limit <= 0) return [];
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const r = await client.query(
      `SELECT hz, py, vi, l, tag, hanviet FROM (
         SELECT DISTINCT ON (v.id)
                v.id AS vid, v.hz, v.py, v.vi, v.l, v.tag, v.hanviet,
                array_position($1::int[], vl.lesson) AS prio
         FROM vocab_lessons vl
         JOIN vocab_words v ON v.id = vl.word_id
         LEFT JOIN fsrs_cards f ON f.user_id = $2
                                AND ((f.word_id IS NOT NULL AND f.word_id = v.id)
                                     OR (f.word_id IS NULL AND f.hz = v.hz AND f.l = v.l))
         WHERE vl.lesson = ANY($1::int[]) AND f.id IS NULL
         ORDER BY v.id, array_position($1::int[], vl.lesson)
       ) sub
       ORDER BY prio, vid
       LIMIT $3`,
      [lessonOrder, userId, limit]
    );
    return r.rows;
  } finally {
    client.release();
  }
}

// Đếm nhanh số NEW word còn lại trong 1 tập lesson (không cần thứ tự ưu tiên, chỉ cần con số cho
// dashboard "Hôm nay học"). V93: COUNT DISTINCT theo v.id vì 1 từ có thể thuộc nhiều bài trong
// scope (đồng bộ đúng con số với getNewWordsByLessonOrder ở trên, tránh đếm trùng).
async function countNewWordsInLessons(userId, lessons) {
  if (!lessons || lessons.length === 0) return 0;
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const r = await client.query(
      `SELECT COUNT(DISTINCT v.id)::int AS c
       FROM vocab_lessons vl
       JOIN vocab_words v ON v.id = vl.word_id
       LEFT JOIN fsrs_cards f ON f.user_id = $2
                              AND ((f.word_id IS NOT NULL AND f.word_id = v.id)
                                   OR (f.word_id IS NULL AND f.hz = v.hz AND f.l = v.l))
       WHERE vl.lesson = ANY($1::int[]) AND f.id IS NULL`,
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
// V93: JOIN vocab_words qua f.word_id (fallback hz+l); đếm wrong_count qua word_id khi có để không
// bỏ sót các lượt trả lời sai TỪ TRƯỚC migration (khi từ này còn bị phân mảnh nhiều thẻ theo lesson).
async function getWeakFsrsCards(userId, limit) {
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const r = await client.query(
      `SELECT f.*, v.py, v.vi, v.tag, v.hanviet, COALESCE(rh.wrong_count, 0)::int AS wrong_count
       FROM fsrs_cards f
       JOIN vocab_words v ON (f.word_id IS NOT NULL AND v.id = f.word_id)
                          OR (f.word_id IS NULL AND v.hz = f.hz AND v.l = f.l)
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS wrong_count FROM review_history r
         WHERE r.user_id = f.user_id AND r.answer_correct = false
           AND ((f.word_id IS NOT NULL AND r.word_id = f.word_id) OR (f.word_id IS NULL AND r.hz = f.hz AND r.l = f.l))
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

// ── GHI 1 LƯỢT REVIEW (V67: AUTO RATING; BỔ SUNG "Highlight System Rating": khôi phục cho phép
//     client gửi kèm `ratingOverride` — do NGƯỜI DÙNG bấm tay 1 trong 4 nút Again/Hard/Good/Easy,
//     hoặc do countdown ở FE tự chọn khi hết giờ chờ) — giao dịch có khoá dòng (FOR UPDATE) để
//     chống double-click / nhiều tab ghi đè sai lịch FSRS của cùng 1 thẻ (Phần 27). Đây là nơi DUY
//     NHẤT ghi/đổi 1 fsrs_card. Server LUÔN tự suy ra 1 "System Rating" từ hành vi trả lời (Phần
//     6/20, lưu vào cột auto_rating để làm dữ liệu tham khảo/huấn luyện) — nhưng nếu client gửi kèm
//     ratingOverride hợp lệ (1 trong 'again'|'hard'|'good'|'easy'), giá trị đó THẮNG và được dùng
//     làm rating THẬT SỰ gửi vào ts-fsrs + lưu vào cột `rating` ("User Rating luôn thắng System
//     Rating" — quy tắc bắt buộc của yêu cầu bổ sung). answerCorrect ở đây PHẢI đã được xác định
//     bởi server (so khớp với DB) trước khi gọi hàm này — xem app.post('/api/study/review') trong
//     api/index.js (Phần 3/20); ratingOverride KHÔNG được dùng để suy ngược lại answerCorrect. ──
// personalWeights (FSRS Personal Optimizer, tùy chọn — Phần 11): 21 weights riêng của user nếu đã
// Apply (đọc + cache ở lib/fsrs/optimizer.js:getUserActiveWeights, truyền qua reviewService.js).
// Không truyền / null → dùng weights mặc định của ts-fsrs, ĐÚNG hành vi trước đây — tham số này
// hoàn toàn optional nên không phá bất kỳ caller cũ nào chưa biết tới nó.
async function reviewFsrsCard({ userId, hz, l, answerCorrect, responseTimeMs, answerChanges, desiredRetention, idempotencyKey, ratingOverride, personalWeights, _retriesLeft = 3 }) {
  const VALID_RATINGS = new Set(['again', 'hard', 'good', 'easy']);
  const override = (typeof ratingOverride === 'string' && VALID_RATINGS.has(ratingOverride)) ? ratingOverride : null;
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    await client.query('BEGIN');
    // V93 (Phần 3/10 audit): resolve "word_id" canonical của hz NGAY ĐẦU transaction — dùng để
    // (a) đọc review_history ĐẦY ĐỦ hơn (kể cả các dòng cũ từng phân mảnh theo l khác nhau), và
    // (b) "tự chữa lành" gắn word_id cho fsrs_cards nếu thẻ này chưa có (xem đoạn NOT EXISTS bên
    // dưới). null nếu hz không còn tồn tại trong vocab_words (edge case hiếm) — MỌI bước dùng
    // wordId bên dưới đều tự fallback về hành vi hz+l cũ 100% khi null, KHÔNG BAO GIỜ làm vỡ luồng
    // ghi review vì lý do này.
    const wordId = await resolveCanonicalWordId(client, hz);
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
          rating: h.rating,
          systemRating: h.auto_rating || h.rating,
          duplicate: true,
          debug: { answerCorrect: h.answer_correct, responseTimeMs: h.response_time_ms, answerChanges: h.answer_changes, autoRating: h.auto_rating || h.rating, finalRating: h.rating },
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

    // ── V93: gắn word_id cho DÒNG ĐANG KHOÁ (before) nếu resolve được và nó CHƯA có/đang sai —
    //     điều kiện NOT EXISTS đảm bảo KHÔNG BAO GIỜ vi phạm unique index (user_id, word_id) — nếu
    //     user này ĐÃ có 1 dòng KHÁC mang đúng word_id này (tức phát hiện đúng tình huống Phần 4.9:
    //     "1 user có nhiều FSRS record do duplicate vocabulary" CÒN SÓT LẠI, CHƯA chạy migration
    //     script dọn) thì rowCount=0, ĐƠN GIẢN BỎ QUA — KHÔNG throw, KHÔNG chặn lượt review này,
    //     review vẫn tiếp tục lưu bình thường theo hz+l (y hệt hành vi trước V93). Việc GỘP hẳn các
    //     dòng trùng là trách nhiệm của scripts/migrate-vocab-identity.js, không phải của đường link
    //     nóng này — giữ reviewFsrsCard đơn giản, không thêm nhánh lỗi mới nào cần xử lý. ──────────
    let effectiveWordId = before.word_id != null ? before.word_id : null;
    if (wordId != null && effectiveWordId !== wordId) {
      // An toàn tuyệt đối: đây CHỈ là bước "tự chữa lành" (best-effort). Dùng SAVEPOINT — không chỉ
      // try/catch JS thuần — vì trong Postgres, 1 câu lệnh lỗi (kể cả 23505) đánh dấu CẢ transaction
      // hiện tại là "aborted": mọi câu lệnh SAU đó trong CÙNG transaction sẽ tự động bị từ chối cho
      // tới khi ROLLBACK — nếu chỉ try/catch ở tầng JS mà không ROLLBACK TO SAVEPOINT, các bước phía
      // sau (đọc review history, UPDATE FSRS state, INSERT review_history...) sẽ lần lượt thất bại
      // theo, cuối cùng vẫn mất cả lượt review — đúng điều tuyệt đối không được xảy ra. SAVEPOINT chỉ
      // "undo" đúng bước tự chữa lành bị race condition, giữ nguyên mọi thứ trước đó, cho phép
      // transaction tiếp tục bình thường ở các câu lệnh sau.
      await client.query('SAVEPOINT heal_word_id');
      try {
        const setRes = await client.query(
          `UPDATE fsrs_cards SET word_id = $1
           WHERE id = $2
             AND NOT EXISTS (SELECT 1 FROM fsrs_cards f2 WHERE f2.user_id = $3 AND f2.word_id = $1 AND f2.id <> $2)
           RETURNING word_id`,
          [wordId, before.id, userId]
        );
        if (setRes.rows.length) effectiveWordId = wordId;
        await client.query('RELEASE SAVEPOINT heal_word_id');
      } catch (healErr) {
        // Race condition cực hiếm (1 transaction khác vừa gắn xong word_id này cho 1 dòng khác của
        // CÙNG user, đúng lúc giữa NOT EXISTS và UPDATE) khiến unique index (user_id, word_id) bị vi
        // phạm — ROLLBACK TO SAVEPOINT để transaction chính tiếp tục bình thường, effectiveWordId giữ
        // nguyên như cũ (có thể vẫn null) — review vẫn lưu bình thường theo hz+l, không mất gì.
        await client.query('ROLLBACK TO SAVEPOINT heal_word_id');
        if (!(healErr && healErr.code === '23505')) throw healErr;
      }
    }

    // ── Phần 6/9/10/15/16: suy ra rating tự động từ answerCorrect + responseTime (so với baseline
    //     CÁ NHÂN của chính thẻ này) + state/stability/difficulty hiện tại + answerChanges. Lấy
    //     lịch sử NGAY TRONG transaction (cùng client) để nhất quán với dòng đang khoá FOR UPDATE. ──
    const reviewHistory = await getRecentReviewHistoryForCard(userId, hz, l, 10, client, effectiveWordId);
    const systemRatingStr = getAutomaticFSRSRating({
      answerCorrect: !!answerCorrect,
      responseTimeMs: Number.isFinite(responseTimeMs) ? responseTimeMs : null,
      card: before, // có đủ state/stability/difficulty/reps/last_review dù là dòng mới tạo (state=0)
      reviewHistory,
      answerChanges: Number.isFinite(answerChanges) ? answerChanges : 0,
    });
    // Bổ sung "Highlight System Rating": vẫn LUÔN tính systemRatingStr ở trên (để lưu auto_rating
    // làm dữ liệu tham khảo) nhưng nếu có override hợp lệ từ client, dùng override làm rating THẬT
    // SỰ gửi vào ts-fsrs — "User Rating luôn thắng System Rating".
    const ratingStr = override || systemRatingStr;

    const now = new Date();
    // V69: desiredRetention theo user (bảng user_settings, xem lib/fsrs/reviewService.js) — nếu
    // không truyền vào (caller cũ / chưa có setting) thì lib/fsrs.js tự fallback DEFAULT_RETENTION.
    const { newCard } = fsrsReviewCard(beforeCard, ratingStr, now, desiredRetention, personalWeights);
    const row = cardToRow(newCard);
    // V76 (Yêu cầu 3 — optimistic locking): WHERE kèm version cũ, tăng version lên 1. SELECT...FOR
    // UPDATE ở trên đã khoá đúng dòng này nên về lý thuyết rowCount luôn = 1 ở đây; kiểm tra dù vậy
    // để KHÔNG BAO GIỜ có đường ghi đè mù (last-write-wins) nếu sau này có code khác lỡ update
    // fsrs_cards mà không qua hàm này / không giữ lock.
    const beforeVersion = Number(before.version) || 0;
    const updateResult = await client.query(
      `UPDATE fsrs_cards SET state=$1, due=$2, stability=$3, difficulty=$4, elapsed_days=$5,
         scheduled_days=$6, reps=$7, lapses=$8, last_review=$9, version=$10, updated_at=now(), word_id=$13
       WHERE id = $11 AND version = $12`,
      [row.state, row.due, row.stability, row.difficulty, row.elapsed_days, row.scheduled_days,
        row.reps, row.lapses, row.last_review, beforeVersion + 1, before.id, beforeVersion, effectiveWordId]
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
        userId, hz, l, answerCorrect, responseTimeMs, answerChanges, desiredRetention, idempotencyKey, ratingOverride, personalWeights,
        _retriesLeft: _retriesLeft - 1,
      });
    }
    try {
      await client.query(
        `INSERT INTO review_history
           (user_id, hz, l, rating, answer_correct, reviewed_at,
            previous_state, new_state, previous_due, new_due,
            previous_stability, new_stability, previous_difficulty, new_difficulty, scheduled_days,
            response_time_ms, answer_changes, auto_rating, elapsed_days, idempotency_key, word_id)
         VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9,$10, $11,$12,$13,$14, $15, $16,$17,$18, $19, $20, $21)`,
        [userId, hz, l, ratingStr, !!answerCorrect, now,
          before.state, row.state, before.due, row.due,
          before.stability, row.stability, before.difficulty, row.difficulty, row.scheduled_days,
          Number.isFinite(responseTimeMs) ? Math.round(responseTimeMs) : null,
          Number.isFinite(answerChanges) ? answerChanges : 0, systemRatingStr, row.elapsed_days,
          idempotencyKey || null, effectiveWordId]
      );
    } catch (insErr) {
      // FIX (Ưu tiên 6): 2 request TRÙNG idempotencyKey lọt qua được cả 2 tới đây (race hiếm gặp
      // giữa lúc SELECT dedupe ở trên và lúc INSERT) — unique index sẽ chặn 1 trong 2 ở tầng DB
      // (mã lỗi 23505). Coi như trùng lặp: rollback thao tác của request này, KHÔNG throw ra ngoài
      // như lỗi thật, để caller không hiểu nhầm là mất dữ liệu.
      if (insErr && insErr.code === '23505' && idempotencyKey) {
        await client.query('ROLLBACK');
        return reviewFsrsCard({ userId, hz, l, answerCorrect, responseTimeMs, answerChanges, desiredRetention, idempotencyKey, ratingOverride, personalWeights });
      }
      throw insErr;
    }
    await client.query('COMMIT');
    return {
      ok: true,
      card: { ...row, hz, l, version: beforeVersion + 1 },
      wasNew,
      rating: ratingStr,
      systemRating: systemRatingStr,
      debug: {
        answerCorrect: !!answerCorrect,
        responseTimeMs: Number.isFinite(responseTimeMs) ? responseTimeMs : null,
        answerChanges: Number.isFinite(answerChanges) ? answerChanges : 0,
        autoRating: systemRatingStr,
        finalRating: ratingStr,
        ratingOverridden: !!override,
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

// ── Bổ sung "Highlight System Rating": xem TRƯỚC gợi ý rating hệ thống sẽ tự suy ra cho lượt trả
//     lời này — CHỈ ĐỌC, không insert/update/khoá gì (không tạo fsrs_cards trống, không mở
//     transaction) để FE có thể hiện 4 nút Again/Hard/Good/Easy + highlight đúng nút hệ thống đề
//     xuất TRƯỚC khi thật sự commit lên FSRS. Dùng CHUNG đúng 1 hàm suy luận getAutomaticFSRSRating
//     với reviewFsrsCard — không viết lại logic ở 2 nơi rồi lệch nhau theo thời gian. ──
async function previewAutoRating({ userId, hz, l, answerCorrect, responseTimeMs, answerChanges }) {
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const sel = await client.query(
      'SELECT * FROM fsrs_cards WHERE user_id = $1 AND hz = $2 AND l = $3',
      [userId, hz, l]
    );
    // null = từ hoàn toàn mới, y hệt trạng thái "before" mà reviewFsrsCard thấy TRƯỚC KHI insert
    // dòng trống (getAutomaticFSRSRating tự coi !card là NEW card, xem lib/fsrs-auto-rating.js).
    const card = sel.rows.length ? sel.rows[0] : null;
    // V93: dùng word_id có sẵn trên card (nếu đã backfill) để lấy review history đầy đủ hơn; nếu
    // card chưa có / word_id chưa backfill, tự resolve từ hz (chỉ đọc, không ảnh hưởng gì).
    const wordId = (card && card.word_id != null) ? card.word_id : await resolveCanonicalWordId(client, hz);
    const reviewHistory = await getRecentReviewHistoryForCard(userId, hz, l, 10, client, wordId);
    return getAutomaticFSRSRating({
      answerCorrect: !!answerCorrect,
      responseTimeMs: Number.isFinite(responseTimeMs) ? responseTimeMs : null,
      card,
      reviewHistory,
      answerChanges: Number.isFinite(answerChanges) ? answerChanges : 0,
    });
  } finally {
    client.release();
  }
}

// ── [DEBUG — dev] Xem toàn bộ thẻ FSRS của 1 user trong phạm vi bài chỉ định (Phần 30) ──
// V93: JOIN vocab_words qua word_id (fallback hz+l, xem giải thích ở getDueFsrsCards) — công cụ
// debug thôi nhưng vẫn nên nhất quán với luồng chính để không hiện dữ liệu sai lệch khi debug.
async function getFsrsCardsDebug(userId, lessons) {
  const client = await getPool().connect();
  try {
    await ensureFsrsTables(client);
    const params = [userId];
    let where = 'f.user_id = $1';
    if (lessons && lessons.length) { params.push(lessons); where += ' AND f.l = ANY($2::int[])'; }
    const r = await client.query(
      `SELECT f.*, v.py, v.vi FROM fsrs_cards f
       JOIN vocab_words v ON (f.word_id IS NOT NULL AND v.id = f.word_id)
                          OR (f.word_id IS NULL AND v.hz = f.hz AND v.l = f.l)
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
// V93 (Phần 3 audit — identity ổn định): tra theo hz THÔI (đã là identity duy nhất sau migration),
// KHÔNG còn yêu cầu l phải khớp chính xác — client luôn nhận `l` từ chính server (getDueFsrsCards/
// getNewWordsByLessonOrder đều trả canonical l), nên trong điều kiện bình thường l gửi lên vốn đã
// đúng canonical; bỏ điều kiện AND l=$2 giúp hàm này còn ĐÚNG cả khi client gửi lên 1 `l` cũ/lệch
// (vd dữ liệu cache phía client từ trước khi migration) thay vì trả null oan và chặn nhầm cả lượt
// học. Vẫn nhận tham số `l` để không đổi chữ ký gọi ở nơi khác (Phần 11 — tương thích ngược).
async function getWordForAnswerCheck(hz, l) {
  const client = await getPool().connect();
  try {
    const r = await client.query(
      'SELECT hz, py, vi, l, tag, hanviet FROM vocab_words WHERE hz = $1 ORDER BY id ASC LIMIT 1',
      [hz]
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
  getVocabWordsByLesson, updateVocabWord, deleteVocabWord,
  removeVocabWordFromLesson, setVocabWordLessons, resolveCanonicalWordId, findVocabWordByHz, // V93 (audit thống nhất từ vựng)
  getAllVocabWords, updateVocabHanviet, getWordExampleCounts, insertWordExamples, getWordExamplesForLessons,
  getAllHanziParts, getHanziPartsKeys, insertHanziParts,
  insertActivityLog, getActivityLogs,
  reserveGeminiSlot, bumpGeminiRateLimit,
  countDueFsrsCards, getDueFsrsCards, getNewWordsByLessonOrder, countNewWordsInLessons,
  getTodayStudyCounts, getWeakFsrsCards, reviewFsrsCard, getFsrsCardsDebug,
  getRecentReviewHistoryForCard, getWordForAnswerCheck, previewAutoRating,
  vnDateKey, // V76: dùng chung cho reviewService.getStudySession() + api/index.js, tránh 2 nơi tự định nghĩa lệch nhau
};
