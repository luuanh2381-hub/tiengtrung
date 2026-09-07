# Audit V93 — Thống nhất vocabulary identity giữa các bài — Báo cáo cuối cùng

## 0. Giới hạn môi trường audit (đọc trước, quan trọng)

Sandbox tôi làm việc **không có network egress** — không `npm install` được (`pg`, `ts-fsrs`,
`express` chưa cài), **không có Postgres thật** để kết nối. Vì vậy:

- Phần **logic quyết định** (chọn bản ghi canonical, merge field, chọn thẻ FSRS sống sót) được
  tách thành module thuần `lib/vocab-merge.js` (0 dependency ngoài) và **đã chạy test thật, pass
  thật** trong sandbox này — xem mục 6.
- Phần **SQL/tích hợp Postgres thật** (migration script, luồng import/review đầy đủ) đã được viết
  và tự rà soát kỹ nhiều lượt, nhưng **CHƯA được chạy thật trên Postgres** — file
  `test/vocab-identity.integration.test.js` đã viết đầy đủ 12 case, tự skip an toàn (exit 0) khi
  thiếu `DATABASE_URL`, sẵn sàng chạy khi bạn có DB thật.
- **Số liệu "trước/sau" ở mục 7 lấy từ dữ liệu MẪU tôi tự tạo trong test** (không phải dữ liệu
  production thật của bạn — tôi không có quyền truy cập DB đó). Bạn cần tự chạy
  `node scripts/migrate-vocab-identity.js` (khuyến khích `DRY_RUN=1` trước) trên bản sao dữ liệu
  thật để có con số thật, script tự in đầy đủ theo đúng format mục 13 của yêu cầu.

**Khuyến nghị bắt buộc trước khi chạy trên production:**
```bash
npm install
npm run test:vocab-merge          # 24 test thuần, chạy ngay, không cần DB
DATABASE_URL=<bản sao/staging> npm run test:vocab-identity
DATABASE_URL=<bản sao/staging> DRY_RUN=1 npm run migrate:vocab-identity   # xem trước, không ghi gì
DATABASE_URL=<production>      DRY_RUN=1 npm run migrate:vocab-identity   # xem trước trên số liệu thật
DATABASE_URL=<production>              npm run migrate:vocab-identity    # chạy thật
```

---

## 1. Nguyên nhân gốc (audit trước khi sửa)

`vocab_words` có `UNIQUE(hz, l)` — **"hz + lesson" là identity**, không phải `hz`. Mọi nơi (import,
add word, FSRS) đều coi `(hz, l)` là 1 từ. `fsrs_cards`/`review_history` cũng khoá theo
`(user_id, hz, l)` — comment gốc trong code thừa nhận thẳng: dùng cặp này *"vì cùng 1 chữ Hán có
thể xuất hiện ở nhiều bài với nghĩa khác nhau"*. Hệ quả: 1 từ xuất hiện ở N bài → N bản ghi
`vocab_words` tách biệt, N bộ FSRS card độc lập cho cùng 1 user. `lib/fsrs/reviewService.js` từng
có 1 đoạn dedupe-by-hz ở tầng hiển thị session học (band-aid che triệu chứng, không sửa gốc) —
**vẫn giữ nguyên, giờ là lưới an toàn vô hại vì gốc đã hết duplicate**.

## 2. Kiến trúc mới

- `vocab_words` — không đổi cột, thêm `UNIQUE(hz)` (tạo **sau khi** dedupe xong, không tạo trước).
- `vocab_lessons(word_id, lesson)` — bảng quan hệ nhiều-nhiều MỚI, nguồn thật cho "từ thuộc bài nào".
- `fsrs_cards.word_id`, `review_history.word_id` — cột MỚI (nullable, cộng thêm), FK →
  `vocab_words.id`. `UNIQUE(user_id, word_id) WHERE word_id IS NOT NULL` — ràng buộc tầng DB cho
  "1 user tối đa 1 thẻ/từ". Cột `hz`/`l` cũ **giữ nguyên 100%**, không xoá, không đổi tên.

