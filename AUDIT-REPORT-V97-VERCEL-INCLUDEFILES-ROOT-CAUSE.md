# Fix V97 — Nguyên nhân THỰC SỰ: vercel.json, không phải logic code

## Thành thật trước

V95 và V96 đều dựa trên suy luận hợp lý về logic resolve, đã verify bằng test tự dựng, nhưng **không
khớp với môi trường thật của bạn** — cả 2 lần đều không dùng được dữ liệu thật từ server bạn, nên bản
chất vẫn là "sửa rồi đoán xem đúng chưa". Lần này khác: tìm ra bằng chứng cụ thể trong chính file cấu
hình, không phải suy luận về cấu trúc package tôi không nhìn thấy được.

## Nguyên nhân thực sự

`vercel.json` có:
```json
"includeFiles": "node_modules/@open-spaced-repetition/**"
```

Vercel dùng công cụ phân tích tĩnh để quyết định file nào được đóng gói vào Function thật sự chạy
trên production. Vì code chỉ **đọc file bằng `fs.readFileSync` tại thời điểm chạy** (không có dòng
`require('@napi-rs/wasm-runtime')` tĩnh nào), công cụ đó không tự biết cần đóng gói package này —
`includeFiles` được thêm (bởi 1 lần audit trước) chính để bù cho việc đó, nhưng **chỉ bao phủ đúng 1
scope** `@open-spaced-repetition`. Nếu `@napi-rs/wasm-runtime` (dependency của package đó) được npm
đặt ở vị trí **ngoài** scope này (hoisted lên gốc `node_modules`, hoặc nested trong 1 package khác),
nó **có mặt lúc `npm install` (build time) nhưng bị bỏ lại phía sau, không có mặt trên Function thật
sự đang chạy** — dù code logic đúng 100%, file cần tìm không tồn tại trên server, nên mọi lần thử
đều thất bại giống hệt nhau.

Đây giải thích tại sao "Engine (server): Native ✅" luôn hoạt động (package đó được dùng theo cách
Vercel tự phát hiện được) trong khi "Optimizer (trình duyệt)" luôn lỗi y hệt bất kể tôi sửa logic gì.

## Đã sửa

1. **`vercel.json`**: `includeFiles` đổi thành `"node_modules/**"` — đóng gói toàn bộ, không giới hạn
   theo 1 scope cụ thể nào nữa. Không dùng cú pháp liệt kê nhiều scope (`{a,b}`) vì không có xác nhận
   chắc chắn Vercel hỗ trợ — rủi ro nếu sai cú pháp là làm mất luôn phần đang hoạt động đúng.
2. **`checkTransitiveDepsOnDisk` (mới, `api/index.js`)**: đọc `package.json` thật của `binding` và
   `binding-wasm32-wasi`, lấy toàn bộ `dependencies` chúng khai báo, rồi kiểm tra **trực tiếp bằng
   `fs.existsSync`** (không qua `require.resolve`, không thể bị ảnh hưởng bởi bất kỳ quy tắc resolve
   phức tạp nào) xem từng cái có thật sự nằm trên đĩa server đang chạy hay không. Không chỉ kiểm tra
   `@napi-rs/wasm-runtime` — kiểm tra **mọi** dependency đã biết, để phát hiện sớm nếu còn thiếu gói
   nào khác trước khi bạn gặp lỗi.
3. **UI** ("🔎 Kiểm tra engine native/WASI"): hiển thị luôn kết quả kiểm tra này — nếu còn thiếu gì,
   sẽ thấy rõ tên gói ngay trên màn hình, không cần đoán hay gửi thêm ảnh.

## Test

`test/fsrs-optimizer.browser-asset-resolution.test.js` — **15/15 PASS**, thêm 1 case verify
`checkTransitiveDepsOnDisk` phân biệt đúng gói có mặt và gói cố tình cho thiếu. Không ảnh hưởng
`fsrs-optimizer-frontend.smoke.test.js` (23/23), `vocab-merge.test.js` (30/30),
`visibility-timer.test.js` (7/7).

## ⚠️ Rủi ro cần biết

`node_modules/**` sẽ đóng gói **nhiều hơn cần thiết** vào Function (kích thước tăng). Với dự án này
khó có khả năng chạm giới hạn 250MB của Vercel, nhưng nếu build báo lỗi vượt giới hạn kích thước,
báo lại — lúc đó sẽ thu hẹp `includeFiles` bằng đúng danh sách gói mà `checkTransitiveDepsOnDisk` xác
nhận là cần thiết (thay vì đoán trước như 2 lần trước).

## Bạn cần làm gì

1. Deploy bản mới, **đợi build xong hẳn** (kiểm tra Vercel Dashboard báo "Ready", không chỉ thấy code
   đã push) — vì cả 3 lần trước tôi chưa loại trừ được khả năng bước deploy/build chưa hoàn tất.
2. Bấm "🔎 Kiểm tra engine native/WASI" **trước khi** bấm Run — xem dòng "📦 Kiểm tra file vật lý trên
   server". Nếu báo "❌ THIẾU": gửi đúng ảnh chụp màn hình đó, tên gói thiếu sẽ hiện rõ, tôi bổ sung
   chính xác gói đó vào `includeFiles` mà không cần đoán.
3. Nếu báo tất cả OK: bấm Run thử.
