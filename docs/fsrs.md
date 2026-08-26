# Kiến trúc hệ thống ôn tập FSRS (v67 — AUTO RATING; BỔ SUNG "Highlight System Rating")

> **V67 so với v66**: màn "Hôm nay học" giờ là trắc nghiệm — user chỉ chọn đáp án, KHÔNG còn thấy
> 4 nút Again/Hard/Good/Easy. Rating được server tự suy ra từ hành vi trả lời (đúng/sai +
> responseTime + state/stability/difficulty hiện tại + lịch sử). Xem chi tiết ở mục 4b/6b bên dưới.
> Mọi phần khác (schema `fsrs_cards`, lesson-priority, daily limit, current lesson...) giữ nguyên
> 100% so với v66.
>
> **Bổ sung sau V67 ("Highlight System Rating")**: khôi phục lại 4 nút Again/Hard/Good/Easy trong
> màn "Hôm nay học" (revert phần UI của V67, GIỮ NGUYÊN phần "server tự xác định đúng/sai" —
> `answerCorrect` vẫn 100% do server tính, không tin client). Sau khi user chọn đáp án trắc nghiệm,
> client gọi `POST /api/study/review/preview` (chỉ đọc) để lấy "System Rating" server sẽ tự suy ra,
> hiện 4 nút có highlight (glow) đúng nút đó + đếm ngược ~2s. User có thể bấm đổi bất kỳ lúc nào
> ("User Rating luôn thắng System Rating"); hết giờ thì tự dùng System Rating. Rating cuối cùng gửi
> kèm `rating` khi commit qua `POST /api/study/review` — xem mục 4b/6c/6d bên dưới.

## 1. Tổng quan

App vẫn là Express + Postgres thuần (không đổi framework/deploy). Hệ thống FSRS là một **lớp mới,
song song** với các chế độ học cũ (Flashcard/Trắc nghiệm/Nghe/Gõ chữ/Dịch câu) — các chế độ cũ giữ
nguyên 100%, dùng `progress.srs` (step-based) như trước. Tab mới **"🎯 Hôm nay học"** là nơi dùng
FSRS thật, quyết định user nên ôn từ nào hôm nay và ưu tiên NEW word nào theo bài gần nhất.

## 2. Thư viện

`ts-fsrs` (npm, `^5.4.1`) — implement đúng thuật toán **FSRS-6** (21 parameters `w[0]..w[20]`,
gồm cả tham số `decay` mới ở v6). Toàn bộ tính toán `due/stability/difficulty/state` nằm trong
`lib/fsrs.js`, đây là **nơi duy nhất** gọi `ts-fsrs`. Desired retention mặc định = **0.90**, dùng
default weights của thư viện — không tự tối ưu.

> **Nâng cấp FSRS-6 (từ `ts-fsrs@4.4.0` → `^5.4.1`)**: API `fsrs()/generatorParameters()/
> createEmptyCard()/repeat()/Rating/State` không đổi giữa các version, chỉ mặc định của bộ weights
> đổi từ 17 (FSRS-4.5) sang 21 tham số (FSRS-6) — nên không cần migrate schema/dữ liệu, thẻ cũ
> (`state/difficulty/stability/due/...`) được giữ nguyên và tiếp tục evolve dưới weights mới ngay
> từ lượt review tiếp theo. `lib/fsrs.js` tự assert số lượng `w` = 21 khi khởi tạo scheduler
> (`getFsrsVerificationInfo()`), fail sớm nếu dependency không phải FSRS-6. Chạy
> `npm run verify:fsrs6` để xem bằng chứng scheduling thực tế.

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
Trong V67 thuần, `rating` và `auto_rating` LUÔN cùng giá trị (server tự suy 100%, không nhận rating
từ client). **Sau bổ sung "Highlight System Rating"**: `auto_rating` vẫn luôn là gợi ý THUẦN của
`lib/fsrs-auto-rating.js` (không đổi, dùng cho phân tích "rating tự động có chính xác không?" —
Phần 21), còn `rating` là rating **THẬT SỰ** đã gửi vào `ts-fsrs` — có thể khác `auto_rating` nếu
user bấm tay 1 nút khác trong lúc countdown (client gửi kèm `rating` khi commit, xem mục 4b). 2 cột
tách biệt này chính là cơ chế lưu vết "hệ thống đề xuất gì" song song với "user thật sự chọn gì".

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
giờ** tự gửi `answerCorrect`, `due`, `stability`, `difficulty`, hay `state` — tất cả đều do server
tự xác định/tự tính. `responseTimeMs` đo bằng `performance.now()` tính từ lúc câu hỏi thực sự hiển
thị đến lúc user chọn đáp án (Phần 4), được sanitize ở server (ép về số hữu hạn ≥0, trần 10 phút)
trước khi dùng — không phải nguồn sự thật FSRS, chỉ là 1 tín hiệu đầu vào cho auto-rating.

