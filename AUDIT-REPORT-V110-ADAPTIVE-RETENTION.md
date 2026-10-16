# AUDIT-REPORT-V110 — Câu tự nhập, trí nhớ dài hạn, khuyến nghị cá nhân hoá

Phát triển TRÊN V109 (không dựng lại). Không đụng thuật toán FSRS, không đổi ID từ vựng, không xoá dữ liệu.

## 0. Kết quả khảo sát (cái đã có → tái sử dụng)

| Yêu cầu | Hiện trạng V109 | Làm gì ở V110 |
|---|---|---|
| Hồ sơ kỹ năng theo từ | ĐÃ CÓ: `word_skill_stats` (điểm giảm dần), `lib/skills.js` | Giữ nguyên thuật toán; thêm `level` (yếu/đang phát triển/tốt) |
| 6 dạng câu + chọn thích ứng | ĐÃ CÓ: `js/question-engine.js`, `question-selector.js` | Thêm 2 dạng **tự nhập**; thêm cổng/ưu tiên cho dạng đó |
| Tách FSRS chính thức / luyện bổ sung | ĐÃ CÓ: `skill_practice_log` vs `review_history`, `EXERCISES[].fsrs` | Giữ; ghi thêm `source`, `session_id` |
| Chống ghi trùng | ĐÃ CÓ: idempotency key + outbox | Dùng lại, không thêm cơ chế |
| Câu tự nhập, chấm chuẩn hoá | THIẾU (server chỉ so chuỗi) | `js/answer-match.js` |
| Trí nhớ theo khoảng nghỉ | THIẾU | `getRetention` (tính từ nhật ký, **không bảng mới**) |
| Chi tiết từng từ, khuyến nghị | THIẾU | `getWordDetail`, `lib/skill-recommend.js`, `js/skills-analysis.js` |
| Hôm nay học: nhóm từ không đếm trùng, 8 chế độ | MỘT PHẦN (V109 due-breakdown) | `getTodayBreakdown`, `renderTodayPanel` |

## 1. Chức năng đã triển khai
1. **Câu tự nhập**: Nghĩa → gõ chữ Hán; Chữ Hán → gõ pinyin. Dùng được ở thẻ FSRS chính thức, luyện bổ sung, tab Phân tích.
2. **Bộ chấm xác định** (`js/answer-match.js`, dùng chung server + trình duyệt, không AI): NFKC, bỏ khoảng trắng/ký tự vô hình/dấu câu thừa, không phân biệt hoa-thường, pinyin dấu thanh **hoặc** số thanh, ü/v/u:, nhiều cách đọc `cháng / zhǎng`.
3. **Bộ chọn**: câu tự nhập chỉ khi kỹ năng đã "đang phát triển/tốt" với ≥ 4 lượt (cổng cứng); thêm ưu tiên kỹ năng lâu chưa kiểm tra; tránh gõ cho thẻ đang học dở / từ rất khó.
4. **Bảng Hôm nay học**: thẻ đến hạn (kèm "lấy X/Y theo giới hạn ngày"), từ mới, cần củng cố, kỹ năng yếu, cần kiểm tra lại, lượt câu hỏi, tiến độ, **"N từ duy nhất"** + số giao nhau; hết thẻ vẫn hiện chế độ luyện.
5. **8 chế độ**: Theo lịch FSRS, Từ mới (bộ lọc trên danh sách FSRS thật), Nhớ chủ động, Nghe, Pinyin, Ngữ cảnh, Phân biệt từ dễ nhầm, Kiểm tra sau khoảng nghỉ; thêm 2 chế độ tự gõ tường minh trong tab Phân tích.
6. **Trí nhớ dài hạn**: 4 nhóm khoảng cách; tách FSRS / luyện bổ sung; chỉ hiện % khi ≥ 10 lượt; ghi rõ mẫu số.
7. **Chi tiết từng từ**: FSRS, từng kỹ năng, lịch sử 15 lượt, dạng hay sai, từ hay bị nhầm, khuyến nghị riêng.
8. **Khuyến nghị**: quy tắc cố định, có số liệu giải thích; không khuyến nghị khi thiếu dữ liệu; chống lặp lời khuyên.

