# V83-FIX-v3/v4 — FSRS Optimizer trên Vercel: root cause + fix (đã research thật, không đoán API)

*(v3 = phần chính bên dưới, sửa "Cannot find module" — ĐÃ XÁC NHẬN xong qua ảnh chụp màn hình thật.
v4 = mục ADDENDUM cuối file, sửa lỗi MỚI phát hiện sau khi v3 chạy trên production — CHƯA xác nhận.)

Khác với "FIXED-v2" (comment cũ trong code tự thừa nhận viết mà không có mạng để kiểm chứng gì cả),
lần sửa này tôi đã **web-search tài liệu THẬT** của `@open-spaced-repetition/binding` (trang npm,
GitHub `open-spaced-repetition/ts-fsrs`, tài liệu chính thức napi-rs) và hành vi thật của Vercel
(GitHub Discussions/Vercel docs) trước khi sửa — không đoán mò tên hàm/field như trước.

**Giới hạn môi trường tôi đang chạy (giống hệt lần trước, tôi nói thẳng ra thay vì lờ đi):** không
có mạng trong sandbox để `npm install`/deploy Vercel/gọi API production của bạn. Vì vậy phần
"PRODUCTION" ở cuối file này là checklist BẠN cần tự chạy — xem `TROUBLESHOOTING-FSRS-OPTIMIZER.md`.

## FILES MODIFIED
- `package.json` — thêm `@open-spaced-repetition/binding-wasm32-wasi` vào `optionalDependencies`;
  thêm script `postinstall`/`verify:optimizer-binding`.
- `scripts/verify-optimizer-binding.js` (MỚI) — chẩn đoán build-time, in vào Vercel Build Logs.
- `vercel.json` — thêm `"framework": null`; `installCommand` tự chuyển `npm ci` khi có lockfile.
- `lib/fsrs/optimizer.js` — viết lại loader (`loadOfficialOptimizer`/`getOptimizerEngineStatus`),
  mở rộng `getOptimizerStatus()` với `optimizerEngineState`/`engineStatus`.
- `test/fsrs-optimizer.binding.smoke.test.js` — thêm bước test `getOptimizerEngineStatus()`.
- `js/fsrs-optimizer.js` — hiện badge engine (native/WASI), root cause chi tiết chỉ cho admin.
- `docs/fsrs.md` — thêm mục 11.1 (deploy notes).
- `TROUBLESHOOTING-FSRS-OPTIMIZER.md` (MỚI) — checklist xác nhận production, dành cho bạn tự chạy.

## ROOT CAUSE (xác minh qua tài liệu thật, không đoán)
1. **WASI fallback chưa từng tồn tại thật**: package base KHÔNG tự động kéo theo
   `@open-spaced-repetition/binding-wasm32-wasi` qua optionalDependencies — tài liệu npm chính thức
   ghi rõ phải cài gói này THỦ CÔNG. Bản trước chỉ khai báo `@open-spaced-repetition/binding` nên
   nếu native fail, không có gì để rơi xuống cả — dù comment cũ tưởng là có.
2. **`includeFiles` có thể bị Vercel âm thầm bỏ qua**: xác nhận qua GitHub Discussions của
   Vercel/Next.js — nếu Framework Preset (tự nhận diện hoặc set tay trên Dashboard) không phải
   "Other", `functions.includeFiles` bị bỏ qua, chỉ log 1 dòng cảnh báo dễ bị lướt qua. `vercel.json`
   trước đó không ép `framework`, nên nếu Vercel từng tự nhận nhầm 1 preset khác, việc thêm
   `includeFiles` ở lần sửa trước sẽ KHÔNG có tác dụng gì — khớp chính xác với triệu chứng bạn báo
   ("đã thêm includeFiles rồi mà vẫn lỗi y hệt").
3. **Dashboard Install Command override** (không thể tự kiểm tra thay bạn) — nếu bật, thắng
   `installCommand` trong `vercel.json`. Đã ghi vào checklist Bước 0 của
   `TROUBLESHOOTING-FSRS-OPTIMIZER.md`.
4. **`@open-spaced-repetition/binding/dynamic-wasi`** (đôi khi được nhắc tới như "cách dùng WASI") —
   xác nhận đây là API cho bundler trình duyệt (Vite `?url`/`?worker`), KHÔNG áp dụng cho Node
   server thuần — nên KHÔNG viết loader riêng cho nó (tránh lặp lại lỗi "tự viết loader" như brief
   đã cấm). Fallback WASI thật sự nằm TRONG loader do chính package sinh ra, kích hoạt tự động khi
   gói WASM có mặt (mục 1).

