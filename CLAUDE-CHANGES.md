# CLAUDE-CHANGES.md — Audit lại FSRS Optimizer (sau bản v90)

Ghi ngắn gọn các file đã sửa và mục đích. Chi tiết đầy đủ xem `AUDIT-REPORT-FSRS-OPTIMIZER.md`.

## File đã sửa (3 file, không có file nào bị xoá/thêm mới)

### `lib/fsrs/optimizer.js`
- Gắn cờ `optimizerAborted = true` vào lỗi khi optimizer bị chủ động dừng vì hết ngân sách thời gian
  (ở cả 2 nhánh có thể xảy ra: thư viện báo lỗi, HOẶC thư viện trả về kết quả không hợp lệ) — để không
  bị nhầm thành lỗi dữ liệu vĩnh viễn (xem `classifyOptimizerError`, kiểm tra cờ này trước tiên).
- Thêm dòng log `OPTIMIZER_ABORTED` (ghi rõ đã chạy bao lâu, động cơ nào) ngay khi việc dừng đó xảy ra.
- Thêm trường `optimizerEngine` (native/wasi) vào kết quả lưu database sau mỗi lần train thành công.
- `runOptimizerJob()` nhận thêm 1 tham số tuỳ chọn `invocationStartedAt` — nếu có, dùng mốc này để tính
  ngân sách thời gian còn lại (chính xác hơn, tính cả thời gian đăng nhập/kết nối database); nếu không
  có, tự động dùng cách tính cũ (không phá vỡ gì với code/test gọi hàm này theo kiểu cũ).

### `api/index.js`
- Route `POST /api/fsrs-optimizer/worker`: đo thời gian ngay dòng đầu tiên (trước bước xác thực đăng
  nhập), rồi truyền mốc đó cho `runOptimizerJob()` ở trên.

### `test/fsrs-optimizer.test.js`
- Thêm test cho các thay đổi trên: kiểm tra cờ `optimizerAborted` thắng được cách phân loại lỗi kiểu cũ,
  kiểm tra cả 2 khả năng phản hồi của thư viện khi bị yêu cầu dừng, kiểm tra `invocationStartedAt` được
  dùng đúng chỗ, kiểm tra `optimizerEngine`/`OPTIMIZER_ABORTED` có trong code.
- Không xoá/sửa test cũ nào — chỉ thêm mới.

## Không sửa gì thêm ở các file khác
Toàn bộ phần còn lại của project (giao diện, các chế độ học, scheduler FSRS, các route khác...) giữ
nguyên 100%, không đụng tới.

## Database
Không cần migration. Không có bảng/cột mới. Chỉ thêm 1 khoá vào 1 cột JSON đã có sẵn.

---

# VÒNG 2 (V92) — DI DỜI TRAINING SANG TRÌNH DUYỆT

Yêu cầu mới: "AUDIT V91 – FIX FSRS OPTIMIZER DỨT ĐIỂM" — lỗi vẫn tái diễn trên dữ liệu thật (5121
review/893 card) dù đã sửa V91. Root cause: heartbeat/retry chỉ dừng SẠCH, không tạo thêm THỜI GIAN
THẬT để train xong trong giới hạn cứng của Vercel — cần dời hẳn `computeParameters()` sang trình duyệt.
Chi tiết đầy đủ: `AUDIT-REPORT-V92-BROWSER-TRAINING-MIGRATION.md`.

- `lib/fsrs/optimizer.js`: +5 hàm mới cho browser-training (prepare/create job/heartbeat/cancel/commit),
  sửa `recoverStaleJobsForUser()` thêm nhánh riêng cho job browser. KHÔNG sửa đường server-training cũ.
- `api/index.js`: +4 route hành động + 2 route serve file WASM/JS từ node_modules (không có bundler nên
  không dùng được `?url`/`?worker` như ví dụ chính thức — đọc file thật qua Express thay thế).
- `js/fsrs-optimizer.js`: viết lại luồng Run để dùng Worker thay vì poll server-training.
- `js/fsrs-optimizer-worker.js` (MỚI): Web Worker chạy `computeParameters()` thật qua WASM/WASI.
- `vercel.json`: thêm header COOP/COEP (bắt buộc theo tài liệu chính thức của package) — **rủi ro cần
  tự kiểm tra**: áp dụng toàn site, có thể ảnh hưởng Google Fonts/script cdnjs đang dùng (đã thêm
  `crossorigin` phòng ngừa trong `index.html`, nhưng chưa tự xác nhận được trên trình duyệt thật).
- Test: +8 (unit) / +7 (integration, cần bạn tự chạy) / +3 (frontend smoke).

