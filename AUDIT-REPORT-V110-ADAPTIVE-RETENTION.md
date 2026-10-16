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
