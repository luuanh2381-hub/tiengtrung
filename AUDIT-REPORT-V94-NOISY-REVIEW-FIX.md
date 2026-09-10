# Fix V94 — Loại review nhiễu khi thoát app/tab giữa chừng rồi vào lại

## Vấn đề
`performance.now()` (dùng để đo `responseTimeMs` ở cả 5 màn hình luyện tập) **vẫn chạy đều khi tab
bị ẩn**. Nếu user chuyển sang app khác / khoá màn hình rồi quay lại ĐÚNG tab đó (không đóng hẳn/tải
lại trang) mới chọn đáp án, khoảng thời gian vắng mặt bị tính luôn vào `responseTimeMs`.

Hậu quả không chỉ là số liệu sai: theo `lib/fsrs-auto-rating.js`, hễ `responseTimeMs` vượt ~20s (hoặc
gấp ~1.8 lần tốc độ thường ngày của chính từ đó) thì hệ thống tự chấm **"Hard"** — dù trả lời đúng
và thực ra nhớ rất rõ. Card bị coi là khó hơn thực tế, lịch ôn bị rút ngắn sai, và các lượt nhiễu này
còn lẫn vào dữ liệu huấn luyện cá nhân hoá (Optimizer).

## Sửa — 2 lớp, độc lập, bổ trợ nhau

**Lớp 1 (frontend) — `js/visibility-timer.js` (mới):** dùng Page Visibility API, cộng dồn tổng thời
gian tab bị ẩn kể từ lúc câu hỏi hiện ra, trừ đúng khoảng đó ra khỏi `responseTimeMs` trước khi gửi
lên server. Áp dụng cho cả 5 màn hình (`review.js`, `flashcard.js`, `quiz.js`, `listen.js`,
`type.js`) — dùng chung 1 module thay vì lặp code 5 lần. Xử lý đúng gốc phần lớn case thật (chuyển
app/khoá máy), kể cả ẩn/hiện nhiều lần trong cùng 1 câu hỏi.

**Lớp 2 (backend) — `lib/fsrs-auto-rating.js`:** thêm `MAX_TRUSTED_RESPONSE_MS = 90000` (90s) —
lưới an toàn cho các kiểu gián đoạn Lớp 1 không bắt hết được (browser/OS lạ không bắn đúng sự kiện,
hoặc user để màn hình mở nhưng không tương tác rất lâu). `responseTimeMs` vượt ngưỡng này bị coi là
tín hiệu không đáng tin — rơi về nhánh "chưa đủ dữ liệu" sẵn có, mặc định an toàn = Good khi trả lời
đúng. Áp dụng cùng ngưỡng khi tính **baseline cá nhân** (`personalBaselineMs`) để 1 lượt nhiễu cũ
không kéo lệch việc suy luận cho các lượt sau.

**Không đổi gì khác:** review vẫn được lưu đầy đủ, đúng/sai vẫn tính bình thường, FSRS due/stability
vẫn cập nhật, `review_history.response_time_ms` vẫn lưu đúng giá trị đo được (không bị sửa/cap) —
chỉ riêng bước *suy luận Hard/Easy từ tốc độ* bỏ qua tín hiệu bị nhiễu.

## Test
- `test/visibility-timer.test.js` (mới) — 7 case, **chạy thật trong Node** (dùng module `vm` giả lập
  `document`/`performance`, không cần trình duyệt): ẩn 1 lần, ẩn nhiều lần cộng dồn, reset đúng lúc
  câu hỏi mới, các edge case thứ tự sự kiện. **7/7 PASS**.
- `test/fsrs.test.js` — thêm 4 case cho `MAX_TRUSTED_RESPONSE_MS` (rt cực lớn không bị chấm Hard
  oan cả khi có/không có baseline; rt vừa phải vẫn hoạt động bình thường, không bị chặn nhầm;
  baseline loại đúng entry nhiễu). File này cần `ts-fsrs` nên **không chạy được trong sandbox**
  (giống các file test FSRS khác từ trước) — đã tự verify riêng logic tương đương bằng mock `ts-fsrs`
  tối giản trong quá trình audit, 7/7 pass, nhưng đây không thay thế cho việc bạn tự chạy
  `npm run test` sau khi `npm install`.

## Bạn cần làm gì
Deploy lại bản mới, thử vào 1 câu hỏi rồi chuyển hẳn sang app khác vài phút, quay lại chọn đáp án
đúng — hệ thống phải chấm Good/Easy như bình thường, không tự nhảy xuống Hard.