**Bổ sung "Highlight System Rating"**: client GIỜ có thể gửi thêm 1 field tuỳ chọn `rating` (1 trong
`'again'|'hard'|'good'|'easy'`) — do NGƯỜI DÙNG bấm tay hoặc do countdown ở FE tự chọn khi hết giờ
chờ (xem mục 6c/6d). Server validate nghiêm ngặt (chỉ nhận đúng 4 chuỗi hợp lệ, sai/không gửi thì
coi như không có override); nếu hợp lệ, `rating` này THẮNG gợi ý tự động (`lib/fsrs-auto-rating.js`)
khi gọi `ts-fsrs` — nhưng **KHÔNG bao giờ** được dùng để suy ngược lại `answerCorrect` (đúng/sai câu
trắc nghiệm vẫn 100% do server tự so khớp DB, độc lập hoàn toàn với rating cuối cùng).

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
| `/api/study/review` | POST | (V67 + bổ sung "Highlight System Rating") Nhận `selectedAnswer`+`responseTimeMs`(+`answerChanges`+`rating` tuỳ chọn), tự xác định đúng/sai + tự suy ra System Rating (+ dùng `rating` override nếu client gửi hợp lệ) + gọi FSRS thật, trả về `{answerCorrect, correctAnswer, card, rating, systemRating}` |
| `/api/study/review/preview` | POST | (Bổ sung "Highlight System Rating") CHỈ ĐỌC — không ghi gì lên FSRS/review_history. Nhận y hệt input của `/api/study/review` (trừ `rating`), trả về `{answerCorrect, correctAnswer, systemRating}` để FE hiện highlight TRƯỚC khi commit thật |
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

Frontend (`js/review.js`, hàm `rvPick`/`rvPrepareCurrentCard`) hiện chữ Hán, sinh 4 lựa chọn nghĩa
bằng `rvMakeOpts` (dùng lại đúng thuật toán chọn "distractor dễ nhầm" của tab Trắc nghiệm —
`makeQuizOpts`, chỉ khác pool: review dùng toàn bộ `WORDS` vì 1 thẻ due có thể thuộc bài ngoài phạm
vi filter đang chọn). `quizType` mặc định gửi lên server là `'hz2vi'` (nhìn chữ Hán → chọn nghĩa),
khớp đúng ví dụ trong yêu cầu V67 ("裙子 là gì?").

### 6d. "Highlight System Rating" — khôi phục Again/Hard/Good/Easy (bổ sung sau V67)

Sau khi user chọn đáp án trắc nghiệm (đúng/sai đã hiện ngay ở client), `js/review.js` KHÔNG commit
thẳng lên FSRS như V67 nữa. Flow mới (`rvPick` → `rvFetchSystemRating` → `rvStartCountdown` →
`rvChooseRating`/`rvCommitRating`):

1. Gọi `POST /api/study/review/preview` (chỉ đọc) → nhận `systemRating`.
2. Hiện 4 nút Again/Hard/Good/Easy (`rvRenderRatingBar`), nút trùng `systemRating` được gắn class
   `.system-rating` (bold + glow + border — CSS riêng ở `css/styles.css`, tắt animation khi
   `prefers-reduced-motion`), kèm đếm ngược `RV_AUTO_COMMIT_MS` (2000ms).
3. User bấm 1 nút bất kỳ trong lúc đếm ngược → `rvChooseRating(rating)` → huỷ countdown, dùng đúng
   `rating` đó làm Final Rating ("User Rating luôn thắng System Rating").
4. Hết giờ mà chưa bấm → tự dùng `systemRating` làm Final Rating.
5. Gửi Final Rating kèm field `rating` khi gọi `POST /api/study/review` (qua
   `submitFsrsReviewAwaited`/`_submitFsrsReviewImpl` ở `js/study-queue.js`, dùng CHUNG hạ tầng
   outbox/idempotency/retry với 4 tab học khác — các tab đó không truyền `rating` nên không đổi
   hành vi V67 cũ của chúng).

`rvRatingPhase = 'committing'` được set NGAY (đồng bộ, trước bất kỳ `await` nào) trong
`rvCommitRating` để chặn commit lần 2 nếu click và hết giờ xảy ra gần như đồng thời. Server vẫn là
nguồn sự thật cuối: `data.rating` trả về từ `/api/study/review` ghi đè lại `rvFinalRating` ở client
sau khi commit xong (Phần 20).

Admin vẫn thấy thêm dòng debug nhỏ `auto rating = ...` (lấy từ `data.debug.autoRating`, chỉ server
trả khi `authed` là admin/superadmin) — nay dùng để đối chiếu xem `auto_rating` (gợi ý hệ thống) có
khác `rating` (rating thật đã dùng, có thể do user override) hay không.

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