## 2. Tệp đã thay đổi
**Mới**: `js/answer-match.js`, `js/skills-analysis.js`, `lib/skill-recommend.js`, `migrations/V110_retention_tracking.sql`, `test/answer-match.test.js`, `test/retention-recommend.test.js`, `test/v110-ui.smoke.test.js`.

| Tệp | Đã sửa | Lý do |
|---|---|---|
| `lib/skills.js` | `typed` trong EXERCISES; `gradeAnswer`; `level`; hằng số + `summarizeRetention` | Chấm tự nhập; trí nhớ dài hạn |
| `lib/skill-store.js` | Migration V110 trong `ensureSkillTables`; `recordPractice` thêm session/source/wrong; `getRetention`, `getTypeBreakdown`, `getWordDetail`, `getTodayBreakdown`, `getTodayProgress`, `getDelayedWords` | Số liệu |
| `lib/db.js` | INSERT `review_history` thêm `session_id`, `wrong_answer` (cùng câu lệnh, không thêm truy vấn) | Phiên + từ hay nhầm |
| `lib/fsrs/reviewService.js` | Trả thêm `dueInScope`, `newInScope`, `daily`, `scopeLessons`; profile thêm `level`, `daysSince` | Dashboard, bộ chọn |
| `api/index.js` | `/review`, `/review/preview`, `/skills/practice` chấm qua `gradeAnswer`; 4 route GET mới; `/study/today` gộp `breakdown`+`progress` (lỗi phần mở rộng không làm hỏng dashboard) | |
| `js/question-engine.js` | `typeVi2hz`, `typeHz2py`, `validateTyped` | |
| `js/question-selector.js` | Cổng cứng + trọng số câu tự nhập, ưu tiên kỹ năng lâu chưa kiểm tra | |
| `js/review.js` | Ô nhập, `rvSubmitTyped`, `startStudyMode`, cài đặt bật/tắt, truyền `sessionId`/`source` | |
| `js/study-queue.js` | `sessionId`, `source` đi qua outbox hiện có | |
| `js/lesson.js` | `renderTodayPanel` | |
| `js/skills-ui.js` | Tích hợp khối mới, 4 chế độ luyện mới, câu tự nhập | |
| `index.html` | 2 thẻ `<script>` | |
| `test/question-engine.test.js`, `test/adaptive-session.test.js` | Điều chỉnh cho dạng tự nhập (xem mục 5) | |
| `package.json` | Script `test:answer-match`, `test:retention`, `test:v110-ui`, `test:v110` | |

## 3. Database
- Dùng lại: `review_history`, `skill_practice_log`, `word_skill_stats`, `fsrs_cards`, `vocab_words`, `study_sessions`. **Không bảng mới.**
- Migration V110 (chỉ cộng thêm, idempotent, tự chạy ở lần dùng đầu qua `ensureSkillTables`; file `.sql` để đối chiếu/chạy tay):
  `skill_practice_log`: `session_id`, `source`, `wrong_answer`; `review_history`: `session_id`, `wrong_answer`; index `skill_practice_log_user_word_idx`.
- Dòng cũ để NULL (không backfill, không đoán). Không DROP/UPDATE/DELETE.
- Chạy tay (tuỳ chọn): `psql "$DATABASE_URL" -f migrations/V110_retention_tracking.sql`. **Không cần biến môi trường mới.**
- Hiệu năng: retention/by-type chỉ chạy khi mở tab Phân tích, cửa sổ ≤ 180 ngày; chi tiết từ có LIMIT; Hôm nay học thêm 2 truy vấn tổng hợp (chạy song song).

