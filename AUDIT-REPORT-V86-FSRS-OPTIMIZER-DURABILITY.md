# V86 — FSRS Optimizer: fix TRIỆT ĐỂ (durable retry + checkpoint), không chỉ heartbeat

## VẤN ĐỀ (báo cáo production, sau khi đã có V85-HEARTBEAT-FIX)

4.372 review hợp lệ / 794 cards / duplicate=0 / data validation=PASS / engine=Native. Job optimizer
**đôi khi** chạy một thời gian rồi mất heartbeat; UI báo "Job không có heartbeat trong thời gian dài —
coi như worker đã chết giữa chừng". Xảy ra dù dữ liệu đủ điều kiện optimize — tức không phải lỗi data
quality, và không phải luôn luôn xảy ra (mới là điểm mấu chốt để tìm đúng root cause).

## ROOT CAUSE — đã xác định bằng cách đọc lại toàn bộ pipeline, KHÔNG suy đoán

V85-HEARTBEAT-FIX (xem `AUDIT-REPORT-V85-ASYNC-OPTIMIZER.md` + comment "V85-HEARTBEAT-FIX" rải trong
`lib/fsrs/optimizer.js`) đã làm **đúng** phần *phát hiện* worker chết: heartbeat độc lập bằng
`setInterval` (không lồng trong progress callback của native binding — đã xác minh KHÔNG bị chặn bởi
event loop vì `computeParameters()` gọi callback qua N-API threadsafe function, không đồng bộ), atomic
claim (`UPDATE ... WHERE status='queued'`), idempotent finish có khoá dòng, stale recovery dựa trên
`heartbeat_at` (không phải `started_at`). Toàn bộ phần này **vẫn đúng, giữ nguyên**.

Nhưng phát hiện được worker chết **không ngăn được** việc nó chết. `POST /api/fsrs-optimizer/worker`
chạy **toàn bộ** pipeline (load review → validate → train native → evaluate → save) trong **đúng 1
`waitUntil()`** — tài liệu `@vercel/functions` xác nhận `waitUntil` là best-effort, bị chặn cứng bởi
`maxDuration` của invocation đó, không có ngoại lệ. `maxDuration` khai `300` trong `vercel.json`
nhưng áp dụng cho **cả** `api/index.js` (mọi route đi qua 1 Express app qua rewrite `/api/(.*)` →
`/api/index`) — và **có thể bị chính plan Vercel của deployment tự động hạ thấp hơn nữa tuỳ hạng tài
khoản, bất kể số khai trong file** (đây là 1 sự thật hạ tầng code không tự xác minh được — xem mục
"Bạn cần tự làm" bên dưới). Khi 1 lượt train (native, không có API checkpoint giữa chừng — đã xác nhận
qua tài liệu package) cộng dồn với load+validate+evaluate+save vượt ngân sách thật, **nền tảng** (không
phải JS) SIGKILL cả invocation — heartbeat "khoẻ" tới đâu cũng chết theo, không có `except` nào bắt
được. Dataset càng lớn/optimizer càng hội tụ chậm → xác suất vượt ngân sách càng cao → đúng triệu
chứng "đôi khi", không phải luôn luôn.

Đây chính là giới hạn mà chính báo cáo V85 đã **nói thẳng** ở mục cuối: *"nếu dataset tương lai lớn tới
mức vượt quá maxDuration của /worker, job tự chuyển failed nhưng KHÔNG tự chia nhỏ thành nhiều
invocation nối tiếp"* — V86 hoàn thiện đúng bước còn thiếu đó.

## FIX — 2 checkpoint + retry có kiểm soát (Phần VI phương án 2 của yêu cầu, KHÔNG cần hạ tầng mới)

