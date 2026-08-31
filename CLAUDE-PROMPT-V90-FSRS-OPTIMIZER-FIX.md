Bạn đang sửa project học từ vựng tiếng Trung này. Hãy đọc TOÀN BỘ source, đặc biệt:
- lib/fsrs/optimizer.js
- api/index.js
- lib/runInBackground.js
- js/fsrs-optimizer.js
- test/fsrs-optimizer.test.js
- test/fsrs-optimizer.integration.test.js
- vercel.json
- AUDIT-REPORT-V90-FSRS-OPTIMIZER-ROOT-CAUSE.md

MỤC TIÊU DUY NHẤT:
Sửa lỗi FSRS Optimizer trên Vercel Hobby khiến job chạy đủ dữ liệu nhưng cuối cùng báo:
“Job không có heartbeat trong thời gian dài, đã thử lại tối đa (3 lần)”

KHÔNG thay đổi thuật toán FSRS, scheduler, review history, Apply/Rollback/Reset và KHÔNG tự viết optimizer/gradient descent thay thế official optimizer.

ROOT CAUSE ĐÃ XÁC ĐỊNH:
Code cũ hiểu sai `timeout` của @open-spaced-repetition/binding.
`computeParameters(items, { timeout })` dùng timeout làm KHOẢNG POLL của progress thread, không phải thời gian tối đa của toàn bộ training.
Source chính thức:
https://github.com/open-spaced-repetition/ts-fsrs/blob/main/packages/binding/src/train.rs
https://github.com/open-spaced-repetition/ts-fsrs/blob/main/packages/binding/src/progress.rs

Ở binding hiện tại:
- timeout_ms được truyền vào progress poller.
- progress callback có thể trả false để đặt want_abort=true.
- computeParameters chạy qua napi AsyncTask.

Vì vậy code phải tách rõ:
1. POLL INTERVAL của binding.
2. TRAIN ABORT BUDGET do application tự áp.

YÊU CẦU SỬA:

1. Trong lib/fsrs/optimizer.js:
- XÓA cách hiểu `OPTIMIZER_COMPUTE_TIMEOUT_MS` như compute timeout.
- Tạo:
  `OPTIMIZER_PROGRESS_POLL_MS` mặc định 500ms.
  `OPTIMIZER_TRAIN_ABORT_BUDGET_MS` mặc định khoảng 40s.
  `OPTIMIZER_POST_TRAIN_RESERVE_MS` mặc định khoảng 5s.
  `OPTIMIZER_WORKER_BUDGET_MS` mặc định 50s.
  `OPTIMIZER_MIN_TRAIN_BUDGET_MS` phải >= TRAIN_ABORT_BUDGET + POST_TRAIN_RESERVE.
- `computeParameters()` phải dùng:
  `timeout: OPTIMIZER_PROGRESS_POLL_MS`
- progress callback phải kiểm tra elapsed time.
- Khi vượt `abortAfterMs`, progress callback PHẢI return `false` để official binding abort.
- `trainWithOfficialOptimizer()` nhận `abortAfterMs` từ worker.
- Worker truyền budget train phù hợp với `budgetLeftMs()` và reserve cho evaluate/save.
- Error message phải nói rõ `abort budget` và `progress poll`, không gọi poll interval là compute timeout.
- Export các constant mới để test.

2. Không phá kiến trúc V86 hiện có:
- checkpoint `training_payload` giữ nguyên.
- continuation phải reset `status='queued'` trước khi return continuation=true.
- retry/attempt/max_attempts giữ nguyên.
- heartbeat độc lập giữ nguyên.
- atomic claim/finish giữ nguyên.
- GET /status tuyệt đối không require native optimizer.

3. Cẩn thận với retry:
- Nếu official optimizer abort do hết application budget, lỗi này được phân loại RETRYABLE.
- Nhưng không được retry vô hạn.
- Nếu sau max_attempts vẫn không train được thì failed rõ ràng, không để job chạy zombie.
- Không giả vờ “đã optimize” nếu chưa có weights hợp lệ.

4. Cập nhật test/fsrs-optimizer.test.js:
- test quan hệ budget: train abort + reserve <= min train < worker budget < 60s.
- test source không còn `timeout: OPTIMIZER_COMPUTE_TIMEOUT_MS`.
- test source có progress callback `return false` cho abort.
- giữ nguyên test continuation status='queued'.

5. Nếu test/integration có test đang gọi tên biến cũ hoặc thông báo cũ thì cập nhật cho đúng semantics mới.

6. Không nâng version @open-spaced-repetition/binding chỉ để né lỗi. Giữ version đang pin nếu API hiện tại vẫn đúng.

7. Không sửa Vercel sang một kiến trúc mới như Queue/Workflow nếu chưa cần. Trước tiên phải sửa đúng semantics timeout/abort của official binding.

8. Sau khi sửa:
- `node --check` toàn bộ JS.
- chạy `npm test`/các optimizer unit tests có thể chạy.
- nếu có DATABASE_URL thì chạy integration test.
- kiểm tra không có duplicate export/duplicate const.
- grep toàn project để chắc không còn chỗ nào gọi `timeout` của binding với ý nghĩa “compute timeout”.

9. Vercel Hobby hiện có giới hạn Function tối đa 60s. Không được dựa vào `maxDuration: 300` để giả định Hobby có 300s.
Nếu deployment là Hobby, worker budget phải nằm dưới 60s và có margin.

10. Không thay đổi UI ngoài mức cần thiết. Người dùng không biết code; UI chỉ cần báo đơn giản:
- đang chuẩn bị dữ liệu
- đang tối ưu
- đang thử lại
- hoàn tất
- thất bại và cho phép thử lại
Không hiển thị stack trace/native error cho user thường.

ĐẶC BIỆT:
Đừng lặp lại sai lầm của V89: `timeout: 35000` KHÔNG có nghĩa “train tối đa 35 giây”.
Hãy kiểm tra source Rust của official binding trước khi kết luận về semantics.

Sau khi hoàn thành, trả lại:
1. danh sách file đã sửa/thêm;
2. nguyên nhân lỗi thật, giải thích cực ngắn;
3. kết quả test;
4. xác nhận official FSRS optimizer vẫn được dùng, không có fallback approximation.