## 4. Thuật toán
- **Điểm kỹ năng**: giữ nguyên (ước lượng làm mượt theo trọng số giảm dần, ngưỡng yếu 0.6, ≥ 3 lượt). Thêm nhãn `level`: yếu < 0.6 ≤ đang phát triển < 0.75 ≤ tốt.
- **Chọn câu**: điểm = trọng số dạng + thưởng kỹ năng yếu/thiếu dữ liệu − phạt lặp/đang vật lộn + thưởng kỹ năng lâu chưa kiểm tra. Tự gõ: cổng cứng (≥ "đang phát triển", ≥ 4 lượt), cộng khi "tốt", trừ khi thẻ đang học dở / từ khó / đang sai liên tiếp.
- **FSRS vs bổ sung**: `EXERCISES[x].fsrs`. Chỉ `/api/study/review` đổi lịch; `/api/skills/practice` không gọi `reviewService` (có test kiểm tra). Giữ nguyên hành vi hiện tại; **không** tự đưa kết quả luyện bổ sung vào FSRS.
- **Trí nhớ dài hạn**: gap = giờ kể từ lần gặp trước của cùng từ (mọi kỹ năng). Nhóm: <1h hoặc vừa xem đáp án (check/redo) · 1h–<3 ngày · 3–<14 ngày · ≥14 ngày. Lần gặp đầu trong cửa sổ không có gap → **không xếp nhóm** (không đoán). Mẫu số = số lượt được kiểm tra; từ chưa kiểm tra lại không bị tính quên.
- **Khuyến nghị**: các quy tắc trong `lib/skill-recommend.js` (nhận diện tốt+nhớ chủ động yếu → nghĩa→chữ Hán; nghe yếu; pinyin yếu; ngữ cảnh yếu; đáp án sai lặp ≥ 2 → từ hay nhầm; kiểm tra muộn kém ≥ 20 điểm % → tăng kiểm tra lại; ổn định ở ≥ 3 kỹ năng → giảm luyện thêm). Đã luyện ≥ 6 lượt/7 ngày mà vẫn yếu → đổi lời khuyên, không lặp.

### Quy tắc chấm
Chữ Hán: đúng từng chữ sau chuẩn hoá; **không** đổi giản↔phồn. Pinyin: dấu thanh hoặc số thanh = đúng; **không dấu = KHÔNG đúng** (verdict `toneless`, giao diện nói rõ "đúng âm, thiếu thanh điệu"); sai thanh = sai. Chế độ muốn nới có thể truyền `allowToneless` (hiện chưa có chế độ nào bật). Ô trống + "Kiểm tra" = không ghi nhận (có thể bấm nhầm); "Bỏ qua" = tính sai nhưng không vào hồ sơ kỹ năng.

## 5. Kiểm thử (đã chạy thật trong sandbox)
| Lệnh | Kết quả |
|---|---|
| `npm run test:v110` | 35 + 29 + 35 = **99 pass, 0 fail** (bộ chấm, khuyến nghị/retention, giao diện) |
| `npm run test:skills` | 50 pass (cần bản gốc ở `/tmp/orig/api` cho case 16) |
| `npm run test:adaptive` | 27 + 32 + 15 pass |
| `test:xss`, `test:orphans`, `test:drill-notes`, `test:auth-security`, `test:vocab-merge`, `test:visibility-timer`, `test:distractor`, `test:optimizer:frontend` | đều pass |
| Kiểm tra đột biến | Cố ý phá 3 chỗ (luyện bổ sung đi vào FSRS; cộng trùng nhóm từ; pinyin không dấu bị coi đúng) → test đều đỏ, rồi khôi phục |

Lỗi phát hiện & sửa trong lúc làm: (1) `retentionBucketOf(null)` xếp nhầm vào "ngay sau học" (null → 0); (2) bảng Hôm nay học thoát sớm khi hết thẻ làm mất các chế độ luyện; (3) kho 1 từ khiến câu tự gõ thế chỗ trắc nghiệm → thêm cổng cứng + test khoá. Hai test cũ phải chỉnh vì giả định mọi câu đều có lựa chọn / danh sách hàm trích cố định (không nới lỏng kiểm tra cho dạng trắc nghiệm).

### CHƯA kiểm thử được (nói thẳng)
- **SQL mới chưa chạy trên PostgreSQL thật** (sandbox không có Postgres). Đã viết bằng cấu trúc đơn giản (CTE, `LAG`, `FILTER`) và dùng lại mẫu đã chạy trong dự án, nhưng **phải chạy thử trên nhánh/bản sao Neon trước khi lên production**.
- `fsrs.test.js` và các test cần `ts-fsrs`/`pg`: không chạy được (sandbox không có mạng để `npm install`) — không phải do thay đổi này, nhưng cũng chưa xác nhận lại.
- Giao diện chỉ kiểm bằng vm + DOM giả: **chưa thử trên trình duyệt/Android thật** (bàn phím, bộ gõ tiếng Trung, bố cục màn hình nhỏ).
- Không có lint/build trong dự án; chỉ chạy `node --check` cho các tệp JS đã sửa.
- Bundling Vercel: `lib/skills.js` giờ `require('../js/answer-match')` (trước đây server không require gì trong `js/`). Vercel thường lần theo `require` tĩnh nhưng chưa xác nhận.

