# Kiến trúc hệ thống ôn tập FSRS (v67 — AUTO RATING)

> **V67 so với v66**: màn "Hôm nay học" giờ là trắc nghiệm — user chỉ chọn đáp án, KHÔNG còn thấy
> 4 nút Again/Hard/Good/Easy. Rating được server tự suy ra từ hành vi trả lời (đúng/sai +
> responseTime + state/stability/difficulty hiện tại + lịch sử). Xem chi tiết ở mục 4b/6b bên dưới.
> Mọi phần khác (schema `fsrs_cards`, lesson-priority, daily limit, current lesson...) giữ nguyên
> 100% so với v66.

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
previous_stability, new_stability, previous_difficulty, new_difficulty, scheduled_days,
response_time_ms, answer_changes, auto_rating        -- V67, thêm qua ALTER TABLE IF NOT EXISTS
```
`rating` và `auto_rating` cùng giá trị trong V67 (server luôn tự suy — không còn rating do UI 4 nút
gửi lên như v66); giữ cả 2 cột để không phá tương thích ngược với `rating` đã có từ v66, đồng thời
`auto_rating` đặt tên rõ ràng cho mục đích phân tích "rating tự động có chính xác không?" (Phần 21).

Dùng cho: daily-limit counter (đếm số review "hôm nay" theo giờ VN), **baseline responseTime cá
nhân của từng thẻ** (V67 — `getRecentReviewHistoryForCard`), weak-words fallback nâng cao sau này,
debug, thống kê.

Cả 2 bảng tạo qua `CREATE TABLE IF NOT EXISTS` (giống `vocab_words`/`word_examples`) — an toàn,
không cần migration script riêng, không đụng dữ liệu cũ.

## 4. Vòng đời 1 thẻ (card lifecycle)

1. User mở "Hôm nay học" → `GET /api/study/today` chỉ COUNT, không tạo card.
2. User bấm "Bắt đầu học" → `GET /api/study/session` trả về danh sách review (đã có card, đến hạn)
   + new (chưa có card) — **không** tạo card cho phần new tại bước này.
3. User trả lời 1 câu trắc nghiệm (dù review hay new) → `POST /api/study/review` — server:
   - Tra `vocab_words` để xác định đáp án đúng theo `quizType`, tự so khớp với `selectedAnswer` của
     client ra `answerCorrect` (**không tin** bất kỳ giá trị đúng/sai nào client tự gửi — Phần 3/20).
   - `BEGIN` transaction, `INSERT ... ON CONFLICT DO NOTHING` (tạo card nếu chưa có),
     `SELECT ... FOR UPDATE` khoá đúng dòng đó (chống double-click/nhiều tab — Phần 27).
   - Lấy tối đa 10 lượt review gần nhất của ĐÚNG thẻ này (`getRecentReviewHistoryForCard`, cùng
     transaction) để dựng baseline responseTime cá nhân.
   - Gọi `lib/fsrs-auto-rating.js` → suy ra 1 trong 4 rating (Again/Hard/Good/Easy) từ
     answerCorrect + responseTime (so với baseline cá nhân) + state/stability/difficulty hiện tại +
     answerChanges (Phần 6/9/10/15/16) — **KHÔNG** tự tính due/stability/difficulty ở bước này.
   - Gọi `lib/fsrs.js` (ts-fsrs thật) với rating vừa suy ra để tính state/due/stability/difficulty mới.
   - `UPDATE fsrs_cards` + `INSERT review_history` (kèm `response_time_ms`, `answer_changes`,
     `auto_rating`) + `COMMIT`.
   - Nếu đây là NEW word (trước đó `reps=0, state=0, last_review=NULL`) → cập nhật
     `progress.ui.currentLesson = l` (tự động dịch "current lesson" theo đúng bài user vừa học).

**V67 — client gửi gì / KHÔNG gửi gì (Phần 20)**: client CHỈ gửi
`{ wordId:{hz,l}, quizType, selectedAnswer, responseTimeMs, answerChanges }`. Client **không bao
giờ** tự gửi `rating`, `answerCorrect`, `due`, `stability`, `difficulty`, hay `state` — tất cả đều
do server tự xác định/tự tính (khác v66: v66 nhận thẳng `rating` từ 4 nút bấm + `answerCorrect` tự
báo cáo của user). `responseTimeMs` đo bằng `performance.now()` tính từ lúc câu hỏi thực sự hiển thị
đến lúc user chọn đáp án (Phần 4), được sanitize ở server (ép về số hữu hạn ≥0, trần 10 phút) trước
khi dùng — không phải nguồn sự thật FSRS, chỉ là 1 tín hiệu đầu vào cho auto-rating.

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
| `/api/study/review` | POST | (V67) Nhận `selectedAnswer`+`responseTimeMs`(+`answerChanges`), tự xác định đúng/sai + tự suy ra rating + gọi FSRS thật, trả về `{answerCorrect, correctAnswer, card}` |
| `/api/study/weak-words` | GET | Danh sách từ hay quên (filter, không đổi FSRS state) |
| `/api/study/debug` | GET (admin) | Xem thô state/due/stability/difficulty/reps/lapses |

### 6b. Auto-rating layer (V67) — `lib/fsrs-auto-rating.js`

Hàm `getAutomaticFSRSRating({ answerCorrect, responseTimeMs, card, reviewHistory, answerChanges })`
là **nơi duy nhất** quyết định rating, tách biệt hoàn toàn khỏi `lib/fsrs.js` (nơi duy nhất gọi
ts-fsrs). Không dùng threshold thời gian cố định chung cho mọi user (kiểu "<2s=Easy") — logic:

1. **Sai** (`answerCorrect=false`) → luôn `again`, bất kể nhanh/chậm (Phần 7/11).
2. **Đúng + card hoàn toàn mới** (chưa từng có `fsrs_card`/`reps=0`) → **không bao giờ** tự suy ra
   `easy` chỉ vì nhanh (Phần 9); chỉ lệch sang `hard` khi có dấu hiệu lúng túng rõ ràng (đổi đáp án
   ≥3 lần hoặc mất >20s), mặc định `good`.
3. **Đúng + card đã có lịch sử** → dựng **baseline responseTime cá nhân** của CHÍNH thẻ đó (median
   tối đa 10 lượt đúng gần nhất, tối thiểu cần 3 lượt mới coi là đủ dữ liệu — Phần 15):
   - baseline có + rất nhanh so với baseline + difficulty thấp + stability ổn định + không đổi đáp
     án → `easy` (Phần 14).
   - baseline có + chậm hơn hẳn baseline, hoặc đổi đáp án ≥2 lần, hoặc difficulty cao mà vẫn chậm
     → `hard` (Phần 12).
   - còn lại → `good` (fallback an toàn — Phần 13).
   - chưa đủ dữ liệu để dựng baseline → lưới an toàn bảo thủ (ngưỡng tuyệt đối rộng, chỉ nghiêng
     `hard`/`easy` khi tín hiệu rất rõ, mặc định vẫn `good` — Phần 15/29).

`reviewHistory` được lấy bằng `getRecentReviewHistoryForCard(userId, hz, l, 10, client)` **trong
cùng transaction** với `SELECT ... FOR UPDATE`, để nhất quán với dòng đang bị khoá.

### 6c. Chế độ trắc nghiệm trong session review (V67)

Frontend (`index.html`, hàm `rvPick`/`rvPrepareCurrentCard`) hiện chữ Hán, sinh 4 lựa chọn nghĩa
bằng `rvMakeOpts` (dùng lại đúng thuật toán chọn "distractor dễ nhầm" của tab Trắc nghiệm —
`makeQuizOpts`, chỉ khác pool: review dùng toàn bộ `WORDS` vì 1 thẻ due có thể thuộc bài ngoài phạm
vi filter đang chọn). `quizType` mặc định gửi lên server là `'hz2vi'` (nhìn chữ Hán → chọn nghĩa),
khớp đúng ví dụ trong yêu cầu V67 ("裙子 là gì?"). User **không còn thấy** Again/Hard/Good/Easy —
chỉ admin mới thấy dòng debug nhỏ `auto rating = ...` sau khi trả lời (Phần 18/19/22), lấy từ
`data.debug.autoRating` mà server chỉ trả về khi `authed` là admin/superadmin.

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
FSRS. Phía client cũng disable các nút đáp án trắc nghiệm trong lúc đang submit (`rvSubmitting`) để
giảm khả năng bắn 2 request cho cùng 1 câu.

## 10. Những gì KHÔNG đổi

- `progress.srs` (hệ SRS cũ, step-based) vẫn giữ nguyên, vẫn dùng cho Flashcard/Trắc nghiệm/Nghe/Gõ
  chữ/Dịch câu như trước — không xoá, không migrate ép buộc.
- `vocab_words`, `word_examples`, `hanzi_parts`, `activity_logs`, hệ thống auth/role, admin panel:
  giữ nguyên hoàn toàn.
- Mobile UX của các tab cũ không đổi (Phần 25: không redesign toàn bộ app).
- Schema `fsrs_cards`, thuật toán FSRS thật (`lib/fsrs.js`), lesson-priority, daily limit, current
  lesson, weak-words, timezone: **giữ nguyên 100%** so với v66 — V67 chỉ thêm 1 layer suy luận
  rating phía trước bước gọi FSRS, không sửa bất kỳ công thức FSRS nào (Phần 28).
