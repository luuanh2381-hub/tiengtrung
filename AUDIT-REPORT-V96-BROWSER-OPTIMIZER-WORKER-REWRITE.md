# Fix V96 — Optimizer trong trình duyệt: lỗi vẫn còn SAU KHI V95 đã fix (2 nguyên nhân sâu hơn)

## Bối cảnh
Sau khi deploy V95 (fix resolve nested transitive dependency), diagnostics báo import map "Sẵn sàng"
với đầy đủ URL asset, nhưng bấm Run vẫn gặp **y hệt lỗi cũ**: `Failed to resolve module specifier
"@napi-rs/wasm-runtime"`. Đào sâu thêm phát hiện **2 nguyên nhân KHÁC**, sâu hơn V95, cùng góp phần:

## Nguyên nhân 1 — Import map không áp dụng được cho Worker (giới hạn nền tảng, đã tự cảnh báo trước)

Package binding-wasm32-wasi **tự tạo 1 Worker riêng** để chạy phần tính toán nặng (đã ghi rõ trong
comment ở đầu `js/fsrs-optimizer.js` — "audit lại lần 7": app đã tránh được Worker *của chính nó*,
nhưng không tránh được Worker mà *thư viện tự spawn bên trong*). Theo đặc tả WHATWG, 1 dedicated
Worker có "module map" **riêng**, không kế thừa import map từ document chính — nên dù import map ở
tài liệu chính đã đúng (V95), module bên trong Worker đó vẫn không resolve được.

**Giải pháp triệt để**: thay vì trông cậy trình duyệt tự áp dụng import map, server tự "viết lại"
mọi bare specifier **ngay trong nội dung** file `.js`/`.mjs`/`.cjs` thành URL tuyệt đối (`/api/...`)
trước khi trả về (`rewriteBareSpecifiersInSource` + `sendPackageFile` mới trong `api/index.js`). Một
đường dẫn tuyệt đối luôn hợp lệ ở MỌI ngữ cảnh module — main thread hay Worker — không phụ thuộc
trình duyệt có hỗ trợ "import map cho Worker" hay không. Import map (V95) vẫn giữ chạy song song làm
lưới an toàn.

## Nguyên nhân 2 — 1 context vẫn chưa đủ: dependency có thể nested trong package "anh em" khác

Khi viết test để verify nguyên nhân 1 (mô phỏng đúng file Worker chứa bare import), phát hiện thêm:
`@napi-rs/wasm-runtime` có thể được npm đặt nested bên trong **`binding`** (không phải
`binding-wasm32-wasi`) — 2 package này là **sibling** (anh em), không phải package con của nhau.
Code V95 chỉ thử resolve từ context của **đúng file đang chứa specifier** — nếu file đó thuộc
`binding-wasm32-wasi` nhưng dependency lại nested trong `binding`, vẫn resolve thất bại.

**Đã sửa**: `resolveBareSpecifierUrl` giờ thử lần lượt 3 "điểm neo": (1) context của chính file đang
xét, (2) root của package `binding`, (3) root của `binding-wasm32-wasi` — dừng ở ứng viên đầu tiên
resolve thành công.

## Đã tái hiện + verify bằng thực nghiệm (không chỉ suy luận)

Mở rộng `test/fsrs-optimizer.browser-asset-resolution.test.js`: thêm nội dung bare-import thật vào
file worker giả lập, viết test gọi **đúng route serve thật** (`serveBrowserOptimizerPackageFile`)
cho file đó. Chạy với code chỉ có V95: **FAIL** (nội dung trả về vẫn chứa nguyên `@napi-rs/wasm-
runtime` chưa rewrite). Chạy với code đã thêm cả 2 fix trên: **PASS** — nội dung trả về không còn
bare specifier nào, đã thay đúng URL tuyệt đối.

## Test
`test/fsrs-optimizer.browser-asset-resolution.test.js` — **14/14 PASS** (6 case mới cho
`rewriteBareSpecifiersInSource`: static import, dynamic import, side-effect-only import, specifier
không resolve được thì giữ nguyên, không đụng đường dẫn tương đối/tuyệt đối sẵn có, và kịch bản Worker
thật qua route thật). Chạy lại 3 lần liên tiếp không flaky. Không ảnh hưởng
`test/fsrs-optimizer-frontend.smoke.test.js` (23/23 PASS), `test/vocab-merge.test.js` (30/30),
`test/visibility-timer.test.js` (7/7).

*(Lưu ý kỹ thuật khi viết test: hàm chạy trong Node `vm` sandbox trả về mảng thuộc "realm" riêng,
không so sánh trực tiếp được bằng `assert.deepStrictEqual` với literal `[]` của file test dù nội
dung giống hệt — phải so qua `.length`. Không ảnh hưởng code sản phẩm thật, vì đó chạy trong runtime
Node bình thường, không qua `vm`.)*

## Không sửa gì khác
Không đụng `lib/fsrs.js`, `lib/fsrs/optimizer.js`, kiến trúc "chạy trên luồng chính" đã có.

## Bạn cần làm gì
1. Deploy bản mới.
2. Bấm "Run Optimizer" thử luôn — không cần bước kiểm tra trung gian nữa vì bản thân cơ chế rewrite
   không phụ thuộc "chờ trình duyệt áp dụng import map đúng lúc" như V95.
3. Nếu **vẫn** gặp lỗi tương tự với 1 package khác (không phải `@napi-rs/wasm-runtime`), khả năng cao
   là 1 dependency thứ 3 nested ở vị trí khác nữa — cơ chế rewrite đã tổng quát (không hardcode tên
   package nào) nên sẽ tự xử lý được, miễn là nó nested trong `binding` hoặc `binding-wasm32-wasi`;
   nếu nested ở nơi khác hẳn, báo lại nguyên văn lỗi mới.
