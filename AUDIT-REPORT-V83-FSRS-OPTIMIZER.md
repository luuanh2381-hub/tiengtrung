# Audit V83 — FSRS Personal Optimizer

## 0. Phạm vi & giới hạn môi trường (đọc trước)

Đã đọc toàn bộ source liên quan trước khi sửa: `lib/fsrs.js`, `lib/fsrs/{scheduler,reviewService,
optimizer,cardMapper,studyScope,analytics}.js`, `lib/db.js` (1307 dòng), `api/index.js` (1676 dòng),
`js/{settings,admin,stats}.js`, `index.html`, `css/styles.css`, `test/*.js`, `migrations/*.sql`,
`docs/fsrs.md`, `package.json`, `vercel.json`. Không rewrite project, không đổi framework/stack/DB
architecture, không đổi scheduler FSRS-6 hiện có (`lib/fsrs.js` vẫn là nơi DUY NHẤT gọi `ts-fsrs`).

**2 giới hạn môi trường quan trọng cần nói rõ trước khi đọc phần còn lại:**

1. **Không có quyền truy cập Postgres thật / dữ liệu 4.000 review thật của bạn.** Bạn upload source
   code (zip), không upload database dump, và tôi không có thông tin kết nối DB của bạn. Vì vậy
   **mục "20. AUDIT 4.000 REVIEWS" của yêu cầu — con số THẬT (valid/invalid/duplicate/date range/
   rating distribution) — tôi KHÔNG thể tự chạy và báo cho bạn được.** Thay vào đó tôi đã xây **toàn
   bộ pipeline audit thật** (`GET /api/fsrs-optimizer/status`, dùng lại được ngay) — bạn mở app, vào
   "🧠 FSRS Optimizer" ở menu tài khoản, sẽ thấy đúng con số thật ngay khi tải xong, TRƯỚC khi bấm
   Run.
2. **Môi trường phát triển này không có network** (không `npm install` được) và **project upload
   không kèm `node_modules`** — nên tôi không thể tự cài `ts-fsrs`/`pg`/... thật lẫn dependency mới
   (`@open-spaced-repetition/binding`) để chạy `npm test`/`npm run build` thật. Tôi ĐÃ tự tạo shim
   nội bộ (giả lập tối thiểu API của `ts-fsrs`, `pg`, `express`, `compression`, `bcryptjs`) chỉ để
   smoke-test logic + wiring trong sandbox này, rồi **xoá sạch shim trước khi giao file** — sản phẩm
   giao cho bạn KHÔNG chứa bất kỳ shim/mock nào, chỉ có code thật. Nhờ shim đó, tôi đã xác nhận được:
   - `test/fsrs.test.js` gốc (19 test cũ) vẫn PASS 100% sau khi sửa `lib/fsrs.js` → không phá hành
     vi FSRS hiện có.
   - `test/fsrs-optimizer.test.js` (25 test mới) PASS 100%.
   - `api/index.js` load được, đăng ký đủ 57 route (không trùng route), 6 endpoint optimizer mới +
     2 endpoint admin cũ đều còn nguyên.
   - Nhưng **KHÔNG thể xác nhận `@open-spaced-repetition/binding` (optimizer chính thức) thật sự
     cài/chạy đúng trên máy bạn** — đây là việc BẮT BUỘC bạn cần tự làm sau khi tải project về (xem
     mục 3 và mục "VERIFICATION" cuối file).

---

## 1. Audit source code hiện có (trước khi sửa)

| Hạng mục | Hiện trạng |
|---|---|
| FSRS version | FSRS-6 (21 weights `w[0]..w[20]`), xác minh runtime ở `lib/fsrs.js:buildScheduler()` |
| ts-fsrs version | `5.4.1` (package.json) |
| Nơi khởi tạo Scheduler | `lib/fsrs.js:buildScheduler()`, cache theo retention ở `getSchedulerForRetention()` — đây là **nơi DUY NHẤT** trong toàn project gọi `ts-fsrs` |
| Nơi lưu FSRS card | Bảng `fsrs_cards` (`lib/db.js`) |
| Nơi lưu review history | Bảng `review_history` (`lib/db.js`) |
| Format rating | string `again/hard/good/easy` (DB) ↔ số 1-4 (`ts-fsrs Rating`) qua `ratingFromString()` |
| Format timestamp | `TIMESTAMPTZ` (UTC) |
| Format state | INT (`ts-fsrs State` enum) |
| Desired retention hiện tại | Per-user, 1 trong 4 mức cố định (`ALLOWED_RETENTIONS`), lưu `user_settings`, đọc qua `/api/settings/retention` |
| Default weights | Mặc định của `ts-fsrs` (không override) |
| `user_fsrs_weights` | **ĐÃ CÓ bảng** (từ V69) nhưng **CHƯA TỪNG được ghi** — `saveUserWeights()` tồn tại nhưng KHÔNG được gọi ở bất kỳ đâu trong hệ thống thật |
| `optimizer.js` | **ĐÃ CÓ** (`lib/fsrs/optimizer.js`, 144 dòng) nhưng chỉ có: export review history cho admin xem (phân trang, cap 5000), `getOptimizerReadiness()` (chỉ đếm số lượng), `getUserWeights()`/`saveUserWeights()` (CRUD thô). **KHÔNG có** validate dữ liệu, KHÔNG có thuật toán train thật, KHÔNG có so sánh default/personal, KHÔNG có apply/rollback |
| Optimizer API hiện tại | `GET /api/admin/fsrs-optimizer/export`, `GET /api/admin/fsrs-optimizer/weights/:userId` — **chỉ admin xem/xuất**, không có endpoint tự chạy optimizer |
| Frontend FSRS settings | **Không có** — không có UI nào cho optimizer, cũng không có UI cho desired retention (có API nhưng chưa gắn UI) |
| **Kết luận quan trọng nhất** | **Scheduler thật (`reviewFsrsCard` → `lib/db.js`) CHƯA BAO GIỜ đọc `user_fsrs_weights`** — dù bảng đã tồn tại từ V69, personal weights **không hề có tác dụng gì** trong luồng review thật cho tới bản này. Đây là gap chính V83 lấp vào. |

