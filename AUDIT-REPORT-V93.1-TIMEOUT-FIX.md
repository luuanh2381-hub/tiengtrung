# Fix V93.1 — "Failed to fetch" khi Import Excel

## Triệu chứng
Upload file Excel 137 dòng (4 bài: 20, 21, 23, 24) qua màn Admin → báo lỗi
`❌ Không đọc được file: Failed to fetch` — không rõ dữ liệu có được lưu 1 phần hay không.

## Nguyên nhân
Bản V93 (audit trước) viết `bulkUpsertVocab` xử lý **tuần tự từng dòng** — mỗi dòng cần 1 `SELECT`
(tra hz đã tồn tại chưa) + 1 `INSERT`/`UPDATE` + 1 `INSERT` vào `vocab_lessons`, đều là round-trip
riêng tới Postgres. Với 137 dòng ⇒ **~400 round-trip nối tiếp nhau trong 1 request HTTP**. Tuỳ độ
trễ tới DB (Neon/Vercel Postgres có thể có cold start), tổng thời gian dễ vượt ngưỡng chờ response
(của trình duyệt mobile, hoặc lớp proxy/edge của Vercel — độc lập với `maxDuration: 300` trong
`vercel.json`, con số đó chỉ giới hạn runtime của function, không đảm bảo trình duyệt/proxy sẽ chờ
đủ lâu). Request bị ngắt giữa chừng → fetch() phía client nhận lỗi network thô
(`TypeError: Failed to fetch`) vì không có response nào hoàn thành — **khác lỗi HTTP 4xx/5xx** (lỗi
đó vẫn có response, sẽ hiện thông báo lỗi cụ thể, không phải "Failed to fetch").

Đã xác nhận: dữ liệu file (137 dòng, cột `hz/py/vi/l/tag` đầy đủ, không thiếu, không trùng
`(hz,l)`) hoàn toàn hợp lệ — không phải lỗi do format file.

**Vì transaction bao quanh, dữ liệu KHÔNG bị lưu 1 phần dở dang** — khi request bị ngắt, kết nối DB
đóng đột ngột khiến Postgres tự rollback transaction đang mở. An toàn, nhưng người dùng không biết
điều đó và không có gì được thêm vào.

## Sửa
Viết lại `bulkUpsertVocab` (`lib/db.js`) để mỗi **lô** (chunk 500 dòng, giữ nguyên cỡ lô như bản
gốc trước V93) chỉ cần **~5 round-trip DB cố định** — không phụ thuộc số dòng trong lô — thay vì 1
round-trip/dòng:

1. `SELECT` 1 lần toàn bộ `vocab_words` khớp các `hz` xuất hiện trong lô.
2. Tính "kế hoạch" (từ nào mới, từ nào cần update, lesson nào cần thêm) **thuần trong bộ nhớ**
   (`lib/vocab-merge.js:planBulkUpsert` — hàm mới, có unit test riêng).
3. `INSERT` hàng loạt (1 câu, nhiều dòng) cho từ mới.
4. `UPDATE ... FROM (VALUES ...)` hàng loạt cho từ cần đổi metadata.
5. `SELECT` + `INSERT` hàng loạt cho quan hệ `vocab_lessons`.

Với đúng file 137 dòng của bạn: đo thử `planBulkUpsert` (phần tính toán thuần) chỉ mất **0.6ms**;
tổng round-trip DB giảm từ ~411 xuống ~4 cho toàn bộ file — không còn nguy cơ vượt ngưỡng timeout.

**Kết quả nghiệp vụ giữ nguyên 100%** — merge field theo overwrite, không tạo trùng, luôn thêm
lesson relationship — chỉ đổi cách thực thi. Verify lại bằng chính dữ liệu file bạn upload: 137/137
dòng → 137 từ mới (đúng, vì đây là 4 bài lần đầu import), giữ đúng 9 từ có tag `ly_hop`
(毕业/起床/睡觉/下课/爬山/打电话/打的/报名/请假).

## Test
`test/vocab-merge.test.js` — thêm 6 case cho `planBulkUpsert` (gộp nhiều dòng cùng `hz` trong 1
batch, chỉ update khi thực sự đổi, mảng rỗng...). **30/30 PASS** (24 test cũ từ bản V93 + 6 test
mới, chạy thật, không cần DB — đã verify lại bằng cách giải nén độc lập chính file ZIP giao cho
bạn). `test/vocab-identity.integration.test.js` không cần sửa — nó test qua hành vi bên ngoài
của `importVocab()`, không phụ thuộc cách cài đặt bên trong.

## Bạn cần làm gì
Thay code bằng bản ZIP mới, deploy lại, thử upload lại đúng file `tu-vung-bai-20-21-23-24.xlsx`.
Nếu vẫn lỗi "Failed to fetch" (khả năng thấp hơn nhiều nhưng không loại trừ 100% — có thể do mạng
4G lúc đó, hoặc cold start lần đầu của DB): thử lại lần 2 ngay sau, hoặc thử trên wifi ổn định để
loại trừ nguyên nhân mạng phía bạn.
