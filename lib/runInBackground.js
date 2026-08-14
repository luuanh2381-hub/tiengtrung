// ════════════════════════════════════════════════════
// lib/runInBackground.js — chạy 1 việc KHÔNG BẮT USER CHỜ (V72 audit hiệu năng).
//
// Vì sao cần: trên Vercel serverless, function có thể bị "đóng băng" NGAY SAU KHI response đã
// gửi xong — khác hẳn 1 server sống liên tục (nơi 1 promise "quên await" vẫn cứ chạy tiếp bình
// thường trên event loop). Nếu chỉ đơn giản bỏ `await` cho 1 việc phụ (vd ghi log thống kê), việc
// đó có thể KHÔNG BAO GIỜ chạy xong vì runtime đóng function trước khi promise kịp resolve.
//
// `waitUntil` (package chính thức "@vercel/functions") là cách ĐÚNG để nói với runtime: "đợi
// promise này chạy xong rồi mới đóng function, nhưng ĐỪNG delay response gửi cho user". Đây
// chính là cơ chế giúp tách các việc KHÔNG ảnh hưởng tới câu trả lời (ghi study_sessions, cập
// nhật currentLesson...) ra khỏi đường găng (critical path) mà user phải chờ mỗi lần bấm 1 đáp án.
//
// Bọc try/catch phòng trường hợp code chạy NGOÀI môi trường Vercel Functions thật (vd script
// `npm run dev` ở package.json hiện đang chạy thẳng `node api/index.js`, không qua Vercel runtime,
// nên waitUntil có thể không có request context để bám vào và ném lỗi). Khi đó fallback là để
// promise tự chạy nền — vẫn AN TOÀN vì tiến trình `node api/index.js` chạy local sống liên tục,
// không bị đóng băng như serverless thật, nên promise vẫn chạy xong bình thường.
//
// LƯU Ý QUAN TRỌNG (đã nêu rõ, không giấu): waitUntil là "best-effort" — nếu cả function timeout
// (maxDuration) hoặc runtime bị thu hồi bất thường, việc chạy nền CÓ THỂ không kịp hoàn thành. Vì
// vậy hàm này CHỈ nên dùng cho việc KHÔNG ảnh hưởng tới tính đúng của response đã gửi (thống kê,
// đếm streak, currentLesson hiển thị) — KHÔNG dùng cho việc bắt buộc phải chắc chắn ghi được (vd
// chính bản thân điểm FSRS/due/stability của thẻ vẫn phải `await` trong đường chính như cũ).
// ════════════════════════════════════════════════════
let waitUntil = null;
try {
  ({ waitUntil } = require('@vercel/functions'));
} catch (e) {
  waitUntil = null; // package chưa cài / môi trường không hỗ trợ — rơi xuống fallback bên dưới
}

// promiseFactory: hàm KHÔNG NHẬN THAM SỐ, trả về 1 Promise — dùng factory (thay vì nhận thẳng
// promise) để đảm bảo promise chỉ thực sự BẮT ĐẦU chạy tại đúng thời điểm gọi runInBackground,
// tránh side-effect chạy sớm ngoài ý muốn nếu code gọi hàm này bị refactor sau này.
function runInBackground(promiseFactory, onError) {
  let handled;
  try {
    handled = Promise.resolve(promiseFactory()).catch((e) => {
      if (onError) onError(e);
      else console.error('⚠️  [background task lỗi]:', e && e.message);
    });
  } catch (e) {
    // promiseFactory ném lỗi ĐỒNG BỘ (sync throw) — vẫn không được làm hỏng response chính.
    if (onError) onError(e);
    else console.error('⚠️  [background task lỗi - sync]:', e && e.message);
    return;
  }
  if (waitUntil) {
    try {
      waitUntil(handled);
      return;
    } catch (e) {
      // waitUntil ném lỗi (vd gọi ngoài request context Vercel thật) — rơi xuống fallback.
    }
  }
  // Fallback: không có waitUntil khả dụng. Promise đã có .catch() ở trên nên không tạo
  // unhandledRejection; chỉ là runtime không CHỦ ĐỘNG giữ function sống để đợi nó — chấp nhận
  // được cho môi trường chạy local (`node api/index.js`) vì process luôn sống liên tục.
}

module.exports = { runInBackground };
