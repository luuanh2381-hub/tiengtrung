# FSRS Optimizer trên Vercel — cách tự xác nhận (V83-FIX-v4)

Đọc file này SAU khi đã đọc `AUDIT-REPORT-V83-FSRS-OPTIMIZER-v4.md` (root cause + danh sách file đã
sửa). File này CHỈ tập trung vào: **bạn tự chạy các bước nào để chứng minh production đã load được
optimizer thật** — vì môi trường sửa code này không có mạng, không có Vercel CLI, không có
`DATABASE_URL`/URL production của bạn, nên KHÔNG có cách nào tôi tự deploy/tự gọi API production để
xác nhận thay bạn. Đây là điều BẮT BUỘC phải tự làm (đúng yêu cầu gốc: "KHÔNG nói đã sửa nếu chưa
chứng minh được production").

**Bạn đã deploy bản v3 và gửi ảnh chụp màn hình thật — Bước 5 (bên dưới) là phần MỚI, đọc trước
tiên nếu bạn đang gặp đúng lỗi "Unexpected token 'A'... is not valid JSON".**

## Bước 0 — Kiểm tra 2 cấu hình dễ bị bỏ sót nhất trên Dashboard Vercel

Đây là 2 nguyên nhân phổ biến khiến "sửa `vercel.json` rồi mà deploy vẫn y hệt lỗi cũ":

1. **Project Settings → General → Framework Preset** — phải là **"Other"**. Nếu Vercel tự nhận
   nhầm 1 framework khác, nó **âm thầm bỏ qua `functions.includeFiles`**, chỉ log 1 dòng cảnh báo
   dạng `Ignoring function property "includeFiles"` trong Build Logs (dễ bị lướt qua). Bản sửa lần
   này đã thêm `"framework": null` vào `vercel.json` để ép cứng "Other" — nhưng bạn vẫn nên tự nhìn
   lại Dashboard 1 lần để chắc chắn.
2. **Project Settings → Build & Development Settings → Install Command** — nếu nút **Override**
   đang BẬT với 1 lệnh khác trong Dashboard, giá trị Dashboard **THẮNG** `installCommand` trong
   `vercel.json` (Vercel docs: "Build & Development Settings are only applied to zero-configuration
   deployments" — dashboard override vẫn áp dụng ngay cả khi có `installCommand` trong file). Tắt
   Override đi (hoặc sửa cho khớp) để chắc chắn `rm -rf node_modules && npm install` thật sự chạy.

## Bước 1 — Đọc Build Logs của lần deploy MỚI NHẤT

Sau khi push code này lên và Vercel build xong, mở **Deployments → (deployment mới nhất) → Build
Logs**, tìm đoạn banner:

```
════════════════════════════════════════
FSRS OPTIMIZER — build-time binding check (scripts/verify-optimizer-binding.js)
════════════════════════════════════════
```

Nó chạy tự động (qua `postinstall`) và tự phân loại lỗi cho bạn:

- **Nếu thấy `❌ require(...) FAIL NGAY TRONG BUILD`** → kết luận CHẮC CHẮN: đây là lỗi **cài đặt**
  (`npm install` trong build container không cài được gói này) — KHÔNG PHẢI lỗi đóng gói function.
  Kiểm tra theo đúng 3 gợi ý script in ra (package.json, `.npmrc`, log `npm install` phía trên).
- **Nếu thấy `✅ require(...) OK trong build container`** → gói CÀI ĐƯỢC trong lúc build. Bước tiếp
  theo (Bước 2) sẽ cho biết nó có **còn sống sót** tới lúc function chạy thật hay không (đây là nơi
  Node File Trace/`includeFiles` có thể làm rớt file dù cài đặt đã đúng).

Muốn build TỰ CHẶN deploy khi thiếu (thay vì chỉ cảnh báo): thêm biến môi trường
`FSRS_OPTIMIZER_STRICT_BUILD=1` trong Project Settings → Environment Variables rồi redeploy.

## Bước 2 — Gọi status API TRÊN PRODUCTION THẬT (bằng chứng duy nhất đáng tin)

Đăng nhập vào app đã deploy, mở DevTools → Console, hoặc dùng `curl` với cookie/token đã đăng nhập,
gọi:

```
GET https://<ten-app-cua-ban>.vercel.app/api/fsrs-optimizer/status
```

Xem field `optimizerEngineState` trong JSON trả về:

| Giá trị | Ý nghĩa |
|---|---|
| `OPTIMIZER_NATIVE_READY` | Native binding load được — nhanh nhất, đúng như kỳ vọng ban đầu. |
| `OPTIMIZER_WASI_READY` | Native không load được nhưng WASI fallback CHÍNH THỨC đã chạy — vẫn là optimizer thật, không phải hàng tự viết. |
| `OPTIMIZER_READY` | Package load OK nhưng không suy luận được cụ thể engine nào (hiếm, best-effort detection không xác định được) — vẫn dùng được bình thường. |
| `OPTIMIZER_UNAVAILABLE` | Cả 2 đều KHÔNG load được — xem tiếp field `engineStatus.error` (chi tiết) và `engineStatus.nativeBinary`/`nodeVersion`/`platform`/`arch`. |

Nếu Bước 1 báo `✅ PASS` nhưng Bước 2 vẫn ra `OPTIMIZER_UNAVAILABLE` → kết luận CHẮC CHẮN: vấn đề
nằm ở bước **đóng gói function** (Node File Trace không đưa file vào bundle dù build container có
cài đặt đúng), không phải lỗi cài đặt. Lúc đó, các hướng xử lý tiếp theo (không có cách nào tôi tự
kiểm chứng thay bạn được — cần thử trực tiếp trên Vercel):

- Xác nhận lại Bước 0 (framework/install command) một lần nữa — đây vẫn là nguyên nhân hay gặp nhất.
- Thử phóng to `includeFiles` thành mảng liệt kê rõ từng thư mục thay vì 1 glob duy nhất, ví dụ:
  ```json
  "includeFiles": [
    "node_modules/@open-spaced-repetition/binding/**",
    "node_modules/@open-spaced-repetition/binding-linux-x64-gnu/**",
    "node_modules/@open-spaced-repetition/binding-wasm32-wasi/**"
  ]
  ```
  (tên gói native chính xác cho runtime của bạn nằm trong `engineStatus.nativeBinary` ở Bước 2).
- Cân nhắc bật **Large Functions** (Vercel Function limits) nếu nghi ngờ bundle bị cắt vì giới hạn
  dung lượng.
- Liên hệ Vercel Support kèm bằng chứng cụ thể: "build log PASS, nhưng
  `/api/fsrs-optimizer/status` trên production báo `OPTIMIZER_UNAVAILABLE` với lỗi X" — đây là bằng
  chứng rất cụ thể, dễ debug hơn nhiều so với chỉ nói "cannot find module".

## Bước 3 — `npm run test:optimizer:binding` ở máy có mạng (không bắt buộc nhưng nên làm)

Trên máy local (có mạng) hoặc CI:

```
npm install
npm run test:optimizer:binding
```

Test này require() thẳng package, train thử trên dataset tổng hợp, và validate đúng 21 số hữu hạn —
PASS ở đây nghĩa là ít nhất máy đó chạy được (không chứng minh production Vercel, nhưng loại trừ khả
năng code sai logic).

## Bước 4 — Lockfile thật (khuyến khích, không bắt buộc để optimizer chạy)

Repo này CHƯA có `package-lock.json` vì môi trường sửa code không có mạng để tự sinh 1 file lockfile
THẬT (có integrity hash đúng) — tự bịa 1 file lockfile giả sẽ NGUY HIỂM hơn không có (npm ci có thể
fail hoặc âm thầm dùng sai version). Sau khi tải project về máy có mạng:

```
npm install
git add package-lock.json
git commit -m "Add package-lock.json for deterministic installs"
git push
```

`vercel.json` đã tự động chuyển sang `npm ci` (deterministic) ngay khi thấy `package-lock.json` tồn
tại — không cần sửa gì thêm.

## Bước 5 — CẬP NHẬT (V83-FIX-v4): "Lỗi kết nối: Unexpected token 'A'... is not valid JSON"

Đây là 1 vấn đề MỚI, KHÁC với "Cannot find module" ban đầu — thực ra là tin TỐT: badge
"⚙️ Engine: Native" lên xanh nghĩa là root cause gốc (module không load được) ĐÃ HẾT. Vấn đề mới này
xảy ra khi bấm "Run Optimizer" thật trên dataset thật (4.060 review/794 thẻ).

**Đã xác nhận được (từ chính code, không đoán):**
- Response nhận được KHÔNG PHẢI JSON (`res.json()` throw "Unexpected token 'A'..."). App LUÔN trả
  JSON cho mọi lỗi tự bắt được (`api/index.js:fail()`), kể cả `catch` trong `runOptimizer()` cũng
  LUÔN gọi `finishOptimizerRun(userId, { error })` để lưu lỗi vào DB trước khi throw ra ngoài. Vậy
  response non-JSON nghĩa là request **KHÔNG hề chạm được các đường try/catch bình thường của app**.
- Bằng chứng CỦNG CỐ thêm: ô "⚠️ Lỗi lần chạy trước" trong ảnh chụp màn hình vẫn hiện đúng NGUYÊN
  VĂN lỗi CŨ (từ trước khi fix "Cannot find module") — nếu lần chạy MỚI NHẤT bắt được lỗi bình
  thường, cột `last_error` trong DB đã phải được ghi đè bằng lỗi MỚI rồi. Việc nó vẫn còn nguyên lỗi
  CŨ nghĩa là lần chạy mới nhất chưa bao giờ chạy tới được dòng `finishOptimizerRun(...)`.
- Kết luận: **process bị dừng ở tầng hạ tầng** (Vercel timeout SIGKILL cả function giữa chừng, HOẶC
  native Rust code crash/panic không được lớp N-API bắt lại) — 2 khả năng KHÔNG apply/không throw
  được qua try/catch JS bình thường. Nghi ngờ nhiều nhất là timeout: dataset thật (~600+ thẻ train)
  lớn hơn NHIỀU so với dataset tổng hợp nhỏ của smoke test, optimizer Rust có thể cần nhiều thời gian
  hơn "vài giây" mà UI đang hiển thị.

**Đã sửa (không cần chờ xác nhận, an toàn dù đúng hay sai giả thuyết trên):**
1. `computeParameters()` giờ được gọi kèm `timeout` (option CÓ THẬT, xác nhận qua ví dụ chính thức
   trên trang npm) — mặc định 45000 (đoán là ms theo convention JS, dưới `maxDuration: 60` của
   `vercel.json` 15 giây) — cho phép Rust-side TỰ dừng và trả lỗi JS bắt được, thay vì để Vercel
   platform giết cả process (nguồn gốc response non-JSON). Chỉnh được qua env `FSRS_OPTIMIZER_TIMEOUT_MS`
   trên Vercel (Project Settings → Environment Variables) nếu 45s vẫn chưa đủ/quá nhiều.
2. Thêm `progress` callback (option có thật) — log tiến độ (throttle 1 dòng/2s) vào Vercel Function
   Logs — LẦN SAU nếu lỗi này xảy ra lại, log sẽ cho biết optimizer có đang chạy/chạy tới đâu trước
   khi chết, thay vì hoàn toàn không có manh mối như lần này.
3. Thêm log mốc bắt đầu (`runOptimizer bắt đầu — user=...`) — xác nhận request có thật sự vào tới
   `runOptimizer()` hay chết sớm hơn (vd ở tầng auth/routing).
4. **Sửa 2 bug UI thấy được trong ảnh chụp màn hình** (độc lập với root cause ở trên, luôn đúng để
   sửa): nút bấm bị kẹt mãi ở "⏳ Đang chạy..." sau lỗi (vì code cũ không load lại status trong
   nhánh lỗi), và nếu load lại status TRƯỚC khi hiện thông báo lỗi thì thông báo lỗi bị xoá mất ngay
   (vì render lại tạo `<div id="optimizer-error">` rỗng mới) — nay đổi đúng thứ tự.
5. Thông báo lỗi khi gặp response non-JSON giờ RÕ RÀNG hơn hẳn "Unexpected token" — nói thẳng khả
   năng là timeout/crash hạ tầng và hướng dẫn xem Vercel Logs, thay vì lộ ra lỗi JS khó hiểu.

**KHÔNG tự tin đây là fix cuối cùng** (đúng nguyên tắc gốc) — nếu nguyên nhân thật là native
panic/crash (không liên quan thời gian), riêng `timeout` sẽ KHÔNG giúp được gì. Chỉ Vercel Function
Logs thật (Bước 1 ở trên, đọc lại SAU KHI deploy bản này) mới xác nhận chắc chắn. Nếu vẫn lỗi sau
khi deploy bản v4 này, hãy copy nguyên văn đoạn log quanh thời điểm bấm Run — đặc biệt tìm các dòng
bắt đầu bằng `[fsrs-optimizer]` (log mới thêm) và bất kỳ dòng nào có "Task timed out", "SIGKILL",
"SIGSEGV", "panic", hoặc mã lỗi Vercel (vd `FUNCTION_INVOCATION_TIMEOUT`) — dán lại các dòng đó, đó
sẽ là bằng chứng quyết định thay vì đoán tiếp lần thứ 3.


## Tóm tắt — điều gì ĐÃ được xác minh thật vs. điều gì BẠN cần tự xác nhận

**Đã xác nhận THẬT trên production của bạn (từ ảnh chụp màn hình bạn gửi — không còn là giả thuyết):**
- "Cannot find module '@open-spaced-repetition/binding'" (lỗi gốc) — **HẾT**. Badge "⚙️ Engine:
  Native" lên xanh chứng minh module load được trên chính Vercel Function của bạn.
- Data quality check (4.060 review/794 thẻ, 🟢 Sẵn sàng tối ưu) chạy đúng.

**Đã xác minh (qua tài liệu chính thức npm/GitHub/napi-rs, không đoán API):**
- `computeParameters`/`FSRSBindingItem`/`FSRSBindingReview`/`timeout`/`progress` là API thật, đúng
  chữ ký đang dùng.
- Package tự động fallback native → WASI nội bộ NẾU gói `binding-wasm32-wasi` có mặt (đã thêm).
- `dynamic-wasi` là API cho bundler trình duyệt — không áp dụng ở đây, nên KHÔNG tự viết loader đó.
- `includeFiles`/`excludeFiles` bị Vercel bỏ qua với 1 số framework khác "Other" (xác nhận qua
  GitHub Discussions của Vercel/Next.js).

**BẠN cần tự xác nhận (không thể làm thay vì không có mạng/quyền truy cập Vercel/DB của bạn):**
- Kết quả sau khi deploy bản V83-FIX-v4 này: bấm "Run Optimizer" thật với dữ liệu 4.060 review thật,
  xem có còn ra lỗi non-JSON hay không.
- NẾU vẫn lỗi: Vercel Function Logs quanh thời điểm bấm Run (Bước 5) — đây là bằng chứng duy nhất
  phân biệt được "cần tăng `FSRS_OPTIMIZER_TIMEOUT_MS`/`maxDuration`" khỏi "native code crash không
  liên quan thời gian" (2 hướng sửa hoàn toàn khác nhau).

Chỉ khi bấm Run thành công VÀ thấy kết quả (default/personal log-loss, % cải thiện) mới coi là XONG
thật sự — không chỉ dừng ở "Engine: Native lên xanh".
