# AUDIT REPORT — FSRS Optimizer trên Vercel + Neon (audit lại, bản yêu cầu đầy đủ 16 phần)

Ngày: 2026-09-02
Phạm vi: `lib/fsrs/optimizer.js`, `api/index.js` (2 route `/run` và `/worker`), `test/fsrs-optimizer.test.js`.
File input: `hoc-tu-vung-v90-full.zip` (đã chứa 2 lần sửa từ trước — xem "Bối cảnh" bên dưới).

---

## 0. Bối cảnh — bản ZIP này đã có 2 lần sửa từ trước

Trước khi audit lại, tôi đọc toàn bộ lịch sử đã có sẵn trong ZIP (`TROUBLESHOOTING-FSRS-OPTIMIZER.md`,
`AUDIT-REPORT-V89-CONTINUATION-CLAIM-BUG.md`, `AUDIT-REPORT-V90-FSRS-OPTIMIZER-ROOT-CAUSE.md`). Tóm tắt:

- **V89**: phát hiện job bị "mất heartbeat" vì nhánh checkpoint (dừng giữa chừng để chờ 1 lượt gọi mới)
  KHÔNG reset trạng thái job về `'queued'` trước khi báo "sẽ tiếp tục" — khiến lượt gọi tiếp theo không
  claim lại được, job treo tới khi cơ chế dọn job-treo (180 giây) mới cứu, tốn oan lượt thử lại.
- **V90**: phát hiện tham số `timeout` truyền cho optimizer chính thức KHÔNG PHẢI là "thời gian tối đa
  cho phép train" như đã hiểu nhầm ban đầu, mà là **tần suất kiểm tra tiến độ** (mặc định rất ngắn). Sửa
  bằng cách tách riêng 2 khái niệm và tự chủ động yêu cầu optimizer dừng nếu train lâu hơn 1 ngưỡng an
  toàn tự đặt ra.

**Tôi đã kiểm tra lại độc lập cả 2 điểm trên bằng cách đọc thẳng source code hiện tại** (không chỉ tin
vào báo cáo cũ) **và xác nhận cả 2 đều đã được sửa ĐÚNG trong code, không chỉ ghi trong báo cáo.** Điểm
V90 tôi còn tra cứu thêm tài liệu/mã nguồn thật của đúng phiên bản thư viện đang dùng (xem mục 2) để chắc
chắn cách hiểu là đúng, không phải đoán.

Vì 2 điểm trên đã đúng, tôi **giữ nguyên, không sửa lại** — đúng yêu cầu "nếu đã có phần sửa đúng thì
giữ lại". Phần audit lại này tập trung tìm những gì CÒN CHƯA ĐÚNG hoặc CHƯA ĐỦ, dựa trên yêu cầu đầy đủ
hơn (16 phần) lần này.

---

## 1. Root cause (tổng hợp — cả cũ lẫn mới)

Thông báo lỗi gốc ("Job không có heartbeat trong thời gian dài...") có thể tới từ **nhiều nguyên nhân
khác nhau cộng dồn**, không phải 1 nguyên nhân duy nhất:

1. *(Đã sửa từ V89)* Job checkpoint không reset trạng thái → lượt gọi tiếp theo không claim lại được.
2. *(Đã sửa từ V90)* Hiểu nhầm ý nghĩa `timeout` → không có cơ chế chủ động dừng train trước khi Vercel
   tự giết tiến trình (Vercel giết tiến trình thì heartbeat cũng chết theo, không kịp ghi gì cả).
3. *(MỚI tìm ra trong audit lại này)* Ngay cả khi đã chủ động yêu cầu dừng train đúng lúc, có **1 khả
   năng bị phân loại sai** khiến 1 lần "hết ngân sách, cần thử lại" bị coi là "lỗi dữ liệu, không thử lại
   nữa" — biến 1 sự cố tạm thời thành thất bại hẳn ngay từ lần đầu.
4. *(MỚI)* Đồng hồ đếm ngược ngân sách an toàn (mặc định 50 giây) trước đây tính từ SAU BƯỚC đăng nhập +
   nhận job — nếu bước đó chậm (Neon "ngủ" phải khởi động lại, gọi là cold start), phần thời gian đó bị
   tính "miễn phí", làm biên an toàn (vốn chỉ ~10 giây dưới ngưỡng cứng 60 giây của Vercel Hobby) hẹp hơn
   so với thực tế mà không ai biết.
5. *(MỚI, không phải lỗi mà là thiếu công cụ chẩn đoán)* Không có cách nào xem lại SAU KHI đã chạy xong
   liệu lần đó có chạy trên "động cơ" nhanh (native) hay động cơ dự phòng chậm hơn nhiều (WASI) — thông
   tin này trước đây chỉ có trong log tạm thời, biến mất sau khi đóng cửa sổ xem log của Vercel.

