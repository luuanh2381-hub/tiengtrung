# V87 — "Failed to fetch": tách GET /status khỏi native optimizer hoàn toàn

## VẤN ĐỀ

Mở FSRS Optimizer trên production, popup hiện `"⚠️ Không kết nối được máy chủ: Failed to fetch"` —
KHÔNG phải HTTP 500/lỗi JSON/timeout hiển thị trong UI, mà là browser `fetch()` **THROW trực tiếp**
(`TypeError: Failed to fetch`), nghĩa là `GET /api/fsrs-optimizer/status` không trả về được bất kỳ HTTP
response nào — mất kết nối ở tầng mạng/process, không phải lỗi ứng dụng bình thường.

## ROOT CAUSE — đã xác định qua đọc code, không suy đoán

`getOptimizerStatus()` (hàm đứng sau `GET /status`, được FE poll **mỗi ~2 giây** trong lúc modal mở —
xem `js/fsrs-optimizer.js`) gọi `getOptimizerEngineStatus()` → `loadOfficialOptimizer()` →
`require('@open-spaced-repetition/binding')` **trên mỗi lần poll**, chỉ để hiển thị badge "Engine:
Native/WASI/chưa sẵn sàng" trước khi user bấm Run.

`require()` một native N-API addon có khả năng làm **crash cả process** (SIGSEGV/SIGABRT) nếu binary
không tương thích với runtime — vượt ngoài khả năng bắt của `try/catch` trong JavaScript. Điều đáng nói
là chính comment cũ trong code (đánh dấu "V83-FIX-v4") **đã tự nhận diện rủi ro này** cho path native
loading, nhưng chỉ áp dụng biện pháp phòng ngừa cho path **worker** (đúng — nơi DUY NHẤT cần chạy native
thật) mà bỏ sót rằng `getOptimizerStatus()` — được gọi liên tục, tự động, mỗi 2 giây, bởi MỌI user mở
modal — cũng đi qua **cùng một hàm** `loadOfficialOptimizer()`.

Khi native binary crash process giữa chừng request, browser không nhận được response nào — đúng khớp
`TypeError: Failed to fetch`, không phải HTTP 500 (500 vẫn là 1 response hợp lệ, chỉ sai nội dung).

## FIX

`GET /status` giờ **tuyệt đối không đụng native code**: xoá hoàn toàn lời gọi
`getOptimizerEngineStatus()`/`loadOfficialOptimizer()`. Trả cố định:

```json
{ "bindingAvailable": null, "optimizerEngineState": "UNKNOWN", ... }
```

(đúng ví dụ JSON được yêu cầu). `bindingVersion` được **giữ lại** vì chỉ `require()` file
`package.json` thuần — `require()` cho `.json` là `JSON.parse` thuần tuý, không `dlopen`/thực thi native
code, an toàn tuyệt đối, khác hẳn `require()` module chính của package.

Engine detail đầy đủ (native/WASI/lỗi cụ thể) tách sang endpoint mới, **admin-only**, **không** được FE
tự động poll:

```
GET /api/fsrs-optimizer/diagnostics           → Tầng 1 (mặc định) — chỉ require.resolve(), AN TOÀN TUYỆT ĐỐI
GET /api/fsrs-optimizer/diagnostics?probe=1   → Tầng 2 — thật sự require() module chính, CÓ rủi ro thật
```

Tầng 2 chỉ chạy khi 1 admin **chủ động** bấm nút "🔎 Kiểm tra engine" trong UI — nếu native crash xảy ra
ở đây, chỉ ảnh hưởng chính invocation đó (admin đang chủ động chấp nhận rủi ro), hoàn toàn tách biệt
khỏi `/status` mà mọi user đều poll liên tục.

Thêm `GET /api/fsrs-optimizer/health` — không auth, không DB, không native, JSON tĩnh — để phân biệt rõ
4 lớp có thể chết độc lập: (A) route/Vercel rewrite chết → health cũng Failed to fetch; (B) auth chết →
health OK, status 401; (C) DB chết → health OK, status 500 JSON; (D) native chết → **không còn khả năng
này nữa** vì status không đụng native.

## Files thay đổi

- `lib/fsrs/optimizer.js` — `getOptimizerStatus()` xoá lời gọi native, trả `optimizerEngineState:
  'UNKNOWN'`/`bindingAvailable: null` cố định. `getOptimizerEngineStatus()` (đổi tên ý nghĩa: giờ chỉ
  dùng nội bộ cho worker + diagnostics-probe, không còn dùng cho status) giữ nguyên implementation.
  `getOptimizerDiagnostics({probe})` mới — 2 tầng an toàn/có-rủi-ro tách bạch, export cho route mới.
- `api/index.js` — thêm `GET /health` (không auth/DB/native), `GET /diagnostics` (admin-only qua
  `requireAdmin()`, sanitize làm lớp phòng thủ thứ 2 dù về lý thuyết không cần).