## 6. Hướng dẫn triển khai
1. `npm ci` rồi `npm run test:v110 && npm run test:skills && npm run test:adaptive` (và `npm test` nếu có).
2. **Thử trên nhánh Neon / preview**, không dùng production: mở tab Phân tích → kiểm tra có lỗi 500 ở `/api/skills/retention`, `/recommendations`, `/word`, `/delayed-words`, `/api/study/today` (xem log Vercel).
3. Migration tự chạy khi gọi API kỹ năng đầu tiên; muốn chủ động: chạy file `migrations/V110_retention_tracking.sql`. Sau đó kiểm `count(*)` của `review_history` và `fsrs_cards` không đổi.
4. Sau khi deploy preview: làm 1 câu tự gõ ở thẻ FSRS chính thức → xác nhận hàm serverless có `js/answer-match.js` (không báo "Cannot find module"). Nếu lỗi, thêm `js/answer-match.js` vào `includeFiles` của `vercel.json`.
5. Không có biến môi trường mới.
6. Hoàn tác: các cột mới nullable, bỏ qua được; lệnh DROP nằm trong phần comment cuối file migration.

## 7. Việc còn lại / cố ý chưa làm
- **Không** đưa kết quả luyện bổ sung vào FSRS (theo yêu cầu: giữ hành vi hiện tại).
- Biểu đồ: dạng thanh theo khoảng nghỉ và bảng theo dạng bài; chưa có biểu đồ đường tiến bộ mới (đã có sẵn "Tiến bộ theo thời gian" của V104).
- "Phân biệt từ dễ nhầm" chỉ có với từ thuộc nhóm `CONFUSE_GROUPS`; chưa tự tạo cặp nhầm từ `wrong_answer` (mới chỉ dùng nó để cảnh báo "hay nhầm").
- Dữ liệu `wrong_answer`/`source`/`session_id` chỉ có từ khi triển khai; phân tích sẽ giàu dần theo thời gian. Dòng cũ không có nhãn nguồn.
- Câu tự gõ pinyin không chấp nhận không dấu; nếu người học than phiền, bật `allowToneless` cho một chế độ riêng.
- Chưa thử Hán Việt/âm thanh/ví dụ thiếu: các khối đều ẩn khi dữ liệu không có (không tự tạo).

## 8. Tổng kết
Hệ thống giờ đo được **tự nhớ lại** (gõ chữ Hán / gõ pinyin có thanh) tách khỏi **nhận ra** (trắc nghiệm), tách kết quả ngay-sau-khi-xem-đáp-án khỏi kết quả sau khoảng nghỉ, và chỉ kết luận khi đủ mẫu. Người học thấy rõ mình yếu kỹ năng nào ở từ nào, vì sao hệ thống gợi ý, mà lịch FSRS không bị bài luyện thêm làm lệch.

---

# V111 — Làm bộ chọn thích ứng thật hơn

Mở rộng V110 theo đúng thứ tự đề xuất. Không đổi FSRS, không thêm bảng/cột mới (dùng lại `wrong_answer` đã có ở V110).

