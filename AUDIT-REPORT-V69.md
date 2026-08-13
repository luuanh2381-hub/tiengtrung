# Audit FSRS → V69 "Pure FSRS" — Báo cáo cuối cùng

## 0. Điều chỉnh phạm vi so với brief gốc

Brief giả định một hệ thống ở quy mô lớn (nhiều service, ORM, migration runner riêng). Thực tế
codebase là **một Express app duy nhất** (~3.100 dòng `api/index.js` + `lib/`), **một pool
Postgres duy nhất** (`pg`), state app lưu trong 1 bảng `app_store` (JSONB) + các bảng FSRS riêng
(`fsrs_cards`, `review_history`). Không có ORM, không có ts-fsrs "wrapper" nào khác ngoài
`lib/fsrs.js`. Báo cáo dưới đây phản ánh đúng hệ thống thật, không phải hệ thống tưởng tượng trong
brief.

---

## 1. Xác minh FSRS

| Mục | Giá trị thực tế |
|---|---|
| Package | `ts-fsrs` |
| Version khai báo (`package.json`) | `^5.4.1` |
| Số weights (`w`) | **21** — khớp chính xác bộ default FSRS-6 công bố chính thức (so khớp từng giá trị trong `test/fsrs.test.js`, không chỉ đếm length) |
| Scheduler | `fsrs(generatorParameters({...}))` từ `ts-fsrs`, dùng `.next()` khi rating đã biết (không dùng `.repeat()` lãng phí) |
| Xác minh runtime | `lib/fsrs.js:buildScheduler()` throw ngay nếu `params.w.length !== 21` — fail-fast, không âm thầm chạy sai version |
| Endpoint xác minh | `GET /api/study/fsrs-verify` (admin) + `npm run verify:fsrs6` |

**Kết luận: hệ thống ĐANG dùng FSRS-6 thật, không phải FSRS-5/4 giả mạo hay pad số.** Đây là phần
audit duy nhất tôi có thể "xác minh" theo đúng nghĩa đen — không chạy được `npm install`/`npm test`
trong sandbox này (không có network egress), nên tôi xác nhận dựa trên đọc code + logic tự-assert
sẵn có trong `verify-fsrs6.js`/`fsrs.test.js`, KHÔNG phải dựa trên chạy thử thực tế. **Việc bắt buộc
trước khi deploy: chạy `npm install && npm test && npm run verify:fsrs6` trên máy có mạng.**

---

## 2. Loại bỏ SRS cũ — tìm thấy gì, đã xoá gì

**Điều bất ngờ:** lịch ôn tập (scheduling) đã KHÔNG dùng ease factor/interval cũ từ trước — quá
trình ôn tập trong `lib/db.js:reviewFsrsCard()` đã đi thẳng qua `ts-fsrs` từ trước khi tôi vào audit.
Cái còn sót lại là **1 hệ thống song song ở lớp hiển thị/thống kê**, không phải ở lớp lịch ôn:

- `progress.srs` — object `{ [hz]: { step } }` lưu trong `app_store` JSONB, dùng để đếm "known
  words" cho leaderboard/rank. Không ảnh hưởng lịch ôn, nhưng là **2 nguồn sự thật** cho "user đã
  thuộc từ này chưa" (progress.srs.step >= 3 vs fsrs_cards.state = Review) → **đã xoá khỏi
  `emptyProgress()`**, thay bằng đếm trực tiếp từ `fsrs_cards` (`countKnownFsrsWords`).
- `progress.streak` / `progress.lastDate` — **client tự POST số này lên, server tin tưởng mù
  quáng** (`app.post('/api/progress')` cũ). Đây là 1 bug bảo mật nhẹ (user tự sửa streak tuỳ ý) chứ
  không chỉ là "SRS cũ". **Đã xoá hoàn toàn khỏi input được chấp nhận**, thay bằng streak **server
  tự tính** từ bảng `study_sessions` mới (`lib/fsrs/analytics.js:getStreak()`).

Dữ liệu `progress.srs`/`progress.streak` cũ **vẫn còn nằm im trong JSONB** của các user hiện có —
cố tình KHÔNG xoá bằng migration tự động (rủi ro sửa JSONB thủ công cao hơn lợi ích, vì code đã
ngừng đọc field này). Có ghi chú SQL dọn dẹp tuỳ chọn trong `migrations/V69_pure_fsrs.sql` mục 5.

**Không có 2 scheduler nào chạy song song** — xác nhận bằng cách đọc toàn bộ `lib/`, chỉ có 1 chỗ
gọi `fsrs(generatorParameters(...))` (`lib/fsrs.js`), mọi module mới (`lib/fsrs/scheduler.js`) chỉ
re-export, không tự tạo scheduler khác.