```
Trước (V85):  claim → load → validate → [ CHECKPOINT DUY NHẤT: train → evaluate → save ] → completed
              toàn bộ trong 1 invocation, 1 waitUntil — chết bất kỳ đâu trong [...] = mất trắng

Sau (V86):    claim (queued→running, hoặc resume nếu đã có training_payload)
              → load + validate + build training items
              → CHECKPOINT 'prepared' (lưu training_payload JSONB)
              → còn đủ ngân sách AN TOÀN (OPTIMIZER_MIN_TRAIN_BUDGET_MS)?
                  CÓ  → train → evaluate → save → completed   (invocation nhỏ/vừa: y hệt trước, 0 round-trip thêm)
                  KHÔNG → dừng SẠCH ở đây, báo continuation:true
                          → api/index.js tự kích hoạt NGAY 1 invocation /worker MỚI cho ĐÚNG job này
                          → invocation mới claim lại, THẤY training_payload → nhảy thẳng vào train với
                            ngân sách MỚI TINH (không phải chia sẻ với phần load/validate đã xong)

              Lỗi trong lúc train (kể cả timeout nội bộ 45s của chính native call)?
                  → classifyOptimizerError() phân loại NGAY (không đợi 180s poll mới phát hiện):
                    RETRYABLE (hạ tầng/tạm thời, còn lượt) → requeue NGAY, attempt+1, GIỮ checkpoint
                    NON_RETRYABLE (dữ liệu/deployment) HOẶC hết max_attempts → failed HẲN, dừng
```

Đây **không phải** "tăng timeout" (quy tắc I.3 bị cấm) — ngược lại là tự áp 1 giới hạn AN TOÀN HƠN
`maxDuration` thật, biến "có thể bị SIGKILL bất kỳ lúc nào, không đoán trước được" thành "chỉ dừng ở 1
ranh giới đã biết trước, luôn có checkpoint để tiếp tục" — đúng tinh thần Phần VI: chọn phương án ít
thay đổi nhất, tương thích stack hiện tại, không cần hạ tầng mới (Vercel Queues/Workflow — phương án 1
— vẫn cần tự cấu hình Dashboard, ngoài phạm vi code có thể tự làm; chuyển compute sang browser — phương
án 3 — đổi hẳn UX/bảo mật review data sang client, không phải "ít thay đổi nhất").

## Retry có kiểm soát, phân loại được (Phần IX)

`classifyOptimizerError()` (thuần JS, có unit test riêng không cần Postgres) đọc **đúng thông điệp lỗi
thật** mà code ném ra (không đoán mò):

| Lỗi thật | Phân loại | Vì sao |
|---|---|---|
| `"...timeout cấu hình=...”` (native tự timeout ở 45s) | RETRYABLE | Có thể do tải hệ thống/ngân sách — sau khi tách checkpoint, lần sau có FULL ngân sách mới |
| `"KHÔNG load được trên môi trường"` | NON_RETRYABLE | Deployment/dependency thiếu — cùng input sẽ luôn lỗi y hệt |
| `"...trả về weights không hợp lệ"` | NON_RETRYABLE | Deterministic với cùng dữ liệu — retry vô ích |
| `ECONNREFUSED`/`Connection terminated`... | RETRYABLE | Lỗi hạ tầng DB/mạng điển hình, tạm thời |
| `OPTIMIZER_WORKER_BUDGET_EXCEEDED` (guard tự áp) | RETRYABLE | Ngân sách 1 invocation không đủ — lần sau (invocation khác) có thể đủ |
| Không nhận diện được | NON_RETRYABLE (mặc định) | An toàn hơn lặp vô ích 1 lỗi lập trình/dữ liệu thật |

`attempt`/`max_attempts` (mặc định 3, cấu hình qua env) đếm trên **cùng 1 dòng job** (không tạo job
mới mỗi lần retry — dễ audit lịch sử 1 lần Run xuyên suốt các lần thử). Hết `max_attempts` → `failed`
hẳn, thông báo rõ "đã thử lại tối đa N lần" — khác thông báo lần fail đầu tiên, không mập mờ.

## Cột DB mới (`fsrs_optimizer_jobs`, áp dụng idempotent qua `ensureOptimizerTables()`, không mất dữ liệu cũ)

`attempt` (INT, default 1), `max_attempts` (INT, default 3), `worker_id` (TEXT, định danh lượt claim —
chỉ phục vụ logging/chẩn đoán, Phần III/XIII), `training_payload` (JSONB, checkpoint — bị xoá ngay khi
job đạt trạng thái cuối, không lưu dữ liệu suy ra từ review lâu hơn cần), `error_retryable` (BOOLEAN).