**Chưa xác minh được (cần bạn tự test sau khi deploy, xem mục VI/VII của audit report)**: WASM có load
được thật trong trình duyệt không, Worker lồng Worker có chạy đúng không, header COOP/COEP có làm hỏng
font/xlsx không, hiệu năng trên Android Chrome với dữ liệu thật.

---

# VÒNG 3 (V92.1) — SỬA "thiếu gói WASM" SAU KHI DEPLOY THẬT

Bạn gửi ảnh chụp lỗi thật trên production: "Optimizer (bản chạy trong trình duyệt) chưa sẵn sàng trên
server — thiếu gói WASM." — đúng như đã cảnh báo ở mục VI của V92, đây là điều tôi không thể tự kiểm
tra trong sandbox. Không có log Vercel thật nên KHÔNG đoán mù — thay vào đó:

- `api/index.js`: `computeBrowserOptimizerAssetUrls()` trước đây ĐOÁN cứng tên file
  (`fsrs-binding.wasm32-wasi.wasm`, `wasi-worker-browser.mjs`) — giờ QUÉT thư mục package thật tìm file
  khớp mẫu (`*.wasm`, file có "worker"+"browser" trong tên) thay vì đoán, để không phụ thuộc việc tôi
  đoán đúng tên file phiên bản thật hay không.
- Thêm chẩn đoán chi tiết vào ĐÚNG nút bạn đã thấy sẵn trong app: "🔎 [Admin] Kiểm tra engine
  native/WASI" — giờ bấm nút đó sẽ hiện thêm 1 mục "Optimizer (trình duyệt)" nói rõ ĐANG kẹt ở bước nào
  (thiếu package / thiếu export dynamic-wasi / thiếu file wasm-worker) — không cần vào Vercel Logs nữa.

**Bước tiếp theo**: deploy lại, bấm Run Optimizer thử lại. Nếu vẫn lỗi, bấm nút "🔎 [Admin] Kiểm tra
engine native/WASI" và gửi tôi xem đúng dòng "Optimizer (trình duyệt)" hiện gì.

---

# VÒNG 4 (V92.2) — TÌM ĐÚNG ROOT CAUSE THẬT TỪ LOG PRODUCTION

Bạn gửi ảnh chụp dòng chẩn đoán mới: `"bindingRoot":null,"wasmRoot":null,"failedAt":"package_resolve"`
— NHƯNG cùng lúc đó dòng "Engine (server): Native ✅" ngay phía trên lại xác nhận
`@open-spaced-repetition/binding` chắc chắn ĐÃ cài và chạy tốt. Hai điều này MÂU THUẪN nếu nguyên nhân
thật là "thiếu package" — nghĩa là lỗi nằm ở CÁCH TÔI TÌM thư mục package, không phải do thiếu cài đặt.

**Root cause thật**: code cũ dùng `require.resolve('<package>/package.json')` để tìm thư mục gốc —
nhưng `@open-spaced-repetition/binding` khai `"exports"` map trong package.json KHÔNG cho phép truy cập
trực tiếp subpath `"./package.json"` từ bên ngoài (dù package vẫn dùng bình thường qua các subpath ĐƯỢC
khai, như `dynamic-wasi`). Đây là 1 quy tắc bảo mật/đóng gói chuẩn của Node.js hiện đại — tôi đã viết
lại test tái hiện chính xác lỗi này để xác nhận (không chỉ đoán), xem
`test/fsrs-optimizer.browser-asset-resolution.test.js`.

- `api/index.js`: đổi cách tìm thư mục package — không dựa vào resolve `./package.json` nữa, mà đi từ
  1 subpath THẬT SỰ dùng được (`dynamic-wasi`) rồi truy ngược lên tìm đúng `package.json`. Với gói WASM
  (`binding-wasm32-wasi`, thường không có "main" để resolve trực tiếp) — suy ra vị trí từ việc nó luôn
  nằm CẠNH package chính (cách npm cài các gói chung 1 scope). Cũng làm việc tìm file `.wasm`/file
  worker linh hoạt hơn (không giả định thứ tự chữ trong tên file).
- Test mới `test/fsrs-optimizer.browser-asset-resolution.test.js`: tự dựng 1 bộ `node_modules` giả
  ngay trên đĩa mô phỏng ĐÚNG 2 khó khăn đã gặp thật (exports map chặn + tên file khác ví dụ) — chạy
  được ĐỘC LẬP, không cần bản giả lập tối thiểu như các test khác, thêm script
  `npm run test:optimizer:browser-assets`.

**Vẫn CHƯA chắc chắn 100%** đây là nguyên nhân DUY NHẤT (có thể còn vấn đề khác lộ ra sau khi qua được
bước này) — nhưng đây là lần đầu tiên có bằng chứng cụ thể (không phải suy đoán) về CHÍNH XÁC dòng code
nào sai và tại sao.