---

## 3. FSRS Card — đã đủ 9 field từ trước

`fsrs_cards` đã có sẵn `due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses,
state, last_review` trước khi tôi vào audit (không có gì để sửa). Đã thêm `assertValidCardRow()`
trong `lib/fsrs/cardMapper.js` để validate 8/9 field bắt buộc (trừ `last_review`, có thể null cho
thẻ New) trước khi đưa vào `ts-fsrs`, phòng trường hợp có nguồn ghi dữ liệu lỗi trong tương lai.

---

## 4. Scheduler Layer — `lib/fsrs/` (module mới)

| File | Vai trò |
|---|---|
| `scheduler.js` | Re-export scheduler thật từ `lib/fsrs.js` — **không phải scheduler thứ 2** |
| `cardMapper.js` | Re-export mapping card↔row + validate 9 field bắt buộc |
| `reviewService.js` | **Entry point DUY NHẤT** cho mọi lượt review: đọc `desired_retention` của user → gọi `db.reviewFsrsCard()` → ghi `study_sessions` |
| `analytics.js` | `study_sessions` table, streak, heatmap, dashboard, `GET /api/fsrs/stats` |
| `optimizer.js` | Export review history theo format Optimizer, `user_fsrs_weights` CRUD + fallback |

`api/index.js` đã đổi từ gọi thẳng `db.reviewFsrsCard()` sang gọi `reviewService.reviewCard()`
(dòng ~681) — đúng yêu cầu "mọi review phải đi qua scheduler layer".

**Lưu ý kỹ thuật quan trọng đã tự phát hiện và tránh:** `lib/fsrs.js` (file) và `lib/fsrs/`
(thư mục) không thể cùng được resolve qua `require('../lib/fsrs')` — Node ưu tiên file trước thư
mục, nên 1 barrel `lib/fsrs/index.js` sẽ **không bao giờ được gọi tới** nếu import kiểu đó. Đã bỏ
barrel này, mọi nơi `require` thẳng file con (`require('../lib/fsrs/reviewService')` v.v.) để tránh
dead code / bug ẩn.

---

## 5. Desired Retention theo user

- Bảng `user_settings (user_id PK, desired_retention CHECK IN (0.80,0.85,0.90,0.95))`.
- `lib/fsrs.js` giờ cache 1 scheduler **cho mỗi mức trong 4 mức cho phép** (`schedulerCache`),
  không tạo scheduler mới mỗi request, và **không cho phép giá trị retention tuỳ ý** lọt vào
  `ts-fsrs` (validate qua `isAllowedRetention`).
- API: `GET/POST /api/settings/retention`. Giá trị sai → trả `{ok:false, error}` (lỗi input, không
  phải lỗi server).
- Test mới trong `test/fsrs.test.js`: xác nhận retention thấp hơn → `scheduled_days` dài hơn (đúng
  bản chất toán học FSRS), và giá trị không hợp lệ → fallback 0.90 chứ không throw.

---

## 6. Chuẩn bị FSRS Optimizer

- `review_history` **thiếu `elapsed_days`** trước khi tôi sửa — đây là field bắt buộc để train
  weights (số ngày kể từ lần review trước) nhưng trước đó chỉ tồn tại tạm thời trên `fsrs_cards`
  rồi bị ghi đè ở lượt sau, **không có trong lịch sử**. Đã thêm cột (`ALTER TABLE ... ADD COLUMN IF
  NOT EXISTS`) và ghi vào mỗi lượt review.
- `lib/fsrs/optimizer.js:exportReviewHistoryForOptimizer()` xuất đúng format: `user_id, card_id,
  review_time, rating, response_time_ms, stability_before/after, difficulty_before/after,
  scheduled_days, elapsed_days`. `card_id` ghép từ `hz::l` (khoá composite thật của bảng, không có
  cột id đơn lẻ cho 1 "thẻ" — không đổi schema `fsrs_cards` chỉ để có cột giả).
- **Chưa train tự động** — đúng yêu cầu. `getOptimizerReadiness()` chỉ đếm số review đã có
  (ngưỡng tham khảo 200) để admin biết user nào đã đủ dữ liệu, không tự trigger gì.
- Endpoint admin: `GET /api/admin/fsrs-optimizer/export?userId=...&limit=...`.

---

## 7. Personal Weights

