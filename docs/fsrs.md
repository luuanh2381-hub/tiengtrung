# Kiến trúc hệ thống ôn tập FSRS (v66)

## 1. Tổng quan

App vẫn là Express + Postgres thuần (không đổi framework/deploy). Hệ thống FSRS là một **lớp mới,
song song** với các chế độ học cũ (Flashcard/Trắc nghiệm/Nghe/Gõ chữ/Dịch câu) — các chế độ cũ giữ
nguyên 100%, dùng `progress.srs` (step-based) như trước. Tab mới **"🎯 Hôm nay học"** là nơi dùng
FSRS thật, quyết định user nên ôn từ nào hôm nay và ưu tiên NEW word nào theo bài gần nhất.

## 2. Thư viện

`ts-fsrs` (npm) — implement đúng thuật toán FSRS (v4/v5 weights mặc định). Toàn bộ tính toán
`due/stability/difficulty/state` nằm trong `lib/fsrs.js`, đây là **nơi duy nhất** gọi `ts-fsrs`.
Desired retention mặc định = **0.90**, dùng default weights của thư viện — không tự tối ưu.

## 3. Database

### `fsrs_cards` — 1 dòng = 1 (user, hz, lesson)
```
user_id, hz, l, state, due, stability, difficulty, elapsed_days, scheduled_days,
reps, lapses, last_review, created_at, updated_at
UNIQUE(user_id, hz, l)
INDEX (user_id, due), (user_id, l)
```
Định danh 1 "từ" giữ đúng theo `vocab_words`: cặp `(hz, l)`, vì cùng 1 chữ Hán có thể xuất hiện ở
nhiều bài với nghĩa khác nhau — tránh đụng độ SRS giữa các bài khác nhau (khác `progress.srs` kiểu
cũ chỉ khoá theo `hz`).

Card **không được tạo** khi user chỉ mở session — chỉ tạo (qua `INSERT ... ON CONFLICT DO NOTHING`)
ngay trong transaction của lượt review đầu tiên (`reviewFsrsCard`), đúng yêu cầu "không tạo card giả".

### `review_history` — log mọi lượt review
```
user_id, hz, l, rating, answer_correct, reviewed_at,
previous_state, new_state, previous_due, new_due,
previous_stability, new_stability, previous_difficulty, new_difficulty, scheduled_days
```
Dùng cho: daily-limit counter (đếm số review "hôm nay" theo giờ VN), weak-words fallback nâng cao
sau này, debug, thống kê.

Cả 2 bảng tạo qua `CREATE TABLE IF NOT EXISTS` (giống `vocab_words`/`word_examples`) — an toàn,
không cần migration script riêng, không đụng dữ liệu cũ.

## 4. Vòng đời 1 thẻ (card lifecycle)

1. User mở "Hôm nay học" → `GET /api/study/today` chỉ COUNT, không tạo card.
2. User bấm "Bắt đầu học" → `GET /api/study/session` trả về danh sách review (đã có card, đến hạn)
   + new (chưa có card) — **không** tạo card cho phần new tại bước này.
3. User trả lời 1 từ (dù review hay new) → `POST /api/study/review` — server:
   - `BEGIN` transaction, `INSERT ... ON CONFLICT DO NOTHING` (tạo card nếu chưa có),
     `SELECT ... FOR UPDATE` khoá đúng dòng đó (chống double-click/nhiều tab — Phần 27).
   - Gọi `lib/fsrs.js` tính state/due/stability/difficulty mới.
   - `UPDATE fsrs_cards` + `INSERT review_history` + `COMMIT`.
   - Nếu đây là NEW word (trước đó `reps=0, state=0, last_review=NULL`) → cập nhật
     `progress.ui.currentLesson = l` (tự động dịch "current lesson" theo đúng bài user vừa học).

Client **không bao giờ** tự tính due/stability/difficulty — chỉ gửi `{wordId:{hz,l}, rating,
answerCorrect}`. `answerCorrect` (đúng/sai lúc tự nhớ) và `rating` (Again/Hard/Good/Easy) là 2 giá
trị độc lập — ví dụ "Đúng nhưng Hard" hoặc "Sai nhưng Again" đều hợp lệ, server không tự suy ra cái
này từ cái kia.

## 5. Thứ tự ưu tiên trong 1 session (`GET /api/study/session`)

