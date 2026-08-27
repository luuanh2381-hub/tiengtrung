# V85 — FSRS Optimizer: kiến trúc BẤT ĐỒNG BỘ (async job), thay cho fix chỉ tăng timeout

## VẤN ĐỀ (từ ảnh chụp production V83-FIX-v4)

`POST /api/fsrs-optimizer/run` chạy TOÀN BỘ pipeline (đọc `review_history` → validate → train bằng
optimizer chính thức → evaluate → lưu candidate) trong 1 request HTTP DUY NHẤT. Nếu tổng thời gian
vượt quá thời gian sống của request đó, Vercel SIGKILL cả process giữa chừng — vượt ngoài try/catch
của JS, `finishOptimizerRun()` không kịp chạy → DB kẹt ở `status=running`, UI đứng mãi "Đang chạy...".

## ROOT CAUSE (kiến trúc, không phải 1 dòng code sai)

Kiến trúc synchronous-request-does-everything về bản chất không an toàn trên serverless có giới hạn
thời gian sống request, bất kể tăng `maxDuration` bao nhiêu — dataset càng lớn, rủi ro càng cao, và
khi chết giữa chừng thì KHÔNG có cơ chế nào tự phục hồi trạng thái DB.

## FIX — tách "tạo job" khỏi "chạy job"

```
POST /run    → tạo job (bảng MỚI fsrs_optimizer_jobs, status='queued') → trả 202 NGAY
             → bắn 1 request HTTP TÁCH RỜI (self-fetch) tới POST /worker, KHÔNG đợi worker chạy xong

POST /worker → claim job (queued→running) → trả 202 NGAY cho CHÍNH request đó
             → chạy pipeline nặng Ở NỀN (waitUntil CỦA CHÍNH invocation này — invocation này có đồng
               hồ maxDuration RIÊNG, hoàn toàn tách khỏi request mà trình duyệt đang chờ, vốn đã nhận
               response từ /run từ trước) → cập nhật stage/heartbeat/progress liên tục

GET /status  → đọc job MỚI NHẤT theo index (rẻ) — KHÔNG quét lại review_history mỗi lần poll
```

Frontend (`js/fsrs-optimizer.js`) poll `GET /status` mỗi 2s trong lúc modal mở và job queued/running,
hiện đúng stage thật: Queued → Loading reviews → Preparing data → Training (kèm progress thật từ
`computeParameters({ progress })`) → Evaluating → Saving → Completed/Failed. Đóng modal không huỷ job;
mở lại/tải lại trang luôn khôi phục đúng trạng thái từ DB (không dựa vào biến JS tạm).

## Vì sao KHÔNG dùng waitUntil() để né timeout ngay trong `/run`

Đó sẽ là workaround bị cấm tường minh trong yêu cầu — vẫn giữ nguyên request mà trình duyệt đang chờ
làm nơi chạy training, chỉ trì hoãn lúc đóng invocation đó. `waitUntil()` trong bản sửa này CHỈ áp
dụng cho invocation của chính route `/worker` — 1 invocation KHÔNG ai đang chờ phản hồi cuối cùng.

## Concurrency/Idempotency — thực thi ở TẦNG DATABASE

Partial unique index `uq_fsrs_optimizer_jobs_active_per_user` (trên `user_id` WHERE `status IN
('queued','running')`) — INSERT thứ 2 khi đã có job active bị Postgres từ chối (23505), app bắt lỗi
và trả lại đúng job đã có. Double-click, nhiều tab, nhiều thiết bị đều an toàn — không chỉ dựa vào cờ
nhớ tạm trong 1 process như bản trước (`claimOptimizerRun` cũ dùng UPDATE có điều kiện trên
`user_fsrs_weights`, vẫn đúng nhưng gộp chung với dữ liệu weights, không giữ được lịch sử nhiều lượt).

## Failure handling — không kẹt vĩnh viễn

`heartbeat_at` cập nhật mỗi lần đổi stage + mỗi ~2s trong lúc train (throttled qua `onProgress`).
`recoverStaleJobsForUser()` tự chuyển job `queued` quá 60s chưa được worker claim, hoặc `running` quá
180s không có heartbeat mới, thành `failed` — gọi ở đầu `createOptimizerJob()` VÀ `getOptimizerStatus()`
nên user thấy đúng trạng thái + nút "Thử lại" ngay ở lần poll kế tiếp, không cần đợi 10 phút.

