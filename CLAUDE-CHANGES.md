# CLAUDE-CHANGES.md — Audit lại FSRS Optimizer (sau bản v90)

Ghi ngắn gọn các file đã sửa và mục đích. Chi tiết đầy đủ xem `AUDIT-REPORT-FSRS-OPTIMIZER.md`.

## File đã sửa (3 file, không có file nào bị xoá/thêm mới)

### `lib/fsrs/optimizer.js`
- Gắn cờ `optimizerAborted = true` vào lỗi khi optimizer bị chủ động dừng vì hết ngân sách thời gian
  (ở cả 2 nhánh có thể xảy ra: thư viện báo lỗi, HOẶC thư viện trả về kết quả không hợp lệ) — để không
  bị nhầm thành lỗi dữ liệu vĩnh viễn (xem `classifyOptimizerError`, kiểm tra cờ này trước tiên).
- Thêm dòng log `OPTIMIZER_ABORTED` (ghi rõ đã chạy bao lâu, động cơ nào) ngay khi việc dừng đó xảy ra.
- Thêm trường `optimizerEngine` (native/wasi) vào kết quả lưu database sau mỗi lần train thành công.
- `runOptimizerJob()` nhận thêm 1 tham số tuỳ chọn `invocationStartedAt` — nếu có, dùng mốc này để tính
  ngân sách thời gian còn lại (chính xác hơn, tính cả thời gian đăng nhập/kết nối database); nếu không
  có, tự động dùng cách tính cũ (không phá vỡ gì với code/test gọi hàm này theo kiểu cũ).

### `api/index.js`
- Route `POST /api/fsrs-optimizer/worker`: đo thời gian ngay dòng đầu tiên (trước bước xác thực đăng
  nhập), rồi truyền mốc đó cho `runOptimizerJob()` ở trên.

### `test/fsrs-optimizer.test.js`
- Thêm test cho các thay đổi trên: kiểm tra cờ `optimizerAborted` thắng được cách phân loại lỗi kiểu cũ,
  kiểm tra cả 2 khả năng phản hồi của thư viện khi bị yêu cầu dừng, kiểm tra `invocationStartedAt` được
  dùng đúng chỗ, kiểm tra `optimizerEngine`/`OPTIMIZER_ABORTED` có trong code.
- Không xoá/sửa test cũ nào — chỉ thêm mới.

## Không sửa gì thêm ở các file khác
Toàn bộ phần còn lại của project (giao diện, các chế độ học, scheduler FSRS, các route khác...) giữ
nguyên 100%, không đụng tới.

## Database
Không cần migration. Không có bảng/cột mới. Chỉ thêm 1 khoá vào 1 cột JSON đã có sẵn.