Bảng `user_fsrs_weights (user_id PK, weights DOUBLE PRECISION[21], trained_at, review_count)`.
`getUserWeights()` trả weights riêng nếu có, **fallback về default weights của `ts-fsrs`** nếu
chưa train (không phải hardcode lại 1 mảng default riêng — lấy trực tiếp từ
`getSchedulerForRetention().params.w` để không lệch với scheduler thật đang chạy).
`saveUserWeights()` validate đúng 21 phần tử trước khi ghi. Chưa có job train nào gọi hàm này —
đúng yêu cầu "chưa cần train tự động".

---

## 8. FSRS Analytics — `GET /api/fsrs/stats`

Trả về đúng 8 field yêu cầu. Điểm cần lưu ý về định nghĩa `retention`: tính trên các lượt review có
`previous_state = Review` (tức thẻ đã "chín", đến hạn ôn thật sự), **không gộp chung New/Learning**
— nếu gộp chung, retention sẽ bị thổi phồng ảo vì New/Learning gần như luôn "đúng". Đây là định
nghĩa chuẩn của FSRS, không phải lựa chọn tuỳ tiện.

---

## 9-12. Study Session Tracker / Dashboard / Streak / Heatmap

- Bảng `study_sessions` mới, hoàn toàn tách biệt khỏi `fsrs_cards`/`review_history`.
- **Cơ chế tự động (không cần sửa frontend):** mỗi lượt review gọi `recordStudyActivity()` — nối
  dài session đang mở nếu cách lượt trước < 15 phút, ngược lại mở session mới. Vì frontend
  (`index.html`, 3.484 dòng) chưa được tôi sửa (xem mục "Chưa làm" bên dưới), đây là cách duy nhất
  có dữ liệu dashboard **ngay khi deploy**, không cần chờ frontend gọi start/end thủ công.
- Cũng có sẵn `POST /api/study/session/start` + `/heartbeat` cho frontend tương lai muốn đo chính
  xác hơn (kể cả thời gian không review, ví dụ đang nghe phát âm).
- Streak: 1 ngày tính là "có học" nếu ≥5 phút HOẶC ≥10 review (đúng yêu cầu), tính theo giờ VN
  (`Asia/Ho_Chi_Minh`), current streak cho phép "hôm nay chưa học" mà không gãy streak (đếm lùi từ
  hôm qua nếu hôm nay chưa có dữ liệu).
- Heatmap: `GET /api/study/heatmap?days=365` trả `[{date, minutes}]` — dữ liệu thô, frontend tự vẽ
  lưới kiểu GitHub.
- Dashboard: `GET /api/study/dashboard` trả Hôm nay / 7 ngày / Toàn bộ + streak, đúng các số liệu
  yêu cầu (thời gian, số từ, số review, độ chính xác, ngày học nhiều nhất).

**Giới hạn quan trọng cần biết:** vì `study_sessions` là bảng MỚI, **không thể suy ngược "thời gian
học" từ lịch sử review cũ** (trước V69 không lưu start/end). Dashboard/streak/heatmap sẽ bắt đầu
tích luỹ từ lượt review đầu tiên SAU khi deploy migration này — không phải lỗi, chỉ là giới hạn vật
lý của dữ liệu đã có.

---

## 13. Hiệu năng — bug tìm thấy + đã sửa

| Vấn đề | Vị trí cũ | Sửa |
|---|---|---|
| N+1: leaderboard tính `known` cho từng user bằng cách lặp qua object JS | `/api/leaderboard` | 1 query `GROUP BY` (`getKnownCountsForUsers`) cho known; streak chỉ tính cho top 100 sau khi đã sort (không lặp streak cho toàn bộ user base) |
| N+1: admin user list tương tự | `/api/admin/users` | Bulk query tương tự |
| Thiếu index cho filter theo `state` | `fsrs_cards` chỉ có index theo `(user_id,due)` và `(user_id,l)` | Thêm `fsrs_cards_user_state_idx` — cần cho mature/young cards trong `/api/fsrs/stats` |
| Thiếu index cho filter theo `previous_state` | `review_history` | Thêm `review_history_user_prevstate_idx` — cần cho tính retention thật |
| Race condition khi xoá/reset tài khoản | Đã sửa từ audit V68 trước đó (transaction `FOR UPDATE`) — tôi mở rộng transaction đó để dọn thêm `study_sessions` (chỉ khi xoá hẳn tài khoản, KHÔNG khi reset tiến độ — xem lý do trong code) | |
| Duplicate review cùng lúc (2 request đồng thời) | Đã có `SELECT ... FOR UPDATE` trong `reviewFsrsCard()` từ trước, có test tích hợp `test/fsrs.concurrency.integration.js` (cần Postgres thật, không tự chạy trong unit test) | Không đổi — đã đúng |
| `review_history` sẽ phình to nhanh nhất trong toàn hệ thống (1 dòng/lượt review) | Chưa có partitioning | **Chưa xử lý — xem mục Scale bên dưới** |

