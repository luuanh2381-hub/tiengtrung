#!/usr/bin/env node
// scripts/migrate-skill-evidence.js (V113) — thêm cột bằng chứng + backfill từ lịch sử THẬT. Idempotent, trong 1 transaction.
//   DATABASE_URL=... DRY_RUN=1 node scripts/migrate-skill-evidence.js   # chỉ báo số hàng sẽ cập nhật, không ghi
//   DATABASE_URL=... node scripts/migrate-skill-evidence.js
// Không đổi attempts/correct/w_* (điểm cũ giữ nguyên). Nội dung SQL = migrations/V113_skill_evidence.sql.
const fs = require('fs'), path = require('path');
const { Pool } = require('pg');
const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
(async () => {
  if (!process.env.DATABASE_URL) { console.error('Thiếu DATABASE_URL'); process.exit(1); }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'V113_skill_evidence.sql'), 'utf8');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    // Bảng nền phải có trước (ensureSkillTables cũng tạo các cột V113).
    await require('../lib/skill-store').ensureSkillTables(client);
    await client.query('BEGIN');
    const before = await client.query('SELECT COUNT(*)::int AS n FROM word_skill_stats WHERE active_days = 0 AND attempts > 0');
    await client.query(sql);
    const after = await client.query('SELECT COUNT(*)::int AS n FROM word_skill_stats WHERE active_days = 0 AND attempts > 0');
    console.log(`Hàng chưa biết số ngày: trước ${before.rows[0].n} → sau ${after.rows[0].n}`);
    if (DRY_RUN) { await client.query('ROLLBACK'); console.log('DRY_RUN: đã ROLLBACK, không ghi gì.'); }
    else { await client.query('COMMIT'); console.log('Đã COMMIT.'); }
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error('Lỗi, đã ROLLBACK:', e.message); process.exitCode = 1; }
  finally { client.release(); await pool.end(); }
})();