## 9. Đã thay đổi
| # | Trước | Sau |
|---|---|---|
| 1 | Hồ sơ kỹ năng nạp **một lần** lúc bắt đầu phiên; trong phiên không đổi | `QS.learn()` cập nhật hồ sơ **ngay sau mỗi câu** (cả các thẻ khác của cùng từ trong hàng đợi) |
| 2 | "Từ hay nhầm" chỉ dùng để hiện khuyến nghị | Server gửi đáp án sai lặp lại (≥ 2 lần, 180 ngày) → `QE.injectConfusion` đưa đúng đáp án đó vào làm **đáp án nhiễu** (vẫn qua `validate`) |
| 3 | Thời gian trả lời chỉ dùng cho gợi ý rating FSRS | Đúng nhưng **chậm** (so với nhịp của chính người học, hoặc ngưỡng tuyệt đối) → `fragile`: được củng cố, chưa được gõ đáp án |
| 4 | Độ khó/trạng thái FSRS chỉ ảnh hưởng câu tự gõ | Từ khó/đang học dở → dạng dễ trước; từ dễ & ổn định → dạng khó hơn |
| 5 | Không xét độ dài hàng đợi | Còn > 25 thẻ chính thức → hạ câu tự gõ/điền từ |
| 6 | (Spec gốc yêu cầu, V110 chưa làm) | Mỗi câu kèm **lý do ngắn** vì sao chọn dạng này — chỉ khi dữ liệu hỗ trợ, không hiện cho câu bị ép |

### Tệp
**Mới**: `js/skill-score.js`, `test/adaptive-v111.test.js`.
**Sửa**: `lib/skills.js` (tách công thức sang `skill-score.js`; thêm `profileForClient`), `lib/skill-store.js` (`getConfusionsForWords`), `lib/fsrs/reviewService.js` (hồ sơ có số đếm + `confusions`, lấy song song), `js/question-selector.js`, `js/question-engine.js`, `js/review.js`, `js/skills-ui.js`, `index.html`, `package.json`, 3 harness test (nạp thêm `skill-score.js`), `test/v110-ui.smoke.test.js`.

### Thiết kế đáng chú ý
- **Một công thức duy nhất.** Phép tính điểm giờ nằm ở `js/skill-score.js`, server (`lib/skills.js`) và trình duyệt dùng chung → không thể lệch. Có test 100 chuỗi ngẫu nhiên chứng minh cập nhật ở client cho cùng phân loại với server.
- **Tương thích phiên đang dở.** Phiên lưu cục bộ trước V111 có hồ sơ kiểu cũ (không có số đếm có trọng số). Hàm cập nhật **khôi phục chính xác** `w_attempts` (chỉ phụ thuộc số lượt) và `w_correct` (suy từ điểm) thay vì vứt dữ liệu hay tạo trạng thái mâu thuẫn. Hồ sơ cũ chưa đủ dữ liệu thì đếm lại từ đầu.
- **Chèn đáp án nhầm có điều kiện.** Bỏ qua câu tự gõ, điền từ (nhiều từ có thể cùng vừa câu) và bài phân biệt; nếu câu sau khi chèn không qua `validate` (trùng nghĩa/đồng âm/lộ đáp án) thì giữ câu gốc.
- **Cổng cứng câu tự gõ** nay thêm điều kiện "không `fragile`".

## 10. Kiểm thử V111
- `npm run test:v110`: 35 + 29 + **43** + **46** pass (46 = test mới V111; 43 gồm 8 test tích hợp review.js thật).
- Các test cũ vẫn xanh (`test:skills` 50, `test:adaptive` 74, xss/orphans/auth/vocab/… đều pass).
- **Kiểm tra đột biến**: cố ý (a) bỏ cập nhật hồ sơ sau mỗi câu, (b) tắt chèn đáp án hay nhầm, (c) không bao giờ coi là chậm → test đều đỏ. Lần đầu (b) **không** bị bắt ở một test UI (ngưỡng `≥10/20` quá lỏng vì kho từ nhỏ khiến đáp án xuất hiện tình cờ) → đã siết thành `20/20` và chạy lại phép thử.
- Lỗi thật phát hiện nhờ test: lý do không hiện khi từ chưa có mục hồ sơ; hồ sơ kiểu cũ gây trạng thái mâu thuẫn (xem trên).