## Cơ chế kích hoạt lại — tận dụng hạ tầng CÓ SẴN, không thêm cron/queue

3 nơi cần "tự gọi lại /worker cho 1 jobId" (job vừa tạo, job vừa được requeue, invocation báo
`continuation:true`) đều dùng chung `triggerOptimizerWorker()`/`fetchOptimizerWorker()`
(`api/index.js`). Job vừa requeue được kích hoạt lại **ngay trong response của `GET /status`** — route
này vốn đã được FE poll mỗi ~2s trong lúc job active (`js/fsrs-optimizer.js`), tận dụng đúng chu kỳ đó
làm "trigger" thay vì chờ 180s stale-timeout mới có 1 lượt poll khác tình cờ phát hiện.

## Error security (giữ nguyên nguyên tắc V85)

`errorMessage`/`workerId` (nội dung kỹ thuật chi tiết, worker_id) chỉ trả cho admin. `errorRetryable`
(chỉ là 1 cờ phân loại, không phải nội dung lỗi) trả cho mọi user — không phải thông tin nhạy cảm.

## Files thay đổi

- `lib/fsrs/optimizer.js` — 5 cột mới; `classifyOptimizerError()` mới (export); `claimQueuedJob()` claim
  thẳng vào `stage='prepared'` nếu có `training_payload`, ghi `worker_id`; `persistTrainingPayload()`
  mới; `recoverStaleJobsForUser()` tách 2 nhánh atomic (requeue nếu còn lượt / failed hẳn nếu hết lượt),
  trả về `requeuedJobIds`; `runOptimizerJob()` viết lại — checkpoint `prepared`, guard ngân sách
  (`OPTIMIZER_WORKER_BUDGET_MS`/`OPTIMIZER_MIN_TRAIN_BUDGET_MS`, cấu hình qua env), `failOrRequeue()`
  quyết định ngay trong invocation (không đợi poll); `finishJob()` nhận thêm `errorRetryable`, xoá
  `training_payload` khi vào trạng thái cuối; `createOptimizerJob()`/`getOptimizerStatus()` truyền tiếp
  `requeuedJobIds`; `mapJobRow()` thêm `attempt`/`maxAttempts`/`errorRetryable`/`workerId` (admin);
  `logOptimizerStage()` mới — log có cấu trúc đủ 14 stage yêu cầu (Phần XIII).
- `api/index.js` — tách `fetchOptimizerWorker()`/`triggerOptimizerWorker()` dùng chung cho `/run`,
  `/worker` (tự kích hoạt tiếp nếu `continuation:true`), `/status` (kích hoạt job vừa requeue).
- `js/fsrs-optimizer.js` — nhãn stage `prepared` mới; hiện "🔁 Đang thử lại (lần N/M)..." khi
  `attempt>1` thay vì im lặng lặp lại nhãn queued/running như lần chạy đầu (Phần XV).
- `migrations/V86_fsrs_optimizer_durable_retry.sql` (mới, tham khảo — schema thật áp dụng runtime).
- `test/fsrs-optimizer.test.js` — 12 test mới cho `classifyOptimizerError()`/`mapJobRow()`/hằng số ngân
  sách (thuần JS, không cần Postgres) — **đã chạy PASS** trong sandbox này (dựng stub `pg`/`ts-fsrs`/
  `@vercel/functions` để `require()` được chính code thật, xem mục "Đã kiểm chứng được" bên dưới).
- `test/fsrs-optimizer.integration.test.js` — Test F/G/H/I mới (requeue còn lượt giữ checkpoint, hết
  lượt failed hẳn, NON_RETRYABLE fail ngay không phí lượt, **mô phỏng đúng kịch bản "computeParameters()
  liên tục chậm hơn ngân sách" bằng timeout thật lặp lại nhiều lần tới khi failed hẳn** — yêu cầu đặc
  biệt nhấn mạnh phải có test này). Cập nhật 4 test cũ (C/D/"stale queued"/Test B) để khớp hành vi MỚI
  (ép `attempt=max_attempts` trước khi bắt stale, giữ nguyên Ý NGHĨA GỐC của từng test — chúng kiểm tra
  trạng thái CUỐI CÙNG, không phải nhánh retry, nên không mất coverage, chỉ tách rõ 2 mối quan tâm).