## 3. File đã sửa / tạo mới

| File | Loại | Nội dung |
|---|---|---|
| `lib/vocab-merge.js` | **Mới** | Toàn bộ logic quyết định (pure function, 0 dependency): merge field/pinyin/nghĩa, chọn canonical, chọn thẻ FSRS sống sót |
| `lib/db.js` | Sửa | Schema (`ensureVocabTable`/`ensureFsrsTables`), `bulkUpsertVocab` viết lại hoàn toàn, các hàm đọc theo lesson, `reviewFsrsCard` + các hàm FSRS liên quan |
| `api/index.js` | Sửa | Route import/update/delete-word sửa semantics, thêm `GET /api/admin/vocab/find-by-hz` |
| `js/admin.js` | Sửa | Dialog trùng lặp khi thêm từ thủ công, hiển thị nhiều bài/từ, xoá theo đúng bài |
| `scripts/migrate-vocab-identity.js` | **Mới** | Script migration 1 lần, có `DRY_RUN`, tự snapshot trước/sau |
| `migrations/V93_vocab_identity.sql` | **Mới** | Tài liệu tham khảo schema (không tự chạy — theo đúng convention V69/V76) |
| `test/vocab-merge.test.js` | **Mới** | 24 test thuần — **đã chạy, PASS thật** |
| `test/vocab-identity.integration.test.js` | **Mới** | 12+ case cần Postgres thật — viết đầy đủ, chưa chạy được (xem mục 0) |
| `package.json` | Sửa | Thêm `test:vocab-merge`, `test:vocab-identity`, `migrate:vocab-identity` |

## 4. Thay đổi chính theo từng yêu cầu

- **Add word / Import Excel** (`bulkUpsertVocab`): tra theo `hz`; có rồi → merge metadata theo
  `overwrite` (KHÔNG BAO GIỜ ghi đè bằng rỗng) + **LUÔN** thêm quan hệ lesson (dù overwrite ON/OFF);
  chưa có → insert mới. Không còn tạo `(hz, l)` trùng.
- **Manual Add Word**: `GET /api/admin/vocab/find-by-hz` kiểm tra trùng trước khi submit; nếu trùng
  → dialog "Giữ dữ liệu hiện tại / Ghi đè" (đúng mẫu yêu cầu), chọn xong mới ghi.
- **FSRS**: `reviewFsrsCard` resolve `word_id` từ `hz` ngay đầu transaction; 1 user tối đa 1 thẻ/từ
  bất kể lesson (ràng buộc unique tầng DB, không chỉ tầng code). Không đổi 1 dòng nào trong
  `lib/fsrs.js` (thuật toán ts-fsrs), `lib/fsrs/optimizer.js`, `lib/fsrs/analytics.js` — các file
  này không hề tham chiếu `hz`/`vocab_words` nên nằm ngoài phạm vi, không đụng tới.
- **Xoá từ khỏi 1 bài**: chỉ xoá đúng quan hệ `(word_id, lesson)`; chỉ xoá hẳn `vocab_words` khi đó
  là bài cuối cùng còn lại.
- **Backward compatibility**: mọi hàm đọc theo lesson (`getDueFsrsCards`, `getNewWordsByLessonOrder`,
  `getVocabByLessons`...) JOIN qua `word_id` **có fallback về `hz+l`** khi `word_id` chưa kịp
  backfill — app không "gãy" nếu code mới deploy trước khi chạy migration script.

## 5. Migration strategy

1. Schema mới (bảng/cột/index) tự tạo idempotent khi app chạy (giống pattern V69/V76 sẵn có) — an
   toàn deploy trước migration script.
2. `scripts/migrate-vocab-identity.js` (chạy tay 1 lần, có `DRY_RUN`, 1 transaction duy nhất,
   rollback sạch nếu bất thường):
   Tìm nhóm `hz` trùng → giữ canonical = **id nhỏ nhất** → merge metadata (`lib/vocab-merge.js`,
   field rỗng không ghi đè) → gộp lesson vào `vocab_lessons` → với mỗi user có nhiều FSRS card
   trùng: chọn thẻ sống sót (**reps cao nhất → last_review gần nhất → id nhỏ nhất**), backfill
   `word_id` cho **toàn bộ** `review_history` (kể cả của thẻ bị gộp — không xoá/sửa lịch sử) → xoá
   bản ghi `vocab_words` thua → verify sạch trùng → **mới** tạo `UNIQUE(hz)`.
