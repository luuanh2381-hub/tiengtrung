#!/usr/bin/env node
// ════════════════════════════════════════════════════
// scripts/migrate-to-pure-fsrs.js  (V69)
//
// Mục tiêu (Phần 15 của audit):
//   - KHÔNG mất dữ liệu.
//   - Giữ nguyên lịch học (fsrs_cards/review_history không bị đổi/xoá).
//   - Tạo đầy đủ schema mới (user_settings, user_fsrs_weights, study_sessions) + index còn thiếu.
//   - Backfill user_settings = default 0.90 cho MỌI user đã tồn tại (để mọi user đều có 1 dòng
//     tường minh, thay vì luôn phải fallback ngầm — dễ audit/báo cáo hơn, và để sẵn cho UI cài đặt
//     hiển thị đúng giá trị hiện tại ngay cả trước khi user tự đổi).
//   - KHÔNG đụng vào progress.srs / progress.streak / progress.lastDate cũ trong app_store JSONB —
//     code đã ngừng đọc các field này (xem emptyProgress() trong api/index.js), để nguyên trong
//     JSONB không gây hại gì, xoá thủ công là tùy chọn (xem migrations/V69_pure_fsrs.sql mục 5).
//
// Chạy: DATABASE_URL=... node scripts/migrate-to-pure-fsrs.js
// An toàn chạy lại nhiều lần (idempotent) — dùng CREATE ... IF NOT EXISTS / ON CONFLICT DO NOTHING.
// ════════════════════════════════════════════════════
const { Pool } = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ Thiếu biến môi trường DATABASE_URL.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  try {
    console.log('════════════════════════════════════════════════════');
    console.log('V69 MIGRATION: chuẩn hóa kiến trúc FSRS production-ready');
    console.log('════════════════════════════════════════════════════\n');

    // ── Bước 0: kiểm tra dữ liệu hiện có TRƯỚC khi đổi gì — để in báo cáo "trước/sau" ──
    const before = await snapshot(client);
    console.log('── Trạng thái TRƯỚC migration ──');
    printSnapshot(before);

    // ── Bước 1: đảm bảo fsrs_cards/review_history có đủ index + cột mới (elapsed_days) ──
    console.log('\n[1/5] Đảm bảo fsrs_cards + review_history (schema hiện có, thêm cột/index còn thiếu)...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS fsrs_cards (
        id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, hz TEXT NOT NULL, l INT NOT NULL,
        state INT NOT NULL DEFAULT 0, due TIMESTAMPTZ NOT NULL DEFAULT now(),
        stability DOUBLE PRECISION NOT NULL DEFAULT 0, difficulty DOUBLE PRECISION NOT NULL DEFAULT 0,
        elapsed_days DOUBLE PRECISION NOT NULL DEFAULT 0, scheduled_days DOUBLE PRECISION NOT NULL DEFAULT 0,
        reps INT NOT NULL DEFAULT 0, lapses INT NOT NULL DEFAULT 0, last_review TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS fsrs_cards_user_hz_l_idx ON fsrs_cards (user_id, hz, l)`);
    await client.query(`CREATE INDEX IF NOT EXISTS fsrs_cards_user_due_idx ON fsrs_cards (user_id, due)`);
    await client.query(`CREATE INDEX IF NOT EXISTS fsrs_cards_user_l_idx ON fsrs_cards (user_id, l)`);
    await client.query(`CREATE INDEX IF NOT EXISTS fsrs_cards_user_state_idx ON fsrs_cards (user_id, state)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS review_history (
        id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, hz TEXT NOT NULL, l INT NOT NULL,
        rating TEXT NOT NULL, answer_correct BOOLEAN NOT NULL, reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        previous_state INT, new_state INT, previous_due TIMESTAMPTZ, new_due TIMESTAMPTZ,
        previous_stability DOUBLE PRECISION, new_stability DOUBLE PRECISION,
        previous_difficulty DOUBLE PRECISION, new_difficulty DOUBLE PRECISION, scheduled_days DOUBLE PRECISION
      )`);
    await client.query(`ALTER TABLE review_history ADD COLUMN IF NOT EXISTS response_time_ms INT`);
    await client.query(`ALTER TABLE review_history ADD COLUMN IF NOT EXISTS answer_changes INT NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE review_history ADD COLUMN IF NOT EXISTS auto_rating TEXT`);
    await client.query(`ALTER TABLE review_history ADD COLUMN IF NOT EXISTS elapsed_days DOUBLE PRECISION`);
    await client.query(`CREATE INDEX IF NOT EXISTS review_history_user_time_idx ON review_history (user_id, reviewed_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS review_history_card_idx ON review_history (user_id, hz, l, reviewed_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS review_history_user_prevstate_idx ON review_history (user_id, previous_state)`);
    console.log('    ✅ OK (không có dữ liệu nào bị xoá/đổi — chỉ thêm cột/index nếu thiếu)');

    // ── Bước 2: user_settings ──
    console.log('\n[2/5] Tạo bảng user_settings (Desired Retention theo user)...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        desired_retention DOUBLE PRECISION NOT NULL DEFAULT 0.90
          CHECK (desired_retention IN (0.80, 0.85, 0.90, 0.95)),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    console.log('    ✅ OK');

    // ── Bước 3: user_fsrs_weights ──
    console.log('\n[3/5] Tạo bảng user_fsrs_weights (Personal Weights — chuẩn bị cho Optimizer)...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_fsrs_weights (
        user_id TEXT PRIMARY KEY, weights DOUBLE PRECISION[] NOT NULL,
        trained_at TIMESTAMPTZ NOT NULL DEFAULT now(), review_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    console.log('    ✅ OK (chưa insert gì — chưa có user nào được train riêng, đúng thiết kế "chưa cần train tự động")');

    // ── Bước 4: study_sessions ──
    console.log('\n[4/5] Tạo bảng study_sessions (Study Session Tracker / Dashboard / Streak / Heatmap)...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS study_sessions (
        id SERIAL PRIMARY KEY, user_id TEXT NOT NULL,
        start_time TIMESTAMPTZ NOT NULL, end_time TIMESTAMPTZ NOT NULL,
        duration_seconds INT NOT NULL DEFAULT 0, cards_reviewed INT NOT NULL DEFAULT 0,
        correct_count INT NOT NULL DEFAULT 0, wrong_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS study_sessions_user_start_idx ON study_sessions (user_id, start_time)`);
    await client.query(`CREATE INDEX IF NOT EXISTS study_sessions_user_end_idx ON study_sessions (user_id, end_time DESC)`);
    console.log('    ✅ OK (bảng mới, rỗng — dashboard/streak sẽ bắt đầu tính từ lượt review kế tiếp trở đi;');
    console.log('       KHÔNG thể suy ngược "thời gian học" từ review_history cũ vì trước V69 không ghi start/end).');

    // ── Bước 5: backfill user_settings cho user đã tồn tại (đọc từ app_store JSONB) ──
    console.log('\n[5/5] Backfill user_settings = 0.90 (default) cho toàn bộ user đã tồn tại...');
    const appStoreRes = await client.query('SELECT data FROM app_store WHERE id = 1');
    const users = (appStoreRes.rows[0] && appStoreRes.rows[0].data && appStoreRes.rows[0].data.users) || {};
    const userIds = Object.keys(users);
    let inserted = 0;
    for (const userId of userIds) {
      const r = await client.query(
        `INSERT INTO user_settings (user_id, desired_retention) VALUES ($1, 0.90)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );
      inserted += r.rowCount;
    }
    console.log(`    ✅ OK (${inserted}/${userIds.length} user mới được gán default 0.90; số còn lại đã có sẵn setting)`);

    const after = await snapshot(client);
    console.log('\n── Trạng thái SAU migration ──');
    printSnapshot(after);

    console.log('\n════════════════════════════════════════════════════');
    console.log('✅ MIGRATION HOÀN TẤT — không có dữ liệu FSRS nào bị xoá/ghi đè.');
    console.log('   Lưu ý: progress.srs/progress.streak/progress.lastDate (legacy, trong app_store');
    console.log('   JSONB) vẫn còn nguyên trong DB nhưng KHÔNG còn được code đọc/ghi — an toàn để lại,');
    console.log('   xem migrations/V69_pure_fsrs.sql mục 5 nếu muốn dọn dẹp thủ công (tùy chọn).');
    console.log('════════════════════════════════════════════════════');
  } catch (e) {
    console.error('\n❌ MIGRATION LỖI:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

async function snapshot(client) {
  const tables = ['fsrs_cards', 'review_history', 'user_settings', 'user_fsrs_weights', 'study_sessions'];
  const counts = {};
  for (const t of tables) {
    try {
      const r = await client.query(`SELECT COUNT(*)::int AS c FROM ${t}`);
      counts[t] = r.rows[0].c;
    } catch (e) {
      counts[t] = 'chưa tồn tại';
    }
  }
  return counts;
}
function printSnapshot(s) {
  for (const [table, count] of Object.entries(s)) {
    console.log(`  ${table.padEnd(20)} : ${count}`);
  }
}

main();
