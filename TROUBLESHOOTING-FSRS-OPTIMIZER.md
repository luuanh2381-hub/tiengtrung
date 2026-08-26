# FSRS Optimizer trên Vercel — cách tự xác nhận (V83-FIX-v3)

Đọc file này SAU khi đã đọc `AUDIT-REPORT-V83-FSRS-OPTIMIZER-v3.md` (root cause + danh sách file đã
sửa). File này CHỈ tập trung vào: **bạn tự chạy các bước nào để chứng minh production đã load được
optimizer thật** — vì môi trường sửa code này không có mạng, không có Vercel CLI, không có
`DATABASE_URL`/URL production của bạn, nên KHÔNG có cách nào tôi tự deploy/tự gọi API production để
xác nhận thay bạn. Đây là điều BẮT BUỘC phải tự làm (đúng yêu cầu gốc: "KHÔNG nói đã sửa nếu chưa
chứng minh được production").

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

## Tóm tắt — điều gì ĐÃ được xác minh thật vs. điều gì BẠN cần tự xác nhận

**Đã xác minh (qua tài liệu chính thức npm/GitHub/napi-rs, không đoán API):**
- `computeParameters`/`FSRSBindingItem`/`FSRSBindingReview` là API thật, đúng chữ ký đang dùng.
- Package tự động fallback native → WASI nội bộ NẾU gói `binding-wasm32-wasi` có mặt (đã thêm).
- `dynamic-wasi` là API cho bundler trình duyệt — không áp dụng ở đây, nên KHÔNG tự viết loader đó.
- `includeFiles`/`excludeFiles` bị Vercel bỏ qua với 1 số framework khác "Other" (xác nhận qua
  GitHub Discussions của Vercel/Next.js).

**BẠN cần tự xác nhận (không thể làm thay vì không có mạng/quyền truy cập Vercel/DB của bạn):**
- Build Logs thật của deployment mới nhất (Bước 1).
- Kết quả `GET /api/fsrs-optimizer/status` trên chính production URL của bạn (Bước 2).
- Bấm "Run Optimizer" thật trên UI production với dữ liệu 4.060 review thật của bạn.

Chỉ khi Bước 2 báo `OPTIMIZER_NATIVE_READY` hoặc `OPTIMIZER_WASI_READY` mới coi là ĐÃ XONG thật sự.