## FIX
- Thêm `binding-wasm32-wasi` vào `optionalDependencies` → kích hoạt fallback WASI CHÍNH THỨC có sẵn
  trong package, không tự viết loader.
- `"framework": null` trong `vercel.json` → đảm bảo `includeFiles` không bị bỏ qua vì lý do (2).
- `installCommand` tự chuyển `npm ci` khi có lockfile thật (bạn tự tạo — xem lý do ở mục LOCAL).
- Viết lại loader thành `loadOfficialOptimizer()` — trả về diagnostic đầy đủ (available/engine/
  node/platform/arch/glibc/error/nativeBinary/wasmAssetPresent), dùng CHUNG bởi cả
  `trainWithOfficialOptimizer()` (throw lỗi rõ ràng, không fallback approximation) và
  `getOptimizerEngineStatus()` (hiển thị cho UI trước khi user bấm Run).
- `postinstall` chạy `scripts/verify-optimizer-binding.js` — in chẩn đoán vào Build Logs của Vercel,
  mặc định KHÔNG chặn deploy (optimizer là tính năng phụ, không nên làm sập cả app), tuỳ chọn
  `FSRS_OPTIMIZER_STRICT_BUILD=1` để bắt buộc build fail khi thiếu.
- `getOptimizerStatus()` trả thêm `optimizerEngineState` (4 giá trị: `OPTIMIZER_NATIVE_READY` /
  `OPTIMIZER_WASI_READY` / `OPTIMIZER_READY` / `OPTIMIZER_UNAVAILABLE`) — giữ nguyên field cũ
  `bindingAvailable`/`bindingVersion` để không phá tương thích UI hiện tại.
- UI (`js/fsrs-optimizer.js`): hiện badge engine cho mọi user; hiện thêm root cause kỹ thuật (lỗi
  gốc, node/platform/arch/glibc, tên gói native kỳ vọng) CHỈ cho admin (`isAdminRole()`), tuân theo
  yêu cầu "báo root cause ngắn gọn cho admin" mà không lộ chi tiết kỹ thuật cho user thường.

## OPTIMIZER ENGINE
- **Chưa xác định được** (Native hay WASI) — phụ thuộc runtime THẬT của Vercel, tôi không deploy
  được để biết. `GET /api/fsrs-optimizer/status` trên production của bạn sẽ trả lời chính xác qua
  field `optimizerEngineState`.

## LOCAL (trong sandbox sửa code — không có `node_modules` thật, không có mạng)
- `npm ci` / `npm install`: **KHÔNG CHẠY ĐƯỢC** (không có mạng) — không tự đánh giá PASS/FAIL được.
- binding smoke test (`test/fsrs-optimizer.binding.smoke.test.js`): **KHÔNG CHẠY ĐƯỢC** với package
  thật (lý do như trên). ĐÃ tự kiểm chứng logic của `loadOfficialOptimizer`/`trainWithOfficialOptimizer`
  bằng cách viết 1 module giả (`@open-spaced-repetition/binding` fake) lập trong `/tmp`, chạy qua cả
  3 hình dạng kết quả (`array`, `{parameters}`, `{w}`) + kịch bản module hoàn toàn thiếu — logic
  PASS, sau đó ĐÃ XOÁ SẠCH module giả (không có trong sản phẩm giao bạn, đúng cam kết "không mock").
- Toàn bộ file `.js`/`.json` trong project: `node -c` (kiểm tra cú pháp) — PASS 100%.
- integration test (`test/fsrs-optimizer.integration.test.js`, cần Postgres thật): **KHÔNG CHẠY
  ĐƯỢC** (không có `DATABASE_URL`) — không đổi logic phần này nên rủi ro thấp, nhưng bạn nên tự
  chạy lại sau khi deploy.

## PRODUCTION (BẠN tự làm — xem `TROUBLESHOOTING-FSRS-OPTIMIZER.md` để biết cách đọc kết quả)
- Vercel runtime: **chưa biết** — script chẩn đoán sẽ tự in ra trong Build Logs sau khi bạn deploy.
- binding status: **CHƯA XÁC NHẬN** — cần Bước 1+2 trong `TROUBLESHOOTING-FSRS-OPTIMIZER.md`.
- optimizer status: **CHƯA XÁC NHẬN** — cần bấm Run Optimizer thật trên UI production.

