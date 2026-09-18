# AUDIT REPORT V97.1 — "Lỗi server nội bộ" khi Xoá bài / Xoá từ / Xoá toàn bộ dữ liệu

## 1. Triệu chứng
Admin bấm "🗑️ Xoá bài" (hoặc "Xoá từ", hoặc "Xoá toàn bộ từ đã thêm") → app hiện dialog lỗi:
> hoctiengtrung203.vercel.app cho biết: Lỗi server nội bộ. Vui lòng thử lại sau.

Đây chính là `GENERIC_SERVER_ERROR_MESSAGE` (api/index.js) — thông điệp CHUNG mà `fail(res, e)`
trả về cho MỌI lỗi không phải `PublicError` (Postgres/driver error, TypeError do bug, v.v. — xem
comment tại api/index.js dòng ~129-138). Nghĩa là một exception "lạ" (không được chủ động đánh dấu
an toàn) đã bị ném ra từ tầng DB.

## 2. Nguyên nhân gốc
Migration **V93** ("vocab identity") thêm 2 cột FK **KHÔNG có `ON DELETE CASCADE`**:

```sql
ALTER TABLE fsrs_cards     ADD COLUMN IF NOT EXISTS word_id INT REFERENCES vocab_words(id);
ALTER TABLE review_history ADD COLUMN IF NOT EXISTS word_id INT REFERENCES vocab_words(id);
```

(Khác với `vocab_lessons.word_id` — bảng NÀY có `ON DELETE CASCADE`, nên an toàn.)

4 hàm xoá trong `lib/db.js` — `deleteVocabLesson`, `removeVocabWordFromLesson`, `deleteVocabWord`,
`clearVocab` — khi quyết định có nên `DELETE FROM vocab_words` hẳn hay không, **chỉ kiểm tra
`vocab_lessons`** (đúng tinh thần Phần 16 audit V93: "chỉ xóa vocabulary thực sự khi đảm bảo không
còn dependency") — nhưng **quên mất 2 dependency mới** mà chính V93 vừa thêm vào.

Hệ quả: hễ 1 từ trong bài bị xoá **đã từng được BẤT KỲ user nào ôn tập** (có dòng trong
`fsrs_cards`/`review_history`) → câu `DELETE FROM vocab_words` vi phạm khoá ngoại
(Postgres error code **23503**) → ném exception thường (không phải `PublicError`) → lộ ra client
thành thông điệp chung chung, đồng thời `ROLLBACK` sạch (may mắn: không mất dữ liệu, nhưng admin
xoá được 0 từ, kể cả những bài có lẫn 1 từ đã học).

Điều thú vị: chính file `test/vocab-identity.integration.test.js` (viết cùng đợt V93) đã BIẾT rõ
ràng buộc này — hàm `cleanup()` của nó tự comment: *"Thứ tự QUAN TRỌNG: fsrs_cards/review_history có
FK -> vocab_words.id (không CASCADE), phải xoá TRƯỚC vocab_words"* — nhưng bài học đó chưa từng được
áp dụng ngược lại vào chính code xoá thật (`deleteVocabLesson` v.v.) cho tới bản vá này.

## 3. Cách sửa
Áp dụng đúng NGUYÊN TẮC đã có sẵn trong code (Phần 16 V93: "chỉ xoá hẳn khi hết dependency"), chỉ mở
rộng danh sách dependency cần kiểm tra — thêm `fsrs_cards`/`review_history` bên cạnh `vocab_lessons`:

- **`deleteVocabLesson(l)`**: gỡ quan hệ `(word_id, l)` như cũ; chỉ `DELETE FROM vocab_words` khi từ
  đó KHÔNG còn thuộc bài nào **VÀ** không có `fsrs_cards`/`review_history` nào tham chiếu.
- **`removeVocabWordFromLesson(id, lesson)`**: tương tự, khi đây là bài cuối cùng của từ.
- **`deleteVocabWord(id)`**: gỡ hết quan hệ lesson trước (an toàn), rồi mới thử xoá hẳn với cùng
  guard; nếu bị chặn, từ vẫn được coi là "đã xử lý xong" (không còn ở bài nào) — trả `true` như cũ,
  tránh đổi hợp đồng API mà FE đang dựa vào (`fullyDeleted`).
- **`clearVocab()`**: xoá hết `vocab_lessons` trước (luôn an toàn), rồi chỉ purge những `vocab_words`
  không có dependency FSRS — giữ nguyên ý nghĩa số đếm trả về ("số từ đã gỡ khỏi mọi bài").

**Từ có lịch sử ôn tập** (đã hoặc đang được user học) sẽ được **giữ lại dạng "mồ côi"**: gỡ khỏi mọi
bài/lesson (không còn hiện ở bất kỳ đâu trong app — đúng ý định của admin khi bấm xoá), nhưng dòng
`vocab_words` gốc (chữ Hán/pinyin/nghĩa) vẫn còn trong DB để không phá vỡ `fsrs_cards`/
`review_history` hiện có của user (không mất tiến độ, không crash khi hiển thị lại thẻ due cũ).

Đây là lựa chọn AN TOÀN HƠN so với thêm `ON DELETE SET NULL`/`ON DELETE CASCADE` vào 2 FK đó — vì
`fsrs_cards`/`review_history` vẫn cần nội dung chữ Hán thật (qua `word_id`) để hiển thị đúng khi ôn
tập lại; `SET NULL` sẽ làm mất liên kết đó, còn `CASCADE` sẽ xoá luôn lịch sử ôn tập của user — cả
hai đều KHÔNG phải điều admin muốn khi chỉ đang dọn dẹp danh sách bài học.

## 4. File đã sửa
- `lib/db.js` — `clearVocab`, `deleteVocabLesson`, `removeVocabWordFromLesson`, `deleteVocabWord`.
- `test/vocab-identity.integration.test.js` — thêm **Case 13**: tạo từ có `fsrs_card`/
  `review_history` thật, gọi `deleteVocabLesson` trên CẢ 2 bài nó thuộc về (kể cả bài cuối cùng),
  verify KHÔNG ném lỗi và từ được giữ mồ côi đúng như thiết kế; verify tương tự cho logic guard dùng
  trong `clearVocab()` (không gọi thẳng `clearVocab()` thật trong test vì hàm đó xoá KHÔNG giới hạn
  theo tiền tố test — sẽ xoá dữ liệu thật nếu chạy nhầm lên `DATABASE_URL` production).

## 5. Cách verify
Chưa chạy được trong môi trường sửa lỗi này (không có kết nối Postgres/network). Trước khi deploy,
chạy trên staging/bản sao (không phải production):
```
DATABASE_URL=postgres://... npm run test:vocab-identity
```
Case 13 sẽ FAIL rõ ràng (ném lỗi 23503) trên code CŨ, và PASS trên code đã vá.

## 6. Phạm vi ảnh hưởng / KHÔNG đụng tới
- Không đổi schema/migration nào — chỉ đổi logic ứng dụng (thêm điều kiện `NOT EXISTS`).
- Không đổi hợp đồng API (`res.json({...})` shape) của `/api/admin/vocab/delete-lesson`,
  `/api/admin/vocab/delete-word`, `/api/admin/vocab/clear`.
- Không đụng `bulkUpsertVocab`/`importVocab`, `lib/fsrs/*`, `lib/vocab-merge.js`.
