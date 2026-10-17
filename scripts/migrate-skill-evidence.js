#!/usr/bin/env node
// scripts/migrate-skill-evidence.js (V113, sửa ở V114) — thêm cột bằng chứng + backfill từ lịch sử THẬT. Idempotent.
//   DATABASE_URL=... DRY_RUN=1 node scripts/migrate-skill-evidence.js   # (hoặc --dry-run) chạy THẬT mọi bước trong 1 transaction rồi ROLLBACK
//   DATABASE_URL=... node scripts/migrate-skill-evidence.js             # chạy thật: mọi bước trong 1 transaction rồi COMMIT
//
// V114 — SỬA QUY TRÌNH. Trước đây ensureSkillTables(client) chạy TRƯỚC `BEGIN`, tức mọi DDL của nó (và của ensureVocabTable/ensureFsrsTables
// mà nó gọi: CREATE TABLE/INDEX, ALTER ... ADD COLUMN, DROP/ADD CONSTRAINT, và 2 bước nạp dữ liệu vocab_words/vocab_lessons) được AUTOCOMMIT ngay
// cả khi DRY_RUN=1 → thông báo "đã ROLLBACK, không ghi gì" là SAI. Các lệnh đó đều là DDL/DML thường của PostgreSQL (không có CONCURRENTLY)
// nên chạy được TRONG transaction và hoàn tác được. Giờ toàn bộ (kiểm tra → ensure* → SQL V113) nằm trong CÙNG 1 transaction:
//   • DRY_RUN : thực thi đầy đủ rồi ROLLBACK → CSDL không còn thay đổi nào (xem "Giới hạn" bên dưới).
//   • Chạy thật: lỗi ở bất kỳ bước nào → ROLLBACK toàn bộ (không còn trạng thái nửa vời); thành công → COMMIT một lần.
//
// GIỚI HẠN (nói thẳng, không hứa quá mức):
//   1) ALTER TABLE giữ khoá ACCESS EXCLUSIVE tới khi transaction kết thúc → chạy DRY_RUN trên DB đang có người dùng vẫn có thể làm họ chờ trong
//      lúc script chạy. Script đặt lock_timeout (mặc định 10s, đổi bằng LOCK_TIMEOUT_MS) để thà lỗi còn hơn chặn lâu. Nên chạy trên Neon staging/branch.
//   2) ROLLBACK hoàn tác bảng/cột/chỉ mục/dữ liệu nhưng KHÔNG hoàn tác giá trị sequence đã tiêu thụ (đặc tính của PostgreSQL) và vẫn có ghi WAL/thống kê.
//      Vì vậy thông báo nói "không để lại thay đổi nào", KHÔNG nói "không ghi gì".
//   3) Các bộ nhớ đệm trong tiến trình (skillTablesReady...) sẽ nhớ "đã sẵn sàng" dù transaction bị ROLLBACK — vô hại vì script thoát ngay sau đó.
//   4) ensureVocabTable có nhánh nạp từ bảng cũ app_store khi vocab_words trống; trong transaction, lỗi "bảng không tồn tại" của nhánh đó sẽ làm hỏng
//      cả transaction. Vì vậy script TỪ CHỐI chạy (và ROLLBACK, chưa đổi gì) nếu vocab_words chưa có/đang trống.
// Không đổi attempts/correct/w_* (điểm cũ giữ nguyên) và KHÔNG xoá/sửa review_history/skill_practice_log. Nội dung SQL = migrations/V113_skill_evidence.sql.
const fs = require('fs'), path = require('path');
const { Pool } = require('pg');
const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
const LOCK_TIMEOUT_MS = Math.max(1000, parseInt(process.env.LOCK_TIMEOUT_MS, 10) || 10000);
const TABLES = ['vocab_words', 'vocab_lessons', 'fsrs_cards', 'review_history', 'word_skill_stats', 'skill_practice_log'];