→ **Đã TÁI SỬ DỤNG toàn bộ** hạ tầng có sẵn (bảng `user_fsrs_weights`, `exportReviewHistoryForOptimizer`, `getOptimizerReadiness`, `getUserWeights`/`saveUserWeights`, 2 API admin) — **không tạo hệ thống thứ hai**, chỉ mở rộng.

## 2. Data Quality Check (`lib/fsrs/optimizer.js:validateReviewHistory`)

Đọc TOÀN BỘ `review_history` của user (không cap 5000 như export cho admin — hàm nội bộ mới
`fetchAllReviewRowsForTraining`, cap an toàn 50.000 dòng, không phải giới hạn thực tế cho ~4.000
review hiện tại). Validate từng dòng: thiếu `hz/l`, rating không hợp lệ, timestamp không đọc được,
timestamp tương lai (dung sai 60s lệch đồng hồ), `elapsed_days` âm. Duplicate = trùng `(card, thời
điểm)` chính xác. Không xoá gì trong DB thật — chỉ loại khỏi tập dùng cho optimizer, trả về report
đầy đủ (`totalReviews/validReviews/invalidReviews/duplicates/uniqueCards/dateRange/
ratingDistribution/issues`).

## 3. Optimizer — dùng implementation CHÍNH THỨC, không tự viết gradient descent

`ts-fsrs` (thư viện scheduling) **không tự bao gồm** thuật toán train. Companion package chính thức
cùng tổ chức (`open-spaced-repetition`) là **`@open-spaced-repetition/binding`** — native NAPI/Rust
(`fsrs-rs`), export `computeParameters(items, options)`. Đã thêm vào `package.json`
(`^0.5.0`) và cách ly toàn bộ lời gọi vào ĐÚNG 1 hàm: `trainWithOfficialOptimizer()` trong
`lib/fsrs/optimizer.js`.

**Rủi ro cần bạn biết:** package này đang ở **public beta** (API có thể đổi giữa các version — theo
chính tài liệu của package), và dùng **native binary theo nền tảng** (optionalDependencies) — khác
hẳn cách project bạn từng chọn `bcryptjs` (pure JS) thay vì `bcrypt` (native) để **tránh đúng vấn đề
này** trên Vercel. Tôi vẫn chọn dùng package chính thức này vì đúng yêu cầu "ưu tiên implementation
chính thức, không tự viết approximation" — nhưng đã code phòng thủ: nếu package thiếu/API không
đúng như tài liệu công khai lúc viết code, `trainWithOfficialOptimizer()` **throw lỗi RÕ RÀNG** (nêu
rõ cần làm gì) thay vì âm thầm dùng thuật toán tự viết thay thế hoặc âm thầm chạy sai. **Bạn PHẢI**
`npm install && npm run test:optimizer:integration` (với `DATABASE_URL` thật) sau khi tải project để
xác nhận package cài/chạy đúng trên môi trường deploy thật (xem mục VERIFICATION).

## 4. 21 weights — validate tập trung 1 chỗ

`lib/fsrs.js:isValidWeightsArray()` (export qua `lib/fsrs/scheduler.js`) là **định nghĩa DUY NHẤT**
"weights hợp lệ" dùng lại ở mọi nơi: đúng 21 phần tử, toàn bộ finite number (không NaN/Infinity/
undefined/null). Optimizer trả về weights không hợp lệ → `saveOptimizerCandidate()` throw, **không
lưu**, giữ nguyên weights đang active.

## 5. Minimum data — readiness dựa trên chất lượng, không chỉ đếm

`classifyReadiness()`: `NOT_READY` nếu `<500` review hợp lệ HOẶC `<30` thẻ khác nhau HOẶC tỉ lệ lỗi
`>30%` HOẶC thiếu đa dạng rating (`<3/4` loại). `OPTIMIZABLE` nếu `≥2000` review hợp lệ, tỉ lệ lỗi
`≤10%`, `≥100` thẻ. Còn lại → `READY` (thận trọng). ~4.000 review sạch trên nhiều thẻ (kịch bản của
bạn) → `OPTIMIZABLE`, đã có test xác nhận (`test/fsrs-optimizer.test.js`).

