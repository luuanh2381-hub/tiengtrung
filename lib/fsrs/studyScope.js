// ════════════════════════════════════════════════════
// lib/fsrs/studyScope.js — V76 (Yêu cầu 1: reviewService là nguồn sự thật duy nhất)
//
// TRƯỚC ĐÂY: BOOKS_RANGES/resolveStudyScope/resolveCurrentLesson/buildLessonPriorityOrder/
// studySettings/formatVocabWord/formatFsrsCard nằm THẲNG trong api/index.js — nghĩa là quyết định
// "due card nào, new word nào, bài nào ưu tiên" nằm ở lớp API chứ không phải ở reviewService, dù
// 100% chạy phía server (không phải lỗi bảo mật) nhưng sai kiến trúc "1 nguồn sự thật duy nhất" mà
// yêu cầu V76 đòi hỏi. Chuyển toàn bộ sang đây, lib/fsrs/reviewService.js import module này —
// api/index.js chỉ còn gọi reviewService.getTodayOverview()/getStudySession(), không tự quyết định
// gì nữa (Phần "Client/API chỉ request dữ liệu, render, gửi kết quả").
// ════════════════════════════════════════════════════
const { getVocabCounts, getBookDefs } = require('../db');

// Giữ ĐỒNG BỘ THỦ CÔNG với mảng BOOKS trong js/ui.js — chỉ cần from/to để biết ranh giới Quyển/HSK.
// Nếu sửa BOOKS trong js/ui.js (thêm Quyển mới), nhớ sửa cả ở đây. V102: đây chỉ còn là phần
// Quyển/HSK CÓ SẴN của app (hardcoded) — Quyển admin TỰ THÊM qua web nằm ở bảng book_defs (xem
// lib/db.js), được GỘP thêm vào lúc chạy bởi getEffectiveBookRanges() bên dưới, không sửa mảng này.
const BOOKS_RANGES = [
  { id: 1, from: 1, to: 15 }, { id: 2, from: 16, to: 30 },
  { id: 12, from: 100, to: 109 }, { id: 13, from: 110, to: 119 },
  { id: 3, from: 31, to: 31 }, { id: 14, from: 90, to: 90 },
  { id: 15, from: 91, to: 91 }, { id: 16, from: 120, to: 120 },
  { id: 4, from: 32, to: 32 }, { id: 5, from: 33, to: 33 },
  { id: 6, from: 34, to: 34 }, { id: 7, from: 35, to: 35 },
  { id: 8, from: 36, to: 36 }, { id: 9, from: 37, to: 37 },
  { id: 10, from: 38, to: 38 }, { id: 11, from: 39, to: 39 },
];
function bookOfLessonServer(l) {
  const b = BOOKS_RANGES.find(x => l >= x.from && l <= x.to);
  return b ? b.id : 1;
}

// V102: BOOKS_RANGES (hardcoded, có sẵn) + book_defs (admin tự khai báo qua web, xem lib/db.js) GỘP
// LẠI thành 1 danh sách duy nhất để tính phạm vi học — id của book_defs được cộng thêm 3000 để
// không đụng namespace id 1-16 (hardcoded) hay 2000+ (bài tự nhận diện, xem
// mergeDiscoveredLessonsIntoBooks ở js/ui.js). Giữ đúng quy ước id đã có trong toàn bộ codebase.
async function getEffectiveBookRanges() {
  const defs = await getBookDefs();
  const custom = defs.map(d => ({ id: 3000 + d.id, from: d.lesson_from, to: d.lesson_to }));
  return [...BOOKS_RANGES, ...custom];
}
function bookOfLessonInRanges(l, ranges) {
  const b = ranges.find(x => l >= x.from && l <= x.to);
  return b ? b.id : 1;
}

// Xác định phạm vi bài (scope) đang học của user, dựa trên lựa chọn Quyển/bài đã có sẵn trong
// progress.ui (không tạo hệ thống current-lesson mới, tái dùng dữ liệu hiện có).
async function resolveStudyScope(ui) {
  const [vocabCounts, ranges] = await Promise.all([getVocabCounts(), getEffectiveBookRanges()]);
  const allLessonsWithVocab = Object.keys(vocabCounts).map(Number).filter(n => vocabCounts[n] > 0);
  const bookIds = (Array.isArray(ui.selectedBookIds) && ui.selectedBookIds.length) ? ui.selectedBookIds : [1];
  const lessonsAllMode = ui.lessonsAllMode !== false;
  let scopeLessons;
  if (lessonsAllMode) {
    scopeLessons = allLessonsWithVocab.filter(l => bookIds.includes(bookOfLessonInRanges(l, ranges)));
  } else {
    const sel = Array.isArray(ui.selectedLessons) ? ui.selectedLessons : [];
    scopeLessons = allLessonsWithVocab.filter(l => sel.includes(l));
  }
  return { scopeLessons, allLessonsWithVocab };
}