// Ảnh chụp cấu trúc (bảng/cột/chỉ mục) của các bảng liên quan — chỉ ĐỌC, dùng để báo cáo ensure* sẽ thêm gì.
async function schemaSnapshot(client) {
  const r = await client.query(
    `SELECT 'bảng' AS kind, table_name::text AS name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
     UNION ALL
     SELECT 'cột', table_name::text || '.' || column_name::text FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
     UNION ALL
     SELECT 'chỉ mục', tablename::text || '.' || indexname::text FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = ANY($1::text[])`,
    [TABLES]
  );
  return new Set(r.rows.map(x => x.kind + ' ' + x.name));
}
async function countOf(client, table) {
  const ex = await client.query('SELECT to_regclass($1) AS t', [table]);
  if (!ex.rows[0].t) return null;
  const r = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`); // tên bảng cố định trong mã, không lấy từ đầu vào
  return r.rows[0].n;
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Thiếu DATABASE_URL'); process.exit(1); }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'V113_skill_evidence.sql'), 'utf8');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  let began = false;
  try {
    console.log(DRY_RUN
      ? 'DRY_RUN: sẽ chạy THẬT mọi bước (kể cả đổi cấu trúc bảng) trong 1 transaction rồi ROLLBACK. Lưu ý khoá bảng — nên chạy trên staging/branch.'
      : 'Chạy thật: mọi bước nằm trong 1 transaction; lỗi → ROLLBACK toàn bộ, thành công → COMMIT.');
    await client.query('BEGIN'); began = true;
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`); // số nguyên đã ép kiểu ở trên

    // 0) Kiểm tra điều kiện trước khi đổi bất cứ thứ gì (xem GIỚI HẠN 4).
    const vocabN = await countOf(client, 'vocab_words');
    if (!vocabN) throw new Error('vocab_words chưa có hoặc đang trống — không thể chạy migration an toàn trong transaction. Hãy chạy ứng dụng/nhập từ vựng trước (hoặc dùng bản sao dữ liệu thật), rồi chạy lại. Chưa thay đổi gì.');
    const linksBefore = await countOf(client, 'vocab_lessons');

    // 1) Chụp cấu trúc → 2) ensure* (DDL + 2 bước nạp dữ liệu của ensureVocabTable) TRONG transaction → 3) so sánh.
    const snapBefore = await schemaSnapshot(client);
    await require('../lib/skill-store').ensureSkillTables(client);
    const snapAfter = await schemaSnapshot(client);
    const added = [...snapAfter].filter(x => !snapBefore.has(x)).sort();
    const linksAfter = await countOf(client, 'vocab_lessons');
    console.log(added.length ? `ensureSkillTables sẽ THÊM ${added.length} mục cấu trúc:\n  + ` + added.join('\n  + ') : 'ensureSkillTables: cấu trúc đã đầy đủ, không thêm mục nào.');
    if (linksBefore !== linksAfter) console.log(`vocab_lessons: ${linksBefore} → ${linksAfter} dòng (bước nạp liên kết bài học của ensureVocabTable).`);
    console.log('Lưu ý: ensureSkillTables luôn DROP rồi ADD lại ràng buộc word_skill_stats_skill_check (cùng tên) — việc này không hiện trong danh sách trên.');

    // 4) SQL V113 (thêm cột idempotent + backfill bằng chứng; không đổi attempts/correct/w_*).
    const before = await client.query('SELECT COUNT(*)::int AS n FROM word_skill_stats WHERE active_days = 0 AND attempts > 0');
    await client.query(sql);
    const after = await client.query('SELECT COUNT(*)::int AS n FROM word_skill_stats WHERE active_days = 0 AND attempts > 0');
    console.log(`Hàng chưa biết số ngày: trước ${before.rows[0].n} → sau ${after.rows[0].n}`);

    if (DRY_RUN) {
      await client.query('ROLLBACK'); began = false;
      console.log('DRY_RUN: đã ROLLBACK — cấu trúc và dữ liệu được hoàn tác, KHÔNG để lại thay đổi nào. (Sequence đã tiêu thụ và WAL/thống kê không hoàn tác được.)');
    } else {
      await client.query('COMMIT'); began = false;
      console.log('Đã COMMIT.');
    }
  } catch (e) {
    if (began) await client.query('ROLLBACK').catch(() => {});
    console.error('Lỗi, đã ROLLBACK toàn bộ (không để lại thay đổi nào):', e.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
})();
