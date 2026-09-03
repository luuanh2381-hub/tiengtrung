# AUDIT-REPORT-V92-BROWSER-TRAINING-MIGRATION.md

Ngày: 2026-09-03. Trả lời cho yêu cầu "AUDIT V91 – FIX FSRS OPTIMIZER DỨT ĐIỂM" — dời hẳn việc train
(computeParameters()) từ Vercel Function sang trình duyệt.

---

## I. Audit kiến trúc trước khi sửa (theo đúng yêu cầu — audit trước, sửa sau)

Xác nhận lại bằng cách đọc thẳng source (không suy đoán): **chỉ có đúng 1 chỗ** gọi `computeParameters()`
phía server trước khi sửa — `lib/fsrs/optimizer.js`, hàm `trainWithOfficialOptimizer()`, gọi từ
`runOptimizerJob()`, kích hoạt bởi `POST /api/fsrs-optimizer/worker`. Không có chỗ nào khác.

Kết luận bắt buộc ở đầu yêu cầu (mục I) là **đúng**: cơ chế abort hiện tại (V90/V91) là cooperative
abort qua progress callback — `OPTIMIZER_TRAIN_ABORT_BUDGET_MS` KHÔNG cưỡng chế dừng
`computeParameters()` đúng deadline, chỉ là 1 lời đề nghị mà binding tự quyết định có tuân theo kịp hay
không. Tôi đã tự tra cứu lại tài liệu/mã nguồn thật của package (không dựa vào suy đoán cũ) và xác nhận:
`timeout` = tần suất polling (không phải thời gian train tối đa), cách hiểu này đã đúng từ V90.

## II. Vì sao heartbeat/retry (V90/V91) vẫn không giải quyết dứt điểm

V90/V91 sửa ĐÚNG cơ chế "dừng sạch khi hết ngân sách" và "phân loại đúng lỗi để không tốn oan lượt
retry" — nhưng KHÔNG có sửa nào ở tầng đó tạo thêm THỜI GIAN THẬT để train xong. Nếu bản thân việc
train (dù chạy native hay rơi vào WASI chậm hơn) cần nhiều thời gian hơn giới hạn cứng của Vercel
(60s Hobby / 300s Pro), thì dù abort/retry/heartbeat có đúng tuyệt đối, kết quả cuối cùng sau khi hết
số lần thử vẫn là thất bại — CHỈ khác là chết có kiểm soát hơn, không phải chết đột ngột. Đây là giới
hạn KIẾN TRÚC, không phải lỗi logic có thể vá thêm được nữa ở tầng heartbeat/retry. Kết luận này khớp
với mục I của yêu cầu.

**Không có log thật để xác nhận 100% dữ liệu 5121 review/893 card của bạn rơi vào tình huống nào** —
nhưng V91 đã có sẵn thông tin (`optimizerEngine`, `OPTIMIZER_ABORTED`, `preTrainOverheadMs`) để xác định
sau này nếu cần. Với hướng dời hẳn sang trình duyệt, không cần biết chính xác nguyên nhân cũ nữa vì giới
hạn thời lượng nhân tạo của Vercel không còn áp lên việc train.

## III. Kiến trúc mới — đã triển khai

```
Browser bấm "Run Optimizer"
  → POST /api/fsrs-optimizer/browser/prepare   (server: CHỈ load + validate dữ liệu, KHÔNG train)
  → trả về: train/validation/defaultWeights + assetUrls (URL thật, tính bằng require.resolve() ngay
    lúc trả lời — không đoán tên file)
  → Frontend tạo Web Worker (js/fsrs-optimizer-worker.js)
  → Worker: import dynamic-wasi entry → initOptimizer({wasm, worker}) → computeParameters() THẬT
  → Worker gửi progress → main thread cập nhật UI trực tiếp + gửi keepalive định kỳ lên server
  → Worker xong → POST /api/fsrs-optimizer/browser/commit {jobId, weights}
  → Server validate NGHIÊM NGẶT (ownership + shape) → tự tính lại improvement/recommend/score từ dữ
    liệu đã lưu sẵn lúc prepare (KHÔNG tin số nào client tự khai) → lưu candidate (dùng lại
    finishJobWithCandidate() — HÀM CŨ, không sửa)
  → User vẫn bấm Apply thủ công như trước (KHÔNG đổi)
```

`lib/fsrs/scheduler.js`, `lib/fsrs.js`, `reviewService.js` — **không đụng dòng nào** (Phần IV).
2 route `/run` và `/worker` cũ — **giữ nguyên, không xoá** (Phần V, tương thích ngược) — chỉ đơn giản
là frontend không còn gọi tới nữa, nên trong THỰC TẾ sản phẩm không còn 2 optimizer nào chạy song song.