## 11. FSRS Personal Optimizer (V82)

Pipeline: `review_history` → **data quality check** → chia 80/20 train/validation theo THẺ (không
theo dòng review riêng lẻ, tránh rò rỉ dữ liệu giữa 2 tập) → **train** bằng optimizer chính thức của
`ts-fsrs` (package `@open-spaced-repetition/binding`, native NAPI/Rust — **không tự viết gradient
descent thay thế**) → **evaluate** default vs personal weights trên tập validation bằng log-loss
(binary cross-entropy giữa `get_retrievability()` dự đoán và `answer_correct` thật, dùng đúng
scheduler thật qua `lib/fsrs.js`, không tự viết lại forgetting curve) → lưu kết quả làm **candidate**
(CHƯA active).

Toàn bộ logic ở `lib/fsrs/optimizer.js`. Bảng `user_fsrs_weights` (đã có từ V69) được mở rộng thêm
cột `enabled`/`candidate_*`/`previous_*`/`status` — xem `migrations/V82_fsrs_personal_optimizer.sql`.
`enabled = true` là điều kiện DUY NHẤT để scheduler dùng personal weights
(`lib/fsrs/optimizer.js:getUserActiveWeights`, có cache TTL 30s, được `reviewService.reviewCard()`
đọc song song với `desiredRetention`) — **Apply/Rollback/Reset chỉ đụng bảng này, không bao giờ đụng
`fsrs_cards`/`review_history`** (không reset lịch ôn tập/stability/difficulty/reps/lapses của user).

API tự phục vụ (user đăng nhập chạy trên dữ liệu của chính mình):
`GET/POST /api/fsrs-optimizer/{status,run,apply,rollback,reset}` — xem `api/index.js`. UI: modal
`#optimizer-modal` (mở từ account menu, nút "🧠 FSRS Optimizer") + `js/fsrs-optimizer.js`.

**Cần cài `@open-spaced-repetition/binding`** (`npm install`, package public beta) trước khi Run
Optimizer hoạt động thật — nếu thiếu/API khác tài liệu công khai lúc viết code, hàm
`trainWithOfficialOptimizer()` throw lỗi rõ ràng thay vì âm thầm dùng thuật toán xấp xỉ khác.
Test thuần JS (không cần Postgres): `npm run test:optimizer`. Test vòng đời apply/rollback/reset
(cần `DATABASE_URL`): `npm run test:optimizer:integration`.

### 11.1. Deploy trên Vercel — native binding + WASI fallback (V83-FIX-v3)

`@open-spaced-repetition/binding` là native NAPI/Rust, chọn binary theo platform qua
`optionalDependencies`. Package tự có cơ chế rơi xuống **WASI fallback CHÍNH THỨC** nếu native
không load được — NHƯNG chỉ khi gói tài nguyên WASM `@open-spaced-repetition/binding-wasm32-wasi`
thật sự có trong `node_modules` (đã thêm vào `optionalDependencies` của `package.json` — bản trước
KHÔNG có gói này nên chưa từng có fallback thật). KHÔNG dùng
`@open-spaced-repetition/binding/dynamic-wasi` — đó là API cho bundler trình duyệt (Vite
`?url`/`?worker`), không áp dụng cho Node server thuần.

3 lớp chẩn đoán (xem `TROUBLESHOOTING-FSRS-OPTIMIZER.md` để biết cách đọc):
1. **Build time**: `scripts/verify-optimizer-binding.js` chạy tự động qua `postinstall` — in kết
   quả vào Build Logs của Vercel. Mặc định không chặn deploy; đặt env `FSRS_OPTIMIZER_STRICT_BUILD=1`
   để bắt build fail khi thiếu.
2. **Runtime**: `lib/fsrs/optimizer.js:loadOfficialOptimizer()`/`getOptimizerEngineStatus()` — phản
   ánh qua `GET /api/fsrs-optimizer/status` (field `engineStatus`/`optimizerEngineState`, 1 trong 4
   giá trị `OPTIMIZER_NATIVE_READY`/`OPTIMIZER_WASI_READY`/`OPTIMIZER_READY`/`OPTIMIZER_UNAVAILABLE`).
3. **UI**: `js/fsrs-optimizer.js` hiện badge engine cho mọi user, hiện thêm root cause kỹ thuật CHỈ
   cho admin (`isAdminRole()`).

`vercel.json` có `"framework": null` (ép Framework Preset = "Other" — Vercel âm thầm bỏ qua
`functions.includeFiles` với 1 số framework khác, chỉ log 1 dòng cảnh báo) và
`installCommand` tự chuyển sang `npm ci` nếu đã có `package-lock.json` (chưa có sẵn trong repo vì
môi trường sửa code này không có mạng để tự sinh — xem README ở `TROUBLESHOOTING-FSRS-OPTIMIZER.md`).


