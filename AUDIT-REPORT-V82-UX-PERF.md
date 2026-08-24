# Audit V82 — UX/UI & Performance/Responsiveness (Study Flow)

## 0. Phạm vi

Audit theo đúng brief: **chỉ** tối ưu UX/UI và performance/responsiveness của app hiện có — không
đổi framework/stack, không đổi kiến trúc DB, không đổi thuật toán FSRS hay cách tính lịch ôn, không
thêm chức năng lớn, không đổi dữ liệu người dùng, không phá API. Kế thừa trực tiếp
`AUDIT-REPORT-V69.md` (chuẩn hoá FSRS) và `AUDIT-REPORT-V79.md` (cache/đồng bộ Neon) — đã đọc kỹ cả
2 trước khi audit, không lặp lại hay đảo ngược bất kỳ fix nào ở đó. Đặc biệt: mọi cơ chế "đợi server
xác nhận trước khi chuyển thẻ" (`submitFsrsReviewAwaited`, trần chờ `SUBMIT_REVIEW_MAX_WAIT_MS`,
outbox chống mất review) được **giữ nguyên tuyệt đối** — các thay đổi bên dưới chỉ tối ưu phần *cảm
giác chờ* (feedback thị giác, thời điểm cho phép thao tác), không bao giờ bỏ qua việc chờ ghi dữ
liệu thật.

Trọng tâm: **Study Mode** (Flashcard/Quiz/Type/Listen/Review) — luồng dùng nhiều nhất — đúng theo
yêu cầu Phần 2. Đã đọc toàn bộ `js/*.js`, `css/styles.css`, `index.html` trước khi sửa.

---

## 1. "Highlight System Rating" (Review) — nút chấm điểm bị khoá chờ mạng không cần thiết

**Vị trí:** `js/review.js` — `rvRenderRatingBar()`, `rvChooseRating()`, `rvCommitRating()`, `rvPick()`.

**Vấn đề:** Sau khi trả lời, app gọi `/api/study/review/preview` để lấy gợi ý rating từ hệ thống
(tính năng "Highlight System Rating"). Trong lúc chờ round-trip này (`rvRatingPhase === 'loading'`),
**cả 4 nút Again/Hard/Good/Easy bị khoá cứng** (`disabled`) — đúng kịch bản "tap → loading → chờ →
mới bấm được" mà brief (Phần 2, Phần 12/13) muốn loại bỏ. Trên mạng chậm, user ngồi nhìn 4 nút xám
vài trăm ms đến vài giây dù họ đã biết muốn chấm gì.

**Đã sửa:** Cho phép bấm 4 nút **ngay từ lúc `loading`**, không cần đợi gợi ý hệ thống về:
- `clickable` trong `rvRenderRatingBar()` giờ đúng khi `phase ∈ {loading, pending}` thay vì chỉ
  `pending`.
- `rvChooseRating()` / `rvCommitRating()` chấp nhận commit từ cả 2 phase.
- Quy tắc **"User Rating luôn thắng System Rating" không đổi** — `rvCommitRating` dùng thẳng
  `chosenRating`, không phụ thuộc `rvSystemRating` đã có hay chưa.
- **Race condition mới cần chặn:** nếu user tự bấm rating trong lúc đang `loading`, rồi gợi ý hệ
  thống mới về **sau đó** — code cũ sẽ ghi đè `rvRatingPhase` về lại `pending` (làm "sống lại" màn
  chờ countdown cho 1 lượt đã commit xong). Đã thêm điều kiện `rvRatingPhase !== 'loading' → return`
  ngay sau `await rvFetchSystemRating(...)` trong `rvPick()` để chặn đúng trường hợp này.
