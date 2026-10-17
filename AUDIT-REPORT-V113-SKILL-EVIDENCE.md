# AUDIT V113 — Bằng chứng kỹ năng, loại lượt "vừa xem đáp án", phân tích khoảng nghỉ

Nền: V112. Không viết lại kiến trúc, không đổi FSRS (`lib/fsrs*`, `lib/fsrs/*` không bị sửa), không xoá/đổi dữ liệu cũ.

## 1. Lỗi/điểm yếu thật tìm thấy ở V112
1. **Lượt `check` (kiểm tra ngay sau khi xem từ mới) và `redo` (luyện lại câu sai) được cộng vào `word_skill_stats` y như một lượt kiểm tra thật** (server `recordPractice` và client `QS.learn`). Đáp án vừa được xem → làm điểm kỹ năng cao giả; `redo` còn đếm đôi với chính lần sai.
2. **Lượt FSRS đầu tiên của từ mới** (chỉ cách màn giới thiệu ~3 thẻ) cũng được cộng đầy đủ vào điểm kỹ năng dù người học vừa xem đáp án.
3. **3 lượt đúng đã được gọi là "tốt"** (Laplace + decay: 3/3 → 0.78 ≥ 0.75). Mâu thuẫn với yêu cầu "điểm cao dựa trên 3 lượt ≠ điểm cao dựa trên nhiều lượt qua nhiều ngày".
4. Chưa có dữ liệu về **số ngày** và **lượt sau khoảng nghỉ** của từng (từ, kỹ năng) → không thể có nhãn "tương đối ổn định" / "đã kiểm tra lại sau khoảng nghỉ" có quy tắc.
5. Nhóm khoảng nghỉ chỉ có 4 nhóm lệch so với yêu cầu (10 phút / 24 giờ / 3 ngày / 7 ngày).
6. Bảng trend & "kết quả theo dạng bài" trộn cả lượt vừa xem đáp án với lượt đo năng lực.
7. Khuyến nghị thiếu "điều kiện giảm/dừng"; kỹ năng thiếu dữ liệu không có khuyến nghị chẩn đoán; không có mục tiêu chính của phiên.

## 2. Thay đổi đã làm
| Tệp | Thay đổi |
|---|---|
| `js/skill-score.js` | `GOOD_MIN_ATTEMPTS=5` (good cần ≥5 lượt); `evidenceOf()` → none/few/developing/stable/retested bằng quy tắc cố định; hồ sơ gửi client mang `stage, ad, dn, dc`; `advanceProfileEntry` cập nhật bằng chứng tại chỗ. Công thức điểm Laplace + decay 0.85 **giữ nguyên**; ngưỡng yếu 0.6 / MIN 3 lượt giữ nguyên (3 lượt sai → 0.22, đủ rõ). |
| `lib/skills.js` | 5 nhóm khoảng nghỉ (`immediate<10p`, `short<24h`, `d1<3d`, `d3<7d`, `d7≥7d`), `LATE_BUCKET_IDS`, `EXPOSURES/cleanExposure`, re-export. |
| `lib/skill-store.js` | Cột mới (an toàn) + UPSERT tính `active_days/delayed_*` ngay trong SQL; `recordPractice` vẫn **lưu log** check/redo nhưng **không cộng điểm**; trend/theo-dạng-bài loại lượt vừa xem đáp án; retention xếp lượt `intro` vào "ngay sau học"; `getTodayBreakdown` thêm `stableWords`; `getTodayProgress` thêm tỉ lệ đúng có mẫu số. |
| `lib/db.js` | `review_history.exposure`; lượt `intro` vẫn ghi review_history + FSRS bình thường nhưng không upsert kỹ năng (không chạm `fsrs_cards` thêm). |
| `api/index.js` | `/api/study/review` nhận `exposure` (chỉ chấp nhận `'intro'`); chi tiết từ trả `stage/activeDays/delayed*`. |
| `js/review.js`, `js/study-queue.js` | Gửi `exposure:'intro'` cho lượt official sau màn giới thiệu; `check/redo/intro` không gọi `QS.learn`. |
| `lib/skill-recommend.js` | `stopWhen` cho mọi khuyến nghị có hành động; gợi ý **chẩn đoán** (tối đa 1) cho kỹ năng <5 từ đủ dữ liệu; `primaryGoal`; dùng `LATE_BUCKET_IDS`. |
| `js/lesson.js` | "Tiến độ nhiệm vụ" ghi rõ không phải % đã nhớ; **Mục tiêu chính** (đến hạn → củng cố → từ mới → kỹ năng yếu → kiểm tra sau nghỉ; không bỏ thẻ đến hạn); ô "Tỉ lệ trả lời đúng" (có mẫu số, <5 lượt thì "—") và "Từ đủ bằng chứng tương đối ổn định" (≥2 kỹ năng, ≥6 lượt, ≥3 ngày). |
| `js/skills-analysis.js` | 5 nhóm; hiện "Dừng khi"; nhãn bằng chứng ở chi tiết từ; ghi giới hạn khi so sánh nhóm. |
| `migrations/V113_skill_evidence.sql`, `scripts/migrate-skill-evidence.js` | Cột mới + backfill tuỳ chọn idempotent từ lịch sử thật (có DRY_RUN, 1 transaction). |
| `test/v113-evidence.test.js` (+ sửa `retention-recommend`, `v110-ui.smoke`) | 28 test mới; hai file cũ chỉ đổi tên nhóm (`day/week/month` → `d1/d3/d7`) và 1 kỳ vọng (diagnose thay vì "stable" khi kỹ năng chưa có dữ liệu — đúng chủ đích mới). `package.json`: thêm `test:v113`, `migrate:skill-evidence`. |