## IV. File đã sửa / tạo mới

| File | Thay đổi |
|---|---|
| `lib/fsrs/optimizer.js` | Thêm 5 hàm mới: `prepareOptimizerData`, `createBrowserOptimizerJob`, `updateBrowserJobHeartbeat`, `cancelBrowserJob`, `commitBrowserOptimizerResult` + hằng số `BROWSER_WORKER_SENTINEL`. Sửa `recoverStaleJobsForUser()` thêm nhánh xử lý riêng job browser (mất keepalive → failed thẳng, KHÔNG requeue). Không sửa dòng nào của đường server-training cũ. |
| `api/index.js` | Thêm import `fs`/`path`. Thêm 4 route hành động (`browser/prepare`, `browser/heartbeat`, `browser/cancel`, `browser/commit`) + 2 route serve file (`browser/pkg/binding/*`, `browser/pkg/binding-wasm32-wasi/*`) + hàm tính URL asset động `computeBrowserOptimizerAssetUrls()`. |
| `js/fsrs-optimizer.js` | Viết lại `runOptimizerNow()` để gọi `/browser/prepare` + tạo Worker thay vì `/run`+`/worker` cũ. Thêm `runBrowserOptimizerWorker()`, `cancelOptimizerRun()`, `updateOptimizerLiveProgress()`. Thêm nút Hủy + 2 id trong khối tiến độ. Thêm nhãn trạng thái "cancelled". |
| `js/fsrs-optimizer-worker.js` | **File mới** — Web Worker chạy thật `computeParameters()` qua WASM/WASI trong trình duyệt. |
| `vercel.json` | Thêm header `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` cho toàn site (Phần VIII — bắt buộc theo tài liệu chính thức của package). |
| `index.html` | Thêm `crossorigin="anonymous"` vào thẻ Google Fonts stylesheet + script cdnjs xlsx — **biện pháp phòng ngừa** để 2 tài nguyên cross-origin này không bị COEP chặn (xem mục VI, rủi ro cần bạn tự xác nhận). |
| `test/fsrs-optimizer.test.js` | +8 test mới (validate sớm không cần DB, cấu trúc source, thứ tự nhánh stale). Sửa 1 test đếm `PublicError` (6→10, do tôi tự phát hiện lúc chạy lại toàn bộ test suite — xem mục V). |
| `test/fsrs-optimizer.integration.test.js` | +7 kịch bản test mới (cần Postgres thật — xem mục V). |
| `test/fsrs-optimizer-frontend.smoke.test.js` | +3 test mới cho UI mới (nút Hủy, không còn gọi route cũ, tạo đúng Worker). |
| `AUDIT-REPORT-V92-BROWSER-TRAINING-MIGRATION.md`, cập nhật `CLAUDE-CHANGES.md` | File báo cáo. |

## V. Test đã chạy + kết quả

**Chạy được thật, 100% xanh:**
- `node --check` toàn bộ file `.js` trong project (kể cả file mới) — không lỗi cú pháp.
- `vercel.json` — JSON hợp lệ.
- `test/fsrs.test.js`: 19/19 PASS.
- `test/fsrs-optimizer.test.js`: 72/72 PASS (dùng bản giả lập tối thiểu của `pg`/`ts-fsrs`/binding vì
  sandbox sửa code không có mạng để cài package thật — chỉ kiểm được ĐÚNG luồng logic, không phải toán
  học FSRS/WASM thật; đã ghi rõ trong AUDIT-REPORT vòng trước).
- `test/fsrs-optimizer-frontend.smoke.test.js`: 21/21 PASS — chạy THẬT source `js/fsrs-optimizer.js`
  qua Node `vm` với DOM giả tối giản (kỹ thuật có sẵn từ trước, không phải tôi tạo).
