# AUDIT V114 — cờ `introduced`, thống kê "Tỉ lệ trả lời đúng", DRY_RUN của migration

Nền: V113. Không đổi thuật toán FSRS, không đổi schema (không thêm cột/bảng/migration mới), không viết lại kiến trúc.

## 1. Danh sách tệp đã sửa / thêm

| Tệp | Thay đổi |
|---|---|
| `js/review.js` | Lỗi 1: tách cờ, thêm `rvIsIntroExposure`, `rvNormalizeIntroFlags`; sửa `rvRecordAnswer`, `rvCommitRating`, `rvAdvanceQueue`, khôi phục phiên |
| `lib/skill-store.js` | Lỗi 2: viết lại truy vấn trong `getTodayProgress()` |
| `scripts/migrate-skill-evidence.js` | Lỗi 3: viết lại quy trình (mọi bước trong 1 transaction) |
| `test/v114-fixes.test.js` | **Mới** — 20 test cho cả 3 lỗi |
| `test/v113-evidence.test.js` | Cập nhật 2 kỳ vọng đã mã hoá hành vi cũ (xem mục 5) |
| `test/adaptive-session.test.js` | Thêm `'rvIsIntroExposure'` vào danh sách hàm harness trích từ `review.js` (không đổi assertion) |
| `package.json` | Thêm `test:v114`, nối vào `test:v110` |

Không đụng: `lib/db.js`, `lib/fsrs.js`, `lib/fsrs/*`, `api/index.js`, `migrations/*`.

## 2. Lỗi 1 — `introduced` bị dùng cho 2 việc

**Nguyên nhân.** Sau câu kiểm tra, `rvAdvanceQueue` tạo lại thẻ chính thức `{type:'new', introduced:true}`. `introduced` vừa là "đã giới thiệu" (để không hiện lại màn giới thiệu) vừa là điều kiện gắn `exposure:'intro'` và bỏ qua cập nhật kỹ năng. Khi thẻ trả lời sai, chính object đó được chèn lại hàng đợi nên **mọi lượt sau** vẫn bị coi là "vừa xem đáp án" (server không cộng điểm kỹ năng, client không cập nhật hồ sơ cục bộ).

**Cách sửa.**
- `introduced` giữ nguyên nghĩa "đã giới thiệu".
- Cờ mới `introExposurePending` = "lượt FSRS đầu sau giới thiệu chưa được gửi". Chỉ đặt `true` khi tạo thẻ chính thức sau câu kiểm tra.
- `exposure:'intro'` và việc bỏ qua `QS.learn` chỉ dựa vào cờ mới.
- Cờ bị tắt (và hàng đợi được lưu lại) **ngay sau** khi `submitFsrsReview` được gọi. Hàm đó ghi outbox đồng bộ trước `await` đầu tiên (write-ahead), nên lúc tắt cờ payload (kèm `exposure` + `idempotencyKey`) đã nằm trong outbox. Thẻ quay lại hàng đợi hoặc tải lại trang không còn mang cờ.
- Gửi lại do mất mạng dùng đúng payload cũ trong outbox → cùng `idempotencyKey`, cùng `exposure`; không ảnh hưởng cơ chế outbox/idempotency.
- Tương thích V113: hàng đợi đã lưu trong trình duyệt chỉ có `introduced` được chuẩn hoá khi khôi phục — nếu nhật ký phiên (`rvLog`) đã có lượt chính thức của từ đó thì không còn là lượt đầu, ngược lại vẫn là lượt đầu.

## 3. Lỗi 2 — `measured` / `measured_correct` đếm lượt không đo kỹ năng

**Điều kiện hợp lệ (đọc từ luồng ghi).** `lib/db.js` chỉ cộng điểm kỹ năng khi `skillReady` + `word_id` khác NULL + `exposure` khác `'intro'`; `skillReady` chỉ bật khi `skillRecord.skill` có giá trị. `recordPractice` bỏ qua `check`/`redo`.

**Lỗi.** V113 chỉ lọc `exposure` ở `review_history` → lượt `skill IS NULL` (vd. Flashcard tự chấm) vẫn vào "mẫu số".

**Sửa.** Một CTE `valid` duy nhất:
- `review_history`: `skill IS NOT NULL AND word_id IS NOT NULL AND exposure IS DISTINCT FROM 'intro'`
- `skill_practice_log`: `skill IS NOT NULL AND COALESCE(source,'practice') <> ALL(check,redo)`
- `measured = COUNT(valid)`, `measured_correct = COUNT(valid WHERE ok)` → tử và mẫu **cùng một tập**, không thể lệch điều kiện nữa.
- `official` và `practice` giữ nguyên (đếm mọi dòng trong ngày). Ranh giới ngày vẫn `Asia/Ho_Chi_Minh`. Không đụng lịch FSRS.

