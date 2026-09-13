# Fix V95 — Optimizer trong trình duyệt: "Failed to resolve module specifier '@napi-rs/wasm-runtime'"

## Root cause (đã xác nhận bằng thực nghiệm, không chỉ suy luận)

Cơ chế build "import map" (`buildImportMapForFile`/`resolveBareSpecifierUrl` trong `api/index.js`) tự
đọc nội dung file `dynamic-wasi` entry, tìm mọi "bare specifier" (như `@napi-rs/wasm-runtime`), rồi
**resolve từng specifier đó bằng `require.resolve()` gọi TỪ `api/index.js`**.

Vấn đề: `@napi-rs/wasm-runtime` không phải dependency khai trực tiếp trong `package.json` của dự án —
nó là **transitive dependency** của `@open-spaced-repetition/binding`/`binding-wasm32-wasi`. npm hoàn
toàn có thể đặt nó **nested** bên trong `node_modules/@open-spaced-repetition/binding/node_modules/
@napi-rs/wasm-runtime` thay vì hoist lên `node_modules` gốc (tuỳ version/cây phụ thuộc lúc cài đặt
thật trên máy bạn). `require.resolve()` gọi từ `api/index.js` **chỉ tìm theo cây node_modules xuất
phát từ chính file đó** — đây là đặc tả chính thức của Node.js, không phải bug của Node — nên sẽ
**không thấy** package bị nested kiểu này → import map bị thiếu đúng key đó → trình duyệt báo lỗi
chính xác như ảnh bạn gửi.

**Đã tái hiện được bug bằng thực nghiệm**: sửa lại bộ dữ liệu giả lập trong
`test/fsrs-optimizer.browser-asset-resolution.test.js` để đặt `@napi-rs/wasm-runtime` nested đúng
kiểu trên (bản test cũ vô tình đặt nó ở gốc `node_modules` nên "quá dễ", không bắt được bug này) —
chạy lại với code cũ: **FAIL đúng với thông báo "importMap phải có mục cho @napi-rs/wasm-runtime —
nhận: {}"**, giống hệt lỗi thật. Chạy lại với code đã sửa: **PASS**.

## Đã sửa (2 chỗ, cùng gốc)

1. **`findPackageRootByEntry`/`resolveBareSpecifierUrl`**: nhận thêm tham số `fromFilePath` (file
   đang chứa câu `import` đó), dùng `require('module').createRequire(fromFilePath)` thay vì
   `require.resolve()` toàn cục — resolve đúng theo vị trí thật, tìm được cả `node_modules` lồng bên
   trong package cha. Các lời gọi cũ (cho `binding`/`binding-wasm32-wasi` — top-level dependency, hầu
   như luôn được hoist) **không đổi hành vi** vì tham số này tuỳ chọn.
2. **`serveDynamicPkgFile`** (route thực sự trả file về cho trình duyệt): trước đây tự tính lại
   `root` bằng `require.resolve()` không context — **dù import map ở bước 1 đã đúng, request tải file
   thật vẫn sẽ 404** vì cùng lý do gốc. Nay cache lại `root` đã xác định đúng lúc build import map,
   route dùng lại cache đó thay vì tính lại.

**Cải thiện thêm (phòng ngừa, không có tác dụng phụ)**: mở rộng regex phát hiện bare specifier để bắt
thêm dạng `import 'x'` (side-effect-only, trước đây chủ ý bỏ qua vì cho là hiếm).

## Không sửa gì khác
Không đụng `lib/fsrs.js`, `lib/fsrs/optimizer.js` (thuật toán/luồng train), không đổi kiến trúc
"chạy trên luồng chính" đã có (V92.5/V92.6) — chỉ sửa đúng cách resolve đường dẫn 2 hàm nêu trên.

## Test
`test/fsrs-optimizer.browser-asset-resolution.test.js` — **8/8 PASS**, gồm 2 case mới (cache root
đúng thư mục nested; `serveDynamicPkgFile` không rơi vào nhánh lỗi 404). `test/fsrs-optimizer-frontend.smoke.test.js` — 23/23 PASS, không bị ảnh hưởng. Các test cần
`ts-fsrs`/DB (`fsrs-optimizer.test.js`, `.binding.smoke.test.js`) vẫn không chạy được trong sandbox
này như từ trước, không liên quan tới thay đổi lần này.

## ⚠️ Giới hạn cần biết — chưa chắc là root cause DUY NHẤT

Có 1 khả năng khác chưa loại trừ được hoàn toàn: nếu `@napi-rs/wasm-runtime` được import từ **file
Worker script** (không phải file `dynamic-wasi` entry chính chạy ở luồng chính) thì theo đặc tả
chính thức của Web (đã ghi rõ trong chính comment code từ trước), **import map không áp dụng được
cho module nạp trong Worker** — nếu đúng vậy, fix này sẽ không đủ. Bằng chứng hiện có (thông báo lỗi
ngắn gọn, giống lỗi trực tiếp từ `import()` ở luồng chính hơn là lỗi propagate từ Worker) nghiêng về
giả thuyết đã sửa, nhưng **không có Vercel Function Logs/log trình duyệt thật để khẳng định 100%**.

## Bạn cần làm gì

1. Deploy bản mới.
2. **Trước khi bấm "Run"**: bấm nút "🔎 [Admin] Kiểm tra engine native/WASI" → xem JSON trả về ở field
   `diagnostics.browserTraining.importMap` — phải thấy key `"@napi-rs/wasm-runtime"` trỏ tới 1 URL
   dạng `/api/fsrs-optimizer/browser/pkg-dyn/napi-rs__wasm-runtime/...`. Nếu **có** → fix đã đúng ở
   phía server, tiếp tục bước 3. Nếu **vẫn thiếu** → root cause khác (báo lại nguyên văn field
   `diagnostics.browserTraining` để xác định tiếp).
3. Bấm "Run Optimizer" thật — nếu vẫn lỗi "Failed to resolve module specifier" ở bước này (dù bước 2
   đã có key), rất có thể rơi vào giới hạn Worker nêu trên — mở DevTools Console xem lỗi có kèm chữ
   "Worker" hay không rồi báo lại.