// "Current lesson": ưu tiên giá trị đã lưu (ui.currentLesson, tự cập nhật mỗi khi user học NEW
// word ở bài nào — xem reviewService.reviewCard), nếu không có/không còn hợp lệ thì lấy bài NHỎ
// NHẤT trong phạm vi đang chọn (học từ đầu chương trình, không nhảy vào bài cuối).
function resolveCurrentLesson(ui, scopeLessons) {
  if (Number.isFinite(ui.currentLesson) && scopeLessons.includes(ui.currentLesson)) return ui.currentLesson;
  if (scopeLessons.length) return Math.min(...scopeLessons);
  return 1;
}

// Thứ tự ưu tiên NEW word: current lesson → lùi dần trong PHẠM VI đang chọn. Chỉ khi phạm vi này
// không đủ mới lùi ra ngoài (mở rộng), ưu tiên bài GẦN current lesson nhất.
function buildLessonPriorityOrder(currentLesson, scopeLessons, allLessonsWithVocab) {
  const scopeSet = new Set(scopeLessons);
  const inScopeBefore = [...scopeSet].filter(l => l < currentLesson).sort((a, b) => a - b);
  const inScopeCurrent = [...scopeSet].filter(l => l === currentLesson);
  const inScopeAfter = [...scopeSet].filter(l => l > currentLesson).sort((a, b) => a - b);
  const inScopeOrder = [...inScopeBefore, ...inScopeCurrent, ...inScopeAfter];
  const outside = allLessonsWithVocab
    .filter(l => !scopeSet.has(l))
    .sort((a, b) => Math.abs(a - currentLesson) - Math.abs(b - currentLesson) || b - a);
  return { inScopeOrder, outside };
}

function studySettings(ui) {
  return {
    dailyReviewLimit: Number.isFinite(ui.dailyReviewLimit) ? ui.dailyReviewLimit : 50,
    dailyNewLimit: Number.isFinite(ui.dailyNewLimit) ? ui.dailyNewLimit : 10,
    newOnlyAfterDue: typeof ui.newOnlyAfterDue === 'boolean' ? ui.newOnlyAfterDue : true,
    // unlimitedStudy: V101 — CHỈ có nghĩa là không bị chặn lại vì "đã học đủ hôm nay" (bỏ qua phần
    // trừ theo reviewToday/newToday) — KHÔNG bỏ qua chính 2 số dailyReviewLimit/dailyNewLimit, vẫn
    // luôn là mức trần cho MỖI LƯỢT lấy phiên (xem getDailyBudget ở reviewService.js).
    unlimitedStudy: typeof ui.unlimitedStudy === 'boolean' ? ui.unlimitedStudy : false,
  };
}

// V103 (yêu cầu người dùng — hiện "từ này thuộc những bài nào" lúc đang học/ôn): `lessonsMap` là
// kết quả getLessonsByWordIds() (lib/db.js), tra theo row.resolved_word_id — tham số TUỲ CHỌN để
// các nơi gọi cũ (chưa truyền map) vẫn chạy được, chỉ là `lessons` khi đó chỉ có đúng 1 phần tử
// (row.l) như hành vi TRƯỚC ĐÂY, không vỡ hợp đồng cho ai chưa cập nhật.
function formatVocabWord(row, lessonsMap) {
  return {
    hz: row.hz, py: row.py, vi: row.vi, l: row.l, tag: row.tag, hanviet: row.hanviet,
    lessons: (lessonsMap && lessonsMap[row.resolved_word_id]) || [row.l],
  };
}
// version (Yêu cầu 3 — optimistic locking): đi kèm SELECT f.* tự động vì đã thêm cột `version` vào
// fsrs_cards (xem lib/db.js ensureFsrsTables) — trả về cho client để sẵn sàng cho đồng bộ đa thiết
// bị trong tương lai, dù luồng review hiện tại đã tự xử lý conflict ở server (không cần client gửi lại).
function formatFsrsCard(row, lessonsMap) {
  return {
    hz: row.hz, l: row.l, py: row.py, vi: row.vi, tag: row.tag, hanviet: row.hanviet,
    state: row.state, due: row.due, stability: row.stability, difficulty: row.difficulty,
    elapsed_days: row.elapsed_days, scheduled_days: row.scheduled_days,
    reps: row.reps, lapses: row.lapses, last_review: row.last_review,
    wrongCount: row.wrong_count != null ? row.wrong_count : row.lapses,
    version: row.version != null ? row.version : 0,
    lessons: (lessonsMap && lessonsMap[row.resolved_word_id]) || [row.l], // V103
  };
}

module.exports = {
  BOOKS_RANGES,
  bookOfLessonServer,
  getEffectiveBookRanges, // V102 (tự khai báo giáo trình trên web) — dùng ở api/index.js để validate trùng khoảng bài
  resolveStudyScope,
  resolveCurrentLesson,
  buildLessonPriorityOrder,
  studySettings,
  formatVocabWord,
  formatFsrsCard,
};
