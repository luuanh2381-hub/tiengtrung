# V90 — Audit FSRS Optimizer: root cause của lỗi “mất heartbeat / retry tối đa 3 lần”

## Kết luận ngắn

Lỗi hiện tại **không nằm ở dữ liệu**. Dataset trong ảnh có 4.782 review hợp lệ / 833 thẻ / 13 ngày / 0% lỗi và đủ điều kiện train.

Root cause quan trọng nhất trong code V89 là **hiểu sai ý nghĩa của `timeout` trong `@open-spaced-repetition/binding`**.

Code V89 dùng:

```js
computeParameters(items, { timeout: 35_000, progress })
```

và coi `35_000` là “optimizer chạy tối đa 35 giây”. Điều này **không đúng**.

Source chính thức của binding cho thấy `timeout` được dùng làm `timeout_ms` của **progress poller**; poller đọc trạng thái tiến độ và chỉ khi progress callback trả `false` thì binding mới đặt cờ abort. `computeParameters()` chạy trong `AsyncTask`, tức không chạy đồng bộ trên JS event loop. Vì vậy `timeout: 35000` thực chất làm poller chỉ kiểm tra khoảng mỗi 35 giây — quá thưa để bảo vệ một Vercel Hobby Function khỏi giới hạn thời gian. urlSource train.rs của @open-spaced-repetition/bindinghttps://github.com/open-spaced-repetition/ts-fsrs/blob/main/packages/binding/src/train.rs urlSource progress.rs của @open-spaced-repetition/bindinghttps://github.com/open-spaced-repetition/ts-fsrs/blob/main/packages/binding/src/progress.rs

Vercel hiện ghi rõ Hobby có Function maximum duration tối đa 60 giây; Pro tối đa 300 giây. `maxDuration: 300` trong `vercel.json` không biến Hobby thành 300 giây. urlVercel Hobby planhttps://vercel.com/docs/plans/hobby

## Chuỗi lỗi thực tế

1. User bấm **Thử lại**.
2. `/api/fsrs-optimizer/run` tạo job đúng.
3. `/api/fsrs-optimizer/worker` claim job đúng.
4. Checkpoint `prepared` và heartbeat độc lập hoạt động đúng.
5. `computeParameters()` bắt đầu train native bằng official binding.
6. Code V89 tưởng `timeout=35s` sẽ tự dừng train ở 35s. **Không phải.**
7. Nếu native optimizer chạy đủ lâu, invocation có thể chạm giới hạn Function của Vercel.
8. Khi platform kill invocation, JavaScript không kịp chạy `catch/finally`; heartbeat dừng theo process.
9. Sau khoảng stale threshold, DB recovery coi worker đã chết và retry.
10. Lặp lại đủ số attempt → UI hiện đúng thông báo trong ảnh: “Job không có heartbeat trong thời gian dài, đã thử lại tối đa (3 lần)”.

## Một lỗi V89 trước đó đã được sửa

V89 đã sửa một bug khác: nhánh continuation sau checkpoint phải đưa job từ `running` về `queued` trước khi gọi invocation tiếp theo. Code hiện tại đã có `UPDATE ... SET status='queued' ...` nên **không cần quay lại sửa lỗi này**.

## Sửa lần này

### 1. Tách “poll interval” khỏi “train budget”

- `OPTIMIZER_PROGRESS_POLL_MS`: mặc định 500ms — đúng vai trò poll interval.
- `OPTIMIZER_TRAIN_ABORT_BUDGET_MS`: mặc định 40s — ngân sách train do app tự áp.
- Khi progress callback phát hiện vượt budget, callback trả `false` để official binding gửi tín hiệu abort cho Rust optimizer.
- `OPTIMIZER_POST_TRAIN_RESERVE_MS`: mặc định 5s cho evaluate/save/DB.
- `OPTIMIZER_WORKER_BUDGET_MS`: mặc định 50s, dưới giới hạn Hobby 60s.

### 2. Không còn biến `OPTIMIZER_COMPUTE_TIMEOUT_MS`

Biến này gây hiểu nhầm vì `timeout` của binding không phải compute timeout. Đã bỏ khỏi code và test.

### 3. Giữ official optimizer

Không thay bằng gradient descent tự viết, không thay thuật toán FSRS, không thay scheduler. Vẫn dùng `@open-spaced-repetition/binding` chính thức.

### 4. Giữ checkpoint/retry/heartbeat

Không phá kiến trúc V85/V86/V87 hiện có:

- DB job vẫn durable.
- `training_payload` vẫn là checkpoint.
- heartbeat độc lập vẫn tồn tại.
- stale recovery vẫn tồn tại.
- atomic claim/finish vẫn tồn tại.
- GET `/status` vẫn không load native binding.

## Giới hạn cần hiểu rõ

Nếu riêng một lượt official optimizer cần lâu hơn ngân sách train cho phép, code mới sẽ **abort có kiểm soát** thay vì chờ Vercel SIGKILL. Retry có thể chạy lại, nhưng retry không thể “tiếp tục giữa chừng” bên trong `computeParameters()` vì API official hiện không cung cấp checkpoint giữa các bước train.

Nếu dataset về sau lớn đến mức train thường xuyên vượt ngân sách Hobby, giải pháp đúng là chạy optimizer ở môi trường có thời gian chạy dài hơn (ví dụ Vercel Pro/Workflow/Queue hoặc worker riêng), không phải tăng vô hạn retry.

## Bằng chứng source chính thức

- README chính thức của binding xác nhận API `computeParameters(items, { ..., timeout: 500, progress })`. urlREADME @open-spaced-repetition/bindinghttps://www.npmjs.com/package/@open-spaced-repetition/binding
- `train.rs` cho thấy `timeout` được lưu thành `timeout_ms` và truyền vào `spawn_progress_poller`, không phải tham số giới hạn thời gian trực tiếp của `compute_parameters`. urltrain.rshttps://github.com/open-spaced-repetition/ts-fsrs/blob/main/packages/binding/src/train.rs
- `progress.rs` cho thấy poller dùng `Duration::from_millis(timeout_ms)` và callback có thể trả `false` để đặt `want_abort=true`. urlprogress.rshttps://github.com/open-spaced-repetition/ts-fsrs/blob/main/packages/binding/src/progress.rs
- Vercel Hobby: maximum duration configurable tới 60s; Pro tới 300s. urlVercel Hobby planhttps://vercel.com/docs/plans/hobby

## Kiểm tra đã thực hiện trên source zip

- Giải nén và rà soát 70 file.
- `node --check` PASS toàn bộ JavaScript.
- Rà soát các route `/run`, `/worker`, `/status`, `/diagnostics`, `/apply`, `/rollback`, `/reset`.
- Rà soát state machine `queued → running → prepared → training → evaluating → saving → completed/failed`.
- Rà soát heartbeat, stale recovery, retry, checkpoint và atomic finish.
- Rà soát dependency official optimizer và deployment config.

Không phát hiện lỗi syntax hoặc lỗi scheduler FSRS trực tiếp liên quan đến triệu chứng trong ảnh. Vấn đề tập trung ở cơ chế giới hạn thời gian của optimizer worker.
