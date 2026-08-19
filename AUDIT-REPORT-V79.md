# Audit V79 — FSRS / Study Session / Study Queue / Đồng bộ Neon / Cache / Chống lặp từ

## 0. Phạm vi

Audit toàn diện theo yêu cầu, bao trùm: FSRS, Study Session, Study Queue, đồng bộ Neon (đa thiết
bị), chọn bài học, Quiz/Review/Flashcard/Typing/Listening, hiệu năng, cache, logic học nhiều
lần/ngày, học tiếp, học mới, chống lặp từ. Kế thừa trực tiếp `AUDIT-REPORT-V69.md` (chuẩn hoá FSRS)
và `AUDIT-REPORT-V72-HIEU-NANG.md` (cache/song song hoá) — đã đọc kỹ cả 2 trước khi audit tiếp,
không lặp lại việc đã làm.

**Nhận định chung:** phần lớn hệ thống (study-queue.js, study-session.js, flashcard/quiz/type/
listen/review.js, lib/fsrs/*, reviewFsrsCard) đã rất chắc chắn sau nhiều đợt audit trước (V67→V77)
— đọc kỹ toàn bộ, không tìm thấy lỗi logic mới ở các phần này. Vấn đề thật sự tìm thấy nằm ở **tầng
cache in-memory thêm vào ở V72** (để tăng tốc), vốn tối ưu đúng cho 1 instance/1 phiên học liên tục
nhưng chưa tính hết hệ quả cho **đồng bộ đa thiết bị** trên môi trường serverless nhiều instance
(Vercel) — và ở **tooling bị hỏng** (`npm test` không chạy được).

---

## 1. Lỗi nghiêm trọng nhất — cache `app_store` không có TTL (đồng bộ đa thiết bị)

**Vị trí:** `lib/db.js` — `cachedAppStore` (thêm ở V72).

**Vấn đề:** `readDB()` trả thẳng `cachedAppStore` nếu biến này không rỗng — **không có hạn dùng**.
Trong 1 serverless instance được Vercel tái sử dụng (warm) qua nhiều request, cache này có thể
"nóng" hàng chục phút. `requireAuth()` — cổng xác thực cho **mọi** API có đăng nhập (token, dữ liệu
`user.progress.ui` gồm Quyển/bài đang chọn, `currentLesson`...) — gọi `readDB()` ở mọi request.

**Hệ quả thật:** user đổi bài học/tiến độ ở thiết bị A (chạm 1 instance), rồi học tiếp ở thiết bị B
(chạm 1 instance KHÁC, đã cache dữ liệu CŨ từ trước) → instance B trả về dữ liệu cũ cho tới khi
CHÍNH nó tự ghi (`updateDB`) hoặc bị cold start lại — không có giới hạn thời gian. Biểu hiện ra
ngoài: "chọn bài học không có tác dụng", "không đồng bộ giữa các thiết bị", cảm giác "mất tiến
trình" dù dữ liệu thật trên Postgres vẫn đúng. Ảnh hưởng tới `/api/progress`, `/api/study/session`,
`/api/study/today`, đăng nhập/đăng xuất (kiểm tra token), leaderboard, toàn bộ admin panel.

**Đã sửa:** thêm TTL 5 giây cho `cachedAppStore` (`APP_STORE_CACHE_TTL_MS`). Vẫn giữ gần trọn lợi
ích hiệu năng gốc của V72 (đa số request trong 1 phiên học cách nhau vài giây, vẫn ăn cache), nhưng
giới hạn độ trễ tối đa giữa các instance ở vài giây thay vì vô hạn. Cả 2 điểm ghi-qua sau khi commit
(`updateDB`, `updateDBWithFsrsCleanup`) đều được cập nhật mốc thời gian mới.

**Cùng lớp lỗi, mức độ nhẹ hơn (đã sửa theo cùng cách):**
- `cachedVocabCounts` (`lib/db.js`) — số từ theo bài, TTL 60s. Không gây mất dữ liệu (chỉ hiện sai
  số đếm vài phút nếu admin import từ vựng ở 1 instance khác), nhưng sửa cho nhất quán.
- `userSettingsCache` (`lib/fsrs/reviewService.js`) — `desired_retention` theo user, TTL 30s. Không
  gây mất dữ liệu (chỉ ảnh hưởng độ chính xác lịch ôn theo đúng % ghi nhớ mong muốn nếu vừa đổi ở
  thiết bị khác).

**Vì sao chọn TTL thay vì bỏ cache hẳn:** bỏ cache hẳn sẽ quay lại đúng vấn đề "học chậm" mà V72 đã
sửa (round-trip Postgres cho MỌI request, kể cả mỗi câu trả lời). Vì sao chọn TTL thay vì
pub/sub hoặc bảng quan hệ riêng (giải pháp triệt để hơn): đúng như V69/V72 đã kết luận, tách
`users`/`tokens` khỏi blob JSONB `app_store` là 1 dự án riêng quá lớn cho audit này (đụng hàng chục
chỗ gọi `db.users`/`db.tokens`) — TTL là fix đúng mức độ, giảm đau ngay mà không đổi kiến trúc.

---

## 2. `npm test` bị hỏng — file test không tồn tại

**Vấn đề:** `package.json` khai báo `"test": "node test/fsrs.test.js"` và
`"test:integration": "node test/fsrs.concurrency.integration.js"` — cả 2 file này **không có trong
project** dù các báo cáo audit trước (V69) có nhắc tới như đã tồn tại. `npm test` luôn báo lỗi
"Cannot find module" — không có cách nào tự động xác nhận FSRS/logic chưa bị hỏng sau khi sửa.

**Đã sửa:** tạo lại 2 file:
- `test/fsrs.test.js` — unit test THUẦN (không cần Postgres): xác minh 21 weights, validation
  retention/rating, `reviewCard()` cho lịch ôn đúng chiều (retention thấp → scheduled_days dài
  hơn), round-trip `rowToCard`/`cardToRow`, các nhánh chính của `getAutomaticFSRSRating` (sai luôn
  Again, từ mới nhanh không tự suy Easy, chưa đủ baseline → Good), và `studyScope.js` (thứ tự ưu
  tiên bài học, fallback currentLesson).
- `test/fsrs.concurrency.integration.js` — kiểm tra race condition ghi FSRS đồng thời + idempotency
  + optimistic locking (version). Cần `DATABASE_URL` thật — **tự SKIP an toàn** (exit 0, in rõ lý
  do) nếu chưa cấu hình, thay vì crash cứng như hiện trạng cũ.

**Giới hạn cần biết:** sandbox audit này không có network egress (không `npm install` được), nên
**không chạy thử được** `test/fsrs.test.js` với `ts-fsrs` thật — đã `node -c` syntax-check PASS cho
mọi file, và tự tay verify logic từng assertion khớp với hành vi đã đọc trong `lib/fsrs.js`. Việc
BẮT BUỘC trước khi tin tưởng: chạy `npm install && npm test` trên máy có mạng.

---

## 3. Các phần đã rà soát kỹ, XÁC NHẬN KHÔNG có lỗi mới

- `js/study-queue.js`, `js/study-session.js` — cơ chế chống lặp (`sessionKnownHz`, `sqPurgeHzFromAllQueues`),
  outbox chống mất dữ liệu, idempotency, Study Day/Study Session, "Học tiếp"/"Học mới"/"Học lại từ
  đầu" — đúng như thiết kế, không tìm thêm lỗi.
- `js/flashcard.js`, `js/quiz.js`, `js/type.js`, `js/listen.js`, `js/review.js` — nhất quán với
  nhau, đều chờ `submitFsrsReviewAwaited()` trước khi sang câu kế (không mất dữ liệu khi refresh
  giữa chừng), đều tôn trọng `sessionKnownHz`.
- `lib/db.js:reviewFsrsCard()` — transaction FSRS chính: `SELECT...FOR UPDATE` + optimistic locking
  (`version`) + idempotency key + retry khi conflict — đúng, không sửa gì (đây là đoạn nhạy cảm
  nhất, không đụng vào nếu không có bằng chứng lỗi cụ thể).
- `lib/fsrs.js`, `lib/fsrs-auto-rating.js`, `lib/fsrs/studyScope.js` — đúng như thiết kế.
- `lib/runInBackground.js` — fallback an toàn khi chạy ngoài môi trường Vercel thật.

## 4. Việc CHƯA làm — cố tình để ngoài phạm vi

- Tách `users`/`tokens` khỏi blob JSONB `app_store` thành bảng quan hệ riêng — giải pháp TẬN GỐC
  cho mục 1, nhưng là 1 dự án riêng quá lớn (V69/V72 đã kết luận tương tự, xem báo cáo đó).
- `review_history` phình to theo thời gian, chưa partition — đã nêu ở V69, chưa liên quan trực
  tiếp tới các lỗi audit lần này.
- Chạy thật `npm install && npm test && npm run test:integration` — cần môi trường có mạng +
  Postgres thật, ngoài khả năng của sandbox audit này.
