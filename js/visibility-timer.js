// js/visibility-timer.js — "review nhiễu khi thoát ra vào lại": performance.now() vẫn chạy đều
// ngay cả khi tab bị ẩn (chuyển app khác / khoá màn hình / về Home mà KHÔNG đóng hẳn tab) — nếu chỉ
// lấy hiệu số performance.now() thô, thời gian "vắng mặt" (có thể vài phút, vài giờ) bị tính luôn
// vào responseTimeMs, khiến hệ thống tưởng user trả lời cực chậm và tự chấm "Hard" oan dù đáp án
// đúng (xem lib/fsrs-auto-rating.js). Dùng CHUNG đúng 1 bộ đếm cho cả 5 màn hình luyện tập (Hôm nay
// học/Flashcard/Trắc nghiệm/Gõ chữ/Nghe-chọn) — mỗi màn hình tự có 1 biến "xxStartedAt" riêng
// (rvStartedAt/fcStartedAt/qzStartedAt/lsStartedAt/tyStartedAt), nhưng CHỈ 1 câu hỏi hiển thị tại
// 1 thời điểm nên dùng chung 1 bộ đếm ẩn là đủ, không cần tách riêng theo từng tab.
//
// Cách dùng (ở đúng chỗ đang gán "xxStartedAt = performance.now()"):
//   rvStartedAt = performance.now();
//   vtMarkStart(); // reset bộ đếm ẩn cho câu hỏi MỚI này
// Lúc tính responseTimeMs (đang có "performance.now() - xxStartedAt"):
//   const responseTimeMs = Math.max(0, Math.round(performance.now() - rvStartedAt - vtHiddenMs()));
// ════════════════════════════════════════════════════
let vtHiddenSince = null; // performance.now() tại thời điểm BẮT ĐẦU ẩn hiện tại — null nếu đang hiện
let vtHiddenTotalMs = 0;  // tổng cộng dồn thời gian đã ẩn KỂ TỪ lần vtMarkStart() gần nhất (có thể
                           // ẩn/hiện nhiều lần trong CÙNG 1 câu hỏi — vd bật rồi tắt app nhắn tin
                           // vài lần trước khi quay lại chọn đáp án — cộng dồn đủ từng đoạn)

function vtMarkStart() {
  vtHiddenTotalMs = 0;
  // Phòng trường hợp hiếm: gọi vtMarkStart() ngay đúng lúc tab ĐANG ẩn (vd câu hỏi mới được chuẩn
  // bị ngầm trong lúc app còn ở nền) — coi như bắt đầu đếm ẩn luôn từ đây, không bỏ sót.
  vtHiddenSince = document.hidden ? performance.now() : null;
}

function vtHiddenMs() {
  if (vtHiddenSince !== null) return vtHiddenTotalMs + (performance.now() - vtHiddenSince);
  return vtHiddenTotalMs;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (vtHiddenSince === null) vtHiddenSince = performance.now();
  } else if (vtHiddenSince !== null) {
    vtHiddenTotalMs += performance.now() - vtHiddenSince;
    vtHiddenSince = null;
  }
});
