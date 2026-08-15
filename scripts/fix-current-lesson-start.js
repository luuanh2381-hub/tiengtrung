#!/usr/bin/env node
// ════════════════════════════════════════════════════
// scripts/fix-current-lesson-start.js
//
// Sửa hậu quả của bug: resolveCurrentLesson() (api/index.js) trước đây fallback về
// Math.max(...scopeLessons) — mọi user CHƯA từng có progress.ui.currentLesson (VD tài khoản mới
// đăng ký) hoặc vừa đổi phạm vi Quyển/bài khiến currentLesson cũ rơi ra ngoài phạm vi mới, đều bị
// "khoá" vào bài SỐ LỚN NHẤT trong phạm vi đang chọn — từ mới chỉ được giới thiệu ở đúng 1 bài
// (bài cuối/"mới nhất") thay vì trải đều từ bài đầu tiên. Code đã sửa dùng Math.min; script này chỉ
// XOÁ currentLesson đang lưu (nếu có) để lần load session tiếp theo TỰ TÍNH LẠI bằng logic đã sửa.
//
// KHÔNG đụng fsrs_cards/review_history — không mất bất kỳ tiến độ/lịch ôn nào đã có. Chỉ reset 1
// con trỏ UI (progress.ui.currentLesson) để nó tự tính lại đúng ở lần vào tab học kế tiếp.
//
// Chạy: DATABASE_URL=... node scripts/fix-current-lesson-start.js
// An toàn chạy lại nhiều lần (idempotent).
// ════════════════════════════════════════════════════
const { updateDB, readDB } = require('../lib/db');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ Thiếu biến môi trường DATABASE_URL.');
    process.exit(1);
  }

  const before = await readDB();
  const usernames = Object.keys(before.users || {});
  const affected = usernames.filter(u => {
    const cl = before.users[u].progress && before.users[u].progress.ui && before.users[u].progress.ui.currentLesson;
    return Number.isFinite(cl);
  });

  console.log(`Tổng số user: ${usernames.length}`);
  console.log(`User đang có currentLesson đã lưu (sẽ reset để tự tính lại): ${affected.length}`);
  if (affected.length) console.log('  →', affected.join(', '));

  if (!affected.length) {
    console.log('\nKhông có gì để sửa.');
    return;
  }

  await updateDB((db) => {
    for (const u of affected) {
      if (db.users[u] && db.users[u].progress && db.users[u].progress.ui) {
        delete db.users[u].progress.ui.currentLesson;
      }
    }
  });

  console.log('\n✅ Đã reset currentLesson cho', affected.length, 'user. Lần vào tab học kế tiếp của mỗi user sẽ tự tính lại từ bài đầu tiên trong phạm vi đang chọn.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('❌ Lỗi migration:', e); process.exit(1); });
