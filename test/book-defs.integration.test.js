#!/usr/bin/env node
// ════════════════════════════════════════════════════
// test/book-defs.integration.test.js  (V102)
//
// Cover tính năng "tự khai báo giáo trình/Quyển trên web, không cần sửa code" (yêu cầu người dùng):
//   - createBookDef/updateBookDef/deleteBookDef (lib/db.js): validate input, chặn trùng khoảng bài
//     với 1 Quyển TỰ THÊM khác đã có, cache getBookDefs() tự invalidate đúng lúc.
//   - getEffectiveBookRanges (lib/fsrs/studyScope.js): GỘP đúng BOOKS_RANGES (hardcoded) + book_defs
//     (id đã +3000) — không được thiếu, không được lẫn id.
//
// CẦN Postgres thật (DATABASE_URL) — tự SKIP an toàn (exit 0) nếu chưa cấu hình, đúng convention
// test/vocab-identity.integration.test.js. Dữ liệu test dùng tiền tố tên __itest102_ + khoảng bài
// riêng (999201+, không đụng BOOKS_RANGES hay các test khác), tự dọn dẹp trước và sau.
//
// Chạy: DATABASE_URL=postgres://... node test/book-defs.integration.test.js
// ════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');

const NAME_PREFIX = '__itest102_';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('⏭️  SKIP: chưa cấu hình DATABASE_URL — test này cần Postgres thật.');
    console.log('   Chạy lại với: DATABASE_URL=postgres://... node test/book-defs.integration.test.js');
    return;
  }

  const db = require(path.join(__dirname, '..', 'lib', 'db'));
  const studyScope = require(path.join(__dirname, '..', 'lib', 'fsrs', 'studyScope'));
  const pool = db.getPool();

  console.log('════════════════════════════════════════════════════');
  console.log('V102 — tự khai báo giáo trình/Quyển: integration test (cần Postgres thật)');
  console.log('════════════════════════════════════════════════════');

  async function cleanup() {
    await pool.query('DELETE FROM book_defs WHERE name LIKE $1', [NAME_PREFIX + '%']);
  }

  let passed = 0, failed = 0;
  async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
  }

  await cleanup(); // dọn rác từ lần chạy trước bị ngắt giữa chừng (nếu có)

  try {
    let createdId; // id GỐC trong book_defs (chưa +3000)

    console.log('\n[Case 1 — Thêm 1 Quyển tự khai báo hợp lệ]');
    await test('createBookDef với khoảng bài trống (999201-999205) -> thành công', async () => {
      const def = await db.createBookDef({ name: NAME_PREFIX + 'Quyển X', groupName: '🆕 Giáo trình tự thêm', lessonFrom: 999201, lessonTo: 999205 });
      assert.ok(def.id, 'phải trả về id');
      assert.strictEqual(def.lesson_from, 999201);
      assert.strictEqual(def.lesson_to, 999205);
      createdId = def.id;
    });

    console.log('\n[Case 2 — Validate input]');
    await test('tên rỗng -> bị từ chối, KHÔNG tạo được', async () => {
      await assert.rejects(
        db.createBookDef({ name: '  ', groupName: 'x', lessonFrom: 999210, lessonTo: 999212 }),
        /tên hiển thị/i
      );
    });
    await test('từ bài > đến bài -> bị từ chối', async () => {
      await assert.rejects(
        db.createBookDef({ name: NAME_PREFIX + 'Sai khoảng', groupName: 'x', lessonFrom: 999220, lessonTo: 999210 }),
        /không hợp lệ/i
      );
    });

    console.log('\n[Case 3 — Chặn trùng khoảng bài với 1 Quyển tự thêm khác]');
    await test('khoảng bài đụng 1 phần (999203-999208, Quyển X đang 999201-999205) -> bị từ chối', async () => {
      await assert.rejects(
        db.createBookDef({ name: NAME_PREFIX + 'Quyển Y', groupName: 'x', lessonFrom: 999203, lessonTo: 999208 }),
        /trùng với/i
      );
    });
    await test('khoảng bài liền kề, KHÔNG đụng (999206-999208) -> vẫn tạo được bình thường', async () => {
      const def = await db.createBookDef({ name: NAME_PREFIX + 'Quyển Y', groupName: 'x', lessonFrom: 999206, lessonTo: 999208 });
      assert.ok(def.id);
      await db.deleteBookDef(def.id); // dọn ngay, chỉ cần verify tạo được
    });

    console.log('\n[Case 4 — Cache getBookDefs() tự invalidate đúng lúc]');
    await test('sau khi tạo, getBookDefs() (không đợi TTL) phải thấy NGAY Quyển vừa tạo', async () => {
      const defs = await db.getBookDefs();
      assert.ok(defs.some(d => d.id === createdId), 'getBookDefs() phải trả về Quyển vừa tạo ngay lập tức, không phải đợi cache hết hạn');
    });

    console.log('\n[Case 5 — getEffectiveBookRanges() gộp đúng hardcoded + tự khai báo]');
    await test('danh sách gộp phải có ĐỦ BOOKS_RANGES (hardcoded) + Quyển X (id + 3000)', async () => {
      const ranges = await studyScope.getEffectiveBookRanges();
      for (const b of studyScope.BOOKS_RANGES) {
        assert.ok(ranges.some(r => r.id === b.id && r.from === b.from && r.to === b.to), `thiếu Quyển hardcoded id=${b.id}`);
      }
      const custom = ranges.find(r => r.id === 3000 + createdId);
      assert.ok(custom, 'phải có Quyển X với id = 3000 + id gốc trong book_defs');
      assert.strictEqual(custom.from, 999201);
      assert.strictEqual(custom.to, 999205);
    });

    console.log('\n[Case 6 — Sửa 1 Quyển tự khai báo]');
    await test('updateBookDef đổi tên + khoảng bài -> lưu đúng, KHÔNG tạo dòng mới', async () => {
      const before = await pool.query('SELECT COUNT(*)::int AS c FROM book_defs WHERE name LIKE $1', [NAME_PREFIX + '%']);
      const updated = await db.updateBookDef(createdId, { name: NAME_PREFIX + 'Quyển X (đã sửa)', groupName: '📗 Giáo trình cơ bản', lessonFrom: 999201, lessonTo: 999206 });
      assert.strictEqual(updated.name, NAME_PREFIX + 'Quyển X (đã sửa)');
      assert.strictEqual(updated.lesson_to, 999206);
      const after = await pool.query('SELECT COUNT(*)::int AS c FROM book_defs WHERE name LIKE $1', [NAME_PREFIX + '%']);
      assert.strictEqual(after.rows[0].c, before.rows[0].c, 'sửa KHÔNG được tạo thêm dòng mới');
    });
    await test('updateBookDef với khoảng bài trùng chính nó (không đổi từ/đến) -> vẫn lưu được (không tự chặn với chính mình)', async () => {
      const updated = await db.updateBookDef(createdId, { name: NAME_PREFIX + 'Quyển X (đã sửa)', groupName: '📗 Giáo trình cơ bản', lessonFrom: 999201, lessonTo: 999206 });
      assert.strictEqual(updated.lesson_from, 999201);
    });

    console.log('\n[Case 7 — Xoá 1 Quyển tự khai báo]');
    await test('deleteBookDef -> getBookDefs() không còn thấy nữa, getEffectiveBookRanges() cũng vậy', async () => {
      const ok = await db.deleteBookDef(createdId);
      assert.strictEqual(ok, true);
      const defs = await db.getBookDefs();
      assert.ok(!defs.some(d => d.id === createdId), 'phải biến mất khỏi getBookDefs() ngay lập tức');
      const ranges = await studyScope.getEffectiveBookRanges();
      assert.ok(!ranges.some(r => r.id === 3000 + createdId), 'phải biến mất khỏi getEffectiveBookRanges() ngay lập tức');
    });
    await test('deleteBookDef lần 2 (đã xoá rồi) -> trả về false, không throw', async () => {
      const ok = await db.deleteBookDef(createdId);
      assert.strictEqual(ok, false);
    });

    console.log('\n════════════════════════════════════════════════════');
    console.log(`Kết quả: ${passed} PASS, ${failed} FAIL`);
    console.log('════════════════════════════════════════════════════');
    if (failed > 0) process.exitCode = 1;
  } finally {
    await cleanup();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('❌ Integration test lỗi ngoài dự kiến:', e && e.message);
  process.exitCode = 1;
});
