# V89 — FSRS Optimizer: root cause THẬT của "mất heartbeat, đã thử lại tối đa 3 lần"

## TRIỆU CHỨNG

Sau khi có checkpoint + retry (V86) và tách native khỏi /status (V87), job optimizer **vẫn** kết thúc:
"Job không có heartbeat trong thời gian dài, đã thử lại tối đa (3 lần)" — trên dataset hoàn toàn bình
thường (4.782 review / 833 thẻ / 13 ngày / 0 lỗi dữ liệu). Nghĩa là checkpoint+retry (V86) không hề
giúp ích — cả 3 attempt đều thất bại THEO CÙNG MỘT CÁCH.

## ĐÃ LOẠI TRỪ BẰNG NGHIÊN CỨU TRỰC TIẾP (không suy đoán)

**C. `computeParameters()` block event loop?** Đã tra cứu: napi-rs binding dùng `AsyncTask` — chạy
trên **libuv thread pool**, không chặn main JS thread. Giả thuyết bị JS event loop treo trong lúc
train là **SAI** — kiến trúc await/heartbeat độc lập vẫn hoạt động đúng như thiết kế trong lúc train.

## ROOT CAUSE THẬT — 2 vấn đề kết hợp, cả 2 đều đã xác nhận và sửa

### 1) BUG LOGIC: continuation không reset `status` → tự triệt tiêu cơ chế continuation

`runOptimizerJob()` (checkpoint 'prepared', guard ngân sách — thêm ở V86) khi phát hiện không đủ thời
gian để train, trả về `{ continuation: true }` để `api/index.js` tự kích hoạt 1 invocation MỚI —
**nhưng KHÔNG reset `status` của job về `'queued'` trước khi return**. Job vẫn còn `status='running'`
(do CHÍNH invocation này claim ở đầu hàm). `claimQueuedJob()` của invocation MỚI đòi hỏi
`WHERE status = 'queued'` — do status vẫn `'running'`, claim thất bại, trả về `null`,
`runOptimizerJob()` của invocation mới **no-op hoàn toàn, không làm gì cả**. Job kẹt ở
`running`/`prepared` với heartbeat đã NGỪNG (vì `stopHeartbeat()` chạy ngay khi invocation gốc
return) cho tới khi `OPTIMIZER_RUNNING_STALE_MS` (180s) trôi qua mới được stale-recovery cứu — và
**mỗi lần như vậy tốn oan 1 `attempt`** cho một lần chuyển tiếp hoàn toàn bình thường, không phải lỗi
thật. 3 lần continuation = tốn hết cả 3 `attempt` = "đã thử lại tối đa" — đúng khớp triệu chứng.

**Fix**: thêm `UPDATE fsrs_optimizer_jobs SET status='queued', worker_id=NULL, heartbeat_at=now() WHERE
id=$1 AND status='running'` ngay trước `return { continuation: true }`. KHÔNG tăng `attempt` (khác
nhánh lỗi trong `failOrRequeue()`) — đây là chuyển tiếp bình thường trong CÙNG 1 attempt, không phải
1 lần thử lại do lỗi.

### 2) NGÂN SÁCH TỰ ÁP SAI CĂN CỨ: 200s trong khi ngưỡng THẬT của Vercel Hobby là 60s CỨNG

`OPTIMIZER_WORKER_BUDGET_MS` (V86) mặc định 200.000ms, dựa trên giả định `maxDuration: 300` khai
trong `vercel.json` là con số THẬT. Đã tra cứu trực tiếp (nhiều nguồn độc lập, 2026): **trên Vercel
Hobby (free) plan, function timeout LUÔN LÀ 60 GIÂY CỨNG, `vercel.json` khai bao nhiêu cũng bị bỏ
qua, không có cách override từ code/cấu hình project.** Vì app này gần như chắc chắn đang chạy Hobby
(app cá nhân, 1 user), "ngân sách an toàn" 200s mà code tự tin tưởng thực ra **không hề tồn tại** —
platform SIGKILL invocation ở mốc 60s thật, TRƯỚC KHI guard tự áp (200s) của code kịp phát hiện và
dừng sạch. Đáng chú ý: có 1 comment CŨ hơn (trước V86, tại khai báo `OPTIMIZER_COMPUTE_TIMEOUT_MS`)
đã từng đúng khi giả định ngưỡng 60s — nhưng V86 (khi thêm `OPTIMIZER_WORKER_BUDGET_MS`) đã không đối
chiếu lại giả định đó, vô tình dùng con số lớn hơn thực tế 3-4 lần.

**Fix** — tính lại TOÀN BỘ chuỗi số cho vừa khít dưới ngưỡng 60s thật, có biên an toàn:

| Hằng số | V86 (sai) | V89 (đúng, mặc định mới) | Căn cứ |
|---|---|---|---|
| `OPTIMIZER_WORKER_BUDGET_MS` | 200.000 | **50.000** | < 60s thật, chừa 10s biên cho cold-start/overhead |
| `OPTIMIZER_MIN_TRAIN_BUDGET_MS` | 60.000 | **40.000** | ≥ compute-timeout mới + biên evaluate/save (~5s) |
| `OPTIMIZER_COMPUTE_TIMEOUT_MS` | 45.000 | **35.000** | Để prepare (~1-5s) + train (≤35s) + evaluate/save (~1-3s) luôn < 50s |