## Đã KHÔNG đổi

FSRS scheduler/`reviewService.js`/`cardMapper.js`/`studyScope.js`, thuật toán data-quality/train/
evaluate thuần JS, Apply/Rollback/Reset (vẫn chỉ đụng `user_fsrs_weights`), native binding + version
pin (`@open-spaced-repetition/binding@0.5.0` — audit xác nhận KHÔNG phải nguyên nhân, không có lý do
để nâng cấp), toàn bộ route/schema khác của app, UI/UX (chỉ thêm 1 nhãn stage + 1 dòng phụ khi retry).

## Đã kiểm chứng được (trong sandbox này — không có Postgres/Vercel thật)

`node --check` PASS trên mọi file `.js` đã sửa. Dựng **stub `pg`/`ts-fsrs`/`@vercel/functions`** trong
thư mục scratch riêng (không đụng project thật) để `require()` được **chính** `lib/fsrs/optimizer.js`
thật — không phải mock lại logic — rồi chạy `classifyOptimizerError()`/`mapJobRow()` với đúng các thông
điệp lỗi mà code thật ném ra: **13/13 pass**. Soát tay từng câu SQL (param index `$1..$n`) trong
`recoverStaleJobsForUser`/`failOrRequeue`/`finishJob`/`claimQueuedJob` — khớp đúng. Diff xác nhận
KHÔNG file FSRS scheduler nào bị đụng.

## Bạn cần tự làm (code không thể tự xác minh thay)

1. **Kiểm tra `maxDuration` THẬT trên Vercel Dashboard → Project → Settings → Functions** của deployment
   đang chạy production — số `300` trong `vercel.json` có thể bị plan hiện tại tự động clamp thấp hơn.
   Nếu thấp hơn ~90s, hạ `FSRS_OPTIMIZER_WORKER_BUDGET_MS` (env var mới) xuống tương ứng (để lại margin
   ít nhất 20-30s dưới con số thật).
2. Chạy `npm run test:optimizer` (không cần DB) và `DATABASE_URL=... npm run test:optimizer:integration`
   (cần Postgres thật, có `@open-spaced-repetition/binding` cài được để chạy đủ Test B/I) trước khi
   deploy — sandbox này không có mạng nên không tự chạy được 2 lệnh đó.
3. Sau khi deploy, theo dõi log `[fsrs-optimizer] {"stage":"JOB_RETRY",...}` — nếu thấy lặp lại thường
   xuyên (không chỉ 1 lần hiếm hoi), đó là dấu hiệu ngân sách (`FSRS_OPTIMIZER_WORKER_BUDGET_MS`) vẫn
   đang eo hẹp so với dataset thật, cần điều chỉnh thêm hoặc cân nhắc phương án 1 (Vercel Queues).

## Giới hạn còn lại (nói thẳng)

`computeParameters()` của binding chính thức vẫn là 1 lệnh gọi nguyên khối — checkpoint ở V86 nằm
NGOÀI lệnh gọi đó (trước/sau), không thể tách nhỏ chính lượt train thành nhiều phần nhỏ hơn nữa. Nếu 1
dataset tương lai lớn tới mức riêng bước train (không tính load/validate) đã vượt quá
`OPTIMIZER_WORKER_BUDGET_MS` dù đã có nguyên ngân sách mới, `OPTIMIZER_MIN_TRAIN_BUDGET_MS` sẽ chặn
trước và job vẫn kết thúc `failed` sau khi hết `max_attempts` (không kẹt UI, nhưng chưa optimize được).
Ở quy mô đó, bước nâng cấp tự nhiên tiếp theo vẫn là Vercel Queues/Workflow (durable, không giới hạn
bởi `maxDuration` của HTTP Function) — cần tự cấu hình trên Dashboard, ngoài phạm vi 1 lần sửa code.