## 4. Lỗi 3 — DRY_RUN không thật sự "khô"

**Nguyên nhân.** `ensureSkillTables(client)` chạy trước `BEGIN` ở chế độ autocommit. Nó (cùng `ensureVocabTable`, `ensureFsrsTables`) chạy `CREATE TABLE/INDEX`, `ALTER ... ADD COLUMN`, `DROP/ADD CONSTRAINT word_skill_stats_skill_check`, và 2 bước nạp dữ liệu (`vocab_words` từ `app_store` cũ, `vocab_lessons` từ `vocab_words` khi trống). Do đó DRY_RUN vẫn thay đổi DB còn thông báo nói "không ghi gì".

**Kiểm tra khả năng hoàn tác.** Toàn bộ là DDL/DML thường của PostgreSQL, không có `CONCURRENTLY` → chạy được trong transaction.

**Sửa.** `BEGIN` → `SET LOCAL lock_timeout` → kiểm tra điều kiện → chụp cấu trúc → `ensureSkillTables` → chụp lại và in danh sách mục sẽ thêm → SQL V113 → `ROLLBACK` (DRY_RUN) hoặc `COMMIT`. Lỗi ở bất kỳ bước nào → `ROLLBACK` toàn bộ, mã thoát 1. Thông báo nay nói "không để lại thay đổi nào" kèm giới hạn thật (mục 7), không còn hứa "không ghi gì".
Script **từ chối chạy** (chưa đổi gì) nếu `vocab_words` chưa có/đang trống, vì nhánh nạp từ `app_store` có thể làm hỏng transaction. Không xoá/sửa `review_history`/`skill_practice_log`.

## 5. Kết quả kiểm thử THỰC TẾ (sandbox Node 22.22, không Postgres, không mạng)

**Chạy và PASS (số liệu sau khi sửa):** `v114-fixes` 20/20 · `v113-evidence` 28/28 · `adaptive-session` 32/32 · `adaptive-v111` 46/46 · `review-render.smoke` 15/15 · `v110-ui.smoke` 44/44 · `retention-recommend` 33/33 · `answer-match` 35/35 · `question-engine` 27/27 · `study-time` 39/39 · `drill-notes` 10/10 · `orphans` 9/9 · `heavy-distractor` 16/16 · `skills` 50/50 (khi `/tmp/orig` = bản V113 gốc như test yêu cầu; không có thì 49/50 — y hệt trước khi sửa) · `vocab-merge`, `visibility-timer`, `xss-escaping`, `auth-security` (kết thúc mã 0).
**`node --check`:** 85/85 tệp `.js` đạt.
**Test mới chống mã cũ:** chạy `v114-fixes` trên mã V113 gốc → 11/20 FAIL (gồm kịch bản 5 bước), xác nhận test bắt được lỗi.
**KHÔNG chạy được:** `fsrs.test`, `fsrs-optimizer.test`, `fsrs-optimizer.binding.smoke` (thiếu gói `ts-fsrs`, y hệt trước khi sửa); mọi `*.integration` (cần `DATABASE_URL`).
**Về FSRS:** không tệp nào của FSRS bị sửa, nhưng vì các test FSRS không chạy được ở đây nên "lịch FSRS không đổi" dựa trên việc không đụng mã, **không** phải trên test chạy.

**Hai test cũ phải đổi (không phải đổi cho qua):**
1. `v113-evidence`: kỳ vọng `exposure: item.introduced ? ...` chính là hành vi lỗi → đổi sang `rvIsIntroExposure(item)`. Đếm "≥4 lần có `<> ALL($3)`" → "≥3" vì hai truy vấn "today" gộp thành một CTE (`v114-fixes` kiểm riêng điều kiện trong CTE).
2. `adaptive-session`: harness trích hàm theo tên, nên thêm tên hàm mới vào danh sách.

**SQL — CHƯA được PostgreSQL thực thi.** Các câu chưa chạy thật: truy vấn `getTodayProgress` mới (CTE `valid`, `day_start`); mọi lệnh DDL/backfill trong `ensureSkillTables` và `V113_skill_evidence.sql` khi nằm trong transaction; `SET LOCAL lock_timeout`; hai truy vấn chụp cấu trúc (`information_schema`, `pg_indexes`). Test nhóm [2] và [3] chỉ kiểm **chuỗi SQL** và **thứ tự BEGIN/ROLLBACK qua `pg` giả**, cộng một mô hình JS của quy tắc — **không** phải bằng chứng SQL chạy được.

