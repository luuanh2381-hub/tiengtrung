// ════════════════════════════════════════════════════
// LỚP LƯU TRỮ DỮ LIỆU — dùng Postgres thay cho file JSON
// Lý do đổi: Vercel chạy serverless, ổ đĩa không lưu được lâu dài
// (mỗi lần deploy hoặc "ngủ" là mất hết dữ liệu file). Postgres thì
// dữ liệu tồn tại độc lập với server, không bị mất.
//
// Toàn bộ dữ liệu app (users, tokens, visits) vẫn được lưu dưới dạng
// MỘT object JSON duy nhất — y hệt cấu trúc file db.json cũ — chỉ khác
// là object đó nằm trong 1 dòng của bảng Postgres thay vì 1 file.
// Nhờ vậy toàn bộ logic ở server.js hầu như giữ nguyên, chỉ đổi cách
// đọc/ghi.
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
  return { users: {}, tokens: {}, visits: { total: 0, byDate: {} }, vocab: [] };
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
  if (!Array.isArray(db.vocab)) db.vocab = [];
  return db;
}

// Đọc dữ liệu, không khoá — dùng cho các thao tác chỉ đọc
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

// Đọc + sửa + ghi trong 1 transaction có khoá dòng (FOR UPDATE),
// đảm bảo 2 request cùng lúc không ghi đè mất dữ liệu của nhau
// (tương đương writeQueue tuần tự trong bản file JSON cũ, nhưng an toàn
// hơn cho môi trường serverless nhiều instance chạy song song).
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

module.exports = { readDB, updateDB, emptyDB };