## ADDENDUM (V83-FIX-v4) — ảnh chụp màn hình production thật đã xác nhận 1 phần + phát hiện lỗi mới

Bạn đã deploy bản v3 và gửi ảnh chụp màn hình THẬT. Cập nhật:

**Đã xác nhận (không còn là giả thuyết):** badge "⚙️ Engine: Native (nhanh nhất)" lên xanh trên
chính production của bạn — root cause gốc ("Cannot find module") **ĐÃ HẾT THẬT**.

**Lỗi MỚI phát hiện khi bấm Run Optimizer trên dataset thật:** response trả về KHÔNG PHẢI JSON
("Unexpected token 'A', "A server e"... is not valid JSON"). Suy luận từ chính code (không đoán):
app LUÔN trả JSON cho mọi lỗi tự bắt được, và nhánh lỗi trong `runOptimizer()` LUÔN ghi
`last_error` vào DB trước khi throw — nhưng ảnh chụp màn hình cho thấy `last_error` vẫn là lỗi CŨ
(pre-fix) → lần chạy mới nhất chưa từng chạm tới dòng ghi DB đó → **process bị dừng ở tầng hạ tầng**
(Vercel timeout SIGKILL, hoặc native crash/panic vượt ngoài try/catch JS) — nghi ngờ nhiều nhất là
timeout, vì dataset thật (~600+ thẻ train) lớn hơn nhiều so với dataset nhỏ của smoke test.

**Đã sửa thêm (FILES MODIFIED bổ sung so với v3):**
- `lib/fsrs/optimizer.js` — thêm `timeout`/`progress` (option THẬT của `computeParameters()`, xác
  nhận qua ví dụ chính thức trên npm) + log timing/tiến độ; thêm log mốc bắt đầu trong `runOptimizer()`.
- `js/fsrs-optimizer.js` — sửa 2 bug UI thấy được trong ảnh (nút kẹt ở "Đang chạy...", thông báo lỗi
  bị xoá mất do sai thứ tự render) + phân biệt rõ "response không phải JSON" (thường = timeout/crash
  hạ tầng) khỏi lỗi JSON có cấu trúc bình thường.
- `TROUBLESHOOTING-FSRS-OPTIMIZER.md` — thêm Bước 5 (đọc trước nếu gặp đúng lỗi non-JSON này).

Xem đầy đủ trong `TROUBLESHOOTING-FSRS-OPTIMIZER.md` → Bước 5. **Vẫn CHƯA thể coi là xong** — cần
bạn tự bấm Run lại trên production sau khi deploy bản này, và nếu vẫn lỗi, cần Vercel Function Logs
thật (tôi không tự xem được) để phân biệt "cần tăng timeout" khỏi "native crash không liên quan
thời gian" — đây là câu hỏi tôi KHÔNG thể tự trả lời chắc chắn thay bạn được.


**Tôi KHÔNG nói "đã sửa xong"** — tôi đã sửa dựa trên root cause có căn cứ thật (không đoán API lần
này), nhưng chỉ BẠN mới có thể xác nhận production thật sự load được optimizer, vì tôi không có
mạng/quyền truy cập Vercel hay Postgres của bạn trong phiên làm việc này. Làm theo
`TROUBLESHOOTING-FSRS-OPTIMIZER.md` — nếu `GET /api/fsrs-optimizer/status` trên production của bạn
trả `optimizerEngineState: "OPTIMIZER_NATIVE_READY"` hoặc `"OPTIMIZER_WASI_READY"`, lúc đó mới coi
là xong thật.

Nếu sau khi làm đúng cả 2 bước (Bước 0 dashboard + đọc Build Logs) mà `optimizerEngineState` vẫn là
`OPTIMIZER_UNAVAILABLE`, hãy dán lại cho tôi (1) đoạn Build Log của
`scripts/verify-optimizer-binding.js`, và (2) JSON đầy đủ trả về từ
`GET /api/fsrs-optimizer/status` — 2 thứ đó cho tôi đủ thông tin để chẩn đoán bước tiếp theo chính
xác, thay vì đoán tiếp.