## 6. Tương thích V112
Không có mã V112 trong gói nên **không so sánh trực tiếp được**. Suy luận (chưa kiểm bằng chạy thật): không đổi schema, không đổi API/payload (`exposure` đã có từ V113), nên server V112/V113 chấp nhận như cũ; dữ liệu phiên đã lưu từ V113 được chuẩn hoá khi khôi phục.

## 7. Giới hạn còn lại
- `ROLLBACK` không hoàn tác giá trị sequence đã tiêu thụ và vẫn có ghi WAL/thống kê.
- `ALTER TABLE` giữ khoá mạnh đến khi transaction kết thúc; DRY_RUN trên DB đang có người dùng có thể làm họ chờ (có `lock_timeout` mặc định 10s, đổi bằng `LOCK_TIMEOUT_MS`). Hãy chạy trên Neon branch.
- Bộ nhớ đệm trong tiến trình (`skillTablesReady`…) nhớ "đã sẵn sàng" sau ROLLBACK — vô hại vì script thoát ngay.
- `getTrend` lọc `skill IS NOT NULL`, `getTypeBreakdown` lọc `exercise_type IS NOT NULL`; cả hai không lọc `word_id IS NOT NULL` như phía ghi và như `getTodayProgress` mới → có thể lệch rất nhỏ ở trường hợp hiếm (từ không còn trong `vocab_words`). Chưa sửa vì ngoài phạm vi yêu cầu.
- Điểm kỹ năng cũ vẫn chứa các lượt bị tính sai trước V114 (lượt sau intro bị bỏ qua nhầm → thiếu điểm; không có cách phân tách chắc chắn nên không tính lại, tránh sửa dữ liệu lịch sử). Dữ liệu `review_history.exposure` cũ có thể đã gắn `'intro'` cho lượt không phải lượt đầu; không tự sửa.
- Hàng đợi V113 lưu sẵn mà nhật ký phiên bị cắt (>400 mục) có thể bị chuẩn hoá sai 1 lần.
- Chưa chạy trên trình duyệt thật.

## 8. Hướng dẫn thử trên Neon staging (trước khi triển khai)
1. **Tạo branch Neon** từ database production (Neon → Branches → Create branch). Lấy chuỗi kết nối của branch; dùng nó cho mọi bước dưới, **không dùng production**.
2. **DRY_RUN:** `DATABASE_URL=<branch> DRY_RUN=1 npm run migrate:skill-evidence`. Phải thấy danh sách "sẽ THÊM …" (hoặc "đã đầy đủ") và dòng "đã ROLLBACK".
3. **Chạy lại DRY_RUN lần nữa.** Nếu danh sách "sẽ THÊM" vẫn y hệt lần 1 → ROLLBACK đã hoàn tác thật. Nếu lần 2 ít hơn → có gì đó đã ghi; dừng và báo lại.
4. **Chạy thật trên branch** (bỏ `DRY_RUN`). Chạy lần nữa: phải báo cấu trúc đã đầy đủ.
5. **Kiểm số liệu "Tỉ lệ trả lời đúng"** (Neon SQL Editor, thay `<USER>`):
```sql
SELECT
  COUNT(*) FILTER (WHERE skill IS NULL)                                   AS skill_null,
  COUNT(*) FILTER (WHERE exposure = 'intro')                              AS intro,
  COUNT(*) FILTER (WHERE skill IS NOT NULL AND word_id IS NOT NULL
                   AND exposure IS DISTINCT FROM 'intro')                 AS valid_history
FROM review_history
WHERE user_id = '<USER>'
  AND reviewed_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh';
```
   Cộng `valid_history` với số dòng hôm nay của `skill_practice_log` có `source` không phải `check`/`redo`, rồi so với `measuredAnswers` ở `GET /api/study/today`. Phải khớp.
6. **Kiểm kịch bản 5 bước** trên bản Vercel preview trỏ vào branch: học 1 từ mới → xem giới thiệu → trả lời câu kiểm tra → trả lời SAI thẻ chính thức → trả lời lại 1–2 lần. Rồi chạy:
```sql
SELECT reviewed_at, answer_correct, exposure FROM review_history
WHERE user_id = '<USER>' AND hz = '<từ vừa học>' ORDER BY reviewed_at;
```
   Chỉ **dòng đầu** có `exposure = 'intro'`, các dòng sau để trống.
7. **Thử tải lại trang** giữa lúc làm bước 6 và thử tắt mạng khi bấm đánh giá (kết quả phải vào lại khi có mạng, không trùng dòng).
8. **Production:** chỉ sau khi 1–7 đạt; làm giờ ít người dùng; tạo điểm khôi phục/branch backup trước.
