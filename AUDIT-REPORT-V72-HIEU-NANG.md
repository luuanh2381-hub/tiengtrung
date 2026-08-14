# Audit hiệu năng V72 — "Thời gian phản hồi khi học quá chậm"

## 0. Phạm vi

Audit này **chỉ tập trung vào tốc độ phản hồi**, không đụng vào logic FSRS (đã audit kỹ ở
`AUDIT-REPORT-V69.md`) — không đổi công thức tính due/stability/difficulty, không đổi cách tính
rating tự động, không đổi kết quả đúng/sai của bất kỳ câu nào. Mọi thay đổi trong audit này chỉ nhằm
**giảm số round-trip mạng tới Postgres** và **bớt việc user phải chờ trước khi thấy kết quả**.

Không sửa: kiến trúc `app_store` (1 blob JSONB cho toàn bộ user — đã bị V69 nêu ra và cố tình để
ngoài phạm vi, xem mục 5 báo cáo này), không sửa frontend `index.html` (không có lý do phải sửa —
vấn đề nằm ở backend).

---

## 1. Chẩn đoán — vì sao mỗi câu trả lời lại chậm

### 1.1. `/api/study/review` (chạy 1 lần cho MỖI câu trả lời) — chuỗi round-trip TRƯỚC khi sửa

| Bước | Việc gì | Round-trip Postgres |
|---|---|---|
| `requireAuth` | `readDB()` — tải **toàn bộ** blob `app_store` (mọi user + mọi token + lịch sử visit từng ngày) chỉ để tra 1 token | 1 connect + 1 query |
| `getWordForAnswerCheck` | Tra đáp án đúng | 1 connect + 1 query |
| `reviewService.getUserSettings` | Tra `desired_retention` | 1 connect + 1 query |
| `dbReviewFsrsCard` | `BEGIN` → `INSERT ON CONFLICT` → `SELECT...FOR UPDATE` → đọc lịch sử gần nhất → `UPDATE` → `INSERT review_history` → `COMMIT` | 1 connect + **7 query** |
| `recordStudyActivity` | `BEGIN` → `SELECT...FOR UPDATE` (session gần nhất) → `UPDATE`/`INSERT` → `COMMIT` | 1 connect + **4 query** |
| *(nếu là từ MỚI)* `updateDB` cập nhật `currentLesson` | `BEGIN` → `SELECT...FOR UPDATE` trên **đúng 1 dòng `app_store` DUY NHẤT cho TOÀN HỆ THỐNG** → `UPDATE` (ghi lại NGUYÊN khối blob) → `COMMIT` | 1 connect + 4 query |

**Cộng: ~13 query khi ôn từ cũ, ~17 query khi học từ mới — tất cả chạy TUẦN TỰ (`await` nối
đuôi), không cái nào song song.** Tất cả đều xảy ra SAU khi user đã bấm chọn đáp án, TRƯỚC khi họ
thấy màn hình báo đúng/sai — đây là nguyên nhân trực tiếp của "chậm khi học".

Nghiêm trọng hơn số lượng round-trip: bước cuối (`updateDB` cho `currentLesson`) khoá **1 dòng
Postgres dùng chung cho TẤT CẢ user và TẤT CẢ loại ghi khác** (đăng ký tài khoản mới, đổi cài đặt,
admin thao tác...). Nếu đúng lúc 2 người học từ mới cùng lúc, hoặc 1 người đang đăng ký tài khoản
trong khi người khác đang học, **request phải xếp hàng chờ nhau** dù về logic chúng chẳng liên quan
gì tới nhau.

### 1.2. Vì sao càng dùng lâu càng chậm dần