- **Tự bắt được 1 lỗi do tôi gây ra**: thêm 4 hàm mới dùng `PublicError` khiến 1 test đếm cứng
  "phải có đúng 6 chỗ throw PublicError" FAIL — đây là test cố ý ("nếu số này đổi trong tương lai, cập
  nhật lại"), tôi cập nhật thành 10 và ghi rõ lý do trong chính test đó.

**KHÔNG chạy được trong sandbox này** (đúng như đã nói ở báo cáo vòng trước, không đổi):
- `test/fsrs-optimizer.integration.test.js` (cần `DATABASE_URL` thật) — đã VIẾT SẴN 7 kịch bản mới cho
  toàn bộ flow browser-training (tạo job/keepalive đúng-sai chủ/commit đúng-sai chủ/weights sai bị chặn
  không làm hỏng job/hủy/job bị bỏ rơi → failed thẳng không requeue) — **bạn cần tự chạy** file này với
  `DATABASE_URL` thật để xác nhận (`npm run test:optimizer:integration` hoặc tương đương).
- `test/fsrs-optimizer.binding.smoke.test.js` — cần package native/WASM thật cài trên máy.

**KHÔNG THỂ xác minh trong SANDBOX SỬA CODE, dù bạn có test:**
- Toàn bộ phần trình duyệt thật: `import()` file `dynamic-wasi` qua URL server tính, `initOptimizer()`
  có thực sự trả đúng `computeParameters()` hay không, WASM có load được trong Worker lồng Worker hay
  không, header COOP/COEP có làm hỏng font/script cdnjs hiện có hay không, hiệu năng/bộ nhớ trên Android
  Chrome với 5121 review. **Đây LÀ đúng phần "Phần XIV — KHÔNG ĐƯỢC TUYÊN BỐ DONE NẾU CHƯA TEST" của bạn
  — tôi KHÔNG tuyên bố các phần này đã chạy được, chỉ tuyên bố đã viết đúng theo tài liệu chính thức đã
  tra cứu, syntax đúng, và logic phía server đã kiểm được.**

## VI. Rủi ro lớn nhất cần bạn tự kiểm tra đầu tiên sau khi deploy

**Header COEP (`require-corp`) áp dụng cho TOÀN SITE** (vì đây là 1 trang HTML duy nhất, không tách
được riêng trang optimizer) — trang hiện đang tải Google Fonts + 1 script từ cdnjs.cloudflare.com. Tôi
đã thêm `crossorigin="anonymous"` cho cả 2 (biện pháp tiêu chuẩn, rủi ro thấp vì 2 CDN này vốn đã hỗ trợ
CORS công khai từ lâu) nhưng **tôi không có trình duyệt để tự xác nhận** font và tính năng dùng thư viện
xlsx vẫn hoạt động bình thường sau khi bật COEP. **Đề nghị**: deploy lên 1 preview deployment của Vercel
trước (Vercel tự tạo cho mỗi lần push), tự mở bằng điện thoại Android Chrome, kiểm tra: (1) chữ có hiện
đúng font không, (2) tính năng liên quan tới xlsx (nếu có dùng) còn hoạt động không, (3) bấm Run
Optimizer thật xem có tải được WASM và train thành công không — TRƯỚC khi merge vào production.

## VII. Checklist Phần X (18 mục bạn yêu cầu) — mục nào đã có test tự động, mục nào cần bạn tự tay thử

| # | Mục | Trạng thái |
|---|---|---|
| 1-4 | browser optimizer init/WASM load/Worker startup/dataset lớn | ❌ Cần bạn tự thử trên trình duyệt thật |
| 5-6 | computeParameters trả đúng 21 số hữu hạn | ✅ Test tự động (giả lập) + validate server-side thật (`isValidWeightsArray`) |
| 7 | validation evaluation | ✅ Dùng lại `evaluateWeights()` đã có test từ trước |
| 8-9 | commit weights / Apply | ✅ Test tự động (integration, cần bạn tự chạy) + Apply dùng nguyên hàm cũ không đổi |
| 10-11 | Rollback / Reset | ✅ Không đổi, dùng nguyên hàm cũ |
| 12 | cancel worker | ✅ Test tự động (integration) cho phần server; ❌ phần `Worker.terminate()` thật cần thử tay |
| 13 | reload trong lúc training | ✅ Test tự động (integration) xác nhận job → failed sau khi mất keepalive |
| 14-15 | double click Run / 2 tab cùng Run | ✅ Test tự động (integration) |
| 16 | invalid weights từ client | ✅ Test tự động (cả unit lẫn integration) |
| 17-18 | job id / candidate của user khác | ✅ Test tự động (integration) |

## VIII. Hướng dẫn deploy

1. Đưa toàn bộ file đã sửa lên GitHub, deploy lại Vercel như bình thường — **không cần lệnh đặc biệt**.
2. **Không cần migration database** — không có bảng/cột mới, chỉ dùng lại cột có sẵn theo cách khác.
3. Xác nhận `@open-spaced-repetition/binding-wasm32-wasi` cài thành công trong Build Logs của Vercel
   (đây là optionalDependency có sẵn từ trước — kiểm tra không bị bỏ qua do lỗi kiến trúc CPU/OS).
4. Test theo đúng thứ tự ở mục VI trước khi coi là xong.