```
1. FSRS card due/overdue, ưu tiên Learning/Relearning (state 1,3) trước Review (state 2),
   trong mỗi nhóm sắp theo due sớm nhất — LUÔN cao hơn NEW word.
2. NEW word, ưu tiên current lesson → lùi dần qua các bài trong PHẠM VI Quyển/HSK đang chọn
   (progress.ui.selectedBookIds/selectedLessons/lessonsAllMode — tái dùng dữ liệu có sẵn).
   Chỉ khi phạm vi này không đủ mới mở rộng ra ngoài, ưu tiên bài GẦN current lesson nhất.
```
Lesson-priority **không bao giờ** đụng vào `due/stability/difficulty` của FSRS card — chỉ quyết
định NEW card nào được đưa vào session.

### Daily limit (Phần 22)
`progress.ui.dailyReviewLimit` (mặc định 50) và `dailyNewLimit` (mặc định 10), đếm số đã làm "hôm
nay" (giờ VN) trực tiếp từ `review_history` (không cần state riêng, không lệch khi refresh/nhiều
tab). Nếu `newOnlyAfterDue = true` (mặc định) và tổng số due vượt quá số slot ôn còn lại trong
ngày (tức còn backlog), session **không** lấy NEW word — tránh new cards đè thêm backlog FSRS.

### Current lesson (Phần 6)
Ưu tiên `progress.ui.currentLesson` (tự cập nhật ở bước 3 vòng đời thẻ). Nếu chưa có, lấy bài lớn
nhất trong phạm vi Quyển/bài đang chọn của user (dữ liệu có sẵn, không tạo hệ thống mới).

⚠️ **Lưu ý bảo trì**: ranh giới Quyển/HSK (`BOOKS`) hiện chỉ định nghĩa trong `index.html`
(frontend). `api/index.js` có một bản sao rút gọn `BOOKS_RANGES` (chỉ `from/to`) để server biết
phạm vi khi `lessonsAllMode = true`. Nếu bạn thêm/sửa Quyển trong `index.html`, nhớ cập nhật cả
`BOOKS_RANGES` trong `api/index.js`.

## 6. API

| Endpoint | Method | Việc |
|---|---|---|
| `/api/study/today` | GET | Dashboard: dueCount, newInCurrentLesson, currentLesson, weakCount |
| `/api/study/session` | GET | Lấy 1 session (review trước, new sau), áp dụng lesson-priority + daily limit |
| `/api/study/review` | POST | Ghi 1 lượt review, gọi FSRS thật, trả về card mới |
| `/api/study/weak-words` | GET | Danh sách từ hay quên (filter, không đổi FSRS state) |
| `/api/study/debug` | GET (admin) | Xem thô state/due/stability/difficulty/reps/lapses |

## 7. Weak words (Phần 17)

Filter thẻ đã review ít nhất 1 lần (`reps > 0`) và (`lapses >= 2` HOẶC `difficulty >= 6`) — chỉ là
**view**, không thay đổi FSRS state của card khi hiển thị.

## 8. Timezone

Mọi mốc "hôm nay" (daily limit, dashboard) tính theo giờ Việt Nam (`Asia/Ho_Chi_Minh`), tái dùng
`todayKey()`/`vnDateKey()` đã có sẵn trong `api/index.js`. `due` trong Postgres luôn là
`TIMESTAMPTZ` (UTC nội bộ) — so sánh `due <= now()` không phụ thuộc timezone server.

## 9. Concurrency

Mỗi lượt review là 1 transaction Postgres với `SELECT ... FOR UPDATE` trên đúng dòng
`(user_id, hz, l)` — 2 tab/double-click cùng review 1 từ sẽ tự xếp hàng, không ghi đè sai lịch
FSRS. Phía client cũng disable nút rating trong lúc đang submit để giảm khả năng bắn 2 request.

## 10. Những gì KHÔNG đổi

- `progress.srs` (hệ SRS cũ, step-based) vẫn giữ nguyên, vẫn dùng cho Flashcard/Trắc nghiệm/Nghe/Gõ
  chữ/Dịch câu như trước — không xoá, không migrate ép buộc.
- `vocab_words`, `word_examples`, `hanzi_parts`, `activity_logs`, hệ thống auth/role, admin panel:
  giữ nguyên hoàn toàn.
- Mobile UX của các tab cũ không đổi (Phần 25: không redesign toàn bộ app).