3. Idempotent: chạy lại khi đã sạch → không tìm thấy gì để merge → no-op an toàn (test Case 12).

## 6. Kết quả test

**Đã chạy thật trong sandbox này** (không cần DB, không cần `npm install`):
```
node test/vocab-merge.test.js  →  24 PASS, 0 FAIL
```
Cover: merge field/pinyin (Case 11), merge nghĩa, overwrite ON/OFF (Case 3/4), chọn canonical =
id nhỏ nhất, đúng ví dụ 3 bản ghi 101/245/389 trong yêu cầu, chọn thẻ FSRS sống sót (Case 9),
idempotent (Case 12).

**Viết đầy đủ, chưa chạy được** (cần Postgres — xem mục 0): `test/vocab-identity.integration.test.js`
cover Case 1, 2, 5, 7, 8, 9, 10, 12 + "không tạo thẻ FSRS thứ 2 khi review qua 2 lesson khác nhau" —
tự tạo dữ liệu giả lập đúng trạng thái "trước migration" (2 `vocab_words` trùng hz, mỗi bên có FSRS
riêng của cùng 1 user), tự gọi migration script thật (`DRY_RUN` rồi chạy thật rồi chạy lại lần 2),
tự dọn dẹp dữ liệu test.

**Toàn bộ 9 file JS/script đã qua `node --check`** (kiểm tra cú pháp) — không lỗi.

**Tự rà soát phát hiện và vá 2 lỗ hổng transaction** trước khi giao: 1 câu lệnh lỗi trong Postgres
transaction đánh dấu cả transaction "aborted" — đã thêm `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` đúng
chỗ ở bước "tự chữa lành word_id" trong `reviewFsrsCard` và ở `snapshot()` của migration script, để
1 race condition/lỗi phụ hiếm gặp không bao giờ làm mất cả lượt review hay cả transaction migration.

## 7. Data safety check — mẫu (chạy từ dữ liệu test giả lập, KHÔNG phải production thật)

Script tự in đúng format này khi bạn chạy thật (xem mục 0 để chạy trên dữ liệu thật của bạn):

| Chỉ số | Trước | Sau | Ghi chú |
|---|---:|---:|---|
| `vocab_words` (3 bản ghi trùng 1 hz, kiểu ví dụ trong yêu cầu) | 3 | 1 | Gộp trùng — không mất từ, mọi lesson/nghĩa đã merge |
| `vocab_lessons` | 0 | 3 | Bảng mới — đủ cả 3 lesson trỏ về canonical |
| `fsrs_cards` (2 thẻ trùng của cùng 1 user) | 2 | 1 | Gộp — thẻ reps cao hơn sống sót, không tự ý reset |
| `review_history` | 2 | 2 | **Không đổi** — không dòng nào bị xoá/sửa nội dung |
| `app_store` users | N | N | **Không đổi** — migration không đụng tài khoản |

## 8. Known limitations (nói thẳng, không giấu)

- `bulkUpsertVocab` xử lý tuần tự từng dòng (không insert hàng loạt như bản cũ) — đánh đổi tốc độ
  lấy đúng-đắn, chấp nhận được vì đây là thao tác admin không thường xuyên.
- Race condition cực hiếm khi 2 admin cùng lúc import trùng đúng 1 từ mới trong vòng mili-giây có
  thể làm rollback cả batch import đó (KHÔNG mất dữ liệu, chỉ cần thử lại) — không xử lý thêm vì
  xác suất gần như 0 và không đáng đánh đổi thêm độ phức tạp.
- Số liệu mục 7 là dữ liệu mẫu — **bắt buộc** tự chạy `DRY_RUN=1` trên dữ liệu thật trước khi chạy
  chính thức.
