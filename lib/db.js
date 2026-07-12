// ════════════════════════════════════════════════════
// LỚP LƯU TRỮ DỮ LIỆU — dùng Postgres thay cho file JSON
// Lý do đổi: Vercel chạy serverless, ổ đĩa không lưu được lâu dài
// (mỗi lần deploy hoặc "ngủ" là mất hết dữ liệu file). Postgres thì
// dữ liệu tồn tại độc lập với server, không bị mất.
//
// Dữ liệu được chia làm 2 dòng riêng trong cùng 1 bảng:
//   id=1 → tài khoản, token, lượt truy cập (nhỏ, đọc/ghi liên tục)
//   id=2 → từ vựng (có thể rất lớn — hàng nghìn từ, ít khi ghi)
// Tách riêng để việc thêm nhiều từ vựng không làm chậm các thao tác
// đăng nhập / lưu tiến độ của người dùng (vì mỗi thao tác đó không cần
// đụng tới toàn bộ danh sách từ vựng nữa).
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
    // Tạo dòng riêng cho từ vựng nếu chưa có — kèm di chuyển 1 lần duy nhất
    // dữ liệu từ vựng cũ (nếu app từng lưu chung ở dòng id=1 từ bản trước).
    const existing = await client.query('SELECT 1 FROM app_store WHERE id = 2');
    if (existing.rows.length === 0) {
      const main = await client.query('SELECT data FROM app_store WHERE id = 1');
      const legacyVocab = (main.rows[0] && Array.isArray(main.rows[0].data.vocab)) ? main.rows[0].data.vocab : [];
      await client.query(
        `INSERT INTO app_store (id, data) VALUES (2, $1::jsonb) ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify({ vocab: legacyVocab })]
      );
      if (legacyVocab.length && main.rows[0]) {
        const cleaned = { ...main.rows[0].data };
        delete cleaned.vocab;
        await client.query('UPDATE app_store SET data = $1::jsonb WHERE id = 1', [JSON.stringify(cleaned)]);
      }
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

// Đọc danh sách từ vựng (dòng riêng id=2), không khoá
async function readVocab() {
  const client = await getPool().connect();
  try {
    await ensureTable(client);
    const r = await client.query('SELECT data FROM app_store WHERE id = 2');
    return (r.rows[0] && Array.isArray(r.rows[0].data.vocab)) ? r.rows[0].data.vocab : [];
  } finally {
    client.release();
  }
}

// Đọc + sửa + ghi từ vựng trong 1 transaction có khoá dòng riêng (không đụng tới dòng tài khoản)
async function updateVocab(mutateFn) {
  const client = await getPool().connect();
  try {
    await ensureTable(client);
    await client.query('BEGIN');
    const r = await client.query('SELECT data FROM app_store WHERE id = 2 FOR UPDATE');
    const vocab = (r.rows[0] && Array.isArray(r.rows[0].data.vocab)) ? r.rows[0].data.vocab : [];
    const result = await mutateFn(vocab);
    await client.query('UPDATE app_store SET data = $1::jsonb WHERE id = 2', [JSON.stringify({ vocab })]);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { readDB, updateDB, readVocab, updateVocab, emptyDB };