## 11. Giới hạn còn lại (nói thẳng)
1. **`getConfusionsForWords` chưa chạy trên PostgreSQL thật** (sandbox không có Postgres); test chỉ kiểm tra mã nguồn. Thử trên nhánh Neon trước khi lên production. Cột `wrong_answer` chỉ có dữ liệu **từ lúc triển khai V110** → ban đầu chưa có từ nào "hay nhầm"; tính năng sẽ tự kích hoạt dần.
2. **Nhịp trả lời chỉ là tín hiệu trong phiên**, chưa lưu thành thống kê dài hạn theo từ/kỹ năng; hết phiên là quên. Chưa có "thời gian phản hồi điển hình" của từng người qua nhiều buổi.
3. **Hồ sơ cập nhật ở client chỉ là ước lượng cho phiên hiện tại**; điểm thật vẫn do server tính khi ghi.
4. **Trọng số/ngưỡng là giá trị hợp lý do thiết kế chọn** (1.8× trung vị, 12s/30s, 25 thẻ, +0.8/−0.4…), **chưa được hiệu chỉnh bằng dữ liệu học thật** và **chưa có bằng chứng** rằng chúng giúp nhớ lâu hơn. Test chứng minh quy tắc chạy đúng thiết kế, không chứng minh hiệu quả sư phạm.
5. Đây vẫn là **thích ứng theo quy tắc**, không phải CAT/IRT: không ước lượng độ khó câu hỏi, không có mô hình năng lực xác suất.
6. "Thời lượng còn lại của phiên" mới tính theo **số thẻ chính thức còn lại**, chưa theo thời gian thực/mục tiêu phút học.
7. Giao diện vẫn chỉ kiểm bằng vm + DOM giả, chưa thử trên Android thật.

---

# V112 — Sửa thời gian học: không tính khi chuyển tab, khớp với code thích ứng

Không đổi schema, không đổi FSRS. Dùng lại cột `study_sessions.duration_seconds` nhưng đổi **ý nghĩa** của nó: từ "giờ treo tường" sang "tổng đoạn học thực".

## 12. Nguyên nhân (đã đọc code, đã tái hiện bằng test)
| # | Lỗi | Hậu quả |
|---|---|---|
| 1 | Server tính `duration_seconds = (bây giờ − start_time)` ở **cả** `recordStudyActivity` lẫn `heartbeat` | Mọi hoạt động trong vòng 15 phút sau lần trước được cộng **nguyên khoảng trống**: rời 10 phút rồi bấm 1 câu = 10 phút "học" |
| 2 | Đồng hồ hiển thị = `Date.now() − startedAt`; `pauseStudyTimer` chỉ dừng việc *vẽ* | Quay lại là đồng hồ nhảy cóc. Ý định ở comment V74 ("không đếm bù thời gian đã rời đi") chưa bao giờ thành hiện thực |
| 3 | `visibility-timer.js` chỉ trừ khi **trình duyệt bị ẩn** | Sang **tab khác trong app** (vd Thống kê) rồi quay lại: thời gian đó dính vào `responseTimeMs` → làm sai tín hiệu "đúng nhưng chậm" của bộ chọn thích ứng (V111) và gợi ý rating FSRS |
| 4 | `render()` gọi `ensureStudySession()` sau **mỗi lần vẽ lại**, hàm đó tạo lại `setInterval` | Lỗi có sẵn: nếu vẽ lại mỗi vài giây thì heartbeat 20s có thể không bao giờ kịp chạy |
| 5 | Buổi luyện bổ sung (V110, ở tab Phân tích) không nằm trong `STUDY_TABS` | Thời gian luyện bổ sung không được tính là học |
| 6 | Phiên trong bộ nhớ không hết hạn sau 15 phút | Mở trang qua đêm vẫn cộng vào phiên cũ |

## 13. Định nghĩa thống nhất "thời gian học thực"
Chỉ cộng khi **đồng thời**: (1) trình duyệt đang hiển thị, (2) đang ở màn học (5 tab học + buổi luyện bổ sung đang làm bài), (3) có tương tác trong 90 giây gần nhất. Mỗi nhịp 1s cộng tối đa 2s (máy ngủ/tab đóng băng không cộng bù).

- **Client** (`js/timer.js`): `activeMs` thay cho giờ treo tường; heartbeat báo `activeSeconds` (phần chưa gửi, không báo trùng, không gửi chồng); quay lại sau khi vắng thì gửi heartbeat đồng bộ với ≈ 0 giây để server dời mốc mà không cộng khoảng vắng.
- **Server** (`lib/fsrs/study-time.js`, `analytics.js`): cộng dồn `credit = min(khoảng thực, trần 60s, activeSeconds client báo)`. Client không thể cộng lố; client cũ không báo gì vẫn bị trần chặn; retry trùng gần như không cộng thêm. Heartbeat chạy trong giao dịch có `FOR UPDATE`, `end_time` chỉ tiến.
- **Thời gian trả lời từng câu** (`js/visibility-timer.js`): "vắng mặt" gồm cả đổi tab trong app (mỗi câu hỏi có tab sở hữu). Nếu tab đổi trong 500ms đầu (vd bấm chế độ luyện ở Hôm nay rồi chuyển sang Phân tích) thì nhận tab mới, không bị coi là vắng.
- **Bảng Hôm nay học** nay hiện "Thời gian học thực" (V110 đã định nghĩa hàm hiển thị nhưng quên gọi).