- `js/fsrs-optimizer.js` — `loadOptimizerStatus()` viết lại: phân biệt fetch-network-error (throw thật
  từ `fetch()`) / non-JSON response / HTTP 401 / lỗi server khác — không còn gộp chung "Không kết nối
  được máy chủ" cho MỌI loại lỗi (Phần XVII). Badge engine cũ (dựa vào field `engineStatus` đã xoá) thay
  bằng nút thủ công `checkOptimizerEngineDiagnostics()`, chỉ hiện cho admin (`isAdminRole()`).
- `test/fsrs-optimizer.test.js` — 8 test mới (thuần JS, không cần Postgres): kiểm tra TĨNH source text
  của `getOptimizerStatus()`/`createOptimizerJob()`/`getOptimizerDiagnostics()` không chứa lời gọi
  native nguy hiểm (ngoài phạm vi cho phép), route `/health` không auth/DB/native, route `/diagnostics`
  có `requireAdmin()`, cộng với 3 test chạy THẬT `getOptimizerDiagnostics()`/`sanitizeEngineStatusForUser()`.
  **Đã tự verify các test tĩnh có "răng"** bằng cách chèn ngược bug vào bản scratch, xác nhận test FAIL
  đúng như kỳ vọng, rồi phục hồi bản đúng.
- `test/fsrs-optimizer.integration.test.js` — thêm kịch bản gọi `getOptimizerStatus()` THẬT với Postgres
  thật, xác nhận trả JSON hợp lệ + `optimizerEngineState==='UNKNOWN'` + field `engineStatus` cũ đã biến
  mất hẳn (không chỉ ẩn) — cho cả user thường và admin; cộng `getOptimizerDiagnostics()` Tầng 1 vs Tầng 2.

## Đã KHÔNG đổi

`POST /run` (đã audit: chưa từng đụng native, không cần sửa), `POST /worker` (nơi DUY NHẤT được phép
chạy native — không đổi), toàn bộ job state machine/checkpoint/retry/heartbeat của V86 (đã audit lại,
đúng, giữ nguyên), FSRS scheduler/reviewService, Apply/Rollback/Reset.

## Đã kiểm chứng được (sandbox này — không có Postgres/Vercel thật)

`node --check` PASS toàn bộ file sửa. Dựng stub `pg`/`ts-fsrs`/`@vercel/functions` để `require()` được
**chính code thật** — 8 test mới PASS, trong đó có chạy thật `getOptimizerDiagnostics({probe:true})`
trong môi trường KHÔNG cài `@open-spaced-repetition/binding` (mô phỏng đúng "native unavailable" theo
yêu cầu Phần XVI) và xác nhận **không throw**, trả về `available:false` + `loadError` rõ ràng. Tự chèn
ngược bug vào 1 bản scratch để xác nhận test tĩnh thật sự bắt được lỗi (không phải test rỗng luôn pass).

## Bạn cần tự làm

1. Deploy xong, `curl https://<domain>/api/fsrs-optimizer/health` — PHẢI luôn nhận JSON `{"ok":true,...}`
   dù mọi thứ khác (DB/native) đang lỗi. Nếu health cũng "Failed to fetch" → vấn đề nằm ở tầng Vercel
   routing/deployment, không phải code ứng dụng — kiểm tra `vercel.json`/build log.
2. `curl https://<domain>/api/fsrs-optimizer/status` (không header Authorization) — PHẢI nhận HTTP 401
   JSON, không phải kết nối bị treo/reset.
3. Mở FSRS Optimizer thật trên production — xác nhận KHÔNG còn "Failed to fetch". Nếu admin, thử nút
   "🔎 Kiểm tra engine" — nếu THAO TÁC NÀY cũng "Failed to fetch"/session mất kết nối, đó là bằng chứng
   xác nhận rõ native binding trên deployment đó thật sự đang crash process khi load (cần audit riêng
   `@open-spaced-repetition/binding` build cho đúng runtime Vercel — Node version/glibc/arch) — nhưng
   giờ chỉ ảnh hưởng lượt bấm probe đó, không còn ảnh hưởng mọi user mở modal nữa.
4. Chạy `npm run test:optimizer` + `DATABASE_URL=... npm run test:optimizer:integration` trước khi
   deploy — sandbox này không có mạng nên không tự chạy được.

## Giới hạn còn lại (nói thẳng)

Không thể loại trừ 100% khả năng native SIGSEGV thật ngay cả ở `/diagnostics?probe=1`/`/worker` — đó là
giới hạn vốn có của việc chạy native addon trong cùng process với HTTP server, không phải thứ `try/catch`
JS giải quyết được triệt để. Fix này KHÔNG loại bỏ rủi ro đó, chỉ **cách ly** nó ra khỏi 2 đường request
mà MỌI user đều đi qua liên tục (`/status`, `/run`), thu hẹp về đúng 2 nơi CHỦ ĐỘNG chấp nhận rủi ro
(worker thật, và admin bấm probe thủ công) — đúng tinh thần Phần XIII của yêu cầu audit. Nếu native
binding trên deployment thật sự không ổn định tới mức ngay cả `/worker` cũng hay crash, bước tiếp theo
là audit sâu bản build native (`@open-spaced-repetition/binding@0.5.0`) cho đúng target runtime của
Vercel, hoặc cân nhắc cô lập native execution vào 1 process/service riêng (ngoài phạm vi 1 lần sửa này).