Cả 3 vẫn cấu hình được qua biến môi trường (`FSRS_OPTIMIZER_WORKER_BUDGET_MS`,
`FSRS_OPTIMIZER_MIN_TRAIN_BUDGET_MS`, `FSRS_OPTIMIZER_TIMEOUT_MS`) — nếu deployment THẬT đang ở
Pro/Enterprise (ngưỡng thật cao hơn), chỉnh qua env, KHÔNG cần sửa code. `vercel.json` giữ nguyên
`maxDuration: 300` (vô hại với Hobby — bị bỏ qua; có lợi nếu sau này nâng cấp Pro — tận dụng được ngay).

## Vì sao 2 vấn đề CÙNG gây đúng 1 triệu chứng

Với dataset 4.782 review / 833 thẻ (nhỏ), giả thuyết hợp lý nhất: **compute timeout cũ (45s) + tổng
overhead (load/validate/evaluate/save/cold-start native binding) đã VƯỢT ngưỡng THẬT 60s** trên ít
nhất 1 trong 3 lần thử — khi đó platform SIGKILL trực tiếp (không qua bất kỳ nhánh xử lý lỗi nào của
code — đây chính là kiểu chết "không heartbeat" thay vì "job failed rõ ràng"). Ở lần thử tiếp theo
(sau khi bị stale-recovery cứu), nếu train từng suýt chạm ngưỡng cũng đủ khiến guard ngân sách (V86)
trigger continuation — nhưng do BUG #1, continuation đó cũng không hoạt động, lại kẹt tới stale-
recovery, lại tốn thêm 1 attempt. Cả 2 vấn đề cộng hưởng khiến 3 attempt đều thất bại theo đúng cùng
1 kiểu, dù dataset không hề lớn — không cần giả thuyết native crash mới giải thích được triệu chứng.

## Files thay đổi

- `lib/fsrs/optimizer.js` — (1) thêm UPDATE reset `status='queued'` trước `return{continuation:true}`
  ở budget-guard; (2) hạ 3 hằng số ngân sách xuống mức an toàn cho Hobby 60s thật; (3) export thêm
  `OPTIMIZER_COMPUTE_TIMEOUT_MS` (thiếu sót cũ, phát hiện khi viết test); (4) cập nhật toàn bộ comment
  giải thích liên quan cho khớp con số/căn cứ mới.
- `test/fsrs-optimizer.test.js` — test tĩnh mới xác nhận UPDATE status='queued' PHẢI có trước dòng
  return continuation (chặn tái phát); sửa 2 test cũ tham chiếu nhầm hằng số/con số đã lỗi thời.
- `test/fsrs-optimizer.integration.test.js` — Test K mới (cần Postgres thật): dựng lại ĐÚNG kịch bản
  bug bằng cách ép `FSRS_OPTIMIZER_WORKER_BUDGET_MS=1`, xác nhận job thật sự chuyển `status='queued'`
  sau continuation, và invocation mới claim lại thành công NGAY (không tốn oan attempt). Test này
  **không cần** native binding cài được (guard trigger trước khi chạm `computeParameters()`).

## Đã KHÔNG đổi

FSRS scheduler, review history, checkpoint/attempt/heartbeat/stale-recovery/atomic-claim (kiến trúc
tổng thể V86 vẫn đúng, chỉ sửa 1 lỗ hổng cụ thể + hiệu chỉnh số), Apply/Rollback/Reset, `vercel.json`.

## Đã kiểm chứng được (sandbox này — không có Postgres/Vercel thật)

`node --check` PASS toàn bộ file sửa. Test tĩnh mới (không cần Postgres) chạy PASS trong stub `pg`/
`ts-fsrs`/`@vercel/functions` — xác nhận qua source thật rằng UPDATE reset status hiện đã tồn tại ĐÚNG
vị trí. Toàn bộ 47 test cũ (V86/V87/V88) vẫn PASS sau khi hiệu chỉnh — không có regression.

## Bạn cần tự làm

1. Deploy bản này, chạy lại Optimizer trên dữ liệu thật (833 thẻ) — kỳ vọng: hoặc hoàn tất trong 1
   invocation (~10-40s tuỳ tốc độ hội tụ), hoặc tự chuyển tiếp mượt qua 2 invocation nếu prepare chậm
   bất thường — KHÔNG còn kẹt ở "mất heartbeat" do continuation không hoạt động.
2. Nếu deployment THẬT đang ở Pro/Enterprise (không phải Hobby), có thể nới `FSRS_OPTIMIZER_TIMEOUT_MS`/
   `FSRS_OPTIMIZER_WORKER_BUDGET_MS`/`FSRS_OPTIMIZER_MIN_TRAIN_BUDGET_MS` lớn hơn qua Vercel
   Environment Variables để tận dụng ngưỡng cao hơn — mặc định mới ưu tiên AN TOÀN cho Hobby.
3. Chạy `DATABASE_URL=... npm run test:optimizer:integration` để xác nhận Test K (bug thật) PASS trên
   Postgres thật trước khi deploy production.
4. Theo dõi log `[fsrs-optimizer] {"stage":"JOB_RETRY",...note:"hết ngân sách sau prepare"...}` sau khi
   deploy — nếu vẫn thấy THƯỜNG XUYÊN (không chỉ hiếm hoi), nghĩa là ngay cả 35s compute-timeout mới
   cũng không đủ cho dataset thật — cân nhắc dataset đã lớn tới mức cần kiến trúc bền hơn (Vercel
   Queues) thay vì tiếp tục ép vừa trong 1 HTTP Function.
