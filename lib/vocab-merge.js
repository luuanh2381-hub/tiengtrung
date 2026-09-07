// ════════════════════════════════════════════════════
// lib/vocab-merge.js — V93 (audit "thống nhất từ vựng giữa các bài")
//
// TOÀN BỘ hàm trong file này là PURE FUNCTION (không query DB, không require('pg')/express/
// ts-fsrs) — nhận dữ liệu JS thuần (object/array), trả dữ liệu JS thuần. Tách riêng ra khỏi
// lib/db.js CÓ CHỦ Ý:
//   1) Đây là phần "quyết định" (chọn bản ghi nào sống, field nào thắng) — dễ viết sai nhất và
//      quan trọng nhất để "KHÔNG LÀM MẤT DỮ LIỆU" (yêu cầu tuyệt đối của audit này). Tách riêng
//      giúp viết unit test đầy đủ cho ĐÚNG phần logic dễ sai này mà không cần Postgres thật.
//   2) lib/db.js (nơi THỰC THI các quyết định này bằng SQL) tái sử dụng lại đúng các hàm ở đây,
//      đảm bảo migration 1 lần (scripts/migrate-vocab-identity.js) và luồng import/add-word hàng
//      ngày (api/index.js) dùng CHUNG một bộ quy tắc, không lệch nhau theo thời gian.
//
// Quy tắc merge field tổng quát (yêu cầu audit, Phần 5): "dữ liệu mới chỉ ghi đè khi có giá trị
// hợp lệ và đầy đủ hơn; dữ liệu rỗng/thiếu không được xóa dữ liệu cũ."
// ════════════════════════════════════════════════════
'use strict';