Đề xuất index cho 4 bảng đúng yêu cầu — đã áp dụng cho `review_history`, `fsrs_cards`. `cards`
(bảng từ vựng gốc, `vocab` trong code) và `user_progress` (không tồn tại dưới tên này — tương đương
`app_store` JSONB) nằm ngoài phạm vi audit FSRS, tôi không đụng vào để tránh phá vỡ phần vocab
import/quiz đang hoạt động ổn định — nếu cần audit riêng phần đó, nên làm thành 1 audit khác.

---

## 14. Scale — bottleneck thực tế

| Quy mô | Đánh giá | Bottleneck chính |
|---|---|---|
| 1.000 user | Ổn với kiến trúc hiện tại (1 Postgres pool, Express đơn instance) | Không đáng kể |
| 10.000 user | Vẫn ổn NẾU đã có đủ index (đã thêm ở mục 13) | `app_store` là **1 dòng JSONB duy nhất chứa TẤT CẢ user** (`db.users`), mọi thao tác ghi vào đó (đổi progress, đăng ký, v.v.) đi qua `SELECT ... FOR UPDATE` trên **đúng 1 row** → **serialize hoàn toàn**, không parallel được. Đây là bottleneck lớn nhất của cả hệ thống, không riêng gì FSRS. |
| 100.000 user | **Sẽ nghẽn** ở chính điểm trên — mọi request cần sửa `app_store` (login, đổi UI setting, admin thao tác) phải xếp hàng chờ lock của 1 row JSONB. `review_history` cũng sẽ hàng chục triệu dòng, cần partition theo tháng hoặc archive định kỳ. | `app_store` JSONB single-row lock (nghiêm trọng nhất) + `review_history` không partition |

**Kết luận trung thực:** phần FSRS riêng lẻ (fsrs_cards/review_history/study_sessions) scale tốt
đến 100k user nếu có index đúng — vì chúng là bảng quan hệ thật, không phải 1 JSONB blob. Bottleneck
thực sự nằm ở kiến trúc `app_store` (1 row JSONB cho toàn bộ user), **nằm ngoài phạm vi FSRS** nhưng
tôi nêu ra vì nó sẽ chặn hệ thống trước khi FSRS kịp trở thành vấn đề. Sửa việc này (tách user ra
bảng quan hệ riêng) là 1 dự án audit riêng, không nên gộp vào "chuẩn hóa FSRS".

---

## 15. Migration

`scripts/migrate-to-pure-fsrs.js` — idempotent, in báo cáo trước/sau, backfill `user_settings`
mặc định 0.90 cho user đã có, **không đụng `progress.srs`/`streak` cũ** (an toàn hơn để nguyên).
`migrations/V69_pure_fsrs.sql` là bản đối chiếu đầy đủ schema cuối, không bắt buộc chạy tay.

---

## 16. Deliverables

### 1. Danh sách file thay đổi
- **Sửa:** `lib/fsrs.js` (thêm per-retention scheduler cache), `lib/db.js` (thêm `elapsed_days`,
  `countKnownFsrsWords`, `getKnownCountsForUsers`, mở rộng `updateDBWithFsrsCleanup`, thêm 2 index),
  `api/index.js` (xoá `progress.srs`/client-streak, thêm 10 route mới, đổi sang `reviewService`),
  `test/fsrs.test.js` (thêm 3 test cho desired retention), `package.json` (thêm script
  `migrate:fsrs`).
- **Mới:** `lib/fsrs/{scheduler,cardMapper,reviewService,analytics,optimizer}.js`,
  `migrations/V69_pure_fsrs.sql`, `scripts/migrate-to-pure-fsrs.js`, file báo cáo này.

### 2. DB migration SQL
`migrations/V69_pure_fsrs.sql` (xem file).

### 3. API thay đổi
**Route mới:** `GET/POST /api/settings/retention`, `GET /api/fsrs/stats`, `GET /api/study/dashboard`,
`GET /api/study/heatmap`, `POST /api/study/session/{start,heartbeat}`, `GET
/api/admin/fsrs-optimizer/export`, `GET /api/admin/fsrs-optimizer/weights/:userId`.
**Route đổi behavior:** `POST /api/progress` không còn nhận `srs`/`streak`/`lastDate` từ client;
`GET /api/progress` trả thêm `streak`/`longestStreak` tính từ server; `/api/leaderboard` và
`/api/admin/users` không còn field `streak` dựa trên progress cũ (dùng
`GET /api/study/dashboard` để lấy streak actual của chính mình).