### Tệp
**Mới**: `lib/fsrs/study-time.js`, `test/study-time.test.js`.
**Sửa**: `js/timer.js`, `js/visibility-timer.js`, `js/navigation.js`, `js/study-queue.js`, `js/lesson.js`, `lib/fsrs/analytics.js`, `api/index.js` (heartbeat nhận `activeSeconds` tuỳ chọn), `package.json`, `test/v110-ui.smoke.test.js`.

## 14. Kiểm thử V112
- `node test/study-time.test.js`: **39 pass** (quy tắc cộng; `analytics.js` nạp thật với pool giả; `timer.js` + `visibility-timer.js` nạp thật với đồng hồ giả). Toàn bộ test cũ vẫn xanh.
- Các tình huống đã mô phỏng: ẩn trình duyệt 10 phút; sang tab Thống kê 5 phút; bỏ không thao tác 200s; máy ngủ 1 giờ; mất mạng khi heartbeat; heartbeat chồng nhau; vắng > 15 phút; đổi tab trong app chồng với ẩn trình duyệt.
- **Kiểm tra đột biến** (cố ý phá 4 chỗ: luôn coi là đang học; bỏ trần server; bỏ nhận biết tab trong app; trả lại công thức giờ treo tường) → test đều đỏ, rồi khôi phục.
- 5 test đỏ lần chạy đầu: 4 cái do test không chờ hết chuỗi bất đồng bộ của `fetch`, 1 cái phát hiện ràng buộc thật (mốc bắt đầu vắng là lúc `vtSync()` chạy — mọi lần đổi tab đã đi qua `render()`; đã thêm test khoá ràng buộc đó).

## 15. Giới hạn còn lại (nói thẳng)
1. **Dữ liệu cũ không được sửa.** Các dòng `study_sessions` đã lưu theo giờ treo tường vẫn bị thổi phồng (không backfill vì không thể phân biệt đoạn vắng mặt trong quá khứ). Các màn thống kê tổng hợp nhiều ngày sẽ trộn số cũ (cao) với số mới (thật) → trung bình/tổng thời gian có thể **giảm đột ngột** sau khi triển khai. Đó là số được sửa đúng, không phải lỗi.
2. **Client cũ còn bị cache** (chưa tải lại trang) vẫn gửi heartbeat không có `activeSeconds`, kể cả lúc đang ẩn: server chỉ chặn bằng trần 60s/lần nên các client đó vẫn cộng lố một phần cho tới khi tải lại trang. Nên yêu cầu tải lại sau khi deploy.
3. **Hai ngưỡng là lựa chọn của thiết kế, chưa hiệu chỉnh bằng dữ liệu thật:** 90s không tương tác, trần 60s/khoảng. Người học đọc ví dụ rất lâu mà không chạm màn hình sẽ bị tính thiếu sau 90s.
4. **Chưa chạy SQL mới trên PostgreSQL thật** (truy vấn `SELECT … FOR UPDATE` + `GREATEST(end_time, $1)`); chỉ kiểm tra bằng pool giả ghi lại câu lệnh và tham số.
5. **Chưa thử trên trình duyệt thật**: độ tin cậy của `document.hidden`/`visibilitychange` trên iOS Safari/WebView, và `fetch keepalive` lúc đóng trang chưa kiểm chứng. Nếu sự kiện ẩn không bắn, thời gian vẫn dừng nhờ ngưỡng 90s không tương tác (nhưng có thể lố tối đa 90s mỗi lần).
6. Phân tích tổng hợp nhiều ngày (Thống kê) chưa được rà lại để hiện chú thích "từ ngày X đo theo giờ học thực".