function s(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

// ── Merge 1 field "đơn giá trị" kiểu Pinyin: ưu tiên chuỗi ĐẦY ĐỦ HƠN (đo bằng độ dài sau khi
//     trim — heuristic đơn giản, nhất quán, không bao giờ dùng giá trị rỗng để xoá giá trị cũ hợp
//     lệ). Bằng độ dài → ưu tiên giá trị MỚI (coi là ý định cập nhật có chủ đích của admin). ──────
function mergeFuller(oldVal, newVal) {
  const o = s(oldVal), n = s(newVal);
  if (!n) return o;         // mới rỗng/thiếu -> giữ nguyên cũ
  if (!o) return n;         // cũ rỗng -> nhận giá trị mới
  return n.length >= o.length ? n : o;
}

// ── Merge field "nhãn phân loại" kiểu tag (vd 'ly_hop'): mới có giá trị thì dùng, mới rỗng thì
//     GIỮ NGUYÊN giá trị cũ (KHÔNG tự động xoá tag cũ chỉ vì form cập nhật không tick lại — đây là
//     1 fix so với hành vi cũ: trước đây overwrite=true sẽ SET tag = giá trị mới vô điều kiện, kể
//     cả khi rỗng, làm mất tag đã gắn trước đó). ──────────────────────────────────────────────────
function mergeSticky(oldVal, newVal) {
  const n = s(newVal);
  return n ? n : (oldVal || null);
}

// ── Tách 1 chuỗi nghĩa tiếng Việt thành từng "cụm nghĩa" theo dấu ; hoặc ； (giữ khoảng trắng nội
//     bộ của từng cụm, chỉ trim 2 đầu), bỏ cụm rỗng. ────────────────────────────────────────────
function splitMeaningParts(v) {
  return s(v).split(/[;；]/).map(x => x.trim()).filter(Boolean);
}

// ── Merge nghĩa tiếng Việt (Phần 5 — ví dụ mẫu: cũ "học", mới "học; học tập; học hỏi" -> chọn
//     "học; học tập; học hỏi"): hợp nhất theo TẬP HỢP cụm nghĩa, giữ thứ tự xuất hiện (cụm của
//     "oldVi" trước, cụm MỚI của "newVi" chưa từng có thì nối thêm sau), so khớp trùng không phân
//     biệt hoa/thường + khoảng trắng thừa. KHÔNG BAO GIỜ làm rơi mất 1 cụm nghĩa cũ hợp lệ — đúng
//     yêu cầu "hai meaning khác nhau nhưng đều có giá trị -> merge có kiểm soát thay vì mất 1 bên". ──
function mergeMeaning(oldVi, newVi) {
  const oldParts = splitMeaningParts(oldVi);
  const newParts = splitMeaningParts(newVi);
  if (newParts.length === 0) return s(oldVi);
  if (oldParts.length === 0) return newParts.join('; ');
  const seen = new Set();
  const merged = [];
  for (const p of [...oldParts, ...newParts]) {
    const key = p.toLowerCase();
    if (!seen.has(key)) { seen.add(key); merged.push(p); }
  }
  return merged.join('; ');
}

// ── Merge 1 bản ghi vocabulary hiện có ("existing", đã có sẵn trong DB, khớp theo hz) với dữ liệu
//     mới nhập/import ("incoming", CÙNG hz) — dùng cho CẢ 2 nơi:
//       a) Add word thủ công / Import Excel (api/index.js -> lib/db.js:bulkUpsertVocab) — có khái
//          niệm "overwrite" do admin bật/tắt (Phần 9 audit).
//       b) Migration dọn duplicate cũ (scripts/migrate-vocab-identity.js) — GỌI VỚI overwrite=true
//          vì migration PHẢI gộp hết thông tin từ mọi bản ghi trùng, không được bỏ sót cái nào
//          (không có khái niệm "giữ nguyên, bỏ qua record kia" khi dọn dữ liệu cũ).
//     hz/id/l KHÔNG do hàm này quyết định (identity + lesson relationship xử lý riêng ở lib/db.js/
//     migration script) — hàm này CHỈ quyết định các field metadata: py/vi/tag/hanviet.
// overwrite=false: giữ NGUYÊN 100% metadata cũ (đúng Phần 9: "existing vocabulary + new lesson
//   relationship + giữ metadata cũ") — vẫn trả về object mới (không mutate existing) để caller rõ
//   ràng biết đây là kết quả đã "quyết định", không phải tham chiếu ngầm.
// overwrite=true: áp field-merge KHÔNG BAO GIỜ xoá dữ liệu hợp lệ bằng rỗng (Phần 5).
function mergeVocabRecords(existing, incoming, overwrite) {
  if (!overwrite) {
    return {
      hz: existing.hz, py: existing.py, vi: existing.vi,
      tag: existing.tag != null ? existing.tag : null,
      hanviet: existing.hanviet != null ? existing.hanviet : null,
      changed: false,
    };
  }
  const py = mergeFuller(existing.py, incoming.py);
  const vi = mergeMeaning(existing.vi, incoming.vi) || s(existing.vi) || s(incoming.vi);
  const tag = mergeSticky(existing.tag, incoming.tag);
  // hanviet: âm Hán Việt gắn với ĐÚNG mặt chữ (hz) — hz không đổi trong luồng import/add-word (đó
  // chính là điều kiện để match "existing"), nên hanviet cũ vẫn đúng, GIỮ NGUYÊN (Phần 5: "HSK/
  // Hán Việt không được ghi đè bằng giá trị rỗng" — ở đây incoming thường không mang hanviet, vì
  // hanviet do 1 job AI riêng sinh sau, không phải field admin tự nhập lúc import).
  const hanviet = existing.hanviet != null ? existing.hanviet : null;
  const changed = py !== s(existing.py) || vi !== s(existing.vi) || tag !== (existing.tag || null);
  return { hz: existing.hz, py, vi, tag, hanviet, changed };
}

// ── Chọn bản ghi CANONICAL trong 1 nhóm vocab_words trùng hz (Phần 3/4: "Ưu tiên word_id làm
//     identity" + "GIỮ canonical ID nếu có thể") — quy tắc: id NHỎ NHẤT (bản ghi được tạo sớm
//     nhất) luôn thắng, để ID ổn định qua thời gian/qua nhiều lần chạy migration (idempotent —
//     Phần 4.14: "Migration phải idempotent: chạy lại không làm hỏng dữ liệu"; chạy lại lần 2 với
//     input chỉ còn 1 dòng/hz vẫn cho ra đúng canonical cũ, không đổi). ─────────────────────────
function pickCanonical(rows) {
  if (!rows || rows.length === 0) return { canonical: null, losers: [] };
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  return { canonical: sorted[0], losers: sorted.slice(1) };
}

// ── Gộp TOÀN BỘ metadata của 1 nhóm vocab_words trùng hz (dùng cho migration dọn dữ liệu cũ) —
//     lần lượt coi từng bản ghi (theo thứ tự id tăng dần, TRỪ canonical) là "incoming" merge dần
//     vào canonical (overwrite=true mỗi bước, vì migration phải gộp hết, không bỏ sót) — tái dùng
//     ĐÚNG mergeVocabRecords ở trên, không viết lại logic 2 lần. ─────────────────────────────────
function mergeManyVocabRecords(rows) {
  const { canonical, losers } = pickCanonical(rows);
  if (!canonical) return null;
  let acc = { hz: canonical.hz, py: canonical.py, vi: canonical.vi, tag: canonical.tag, hanviet: canonical.hanviet };
  for (const loser of losers) {
    const merged = mergeVocabRecords(acc, loser, true);
    acc = { hz: acc.hz, py: merged.py, vi: merged.vi, tag: merged.tag, hanviet: merged.hanviet };
  }
  // Danh sách đầy đủ mọi số bài (lesson) xuất hiện trong nhóm — kể cả bài của chính canonical —
  // dùng để nạp vào vocab_lessons (Phần 6: "Merge lesson assignments của các duplicate vào canonical").
  const lessons = [...new Set(rows.map(r => r.l).filter(l => Number.isFinite(l)))].sort((a, b) => a - b);
  return { canonicalId: canonical.id, merged: acc, lessons, loserIds: losers.map(x => x.id) };
}

// ── Chọn 1 fsrs_cards "sống sót" khi 1 user có NHIỀU thẻ trùng cho CÙNG 1 hz (do bug cũ trước
//     migration: mỗi lesson tạo 1 thẻ riêng) — Phần 4.9: "phải có chiến lược merge deterministic,
//     không được tùy tiện reset". Quy tắc ưu tiên (từ "tiến bộ thật" nhiều nhất -> ít nhất):
//       1) reps CAO HƠN thắng (đã ôn tập nhiều hơn = tiến độ thật nhiều hơn).
//       2) Bằng reps -> last_review GẦN ĐÂY HƠN thắng (thẻ đang "sống"/được ôn gần nhất).
//       3) Vẫn bằng -> id NHỎ NHẤT thắng (cũ nhất, ổn định, idempotent).
//     Card thua KHÔNG bị mất review_history (migration script backfill word_id cho review_history
//     của cả card thắng lẫn card thua trỏ về CÙNG 1 canonical word — chỉ xoá dòng fsrs_cards của
//     card thua, vì đó là bản ghi "trạng thái hiện tại", không phải lịch sử). ─────────────────────
function pickSurvivingFsrsCard(cards) {
  if (!cards || cards.length === 0) return { winner: null, losers: [] };
  const sorted = [...cards].sort((a, b) => {
    const repsA = Number(a.reps) || 0, repsB = Number(b.reps) || 0;
    if (repsB !== repsA) return repsB - repsA;
    const lastA = a.last_review ? new Date(a.last_review).getTime() : -Infinity;
    const lastB = b.last_review ? new Date(b.last_review).getTime() : -Infinity;
    if (lastB !== lastA) return lastB - lastA;
    return a.id - b.id;
  });
  return { winner: sorted[0], losers: sorted.slice(1) };
}

// ── Gom mảng object theo 1 field (thường dùng gom vocab_words/fsrs_cards theo "hz"). ────────────
function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

module.exports = {
  mergeFuller, mergeSticky, splitMeaningParts, mergeMeaning,
  mergeVocabRecords, pickCanonical, mergeManyVocabRecords,
  pickSurvivingFsrsCard, groupBy,
};