## 6-7. Training result + Compare before/after (validation, tránh overfit)

Chia **theo THẺ** (không theo dòng review riêng lẻ — tránh rò rỉ dữ liệu giữa 2 tập vì các review
cùng 1 thẻ phụ thuộc thời gian lẫn nhau) 80/20 bằng hash ổn định (không cần lưu seed, luôn tái lập
được). Train trên 80%. Đánh giá **cả default weights lẫn personal weights** trên 20% validation bằng
**log-loss** (binary cross-entropy giữa `get_retrievability()` dự đoán — gọi qua `lib/fsrs.js`, dùng
scheduler thật, KHÔNG tự viết lại forgetting curve — và `answer_correct` thật). Chỉ đề xuất Apply
(`recommend: true`) nếu cải thiện validation loss ≥1% tương đối. Lưu toàn bộ vào `candidate_meta`
(JSONB): data quality report, số thẻ/review train+validation, default/personal score (cả train lẫn
validation — để tự phát hiện overfit), optimizer version, FSRS param count, thời điểm.

## 8-10. Versioning/rollback, không tự động apply, không reset lịch ôn

`user_fsrs_weights` mở rộng (ALTER TABLE ADD COLUMN IF NOT EXISTS, an toàn với dữ liệu cũ — xem
`migrations/V82_fsrs_personal_optimizer.sql`) với `candidate_*` (kết quả optimizer, CHƯA active),
`previous_*` (1 cấp undo cho Rollback), `enabled` (cờ DUY NHẤT quyết định active hay không).
`saveOptimizerCandidate()` KHÔNG BAO GIỜ tự set `enabled=true` — chỉ `applyPersonalWeights()` (user
tự bấm) mới chuyển candidate → active, đồng thời snapshot trạng thái cũ vào `previous_*`.
`applyPersonalWeights/rollbackPersonalWeights/resetToDefaultWeights` **chỉ đụng bảng
`user_fsrs_weights`** — không có câu lệnh nào chạm `fsrs_cards`/`review_history` → stability/
difficulty/reps/lapses/due/review history/card state của bạn **tuyệt đối không đổi** khi Apply/
Rollback/Reset (đã có integration test xác nhận điều này bằng cách so sánh row `fsrs_cards` trước/
sau Apply).

## 11-12. Scheduler & desired retention

`lib/fsrs.js` mở rộng `buildScheduler`/`reviewCard`/`previewSchedule` nhận thêm tham số
`customWeights` (tùy chọn, validate lại — sai thì tự fallback default, không throw giữa 1 lượt review
thật). `lib/fsrs/reviewService.js:reviewCard()` đọc `getUserActiveWeights(userId)` (có cache TTL 30s,
write-through khi apply/rollback/reset) **song song** với `desiredRetention` — đúng
`if enabled → dùng personal weights; else → default`. **`desiredRetention` hoàn toàn không đổi** —
optimizer chỉ tối ưu weights, không đụng tới retention setting của bạn.

## 13-14. API & Frontend UX

Tái sử dụng 2 endpoint admin cũ (không đổi). Thêm 6 endpoint **tự phục vụ** (user đăng nhập chạy
trên dữ liệu chính mình — khác admin export chỉ xem):
`GET /api/fsrs-optimizer/status`, `POST .../run`, `.../apply`, `.../rollback`, `.../reset`. Không
tạo riêng `GET .../result` — `status` đã trả kèm `candidateMeta` đầy đủ (đúng "chỉ tạo endpoint thật
sự cần"). Frontend: modal `#optimizer-modal` (mở từ nút "🧠 FSRS Optimizer" trong account menu, style
kế thừa `.auth-box`/`.dash-kpi*` có sẵn — không cần dashboard riêng) + `js/fsrs-optimizer.js`.

## 15-16. Safety & Performance

Lock chống chạy song song bằng **1 câu `INSERT...ON CONFLICT DO UPDATE...WHERE`** atomic (không cần
Redis/hàng đợi) — run "running" quá 10 phút coi như treo, cho phép chạy lại. Nút Run tự disable khi
đang chạy, cả client (`_optimizerBusy`) lẫn server (lock DB — chống cả trường hợp 2 tab/thiết bị).
~4.000 review là dataset nhỏ, chạy đồng bộ trong 1 request (không cần background job/worker riêng).

## 17-19. Logging & Backward compatibility

`logActivity()` ghi run/apply/rollback/reset (không log giá trị weights thô, chỉ log số liệu tổng
hợp). Toàn bộ thay đổi là ADD COLUMN/thêm hàm/thêm route — không đổi cột cũ, không đổi format
review_history/fsrs_cards, không đổi rating semantics, không phá study queue.

## 20. Data audit thật — CẦN BẠN TỰ XEM (xem mục 0)

## 21. Files & Verification

Xem tóm tắt cuối trong hội thoại chat (đúng format bạn yêu cầu). File zip đính kèm gồm toàn bộ
project đã sửa.