`db.tokens` (mọi phiên đăng nhập) **không bao giờ hết hạn** — chỉ bị xoá khi bấm "Đăng xuất" tường
minh (`app.post('/api/logout')`). Đóng tab, mất mạng, đổi thiết bị đều để lại token mồ côi vĩnh
viễn. `db.visits.byDate` cộng thêm 1 entry MỖI NGÀY, mãi mãi, không bao giờ dọn. Vì `readDB()` tải
**nguyên khối** blob này ở MỌI request có auth, blob càng phình to (theo số lần đăng nhập + số ngày
app đã chạy), **mọi request — kể cả chỉ đọc — càng chậm dần theo thời gian**, đúng như cảm nhận của
bạn.

### 1.3. Nghi vấn hạ tầng (chưa xác nhận được — cần bạn tự kiểm tra, xem mục 4)

- `vercel.json` không khai báo `regions` → mặc định chạy ở `iad1` (Washington D.C, Mỹ). Nếu Postgres
  (theo `HUONG-DAN-VERCEL.md`, khả năng cao là Neon) cũng đang ở vùng Mỹ trong khi user chủ yếu ở
  Việt Nam, **mỗi round-trip ở mục 1.1 cộng thêm độ trễ xuyên lục địa** — với ~13-17 round-trip
  tuần tự/câu, chênh lệch vài chục ms mỗi round-trip cũng cộng dồn thành cả giây.
- Nếu dùng gói **Neon Free**, compute tự "ngủ" sau 5 phút không hoạt động, lần đánh thức đầu tiên
  tốn thêm ~300-800ms — rơi đúng vào câu ĐẦU TIÊN của mỗi lần mở app lên học.

---

## 2. Đã sửa trực tiếp trong code

Tất cả thay đổi đã áp dụng vào project đính kèm, **không đụng tới bất kỳ công thức FSRS nào**. Đã
`node -c` syntax-check toàn bộ file sửa/thêm (PASS), và viết test logic độc lập (không cần Postgres
thật — xem mục 3) để tự kiểm chứng phần cache/parallelize không làm sai lệch hành vi gốc.