**Về dữ liệu thực tế của bạn** (833 thẻ, 4782 review, 13 ngày): dữ liệu này đủ điều kiện train
(`OPTIMIZABLE`) và ở quy mô này, bản thân việc "train" thường rất nhanh (vài giây) nếu chạy bằng động cơ
gốc (native). Nếu optimizer VẪN chậm bất thường trên dữ liệu của bạn, khả năng cao nằm ở #4 hoặc ở việc
lỡ chạy bằng động cơ dự phòng (#5 giúp bạn nhìn thấy điều này ở lần chạy tiếp theo).

---

## 2. Xác minh bên ngoài (không đoán mò)

Vì đây là điểm mấu chốt của lần sửa V90, tôi tự tra cứu độc lập (không chỉ tin báo cáo cũ):

- Đã xác nhận `@open-spaced-repetition/binding` phiên bản đang cài đúng là **0.5.0** (khớp với
  `package.json`, không phải "bản mới nhất trên GitHub" — 2 thứ có thể khác nhau).
- Đã đọc tài liệu kỹ thuật thật của package (qua DeepWiki, dẫn tới đúng file mã nguồn
  `packages/binding/src/progress.rs`) xác nhận: `timeout` = tần suất polling (mặc định 100ms), và
  callback tiến độ trả `false` → cờ "muốn dừng" được set → optimizer tự kiểm tra cờ này định kỳ để dừng.
  Đây đúng là cách hiểu mà bản sửa V90 đã dùng.
- Đã xác nhận qua lịch sử phát hành (GitHub Releases) rằng cơ chế "dừng giữa chừng" đã có từ bản 0.3.0
  (31/3), tức là ổn định và có sẵn ở bản 0.5.0 đang dùng — không phải tính năng mới/chưa chắc còn.
- **Một điểm KHÔNG tìm được xác nhận công khai rõ ràng**: sau khi optimizer bị yêu cầu dừng, hàm
  `computeParameters()` phía JavaScript sẽ BÁO LỖI (reject) hay TRẢ VỀ một kết quả không hợp lệ (resolve)?
  Tài liệu không nói rõ khả năng nào đúng. Vì không có mạng để tự cài bản thật + thử với dữ liệu đủ lớn
  để tận mắt kích hoạt tình huống này, tôi **không giả định** mà sửa code để **đúng ở CẢ HAI khả năng**
  (xem mục 3, sửa #1). Đây là ví dụ cụ thể cho việc "nếu chưa chắc chắn thì phải nói rõ" theo đúng yêu
  cầu — thay vì đoán 1 trong 2 khả năng rồi giả vờ chắc chắn.

---

## 3. Các thay đổi (chi tiết kỹ thuật)

### Sửa #1 — Phân loại đúng "chủ động dừng vì hết giờ" là LUÔN có thể thử lại

**File:** `lib/fsrs/optimizer.js`, hàm `trainWithOfficialOptimizer()` và `classifyOptimizerError()`.

**Logic cũ sai ở đâu:** Khi optimizer bị chủ động yêu cầu dừng (vì đã chạy quá lâu), nếu thư viện phản
hồi bằng cách "trả về xong nhưng kết quả không đúng hình dạng" (thay vì báo lỗi hẳn), code cũ sẽ ném ra
đúng thông điệp "weights không hợp lệ" — và thông điệp NÀY lại trùng với 1 trong 3 dấu hiệu được code
dùng để nhận biết "đây là lỗi dữ liệu, không thử lại nữa vô ích". Kết quả: 1 lần tạm thời hết giờ (bản
chất nên được thử lại, lần sau sẽ có giờ mới hoàn toàn) bị đối xử như lỗi dữ liệu vĩnh viễn — tốn oan các
lượt thử lại còn lại, hoặc worse, hỏng job ngay từ lần đầu dù còn nguyên số lượt thử.

**Logic mới hoạt động thế nào:** Ngay tại nơi DUY NHẤT quyết định "phải dừng vì hết giờ" (bên trong
callback theo dõi tiến độ), code gắn 1 cờ đánh dấu thẳng vào đối tượng lỗi (`optimizerAborted = true`) —
bất kể sau đó thư viện báo lỗi hay trả về kết quả sai hình dạng. Hàm phân loại lỗi
(`classifyOptimizerError`) kiểm tra cờ này TRƯỚC TIÊN, và nếu có, luôn trả "có thể thử lại" — không cần
đoán qua nội dung chữ của thông điệp lỗi nữa. Việc này đúng bất kể thư viện chọn cách phản hồi nào trong
2 khả năng chưa xác nhận được ở mục 2.

### Sửa #2 — Lưu lại "chạy bằng động cơ nào" sau khi train xong

**File:** `lib/fsrs/optimizer.js`, hàm `runOptimizerJob()`.

Thêm trường `optimizerEngine` (giá trị `native` hoặc `wasi`) vào kết quả lưu trong database sau mỗi lần
train THÀNH CÔNG — trước đây thông tin này chỉ nằm trong log tạm thời của Vercel (biến mất khi hết phiên
xem). Nếu sau này optimizer lại chậm bất thường, chỉ cần xem lại kết quả lần chạy gần nhất là biết ngay
có phải do lỡ chạy bằng động cơ dự phòng chậm hơn hay không.

Cũng thêm 1 dòng log riêng (`OPTIMIZER_ABORTED`) mỗi khi việc dừng vì hết giờ thực sự xảy ra, ghi rõ đã
chạy bao lâu và bằng động cơ nào — dễ tìm trên Vercel Function Logs hơn so với trước.

### Sửa #3 — Tính đúng thời gian còn lại, kể cả phần bị "giấu" trước đây

**File:** `lib/fsrs/optimizer.js` (hàm `runOptimizerJob()`) và `api/index.js` (route `POST /worker`).

**Logic cũ sai ở đâu:** Ngân sách an toàn 50 giây (để luôn dừng trước khi Vercel tự giết tiến trình ở
mốc 60 giây) được tính bắt đầu từ SAU KHI đã xong bước xác thực đăng nhập + nhận job — 2 bước này đều
cần gọi tới Neon. Nếu Neon đang "ngủ" (không hoạt động 1 thời gian, phải khởi động lại — hành vi bình
thường của gói miễn phí), bước này có thể tốn thêm vài trăm mili-giây tới vài giây, nhưng thời gian đó
KHÔNG bị trừ vào ngân sách 50 giây — nghĩa là biên an toàn thực tế hẹp hơn con số 10 giây tưởng như có.

**Logic mới hoạt động thế nào:** Mốc thời gian bắt đầu đếm được đo NGAY DÒNG ĐẦU TIÊN khi Vercel nhận
được yêu cầu (trước cả bước xác thực), rồi truyền mốc đó xuống cho hàm tính ngân sách — thay vì để hàm
đó tự đo lại 1 mốc trễ hơn. Ngân sách 50 giây bây giờ phản ánh đúng tổng thời gian THẬT của toàn bộ lượt
gọi, không bỏ sót phần đầu. Có tương thích ngược: nếu ai gọi hàm kiểu cũ (không truyền mốc này), hệ thống
tự dùng lại cách tính như trước, không phá vỡ gì.

### Việc KHÔNG sửa (giữ nguyên vì đã đúng)

- Cơ chế tách "tần suất kiểm tra" và "ngân sách train" (V90) — đã kiểm tra, đúng.
- Cơ chế reset trạng thái job khi checkpoint (V89) — đã kiểm tra, đúng.
- Toàn bộ state machine (claim/heartbeat/stale-recovery/finish) — dùng transaction + khoá dòng đúng
  cách, không có race condition rõ ràng.
- Cách tự gọi lại chính mình để tiếp tục (khi 1 lượt không đủ thời gian) — dùng đúng cơ chế nền chính
  thức của Vercel (`waitUntil`), không phải tự chế.
- Kích thước connection pool tới Neon (`max: 3`) — hợp lý cho môi trường serverless, không cần đổi.

---

## 4. Test đã chạy

Môi trường sửa code này **không có kết nối mạng** để tự `npm install` các thư viện thật (`pg`, `ts-fsrs`,
`@open-spaced-repetition/binding`, `express`...). Vì vậy:

**Chạy được thật (không cần thư viện ngoài):**
- Kiểm tra cú pháp (`node --check`) trên **toàn bộ** file `.js` trong project — không có lỗi.

**Chạy được bằng cách tự dựng bản giả lập tối thiểu của các thư viện ngoài** (chỉ để kiểm tra ĐÚNG luồng
logic/nhánh rẽ, KHÔNG phải để xác nhận toán học FSRS chuẩn xác — việc đó cần thư viện thật):
- Toàn bộ `test/fsrs-optimizer.test.js` (65 test) và `test/fsrs.test.js` (19 test) — **84/84 PASS**.
- Trong đó tôi có thêm test MỚI kiểm tra riêng 3 chỗ vừa sửa ở mục 3, bao gồm việc giả lập CẢ HAI khả
  năng chưa xác nhận được ở mục 2 (thư viện báo lỗi HAY trả kết quả sai hình dạng khi bị yêu cầu dừng) —
  để chắc chắn code đúng ở cả 2 trường hợp, không chỉ trường hợp tôi đoán là có khả năng cao hơn.
- **Trong lúc test, tôi tự phát hiện và sửa 1 lỗi do chính tôi viết ra** (1 biến bị khai báo nhầm chỗ,
  khiến 1 trong 2 nhánh sửa ở mục 3-#1 không hoạt động đúng) — nếu không có bước test này, lỗi đó đã bị
  đóng gói giao cho bạn mà không ai biết.

**KHÔNG chạy được trong môi trường sửa code này** (cần điều kiện tôi không có ở đây):
- `test/fsrs-optimizer.integration.test.js`, `test/fsrs.concurrency.integration.js` — cần kết nối
  Postgres thật (tự SKIP nếu thiếu, đây là thiết kế sẵn có của project, không phải lỗi mới).
- `test/fsrs-optimizer.binding.smoke.test.js` — theo đúng thiết kế của chính file này, nó **KHÔNG được
  phép SKIP** khi thiếu thư viện thật, mà phải FAIL rõ ràng — nghĩa là nó SẼ báo FAIL nếu bạn chạy nó ở
  đây, và đó là điều BÌNH THƯỜNG/dự kiến trong sandbox này. File này cần được chạy thật ở môi trường có
  cài đặt đầy đủ (máy của bạn, hoặc bước build của Vercel) để có ý nghĩa.
- Chạy thử thật trên Vercel + Neon với dữ liệu thật của bạn (833 thẻ/4782 review) để đo thời gian train
  thực tế và xác nhận có chạy bằng native hay không — đây là bước CHỈ có thể làm sau khi bạn deploy (xem
  mục 5, có hướng dẫn cụ thể cách tự xem).

---

## 5. Cách deploy lên Vercel

1. Thay các file đã sửa (hoặc giải nén ZIP đầy đủ) lên GitHub, sau đó deploy lại như bình thường —
   **không cần chạy thêm lệnh nào đặc biệt.**
2. **Không cần sửa database** — 2 trường mới (`optimizerEngine`, `OPTIMIZER_ABORTED` trong log) được lưu
   vào 1 cột kiểu JSON đã có sẵn từ trước, không cần thêm cột/bảng mới.
3. Sau khi deploy, chạy thử FSRS Optimizer 1 lần với dữ liệu thật. Nếu vẫn gặp lỗi, vào Vercel →
   project → tab "Logs" → tìm dòng có chữ `OPTIMIZER_ABORTED` hoặc `optimizerEngine` — 2 dòng này bây giờ
   sẽ cho biết rõ: có bị chủ động dừng vì hết giờ không, và chạy bằng động cơ nào (native/wasi). Nếu thấy
   `engine=wasi` dù server hỗ trợ native, đó là dấu hiệu nên xem lại bước cài đặt/đóng gói của Vercel.
4. **Điểm cần bạn xác nhận thêm** (tôi không có cách xác nhận từ xa): dự án của bạn đang ở gói Vercel
   Hobby (miễn phí) hay Pro? File hướng dẫn deploy trong project ghi là Hobby, nhưng nếu thực tế bạn đã
   nâng lên Pro, giới hạn thời gian chạy thật là 300 giây thay vì 60 giây — khi đó có thể tăng biến môi
   trường ngân sách (`FSRS_OPTIMIZER_WORKER_BUDGET_MS` và tương đương) để optimizer có nhiều thời gian
   train hơn, thay vì bị dừng sớm. Nếu vẫn là Hobby thì không cần đổi gì, các mặc định hiện tại đã được
   tính an toàn cho đúng giới hạn 60 giây đó.

### Ghi chú nhỏ, không phải lỗi

File `TROUBLESHOOTING-FSRS-OPTIMIZER.md` (tài liệu cũ trong project) có hướng dẫn xem trường
`optimizerEngineState` để chẩn đoán — trường này từ bản sửa trước (V87) đã cố định luôn là `"UNKNOWN"` vì
lý do an toàn (tránh việc mỗi lần xem trạng thái đều phải chạm vào thư viện native, có thể gây crash
thêm chỗ khác). Hướng dẫn cũ đó không còn đúng nữa — nếu cần chẩn đoán sâu, dùng endpoint
`/diagnostics` (chỉ admin) như code hiện tại, không dùng `optimizerEngineState` nữa. Tôi không sửa lại
tài liệu cũ đó vì không nằm trong phạm vi được yêu cầu, chỉ ghi chú lại ở đây.
