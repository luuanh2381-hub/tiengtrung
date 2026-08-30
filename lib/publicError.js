// lib/publicError.js
// ════════════════════════════════════════════════════
// V88 (Phần 5 audit "API Error Leak") — PublicError: lỗi được TÁC GIẢ CODE CHỦ ĐỘNG đánh dấu là an
// toàn để hiện NGUYÊN VĂN cho user (đã tự viết message tiếng Việt rõ ràng, hành động được, không chứa
// chi tiết nội bộ — vd "Optimizer đang chạy — đợi hoàn tất trước khi Apply").
//
// MẶC ĐỊNH — 1 Error THƯỜNG (không phải PublicError) — API chỉ trả 1 thông điệp CHUNG CHUNG, AN TOÀN
// cho client (xem lib/publicError.js + api/index.js:fail()/publicErrorMessage()), dù server log
// (console.error) vẫn giữ đầy đủ e.message/stack để debug. Đây LÀ cách phân biệt "lỗi nghiệp vụ user
// cần thấy" (vd validate input sai) với "lỗi nội bộ" (SQL error, đường dẫn hệ thống, package/module
// error, thông tin cấu hình) mà KHÔNG cần liệt kê danh sách "an toàn hay không" theo từng route.
//
// Dùng: throw new PublicError('Tên đăng nhập đã tồn tại');  // sẽ được hiện NGUYÊN VĂN cho user
//       throw new Error('duplicate key value violates...'); // sẽ bị THAY bằng thông điệp chung chung
// ════════════════════════════════════════════════════
class PublicError extends Error {}

module.exports = { PublicError };