## 3. Quy tắc nhãn bằng chứng (không phải xác suất)
`none` 0 lượt · `few` 1–2 · `developing` ≥3 chưa đạt tiêu chí khác · `stable` ≥6 lượt **và** ≥3 ngày **và** điểm ≥0.75 · `retested` ≥2 lượt cách lượt hợp lệ trước ≥24h (cùng từ + kỹ năng). Hàng cũ chưa biết số ngày **không bao giờ** là `stable`.

## 4. Migration
Không bắt buộc: app tự `ADD COLUMN IF NOT EXISTS` ở lần dùng đầu (mặc định 0 = "chưa biết"). Muốn nhãn `stable/retested` cho dữ liệu cũ: `DATABASE_URL=... DRY_RUN=1 npm run migrate:skill-evidence` rồi chạy thật không có `DRY_RUN`. Backfill **không đổi** `attempts/correct/w_*`.

## 5. Kiểm thử THỰC TẾ (sandbox, Node 22, không có Postgres, không có mạng)
- Chạy và PASS: `v113-evidence` 28/28, `retention-recommend` 33/33, `v110-ui.smoke` 44/44, `skills` 50/50 (khi có bản gốc ở `/tmp/orig` như test yêu cầu), `question-engine` 27, `adaptive-session` 32, `adaptive-v111` 46, `review-render.smoke` 15, `answer-match` 35, `study-time` 39, `orphans` 9, `drill-notes` 10, `xss-escaping` 21, `auth-security`, `heavy-distractor`, `visibility-timer`, `vocab-merge`; `node --check` mọi file JS.
- **KHÔNG chạy được**: `fsrs`, `fsrs-optimizer`, `fsrs-optimizer.binding` (thiếu `ts-fsrs` — kết quả y hệt bản gốc); mọi test `*.integration` (cần `DATABASE_URL`). **Các câu SQL mới chưa được thực thi trên Postgres thật** (UPSERT bằng chứng, trend/byType/today, retention, backfill) — mới kiểm tra bằng đọc mã + bản JS tương đương. Cần chạy thử trên DB staging trước khi deploy.
- Không chạy trình duyệt thật: giao diện mới chỉ qua smoke test dựng HTML.

## 6. Giới hạn còn lại
- Điểm cũ trong `word_skill_stats` **vẫn chứa** các lượt check/redo ghi trước V113 (không có cách phân tách chắc chắn cho mọi hàng; không tính lại để khỏi sửa dữ liệu). Ảnh hưởng giảm dần theo decay 0.85 khi có lượt mới.
- Chưa phát hiện "đoán mò/loại trừ đáp án" (không có dữ liệu đủ tin cậy: thời gian phản hồi chỉ là tín hiệu phụ) và chưa có cơ chế "xem gợi ý trước khi trả lời" riêng (UI hiện chỉ có gợi ý pinyin ở dạng `py2hz`, vẫn tính là recall).
- Gap "sau khoảng nghỉ" tính theo **cùng từ + cùng kỹ năng**, không tính lần gặp từ bằng kỹ năng khác; nhóm khoảng ở màn Phân tích lại tính theo lần gặp từ bất kể kỹ năng — hai khái niệm khác nhau, đã ghi trên giao diện.
- Bộ chọn: trọng số `WEIGHTS` giữ nguyên (đã có test phân phối mô phỏng mới: không dạng nào >50% khi chưa có dữ liệu; recall yếu được ưu tiên nhưng ≤70%). Trường hợp cực đoan: 1 từ bị hỏi >5 lần trong 1 buổi và sai liền → có thể quay lại hz2vi nhiều lần; vòng lặp vô hạn chỉ bị chặn ở tầng hàng đợi (`RV_DRILL_MAX_TRIES=2`, `RV_EXTRA_MAX=6`).
- Chưa có mô hình quên được kiểm chứng: không có tuyên bố "tốc độ quên".
