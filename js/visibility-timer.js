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
let vtHiddenSince = null; // performance.now() tại thời điểm BẮT ĐẦU vắng mặt hiện tại — null nếu đang có mặt
let vtHiddenTotalMs = 0;  // tổng cộng dồn thời gian đã vắng mặt KỂ TỪ lần vtMarkStart() gần nhất (có thể
                           // vắng/có mặt nhiều lần trong CÙNG 1 câu hỏi — vd bật rồi tắt app nhắn tin
                           // vài lần trước khi quay lại chọn đáp án — cộng dồn đủ từng đoạn)
// V112: "vắng mặt" gồm CẢ HAI trường hợp: (a) trình duyệt bị ẩn (đổi tab trình duyệt/khoá màn hình/chuyển app) và
// (b) người học sang MỘT TAB KHÁC TRONG APP (vd Thống kê) trong khi câu hỏi vẫn "treo" ở tab cũ. Trước đây chỉ có (a) nên
// thời gian ở tab khác bị tính vào responseTimeMs — làm sai tín hiệu "trả lời chậm" của bộ chọn thích ứng và gợi ý rating FSRS.
let vtStartAt = 0;       // performance.now() lúc vtMarkStart() — để nhận lại chủ sở hữu nếu tab đổi NGAY sau đó (xem vtSync)
const VT_REOWN_MS = 500;
let vtOwnerTab = null;    // tab (currentTab) đang sở hữu câu hỏi hiện tại; null = không theo dõi theo tab (chỉ theo visibility)

function vtIsAway() {
  if (typeof document !== 'undefined' && document.hidden) return true;
  return vtOwnerTab !== null && typeof currentTab !== 'undefined' && currentTab !== vtOwnerTab;
}

// Đồng bộ trạng thái vắng mặt với thực tế — idempotent, gọi bao nhiêu lần cũng được (render() gọi mỗi lần vẽ lại).
function vtSync() {
  // Câu hỏi có thể được chuẩn bị NGAY TRƯỚC khi tab được chuyển sang màn hiển thị nó (vd bấm chế độ luyện ở tab Hôm nay → gọi
  // vtMarkStart rồi mới goTab('skills')). Nếu tab đổi trong 500ms đầu thì coi tab mới là nơi hiển thị câu hỏi, không coi là "vắng".
  if (vtOwnerTab !== null && typeof currentTab !== 'undefined' && currentTab !== vtOwnerTab && vtHiddenSince === null
      && !(typeof document !== 'undefined' && document.hidden) && (performance.now() - vtStartAt) < VT_REOWN_MS) {
    vtOwnerTab = currentTab;
  }
  const away = vtIsAway();
  if (away && vtHiddenSince === null) vtHiddenSince = performance.now();
  else if (!away && vtHiddenSince !== null) { vtHiddenTotalMs += performance.now() - vtHiddenSince; vtHiddenSince = null; }
}

function vtMarkStart() {
  vtHiddenTotalMs = 0;
  vtHiddenSince = null;
  // Câu hỏi MỚI thuộc về tab đang hiển thị. Nếu đang vắng mặt ngay lúc này (vd câu hỏi được chuẩn bị ngầm khi app còn ở nền)
  // thì bắt đầu đếm vắng mặt luôn từ đây, không bỏ sót.
  vtOwnerTab = (typeof currentTab !== 'undefined') ? currentTab : null;
  vtStartAt = performance.now();
  vtSync();
}

function vtHiddenMs() {
  vtSync(); // chốt trạng thái hiện tại (phòng khi đổi tab mà chưa có lượt render nào)
  if (vtHiddenSince !== null) return vtHiddenTotalMs + (performance.now() - vtHiddenSince);
  return vtHiddenTotalMs;
}

document.addEventListener('visibilitychange', vtSync);