- Cập nhật hint text ở trạng thái `loading` từ "⏳ Đang tính gợi ý hệ thống..." (ngụ ý "chưa làm gì
  được") thành mời bấm luôn kèm ghi chú nhỏ là gợi ý đang tải.

**Không đổi:** tốc độ tính gợi ý hệ thống, cách tính rating, countdown 2s khi đã có gợi ý, animation
glow/ngôi sao đề xuất (vẫn chỉ hiện khi đã có `rvSystemRating`, đúng thiết kế gốc).

## 2. Giảm khoảng nghỉ cố định trước khi sang thẻ kế (Review)

**Vị trí:** `js/review.js` — `rvCommitRating()`.

**Vấn đề:** Sau khi chấm điểm, code luôn chờ `Promise.all([reviewPromise, setTimeout(1000)])` — tức
**tối thiểu 1 giây** trước khi sang thẻ kế, bất kể mạng nhanh hay chậm, bất kể user đã tự bấm hay để
tự động. Cộng dồn với bước 1 (loading gợi ý) + tối đa 2s countdown, tổng thời gian/thẻ khá dài,
ngược với mục tiêu "chuyển card nhanh" (Phần 2) và "không animation thừa" (Phần 11).

**Đã sửa:** Giảm còn **450ms** — đủ để mắt kịp thấy dòng "Đã lưu lịch ôn" trước khi chuyển, không
còn cảm giác trễ vô cớ. **Không ảnh hưởng an toàn dữ liệu**: đây chỉ là hằng số hiển thị tối thiểu
song song (`Promise.all`) với `reviewPromise` — việc chờ ghi dữ liệu thật vẫn luôn đủ, có trần chờ
riêng ở `study-queue.js` (`SUBMIT_REVIEW_MAX_WAIT_MS`, không đổi).

## 3. Flashcard/Gõ chữ — bấm xong không có phản hồi gì trong lúc chờ lưu

**Vị trí:** `js/flashcard.js` (`fcAnswer`), `js/type.js` (`tyCheck`, `tySkip`).

**Vấn đề:** Không như Quiz/Review (đã có khoảng nghỉ hiển thị đáp án che thời gian chờ mạng, xem
`AUDIT-REPORT-V79.md`), `fcAnswer()` gọi thẳng `await submitFsrsReviewAwaited(...)` **không có bất kỳ
tín hiệu thị giác nào** trong lúc chờ — mạng nhanh thì vô hại, mạng chậm (trần chờ tới 6s) thì 2 nút
"❌ Chưa nhớ / ✅ Đã nhớ" trông y hệt lúc chưa bấm, gây cảm giác app đứng hình, dễ bấm lại/bấm nhầm.
`tySkip()` gặp đúng vấn đề tương tự; `tyCheck()` chỉ khoá ô nhập, không khoá 2 nút "Kiểm tra"/"Bỏ
qua" (trông vẫn bấm được dù logic đã có `tySubmitting` chặn ngầm).

**Đã sửa:** Ở cả 3 hàm, khoá (`disabled=true`) + làm mờ (`opacity:.5` qua class `.is-busy`) nhóm nút
liên quan **ngay lập tức, đồng bộ, trước khi `await`** — user thấy thao tác được ghi nhận tức thì
("tap → phản hồi ngay"), không cần chờ network mới có phản hồi. Không thêm delay nhân tạo nào (khác
Quiz — nơi 1400ms nghỉ là để xem đáp án, không phải để che loading).

## 4. Trang chủ — phải qua tab khác mới bắt đầu học được

**Vị trí:** `js/lesson.js` — `renderHome()`, `bindHome()` (mới), `loadStudyDashboard()`.

**Vấn đề:** Trang chủ chỉ có 4 nút **chọn chế độ** (Flashcard/Quiz/Nghe/Gõ) — không cho biết hôm nay
có bao nhiêu từ cần ôn/học mới, và không có đường tắt vào đúng hàng đợi FSRS ưu tiên (`review` mode).
Muốn biết + bắt đầu đúng việc cần làm, user phải sang tab "🎯 Hôm nay học" trước — ngược với Phần 1/7
("Home → 'Bắt đầu học', một thao tác").

**Đã sửa:** Thêm khối "at a glance" ở đầu Trang chủ (chỉ hiện khi đã đăng nhập và đã chọn phạm vi
học): số từ 🔴 cần ôn / 🆕 mới hôm nay + đúng 1 nút **"▶️ Bắt đầu học"** đi thẳng vào `review` mode —
y hệt hành vi nút cùng tên ở tab "Hôm nay học". 4 nút chọn chế độ cũ giữ nguyên bên dưới làm lối vào
phụ khi user chủ động muốn luyện riêng 1 kiểu.

**Đi kèm (Phần 12/14 — chống trùng request, tái sử dụng dữ liệu):** tách phần gọi `/api/study/today`
thành hàm dùng chung `fetchTodayDashboard(force)` với cache TTL 10 giây, dùng chung giữa Trang chủ và
tab "Hôm nay học" — bấm qua lại 2 tab này liên tục không gọi API 2 lần. `refreshServerMeta()`
(`js/auth.js`, chạy sau mỗi lượt trả lời) được sửa để **xoá cache này ngay** khi có review mới, tránh
số liệu "đứng hình" vài giây sau khi vừa học xong.

## 5. Keyboard shortcuts (desktop) — Phần 5, trước đó chưa có

**Vị trí:** cuối `js/ui.js`.

Thêm listener `keydown` toàn cục, **chỉ gọi lại đúng hàm mà nút bấm chuột tương ứng đã gọi** (không
có đường đi dữ liệu riêng) nên không phát sinh rủi ro mới về mất review/lệch FSRS:

| Phím | Tác dụng | Tab |
|---|---|---|
| `Space` | Lật thẻ | Flashcard |
| `1` / `2` | Chưa nhớ / Đã nhớ (sau khi đã lật) | Flashcard |
| `1`–`4` | Chọn đáp án trắc nghiệm theo đúng **vị trí đang hiển thị** | Quiz, Listen, Review (câu hỏi) |
| `1`–`4` | Again / Hard / Good / Easy | Review (đang chấm điểm) |
| `A` | Phát âm lại | Flashcard, Listen, Review |

An toàn: bỏ qua hoàn toàn khi target đang gõ chữ (`input`/`textarea`/`select`/`contenteditable` —
không phá tab "Gõ chữ" hay bất kỳ ô nhập nào), khi có phím `Ctrl/Alt/Cmd` (nhường phím tắt trình
duyệt/OS), và khi có modal toàn màn hình đang mở (đăng nhập/đổi mật khẩu/menu tài khoản/xác nhận nguy
hiểm). Hiển thị hint nhỏ, unobtrusive (`.kbd-hint`, chỉ hiện ở thiết bị có bàn phím/con trỏ thật qua
`@media (hover:hover) and (pointer:fine)`, ẩn hẳn trên cảm ứng).

## 6. Mobile — touch target & safe-area

**Vị trí:** `css/styles.css`, `index.html`.

- 2 nút Flashcard (`.fc-controls .fc-btn`, hành động chính của app): min-height 40px → **48px**, và
  `flex:1` để chia đều chiều rộng thay vì co theo chữ (dễ bấm 1 tay hơn, giảm bấm nhầm khi thao tác
  nhanh liên tục). Chỉ áp dụng trong `.fc-controls` — không đụng `.fc-btn` dùng lại ở tab "Dịch câu"
  (layout 3 nút khác, không nên ép `flex:1` ở đó).
- 4 nút rating (`.rv-rate-btn`) trên màn ≤480px: 42px → **46px**, sát chuẩn khuyến nghị 44–48px hơn.
- Thêm `viewport-fit=cover` (`index.html`) + `env(safe-area-inset-top/bottom/right)` cho `#topbar`,
  `#content` và widget Zalo — tránh bị notch/tai thỏ/home-indicator che trên iPhone có màn cong.

## 7. Widget Zalo nổi — có thể che nút cuối hàng

**Vị trí:** `js/app.js` — `initZaloWidget()`.

**Vấn đề:** Widget dạng pill dài (icon + chữ "Hỗ trợ") cố định góc dưới-phải, trên màn hình nhỏ có
thể lấn vào vùng nút cuối cùng của hàng flashcard/rating — vi phạm đúng điều Phần 6 dặn tránh
("không bottom controls bị che").

**Đã sửa:** Thu gọn thành nút tròn nhỏ chỉ icon (giữ `title` tooltip, không mất thông tin), tự né
safe-area. Diện tích có thể che giảm đáng kể, hành vi ẩn vĩnh viễn qua nút ✕ giữ nguyên.

---

## 8. Những gì KHÔNG đổi (theo đúng ràng buộc của brief)

FSRS/`lib/fsrs/*`, cách tính lịch ôn, `reviewService`, schema DB, outbox chống mất review,
`SUBMIT_REVIEW_MAX_WAIT_MS`, quy tắc "User Rating thắng System Rating", API routes, dữ liệu người
dùng — **không chạm**. Cache TTL của V79 (`app_store`, `vocabCounts`, `userSettings`) — không đổi.

## 9. Đề xuất tiếp theo (chưa làm trong đợt này, để tránh vượt phạm vi 1 audit)

- Prefetch audio của thẻ kế tiếp trong hàng đợi Flashcard/Listen khi còn dư băng thông (Phần 13) —
  cần đo thực tế xem `speak()` (Web Speech API hay audio file?) có đáng prefetch không trước khi làm.
- Skeleton loading thay vì text "⏳ Đang tải..." cho các màn hình initial load nặng (đã tốt ở mức
  chấp nhận được — không blank trắng toàn màn — nhưng có thể mượt hơn nữa).
- Xem lại `.trans-*` (tab Dịch câu) theo cùng tinh thần Phần 3/6 — nằm ngoài "study mode" chính nên
  chưa đưa vào đợt audit tập trung vào Flashcard/Quiz/Type/Listen/Review lần này.