### 4. Bug tìm thấy
- Client tự set `streak` (bảo mật nhẹ) — đã sửa.
- 2 nguồn sự thật cho "known word" (`progress.srs` vs `fsrs_cards`) — đã hợp nhất.
- `elapsed_days` không được lưu vào lịch sử — thiếu dữ liệu cho optimizer — đã sửa.
- N+1 query ở leaderboard + admin user list — đã sửa.
- Thiếu index cho `state`/`previous_state` — đã sửa.
- Xoá tài khoản sẽ để lại `study_sessions`/`user_settings`/`user_fsrs_weights` mồ côi nếu không mở
  rộng transaction cleanup — đã sửa (chỉ khi xoá hẳn, không khi reset tiến độ).
- (Tự phát hiện khi code) `lib/fsrs.js` file vs `lib/fsrs/` folder cùng tên → barrel `index.js` sẽ
  không bao giờ được resolve — đã tránh bằng cách bỏ barrel, import thẳng từng file con.

### 5. Bottleneck
`app_store` là 1 row JSONB duy nhất cho toàn bộ user, mọi ghi đều `SELECT FOR UPDATE` trên đúng 1
row → serialize hoàn toàn, sẽ nghẽn trước khi tới 100k user. Nằm ngoài phạm vi FSRS, cần audit
riêng nếu muốn giải quyết.

### 6. Kiến trúc mới
```
api/index.js
  └─ lib/fsrs/reviewService.js   (entry point DUY NHẤT cho review)
       ├─ lib/fsrs/scheduler.js  → lib/fsrs.js → ts-fsrs (scheduler THẬT duy nhất)
       ├─ lib/db.js:reviewFsrsCard()   (ghi fsrs_cards + review_history, transaction)
       └─ lib/fsrs/analytics.js:recordStudyActivity()  (ghi study_sessions)
  └─ lib/fsrs/analytics.js   (GET /api/fsrs/stats, dashboard, streak, heatmap)
  └─ lib/fsrs/optimizer.js   (export cho FSRS Optimizer, personal weights)
```

### 7. Patch code hoàn chỉnh
Toàn bộ đã áp dụng trực tiếp vào project (xem các file trong project đính kèm), không phải diff rời
rạc — an toàn hơn để bạn tải về chạy thẳng.

### 8. Kế hoạch triển khai production
1. `npm install` → `npm test` → `npm run verify:fsrs6` (bắt buộc, tôi chưa chạy được vì sandbox
   không có network).
2. Backup `app_store` + `fsrs_cards` + `review_history` (pg_dump) trước khi migrate.
3. `DATABASE_URL=... node scripts/migrate-to-pure-fsrs.js` trên staging trước, kiểm tra log
   trước/sau.
4. Deploy code mới (route mới không phá route cũ — an toàn deploy trước khi frontend kịp dùng).
5. Chạy lại migration script trên production (idempotent, an toàn chạy 2 lần).
6. Theo dõi `/api/fsrs/stats` + `/api/study/dashboard` cho vài user thật để xác nhận số liệu hợp lý
   trước khi build UI dashboard/heatmap ở frontend.
7. (Việc chưa làm — xem bên dưới) Tích hợp UI vào `index.html`.

---

## Việc CHƯA làm — nói rõ để tránh hiểu nhầm là "xong hết"

- **Frontend (`index.html`, 3.484 dòng)**: tôi **không sửa** — mọi API mới đã sẵn sàng (`GET
  /api/fsrs/stats`, `/api/study/dashboard`, `/api/study/heatmap`, `/api/settings/retention`) nhưng
  chưa có UI gọi tới. Sửa mù 1 file 3.484 dòng tôi chưa từng thấy render ra sao là rủi ro cao hơn
  lợi ích — cần bạn xác nhận trước, hoặc tôi cần xem UI hiện tại render thế nào trước khi thêm
  dashboard/heatmap vào đúng chỗ.
- **Chưa chạy `npm test` thật** — sandbox này không có network để `npm install ts-fsrs`. Đã syntax
  check (`node -c`) toàn bộ file sửa/thêm, không phát hiện lỗi cú pháp, nhưng đó không thay thế cho
  chạy test thật.
- **`app_store` bottleneck** (mục 14) — biết và nêu rõ, không sửa vì ngoài phạm vi FSRS.