| # | Sửa gì | File | Cắt bớt gì |
|---|---|---|---|
| 1 | Cache in-memory cho `app_store`: `readDB()` phục vụ từ cache nếu "nóng"; `updateDB()`/`updateDBWithFsrsCleanup()` ghi-qua cache ngay sau khi commit thành công | `lib/db.js` | Bỏ hẳn round-trip đọc blob khổng lồ ở MỌI request auth thứ 2 trở đi trong cùng 1 serverless instance |
| 2 | Cache `desired_retention` theo user, ghi-qua khi user đổi retention | `lib/fsrs/reviewService.js` | 1 round-trip/lượt review |
| 3 | `recordStudyActivity` (ghi `study_sessions`) đẩy ra chạy nền bằng `waitUntil` thay vì `await` — response không phụ thuộc field nào từ đây | `lib/fsrs/reviewService.js` | 4 round-trip TUẦN TỰ ra khỏi đường user phải chờ |
| 4 | Cập nhật `currentLesson` (chỉ xảy ra khi học từ MỚI) đẩy ra chạy nền — bỏ hẳn việc user phải chờ khoá `app_store` toàn hệ thống | `api/index.js` | 4 round-trip TUẦN TỰ + **bỏ hẳn điểm nghẽn khoá toàn hệ thống** trên đường chờ của user |
| 5 | Cache số từ theo bài (`getVocabCounts`), invalidate khi admin import/xoá từ | `lib/db.js` | 1 round-trip mỗi lần mở "Hôm nay" hoặc bắt đầu phiên học (vocab gần như không đổi giữa các lần học) |
| 6 | Gộp song song 3 truy vấn độc lập (`resolveStudyScope`, `getTodayStudyCounts`, `countDueFsrsCards`) và 2 truy vấn độc lập (`getDueFsrsCards`, `getNewWordsByLessonOrder` trong phạm vi) trong `/api/study/session` | `api/index.js` | ~2 round-trip TUẦN TỰ mỗi lần nạp 1 phiên học (chạy `Promise.all` thay vì nối đuôi) |
| 7 | `pg.Pool`: `idleTimeoutMillis` 10s → 30s, thêm `keepAlive: true` | `lib/db.js` | Bớt số lần phải bắt tay TCP+TLS+Postgres lại giữa các câu trong CÙNG 1 phiên học |
| 8 | Helper `lib/runInBackground.js` — bọc `waitUntil` (`@vercel/functions`) có fallback an toàn khi chạy ngoài môi trường Vercel thật (vd `npm run dev` chạy thẳng `node api/index.js`) | `lib/runInBackground.js` (mới) | — (hạ tầng cho #3, #4) |

**Kết quả: đường chờ chính của `/api/study/review` giảm từ ~13-17 round-trip tuần tự xuống còn ~8**
(chủ yếu là 7 round-trip BẮT BUỘC bên trong transaction ghi điểm FSRS — không thể bớt thêm mà
không đổi logic khoá/tính điểm), **và bỏ hẳn việc phải chờ khoá `app_store` toàn hệ thống** khi học
từ mới.

---

## 3. Đã tự kiểm chứng bằng cách nào (quan trọng — đọc trước khi tin tưởng)

Sandbox này **không có network egress** — không chạy được `npm install`/kết nối Postgres thật, y hệt
giới hạn mà `AUDIT-REPORT-V69.md` đã nêu. Đã làm những gì KHÔNG cần Postgres thật để tự tin vào
logic:

1. `node -c` cho cả 4 file sửa/thêm — PASS, không lỗi cú pháp.
2. Test `runInBackground.js` với package `@vercel/functions` **cố tình chưa cài** (đúng tình huống
   sandbox này) — xác nhận nhánh fallback không crash, không để lọt `unhandledRejection`.
3. Mô phỏng transaction Postgres bằng 1 client giả trong bộ nhớ, chạy đúng thứ tự lệnh SQL của
   `readDB`/`updateDB` — xác nhận: (a) lần đọc thứ 2 ăn cache, không chạm DB; (b) sau khi ghi, đọc
   ngay thấy dữ liệu mới mà không cần đọc lại DB; (c) khi hàm mutate lỗi (rollback), cache **không**
   bị nhiễm dữ liệu hỏng.
4. Mô phỏng lại đúng luồng `Promise.all` mới của `/api/study/session` với 4 kịch bản (đủ từ mới
   trong phạm vi / thiếu phải mở rộng ra ngoài / bị chặn bởi backlog / không bật chặn backlog) — cả
   4 cho kết quả **giống hệt logic gốc**, đồng thời đo được thời gian chạy thật là ~30ms (song song)
   thay vì ~90ms (nối đuôi) cho 3 việc giả lập 30ms mỗi việc — xác nhận `Promise.all` thật sự chạy
   song song, không chỉ "trông có vẻ song song" trên mặt chữ.

**Việc BẮT BUỘC phải làm trước khi deploy production** (chưa làm được vì giới hạn sandbox):
`npm install && npm test && npm run test:integration` trên máy có mạng + Postgres thật, rồi thử tay
1 phiên học đầy đủ trên môi trường staging/preview của Vercel trước khi để user thật dùng.

---

## 4. Việc cần BẠN tự kiểm tra (tôi không có quyền truy cập Vercel/Neon dashboard của bạn)

- **Vùng miền (region)**: vào Vercel dashboard → Project Settings → Functions, xem function đang
  chạy ở region nào. Vào Neon console, xem project đang ở region nào. Nếu cả 2 đều KHÔNG gần user
  của bạn (vd cả 2 đang ở Mỹ), cân nhắc: (a) tạo lại Neon project ở `ap-southeast-1` (Singapore) —
  **lưu ý Neon không cho đổi region của project đã tạo, phải tạo project mới rồi migrate dữ liệu**;
  (b) đổi region function trong `vercel.json` (thêm `"regions": ["sin1"]` hoặc region Đông Nam Á gần
  nhất hiện có trong dashboard của bạn) cho khớp với region Postgres. Tôi **không tự thêm** field
  này vào `vercel.json` vì không biết chắc Postgres của bạn đang ở đâu — đổi mù có thể làm tình hình
  TỆ hơn nếu đoán sai.
- **Neon autosuspend**: nếu đang dùng gói Free, vào Project Settings → xem/điều chỉnh thời gian
  autosuspend, hoặc cân nhắc gói trả phí nếu độ trễ ở câu hỏi ĐẦU TIÊN mỗi phiên quan trọng.
- **Connection string dạng pooled**: nếu `DATABASE_URL` đang dùng host KHÔNG có `-pooler` (Neon), đổi
  sang connection string dạng pooled (PgBouncer) — khuyến nghị chính thức của Neon cho serverless,
  giảm chi phí mở kết nối mới liên tục.

---

## 5. Chưa sửa — cố tình để ngoài phạm vi lần này

- **Tách `users`/`tokens` ra khỏi blob JSONB `app_store` thành bảng quan hệ riêng** (có index thật
  trên `token`, có `expires_at`) — đây mới là fix TẬN GỐC cho mục 1.1/1.2, nhưng đụng tới hàng chục
  chỗ gọi `db.users`/`db.tokens` khắp `api/index.js` (đăng nhập, đăng ký, admin, leaderboard...) —
  đúng như V69 đã kết luận ở mục 14: **"là 1 dự án audit riêng, không nên gộp"**. Cache ở mục 2 là
  giải pháp giảm đau NGAY, không phải thay thế cho việc này.
- Gộp `INSERT ON CONFLICT` + `SELECT...FOR UPDATE` (2 query đầu của `dbReviewFsrsCard`) thành 1
  UPSERT duy nhất — về lý thuyết bớt được thêm 1 round-trip/lượt review, nhưng đây là đúng đoạn
  transaction NHẠY CẢM NHẤT (ghi điểm FSRS thật), tôi không có Postgres thật để test nên **không
  đụng vào** thay vì sửa mù. Nêu ra để cân nhắc nếu bạn có môi trường test.
- `review_history` sẽ là bảng phình to nhanh nhất hệ thống (1 dòng/lượt review, mãi mãi) — V69 đã
  nêu, chưa partition. Không liên quan trực tiếp tới "chậm khi học" ở quy mô hiện tại nên không đụng
  vào lần này.

---

## 6. Deliverables

**File sửa:** `lib/db.js`, `lib/fsrs/reviewService.js`, `api/index.js`, `package.json` (thêm dep
`@vercel/functions`).
**File mới:** `lib/runInBackground.js`, file báo cáo này.
**Chưa sửa, cố tình để nguyên:** `index.html` (không cần sửa gì để giải quyết vấn đề bạn nêu), kiến
trúc `app_store`, `vercel.json` (region — cần bạn xác nhận trước).

### Kế hoạch triển khai
1. `npm install` (kéo về `@vercel/functions` mới thêm) → `npm test` → `npm run test:integration`.
2. Deploy lên Preview của Vercel trước (không phải thẳng Production) — thử 1 phiên học đầy đủ, xem
   Network tab trong DevTools để so sánh thời gian `/api/study/review` trước/sau bằng mắt thật.
3. Kiểm tra mục 4 (region + autosuspend + connection string) — đây là phần khả năng cao đóng góp
   nhiều nhất vào cảm giác "chậm" nếu team/user chủ yếu ở Việt Nam, và tôi không thể tự xác nhận hộ
   bạn từ sandbox này.
4. Theo dõi vài phiên học thật trên Production, nếu vẫn chậm hơn mong đợi sau bước 3 → cân nhắc mục
   5 (tách `users`/`tokens` ra bảng riêng) như bước tiếp theo.