---

# VÒNG 5 (V92.3) — ROOT CAUSE THẬT SỰ: npm CHUẨN BỎ QUA GÓI WASM, KHÔNG PHẢI LỖI CODE

Bạn gửi ảnh mới: `bindingRoot` giờ ĐÃ đúng (`/var/task/node_modules/@open-spaced-repetition/binding`)
— xác nhận sửa vòng 4 có tác dụng thật. Nhưng `wasmRoot` vẫn `null`. Tra cứu kỹ hơn (tài liệu chính
thức của NAPI-RS — framework build ra package đang dùng) xác nhận: package
`@open-spaced-repetition/binding-wasm32-wasi` tự khai `cpu: ["wasm32"]` — và **đây là quy ước CHUẨN**:
mọi máy build thật (kể cả máy của Vercel) đều là x64/arm64, KHÔNG máy nào tự nhận là "wasm32", nên
`npm install`/`npm ci` LUÔN bỏ qua gói này, dù đã khai trong `optionalDependencies` và dù
`includeFiles` trong `vercel.json` đã đúng — `includeFiles` chỉ đóng gói file ĐÃ CÓ trên đĩa, không
giúp CÀI ĐẶT file chưa từng được tải về. **Đây không phải lỗi tôi gây ra hay lỗi cấu hình của bạn** —
`pnpm` có tuỳ chọn riêng để ép cài trường hợp này, nhưng `npm` (project đang dùng) không có.

**Đã sửa**: thêm `scripts/ensure-wasm-optimizer.js`, tự chạy sau `npm install` (postinstall) — nếu thấy
gói WASM bị thiếu, tự tải thẳng từ npm registry (KHÔNG qua bước bị lọc theo cpu) rồi tự giải nén vào
đúng chỗ. Không sửa gì script postinstall cũ (`verify-optimizer-binding.js`) — chỉ nối thêm, không ảnh
hưởng hành vi đã có.

**CHƯA THỂ tự xác nhận 100%** — máy sửa code không có mạng thật để thử tải xuống thành công. Đã kiểm
tra: script không làm hỏng build nếu thất bại (chỉ cảnh báo), đọc đúng version cần tải, có giới hạn thời
gian chờ (30s) để không treo build. Việc TẢI THẬT THÀNH CÔNG chỉ xác nhận được sau khi bạn deploy —
bấm nút 🔎 chẩn đoán để xem `wasmRoot` đã khác `null` chưa.

---

# VÒNG 6 (V92.4) — SỬA "require is not defined" (chọn nhầm file CommonJS thay vì ESM)

Bạn gửi ảnh mới: gói WASM đã cài được (đúng như vòng 5 sửa) — lỗi ĐỔI sang
`"Optimizer lỗi trong trình duyệt: require is not defined"`. Đây là tiến triển thật (đi qua được bước
trước), không phải lỗi cũ quay lại.

**Root cause**: nhiều package hiện đại công bố 2 bản cho cùng 1 chức năng — 1 bản ESM (dành cho
`import`, trình duyệt cần đúng bản này) và 1 bản CommonJS (dành cho `require()`, có chứa `require(...)`
bên trong — chỉ chạy được trong Node, KHÔNG chạy được thẳng trong trình duyệt). Code cũ dùng
`require.resolve()` (chạy trên server, vốn là CommonJS) để tìm file `dynamic-wasi` — Node tự động chọn
ĐÚNG bản CommonJS cho ngữ cảnh đó, rồi tôi lại đem SERVE bản đó cho trình duyệt — sai bản.

**Đã sửa**: đọc thẳng "exports" map trong package.json, tự chọn nhánh "import" (ESM) thay vì để Node tự
chọn theo ngữ cảnh server. Đã viết test tái hiện chính xác tình huống 2 bản file khác nhau + xác nhận
test này THẬT SỰ bắt được lỗi (tự thử revert lại code cũ, xác nhận test báo lỗi đúng file `.cjs`, rồi
khôi phục lại bản sửa — không chỉ tin test tự viết mà không kiểm chứng ngược). Cũng thêm cảnh báo chủ
động trong nút 🔎 chẩn đoán — nếu file được chọn vẫn còn dấu hiệu CommonJS, sẽ thấy cảnh báo ngay mà
không cần đợi thử Run Optimizer thật rồi mới biết.

**Vẫn có thể còn lỗi khác phía sau** (vd nếu chính `wasi-worker-browser.mjs`/file nó gọi tới cũng gặp
vấn đề tương tự) — chỉ xác nhận được sau khi bạn deploy và thử lại.