## Error security

`fsrs_optimizer_jobs.error_message` (đầy đủ) chỉ trả cho admin; `.error_public` (câu chung an toàn,
"Optimizer thất bại. Vui lòng thử lại.") trả cho user thường. `engineStatus` (root cause/node/
platform/arch/glibc) cũng được sanitize Ở TẦNG SERVER cho non-admin (`sanitizeEngineStatusForUser`) —
trước V85 chỉ ẩn ở UI, vẫn xem được qua DevTools/Network.

## Status API — không nặng

Data quality lấy từ cache JSONB của job gần nhất (`data_quality`, tính 1 lần ở stage `preparing_data`)
nếu đã từng chạy; nếu chưa từng chạy, dùng 1 aggregate query duy nhất (`getQuickReadinessSnapshot`,
COUNT/MIN/MAX/COUNT FILTER, có cache TTL 15s) — không kéo hàng nghìn dòng review về Node.

## Files thay đổi

- `lib/fsrs/optimizer.js` — bảng mới `fsrs_optimizer_jobs`; `createOptimizerJob`/`claimQueuedJob`/
  `updateJobHeartbeat`/`setJobDataQuality`/`finishJob`/`recoverStaleJobsForUser`/`hasActiveJob`/
  `runOptimizerJob` (thay `claimOptimizerRun`/`finishOptimizerRun`/`runOptimizer` cũ);
  `getOptimizerStatus`/`getQuickReadinessSnapshot`/`sanitizeEngineStatusForUser` mới; `apply/rollback/
  reset` đổi guard sang `hasActiveJob`; `saveOptimizerCandidate` được export (thiếu ở bản trước — bug
  có sẵn, integration test cũ gọi hàm này nhưng chưa từng export được).
- `api/index.js` — route `/run` chỉ tạo job + trả 202; route MỚI `/worker` (nội bộ, chạy pipeline nặng
  qua `waitUntil`); `/status` truyền `isAdmin` cho sanitize lỗi.
- `js/fsrs-optimizer.js` — polling, hiện stage/progress thật, nút đổi thành "Thử lại" khi failed, đóng/
  mở lại modal khôi phục đúng trạng thái từ server.
- `vercel.json` — `maxDuration` 60→300 (mức mặc định Vercel 2026 trên mọi plan — hỗ trợ thêm cho
  invocation của `/worker`, KHÔNG phải fix chính; kiến trúc mới mới là fix chính).
- `migrations/V85_fsrs_optimizer_async_jobs.sql` (mới, tham khảo — schema thật tạo idempotent lúc chạy).
- `test/fsrs-optimizer.integration.test.js` — thay test run-lock cũ bằng: double-create-job race,
  stale-job recovery, full pipeline thật (dữ liệu tổng hợp chèn thẳng Postgres) qua
  `createOptimizerJob`+`runOptimizerJob`, gọi `runOptimizerJob` trùng trên job đã xong (no-op).
- `docs/fsrs.md` — thêm mục 11.2.

## Đã KHÔNG đổi

FSRS optimizer/binding chính thức (`@open-spaced-repetition/binding`, version pin `0.5.0`), logic
data-quality/train/evaluate (thuần JS, đã có unit test riêng), Apply/Rollback/Reset (vẫn CHỈ đụng
`user_fsrs_weights`, KHÔNG BAO GIỜ đụng `fsrs_cards`/`review_history`), toàn bộ route/schema khác của
app.

## Giới hạn còn lại (nói thẳng)

`computeParameters()` của binding chính thức là 1 lệnh gọi nguyên khối, không có API checkpoint giữa
chừng — nếu dataset tương lai lớn tới mức vượt quá `maxDuration` của `/worker` (300s), job tự chuyển
`failed` (không kẹt UI, cho Retry) nhưng KHÔNG tự chia nhỏ thành nhiều invocation nối tiếp. Bước nâng
cấp tự nhiên ở quy mô đó là Vercel Queues/Workflow — cần tự cấu hình trên Dashboard, ngoài phạm vi sửa
lần này. Không có mạng trong sandbox để tự chạy `npm install`/test thật có Postgres — đã syntax-check
(`node -c`) toàn bộ file `.js` đã sửa (PASS) và đọc lại thủ công toàn bộ luồng; BẠN nên tự chạy
`npm run test:optimizer` + `npm run test:optimizer:integration` (cần `DATABASE_URL`) trước khi deploy.
