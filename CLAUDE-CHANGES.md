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
