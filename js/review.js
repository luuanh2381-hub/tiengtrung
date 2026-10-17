// js/review.js — Tab "Hôm nay học" → phiên ôn tập thật, khôi phục nút Again/Hard/Good/Easy có
// highlight "System Rating" (bổ sung — revert lại phần UI thủ công của V66, ĐÈ LÊN kiến trúc V67).
// ════════════════════════════════════════════════════
// REVIEW SESSION — bổ sung "Highlight System Rating" (revert V67's auto-only flow):
// Flow (Phần 1/17 cũ + yêu cầu bổ sung): hiện chữ Hán → user chọn 1 trong 4 đáp án trắc nghiệm →
// hệ thống tự xác định đúng/sai + đo responseTime → gọi /api/study/review/preview (CHỈ ĐỌC, không
// ghi) để lấy "System Rating" mà server sẽ tự suy ra → hiện 4 nút Again/Hard/Good/Easy, HIGHLIGHT
// rõ ràng (bold + glow + border, class riêng `.system-rating`) đúng nút hệ thống đề xuất, kèm
// countdown vài giây → user có thể bấm ĐỔI sang nút khác bất kỳ lúc nào trong lúc chờ (User Rating
// luôn thắng System Rating) hoặc để hết giờ (dùng luôn System Rating) → gửi rating CUỐI CÙNG lên
// /api/study/review (server vẫn tự xác định lại đúng/sai — KHÔNG tin answerCorrect từ client; chỉ
// riêng RATING gửi vào FSRS mới có thể bị override bởi lựa chọn của user) → lộ đáp án đầy đủ
// (pinyin/nghĩa/Hán Việt/chiết tự/ví dụ) → tự chuyển câu kế.
//
// V78 (Vấn đề 7 — "Session phải là nguồn dữ liệu duy nhất"): TRƯỚC ĐÂY Review giữ 1 bộ biến RỜI
// RẠC (rvSession/rvSessionId/rvTotalPlanned/rvAnsweredCount/rvStartTime/rvEndTime/
// rvCompletedCards/rvLessonFilter) tách biệt hoàn toàn khỏi object sq* mà Flashcard/Trắc nghiệm/Gõ
// chữ/Nghe-chọn đang dùng — 2 nơi định nghĩa "1 Study Session" khác nhau, dễ lệch theo thời gian.
// Giờ Review dùng CHUNG đúng 1 object `rvQueue` tạo bằng sqCreate() (y hệt fcQueue/qzQueue/
// tyQueue/lsQueue), và dùng CHUNG các hàm quản lý phiên ở study-queue.js (sqPersist/
// sqReadPersisted/sqClearPersisted/sqStartNewSession/sqRelearnFromStart/sqSnapshotLessonFilter/
// ssArchiveSession...) — chỉ khác 1 điểm domain thật sự (không phải "state riêng" tuỳ tiện): item
// của rvQueue có dạng {type, word} (để phân biệt "Từ mới"/"Ôn tập") thay vì thẳng là word, và nguồn
// nạp là /api/study/session (trộn due+new) hoặc /api/study/weak-words — nên có rvFetchFreshSession()
// + rvAdvanceQueue() riêng thay vì sqLoad()/sqAdvance() dùng thẳng (2 hàm đó giả định item = word).
// currentIndex trong yêu cầu chính là rvQueue.items[0] (hàng đợi FIFO, "vị trí hiện tại" luôn là
// đầu hàng đợi — cùng mô hình với 4 tab kia, không có index rời).
// ════════════════════════════════════════════════════
let rvQueue = sqCreate(); // StudySessionManager dùng chung: {items,doneHz,totalPlanned,answeredCount,sessionId,startTime,endTime,completedCards,lessonFilter,dayKey}
let rvPhase = 'question'; // 'question' (đang chờ chọn đáp án) | 'answered' (đã có kết quả)
let rvWeakMode = false;
let rvSummary = { reviewCount: 0, newCount: 0 };
let rvExamplePool = [];
let rvSubmitting = false;
let rvOptions = [];      // 4 lựa chọn trắc nghiệm của câu hiện tại (sinh 1 lần/câu, không sinh lại mỗi lần render)
let rvStartedAt = 0;     // performance.now() tại thời điểm câu hỏi THỰC SỰ hiển thị cho user (Phần 4)
let rvAnswerChanges = 0; // UI hiện tại chọn là chốt ngay (không cho đổi trước khi submit) nên luôn 0 (Phần 16/17)
let rvLastAnswer = null; // { correct, card, autoRating } — kết quả lượt vừa submit, để hiện feedback (Phần 18)
let rvBlockedByBacklog = false; // server chặn từ mới vì còn backlog due (có thể ở Quyển/bài KHÁC phạm vi đang chọn) và cài đặt "Chỉ học từ mới sau khi hết backlog" đang bật
let rvTotalDue = 0; // tổng số thẻ due TOÀN TÀI KHOẢN (không riêng phạm vi đang chọn) — dùng để giải thích lý do bị chặn ở trên
const RV_QUIZ_TYPE = 'hz2vi'; // (giữ tên cũ cho tương thích)

// ── V106 — HỆ THỐNG TRẮC NGHIỆM THÍCH ỨNG cho "Hôm nay học" ──────────────────────────────────────
// Tách 3 lớp: (1) js/question-engine.js dựng câu hỏi hợp lệ (không DOM); (2) js/question-selector.js chọn
// DẠNG bài theo kỹ năng yếu/thiếu dữ liệu + chống lặp; (3) file này chỉ lo giao diện + luồng buổi học.
// FSRS: từ nào được học, thứ tự, số lượng, lịch ôn VẪN do server/FSRS quyết định. Mỗi thẻ FSRS chỉ được ôn
// chính thức ĐÚNG 1 lần mỗi lượt (đi đường /api/study/review như cũ); mọi câu hỏi phụ (kiểm tra ngay sau khi
// xem từ mới, từ hay sai, ghép cặp, luyện lại) là LUYỆN BỔ SUNG — chỉ ghi hồ sơ kỹ năng qua
// submitSkillPractice, KHÔNG đổi lịch ôn.
//
// Loại phần tử trong hàng đợi (item.type):
//   'review' / 'new' : thẻ FSRS chính thức (từ server). 'new' CHƯA học → hiện màn GIỚI THIỆU TỪ (xem chữ,
//                      pinyin, nghĩa, nghe, ví dụ) rồi 1 câu 'check' dễ (hz→nghĩa, KHÔNG tính FSRS); sau
//                      RV_NEW_GAP thẻ khác mới đến lượt ôn FSRS chính thức của từ đó (lúc này là nhớ lại
//                      sau khoảng nghỉ, không bị "thổi phồng" bởi vừa xem đáp án xong).
//   'check'          : câu kiểm tra ngay sau khi xem từ mới (luyện bổ sung).
//   'extra'          : từ người học hay trả lời sai (từ hồ sơ kỹ năng) — luyện bổ sung, ≤ 25% buổi, ≤ RV_EXTRA_MAX.
//   'redo'           : luyện lại câu sai (đổi DẠNG so với lần sai) — luyện bổ sung.
//   'match'          : 1 bài ghép cặp từ chính các từ của buổi — luyện bổ sung.
//   'drill'          : (cũ, V105) tương đương 'extra' dạng nghĩa→chữ Hán; chỉ còn để đọc phiên đã lưu.
let rvQuestion = null;          // câu hỏi hiện tại (QE) — sinh 1 lần/câu, không sinh lại mỗi lần render
let rvQSession = QS.newSession(); // lịch sử câu đã hỏi trong buổi (chống lặp, cân bằng vị trí đáp án)
let rvLog = [];                 // nhật ký câu trả lời của buổi → màn Tổng kết
let rvStage = 'run';            // 'start' (màn bắt đầu) | 'run'
let rvStartInfo = null;         // số liệu THẬT của màn bắt đầu
let rvMatch = null;             // trạng thái bài ghép cặp đang chơi
const RV_NEW_GAP = 3;           // thẻ FSRS chính thức của từ mới đến sau ≥ 3 thẻ khác
const RV_DRILL_GAP = 3;         // khoảng cách khi đưa câu luyện sai quay lại
const RV_DRILL_MAX_TRIES = 2;   // tối đa 2 lần hỏi 1 từ ở chế độ luyện lại (không bắt người học lặp vô hạn)
const RV_EXTRA_MAX = 6;
const RV_PRACTICE_TYPES = ['drill', 'extra', 'check', 'redo'];
function rvIsPractice(it) { return !!it && RV_PRACTICE_TYPES.includes(it.type); }
function rvIsOfficial(it) { return !!it && (it.type === 'review' || it.type === 'new'); }
// V114: TÁCH 2 trạng thái trước đây dồn chung vào cờ `introduced`:
//   • introduced            = "từ này ĐÃ qua màn giới thiệu" (chỉ để không hiện lại màn giới thiệu). Tồn tại suốt phiên, kể cả khi thẻ bị sai và quay lại hàng đợi.
//   • introExposurePending  = "lượt FSRS chính thức ĐẦU TIÊN sau giới thiệu CHƯA được gửi" (người học vừa xem đáp án ở màn giới thiệu/câu kiểm tra
//     → lượt đó mang exposure:'intro', không cộng điểm kỹ năng). Chỉ đặt khi tạo thẻ chính thức sau câu kiểm tra; TẮT ngay khi lượt đó được gửi đi
//     (ghi outbox write-ahead xong) nên thẻ quay lại hàng đợi/tải lại trang/gửi lại do mất mạng không bao giờ mang lại cờ này lần nữa.
function rvIsIntroExposure(it) { return !!it && it.type === 'new' && it.introExposurePending === true; }
// Tương thích V113: hàng đợi đã lưu trong localStorage từ bản V113 chỉ có `introduced` (chưa có introExposurePending). Với thẻ chính thức
// kiểu đó, dùng nhật ký phiên (rvLog) để phân biệt: đã có lượt chính thức của từ này trong phiên → KHÔNG còn là lượt đầu; chưa có → vẫn là lượt đầu.
function rvNormalizeIntroFlags(items, log) {
  const answered = new Set((Array.isArray(log) ? log : []).filter(e => e && e.official).map(e => e.hz));
  for (const it of (Array.isArray(items) ? items : [])) {
    if (it && it.type === 'new' && it.introduced === true && it.introExposurePending === undefined && it.word) {
      it.introExposurePending = !answered.has(it.word.hz);
    }
  }
  return items;
}

function rvQCtx() {
  return {
    pool: WORDS.filter(x => isLoggedIn() || x.l <= GUEST_MAX_LESSON),
    examples: rvExamplePool,
    sentences: (typeof SENTENCES !== 'undefined') ? SENTENCES : [],
    confuseGroups: (typeof CONFUSE_GROUPS !== 'undefined') ? CONFUSE_GROUPS : [],
    audioOk: (typeof skillAudioAvailable === 'function') && skillAudioAvailable(),
    heavy: (typeof pickHeavyDistractors === 'function') ? pickHeavyDistractors : null,
  };
}
// V110 — cài đặt "Cho phép câu tự gõ đáp án" (mặc định BẬT; tắt nếu gõ trên điện thoại bất tiện). Lưu cục bộ theo thiết bị.
function rvTypedEnabled() { try { return localStorage.getItem('rvAllowTyped') !== '0'; } catch { return true; } }
function rvSetTypedEnabled(on) { try { localStorage.setItem('rvAllowTyped', on ? '1' : '0'); } catch {} if (typeof render === 'function') render(); }
// Nguồn kết quả của bài luyện bổ sung (lưu ở server để tách "ngay sau xem đáp án" khỏi "nhớ sau khoảng nghỉ").
function rvPracticeSource(item) {
  if (!item) return 'practice';
  if (item.type === 'check') return 'check';
  if (item.type === 'redo') return 'redo';
  if (item.type === 'match') return 'match';
  return 'extra'; // extra / drill
}
function rvSkillTypes(skill) { return QE.MCQ_ORDER.filter(t => QE.TYPES[t].skill === skill); }
function rvBuildQuestionFor(item) {
  // V111: từ hay nhầm (server) → QE chèn đáp án từng nhầm làm đáp án nhiễu; `remaining` = số thẻ chính thức còn lại → bộ chọn
  // bớt dạng chậm khi hàng đợi còn dài.
  const w = item.word, ctx = Object.assign(rvQCtx(), { confusions: item.confusions });
  const base = { session: rvQSession, profile: item.skillProfile, allowTyped: rvTypedEnabled(), remaining: rvQueue.items.filter(rvIsOfficial).length };
  if (item.type === 'check') return QS.choose(w, ctx, Object.assign({}, base, { only: ['hz2vi'] }));
  if (item.type === 'drill') return QS.choose(w, ctx, Object.assign({}, base, { only: ['vi2hz'] }));
  if (item.type === 'extra' || item.type === 'redo') {
    const opts = Object.assign({}, base, { allowPracticeOnly: true, exclude: item.failedTypes || [] });
    const only = item.targetSkill ? rvSkillTypes(item.targetSkill) : [];
    // Ưu tiên đúng kỹ năng đang yếu; nếu kỹ năng đó không dựng được câu hợp lệ thì thử bất kỳ dạng nào khác.
    return (only.length && QS.choose(w, ctx, Object.assign({}, opts, { only }))) || QS.choose(w, ctx, opts)
      || QS.choose(w, ctx, Object.assign({}, base, { allowPracticeOnly: true }));
  }
  return QS.choose(w, ctx, Object.assign({}, base, { fsrsOnly: true })); // thẻ FSRS chính thức: chỉ dạng server tự chấm được
}
function rvStageLabel(item) {
  if (!item) return '';
  if (item.type === 'review') return '🔁 Ôn nhanh';
  if (item.type === 'new' || item.type === 'check') return '🆕 Học từ mới';
  return '🎯 Luyện thích ứng';
}
function rvRecordAnswer(item, q, correct, ms, official) {
  // V111: cập nhật hồ sơ kỹ năng NGAY (cùng công thức server) để câu kế tiếp — kể cả khi từ này quay lại hàng đợi — thấy kết quả
  // vừa rồi: sai thì kỹ năng đó yếu đi, đúng thì tiến lên; đúng nhưng chậm thì đánh dấu "chưa chắc". PHẢI gọi trước QS.record
  // (để câu hiện tại chưa tính vào chuẩn nhịp). Chỉ là ước lượng cục bộ cho phiên này; server ghi & tính lại độc lập.
  // V113: câu check/redo (vừa xem đáp án) và lượt đầu sau màn giới thiệu KHÔNG cập nhật hồ sơ cục bộ — server cũng không tính chúng.
  // V114: "lượt đầu sau giới thiệu" = introExposurePending (KHÔNG còn là introduced) — các lượt sau của từ đó cập nhật bình thường.
  if (item && !(item.type === 'check' || item.type === 'redo' || rvIsIntroExposure(item))) {
    const updated = QS.learn(item.skillProfile, rvQSession, q, correct, ms);
    item.skillProfile = updated;
    for (const other of rvQueue.items) if (other !== item && other.word && other.word.hz === q.hz) other.skillProfile = updated;
  }
  QS.record(rvQSession, q, correct, ms);
  rvLog.push({ hz: q.hz, l: q.l, typeId: q.typeId, skill: q.skill, correct: !!correct, ms: ms == null ? null : Math.round(ms), official: !!official, source: item.type });
  if (rvLog.length > 400) rvLog.shift();
}
function rvRestoreQSession() {
  rvQSession = QS.newSession();
  for (const e of rvLog) {
    // V111: dùng chính QS.record để cả nhịp trả lời (rt) được khôi phục sau khi tải lại trang.
    QS.record(rvQSession, { hz: e.hz, typeId: e.typeId, skill: e.skill, typed: !!(QE.TYPES[e.typeId] && QE.TYPES[e.typeId].typed), correctIndex: null }, !!e.correct, e.ms);
  }
  rvQSession.recentCorrectPositions = []; // vị trí đáp án đúng của buổi trước không còn ý nghĩa
}
// Thời gian đọc phản hồi trước khi tự chọn rating: câu có giải thích dài (điền từ vào câu) cần lâu hơn.
function rvAutoMs() { return (rvQuestion && (rvQuestion.typeId === 'cloze' || rvQuestion.typed)) ? 6000 : RV_AUTO_COMMIT_MS; } // V110: câu tự nhập cũng cần thời gian đọc phản hồi

// ── Bổ sung "Highlight System Rating" (revert V67's auto-only flow) ─────────────────────────────
let rvRatingPhase = null;   // null (chưa tới lúc) | 'loading' (đang hỏi server gợi ý) | 'pending'
                             // (đang hiện 4 nút + đếm ngược, chờ user) | 'committing' (đã chốt rating,
                             // đang gửi lên FSRS) | 'done' (đã lưu xong)
let rvSystemRating = null;  // 'again'|'hard'|'good'|'easy' — gợi ý CỦA HỆ THỐNG cho câu hiện tại
let rvUserRating = null;    // rating do CHÍNH USER bấm tay — null nếu để countdown tự chọn hộ
let rvFinalRating = null;   // rating THỰC SỰ đã/sẽ gửi lên FSRS: userRating nếu có, không thì systemRating
let rvPendingReview = null; // { selectedAnswer, responseTimeMs, answerChanges } cố định từ lúc chọn đáp án trắc nghiệm
let rvCountdownEndAt = 0;   // Date.now() timestamp lúc countdown kết thúc (tự chọn System Rating)
let rvCountdownTimer = null;
const RV_AUTO_COMMIT_MS = 2000; // "Tự động chọn sau 2s" — khớp ví dụ trong yêu cầu bổ sung
const RV_RATING_ORDER = ['again', 'hard', 'good', 'easy'];
const RV_RATING_META = {
  again: { label: 'Again', cls: 'rv-rate-again' },
  hard:  { label: 'Hard',  cls: 'rv-rate-hard'  },
  good:  { label: 'Good',  cls: 'rv-rate-good'  },
  easy:  { label: 'Easy',  cls: 'rv-rate-easy'  },
};

function rvStorageMode() { return 'review' + (rvWeakMode ? '-weak' : ''); }
// Tất cả việc lưu/khôi phục phiên giờ đi thẳng qua sqPersist/sqReadPersisted (study-queue.js) trên
// đúng object rvQueue — không còn hàm rvPersist() tự lắp tay từng field như trước.

// V71: khử trùng lặp {type,word} theo word.hz — cùng lý do với sqDedupeByHz (1 chữ Hán có thể gắn
// với 2 "thẻ" khác nhau ở 2 bài khác nhau phía server). V74: lọc thêm sessionKnownHz (study-queue.js)
// để không nạp lại từ vừa trả lời ĐÚNG ở tab Flashcard/Trắc nghiệm/Gõ chữ/Nghe-chọn hoặc phiên khác
// trong CÙNG NGÀY (Study Day — V77).
function rvDedupeSession(list) {
  const seen = new Set();
  return list.filter(it => {
    if (seen.has(it.word.hz) || sessionKnownHz.has(it.word.hz)) return false;
    seen.add(it.word.hz);
    return true;
  });
}
// V77 (dùng riêng cho "Học lại từ đầu" — Yêu cầu 8): khử trùng lặp theo hz CHỈ trong nội bộ danh
// sách vừa tải, KHÔNG lọc sessionKnownHz — vì "Học lại từ đầu" CỐ Ý cho phép ôn lại từ đã hoàn
// thành hôm nay.
function rvDedupeByHzOnly(list) {
  const seen = new Set();
  return list.filter(it => { if (seen.has(it.word.hz)) return false; seen.add(it.word.hz); return true; });
}

// V77/V78: gọi API lấy 1 bộ từ MỚI (due/new thật từ server, hoặc weak-words) — dùng chung cho cả
// nhánh "tải phiên mới" của startStudySession() lẫn rvRelearnFromStart(), tránh 2 nơi tự viết lại
// cùng 1 logic rồi lệch nhau theo thời gian.
async function rvFetchFreshSession(ignoreDayDedupe) {
  try {
    if (rvWeakMode) {
      const res = await fetch('/api/study/weak-words', { headers: authHeaders() });
      const data = await res.json();
      if (!data.ok) return { error: data.error || 'Không tải được từ hay quên' };
      const list = data.words.map(w => ({ type: 'review', word: w }));
      return { list: ignoreDayDedupe ? rvDedupeByHzOnly(list) : rvDedupeSession(list), reviewCount: list.length, newCount: 0, blockedByBacklog: false, totalDue: 0 };
    }
    // FIX (Vấn đề 5 — "Chọn bài học không hoạt động"): đảm bảo server đã thấy đúng Quyển/bài MỚI
    // NHẤT (không dính debounce 700ms của scheduleSync) trước khi truy vấn.
    await flushProgressSync();
    const res = await fetch('/api/study/session', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) return { error: data.error || 'Không tải được phiên học' };
    const raw = data.session || [];
    return {
      list: ignoreDayDedupe ? rvDedupeByHzOnly(raw) : rvDedupeSession(raw),
      reviewCount: data.reviewCount || 0, newCount: data.newCount || 0,
      blockedByBacklog: !!data.blockedByBacklog, totalDue: data.totalDue || 0,
      scopeLessons: Array.isArray(data.scopeLessons) ? data.scopeLessons : [],
    };
  } catch (e) {
    return { error: e.message };
  }
}

// forceNew: false/undefined = hành vi "Học tiếp" (mặc định) — nếu còn 1 Study Session hợp lệ dang
// dở (cùng weakMode, đúng ngày hôm nay, đúng Quyển/bài đang chọn — xem sqReadPersisted/
// sqLessonFilterMatches), TIẾP TỤC đúng phiên đó (khôi phục đủ queue/currentIndex(=items[0])/
// lessonFilter/completedCards/answeredCards/seenCards — Vấn đề 3); không có thì tự nạp phiên mới.
// true = hành vi "Học mới" (Vấn đề 4) — CHỦ ĐỘNG đóng/ghi nhật ký phiên dang dở (nếu có) rồi mở
// phiên hoàn toàn MỚI, không lấy lại card đã hoàn thành/vừa học/chưa đến hạn FSRS (Vấn đề 4), tự
// tiếp tục đúng từ CHƯA học kế tiếp (không quay lại đầu danh sách).
// V110 — chế độ học THU HẸP: 'due' = chỉ thẻ đến hạn theo lịch FSRS, 'new' = chỉ từ mới. Đây chỉ là BỘ LỌC trên đúng
// danh sách do server/FSRS trả về (cùng ngân sách ngày, cùng thứ tự); không tạo nguồn dữ liệu riêng, không đổi lịch ôn.
// Chỉ áp dụng cho phiên MỚI; phiên đang dở được khôi phục nguyên trạng. Dùng 1 lần rồi tự xoá để "Học tiếp" quay lại bình thường.
let rvOnlyType = null;
function startStudyMode(kind) {
  rvOnlyType = (kind === 'due' || kind === 'new') ? kind : null;
  ssEnterMode('review');
}
async function startStudySession(weakMode, forceNew) {
  const onlyType = rvOnlyType; rvOnlyType = null;
  rvWeakMode = !!weakMode;
  const savedKey = rvStorageMode();
  if (!forceNew) {
    // FIX (Vấn đề 3 — "Học tiếp" phải khôi phục ĐỦ queue/currentIndex/lessonFilter/completedCards/
    // answeredCards/seenCards): đọc thẳng qua sqReadPersisted() dùng chung với 4 tab kia, rồi gán
    // trực tiếp vào rvQueue (thay vì trước đây copy tay từng field vào các biến rời rvSession/...).
    const saved = sqReadPersisted(savedKey);
    if (saved && saved.items.length && sqLessonFilterMatches(saved.lessonFilter)) {
      const filteredItems = saved.items.filter(it => (it.type !== 'review' && it.type !== 'new') || !sessionKnownHz.has(it.word.hz)); // V106: chỉ lọc thẻ FSRS đã biết; giữ câu luyện bổ sung
      const purged = saved.items.length - filteredItems.length;
      if (filteredItems.length) {
        rvQueue.items = filteredItems;
        rvQueue.sessionId = saved.sessionId;
        rvQueue.totalPlanned = saved.totalPlanned;
        rvQueue.answeredCount = saved.answeredCount + purged;
        rvQueue.startTime = saved.startTime || Date.now();
        rvQueue.endTime = null;
        rvQueue.completedCards = Array.isArray(saved.completedCards) ? saved.completedCards : [];
        rvQueue.lessonFilter = saved.lessonFilter || sqSnapshotLessonFilter();
        rvQueue.dayKey = saved.dayKey || todayKey();
        rvSummary = (saved.extra && saved.extra.summary) || rvSummary;
        rvLog = (saved.extra && Array.isArray(saved.extra.log)) ? saved.extra.log : []; rvRestoreQSession();
        rvNormalizeIntroFlags(rvQueue.items, rvLog); // V114: hàng đợi lưu từ V113 chưa có cờ introExposurePending
        rvStage = 'run'; rvStartInfo = null; rvMatch = null;
        rvBlockedByBacklog = false; rvTotalDue = 0; // phiên đang khôi phục chắc chắn có thẻ thật, không liên quan lý do "bị chặn"
        rvExamplePool = []; rvLastAnswer = null;
        goTab('review');
        rvPrepareCurrentCard();
        render();
        return;
      }
    }
  } else {
    // V77 (Vấn đề 4 — "Học mới"): đóng phiên đang dở vào nhật ký ngày trước khi thay bằng phiên mới.
    ssArchiveSession(savedKey, rvQueue);
    sqClearPersisted(savedKey);
  }
  rvExamplePool = []; rvLastAnswer = null;
  rvQueue = sqCreate();
  rvLog = []; rvQSession = QS.newSession(); rvMatch = null; rvStage = 'run'; rvStartInfo = null; // V106: buổi mới
  rvQueue.sessionId = genIdempotencyKey();
  rvQueue.startTime = Date.now();
  rvQueue.lessonFilter = sqSnapshotLessonFilter();
  rvQueue.dayKey = todayKey();
  goTab('review');
  const el = document.getElementById('content');
  if (el) el.innerHTML = `<div class="study-empty">Đang tải phiên học...</div>`;
  const fetched = await rvFetchFreshSession(false);
  const { error, blockedByBacklog, totalDue, scopeLessons } = fetched;
  let { list, reviewCount, newCount } = fetched;
  if (error) { alert(error); goTab('today'); return; }
  if (onlyType && !rvWeakMode) { // V110: chế độ thu hẹp
    list = list.filter(it => it.type === (onlyType === 'due' ? 'review' : 'new'));
    reviewCount = onlyType === 'due' ? list.length : 0;
    newCount = onlyType === 'new' ? list.length : 0;
  }
  // V106: thêm nguồn thứ 3 (từ hay trả lời sai) + 1 bài ghép cặp; thẻ FSRS chính thức giữ nguyên thứ tự.
  let sessionItems = list, extraCount = 0;
  if (!rvWeakMode && !onlyType) {
    const ex = await rvAddExtras(sessionItems);
    extraCount = ex.extraCount;
    sessionItems = rvInsertMatch(ex.items);
  }
  rvQueue.items = sessionItems;
  rvSummary = { reviewCount: reviewCount || 0, newCount: newCount || 0 };
  rvBlockedByBacklog = !!blockedByBacklog;
  rvTotalDue = totalDue || 0;
  rvQueue.totalPlanned = sessionItems.filter(rvIsOfficial).length;
  // Nạp trước kho ví dụ cho các bài xuất hiện trong session (Phần 24) — không chặn hiển thị.
  const lessonsInSession = [...new Set(rvQueue.items.filter(it => it.word).map(it => it.word.l))];
  if (lessonsInSession.length && !isGuest && authToken) {
    fetch('/api/word-examples?lessons=' + lessonsInSession.join(','), { headers: authHeaders() })
      .then(r => r.json()).then(d => { if (d.ok) rvExamplePool = d.examples || []; })
      .catch(() => {});
  }
  sqPersist(savedKey, rvQueue, { summary: rvSummary, log: rvLog });
  if (!rvWeakMode && sessionItems.length) {
    rvStage = 'start'; rvStartInfo = rvBuildStartInfo(sessionItems, extraCount, scopeLessons); // màn bắt đầu: chỉ số liệu thật
  } else {
    rvPrepareCurrentCard();
  }
  render();
}

// V77 (Vấn đề 8/Yêu cầu 8 — "Học lại từ đầu" cho "Hôm nay học"): hành động TƯỜNG MINH riêng, chỉ
// chạy khi user chủ động bấm nút — KHÔNG bao giờ được gọi tự động ở bất kỳ đâu khác. Đóng/ghi nhật
// ký phiên hiện tại rồi nạp lại đúng bộ từ (due/new thật hoặc weak-words) NHƯNG cố ý bỏ qua
// sessionKnownHz để có thể ôn lại đúng những từ vừa hoàn thành trong ngày. Không đụng tới FSRS thật
// trên server.
async function rvRelearnFromStart() {
  const savedKey = rvStorageMode();
  ssArchiveSession(savedKey, rvQueue);
  sqClearPersisted(savedKey);
  rvExamplePool = []; rvLastAnswer = null;
  rvQueue = sqCreate();
  rvLog = []; rvQSession = QS.newSession(); rvMatch = null; rvStage = 'run'; rvStartInfo = null; // V106: buổi mới
  rvQueue.sessionId = genIdempotencyKey();
  rvQueue.startTime = Date.now();
  rvQueue.lessonFilter = sqSnapshotLessonFilter();
  rvQueue.dayKey = todayKey();
  goTab('review');
  const el = document.getElementById('content');
  if (el) el.innerHTML = `<div class="study-empty">Đang tải phiên học...</div>`;
  const { list, error, reviewCount, newCount, blockedByBacklog, totalDue } = await rvFetchFreshSession(true);
  if (error) { alert(error); goTab('today'); return; }
  rvQueue.items = list;
  rvSummary = { reviewCount: reviewCount || 0, newCount: newCount || 0 };
  rvBlockedByBacklog = !!blockedByBacklog;
  rvTotalDue = totalDue || 0;
  rvQueue.totalPlanned = rvQueue.items.length;
  sqPersist(savedKey, rvQueue, { summary: rvSummary });
  rvPrepareCurrentCard();
  render();
}

function rvFindExample(hz) {
  const matches = rvExamplePool.filter(e => e.hz === hz);
  if (!matches.length) return null;
  return matches[Math.floor(Math.random() * matches.length)];
}

// Chuẩn bị phần tử Ở ĐẦU hàng đợi: màn giới thiệu từ mới | bài ghép cặp | câu trắc nghiệm do bộ chọn
// chọn dạng + QE dựng (đã kiểm hợp lệ). Bắt đầu đo responseTime NGAY tại đây — thời điểm câu hỏi thực sự
// sẵn sàng cho người học (Phần 4).
function rvPrepareCurrentCard() {
  rvClearCountdown();
  rvQuestion = null; rvMatch = null;
  rvAnswerChanges = 0;
  rvLastAnswer = null;
  rvPhase = 'question';
  let guard = 0;
  while (rvQueue.items.length && guard++ < 60) {
    const item = rvQueue.items[0];
    if (item.type === 'new' && !item.introduced) { rvPhase = 'intro'; break; }
    if (item.type === 'match') {
      const words = (item.hzs || []).map(h => WORDS.find(x => x.hz === h)).filter(Boolean);
      const ctx = rvQCtx();
      const m = QE.buildMatch(words, 'vi', ctx) || QE.buildMatch(words, 'py', ctx);
      if (m) {
        rvMatch = { m, solved: new Set(), solvedRights: new Set(), selected: null, wrong: new Set(), answers: {}, done: false };
        rvPhase = 'match'; break;
      }
      rvQueue.items.shift(); continue; // không đủ dữ liệu ghép cặp không mơ hồ → bỏ qua, không tạo bài giả
    }
    const q = rvBuildQuestionFor(item);
    if (q) { rvQuestion = q; rvPhase = 'question'; break; }
    // Không dựng nổi câu hợp lệ nào cho từ này (kho từ quá ít): bỏ phần tử khỏi phiên thay vì kẹt vòng lặp.
    rvQueue.items.shift();
  }
  // Bổ sung "Highlight System Rating": dọn sạch trạng thái rating của câu TRƯỚC ĐÓ.
  rvRatingPhase = null; rvSystemRating = null; rvUserRating = null; rvFinalRating = null; rvPendingReview = null;
  rvStartedAt = performance.now();
  vtMarkStart(); // "review nhiễu khi thoát ra vào lại" — reset bộ đếm ẩn cho câu hỏi MỚI này
}

// Người học xem xong từ mới → câu kiểm tra nhanh (luyện bổ sung, không tính FSRS). Thẻ FSRS chính thức của
// từ này được đưa lại vào hàng đợi sau RV_NEW_GAP thẻ khi câu kiểm tra xong (xem rvAdvanceQueue).
function rvIntroDone() {
  const it = rvQueue.items[0];
  if (!it || rvPhase !== 'intro') return;
  rvQueue.items[0] = Object.assign({}, it, { type: 'check', introduced: true, origType: 'new' });
  rvPrepareCurrentCard();
  render();
}

function rvClearCountdown() {
  if (rvCountdownTimer) { clearInterval(rvCountdownTimer); rvCountdownTimer = null; }
}

// Ước lượng còn bao lâu tới lần ôn tiếp theo, chỉ để hiển thị thông tin cho user (Phần 18) —
// KHÔNG dùng để quyết định gì thêm, due thật đã được server/FSRS tính và lưu xong.
function rvSavedLine(r) {
  if (!r) return '';
  if (!r.card || !r.card.due) return '📌 Đã lưu lịch ôn';
  const diffMs = new Date(r.card.due).getTime() - Date.now();
  const diffDays = Math.round(diffMs / 86400000);
  if (diffDays <= 0) return '📌 Đã lưu lịch ôn — sẽ xuất hiện lại rất sớm';
  if (diffDays === 1) return '📌 Đã lưu lịch ôn — ôn lại sau 1 ngày';
  return `📌 Đã lưu lịch ôn — ôn lại sau ${diffDays} ngày`;
}

// ── Bổ sung "Highlight System Rating": vẽ 4 nút Again/Hard/Good/Easy theo đúng rvRatingPhase.
//     Luôn vẽ đủ 4 nút (kể cả lúc 'loading') để không gây layout shift (yêu cầu Phần "Mobile UX").
function rvRenderRatingBar() {
  if (!rvRatingPhase) return '';
  const finalRating = (rvRatingPhase === 'committing' || rvRatingPhase === 'done') ? rvFinalRating : null;
  const showSystemGlow = rvRatingPhase === 'pending' && !finalRating;
  // AUDIT V82 (UX/Performance — Phần 2/4/12): TRƯỚC ĐÂY 4 nút chỉ bấm được ở 'pending' (tức là phải
  // đợi xong round-trip /api/study/review/preview mới bấm được) — đúng cảnh "tap → loading → chờ"
  // mà yêu cầu audit muốn loại bỏ. User đã tự biết mình muốn chấm gì (không cần chờ gợi ý hệ thống)
  // nên cho bấm được NGAY từ lúc 'loading' — không đổi quy tắc "User Rating luôn thắng System
  // Rating" (rvCommitRating vẫn nhận chosenRating bình thường, không phụ thuộc rvSystemRating đã
  // có hay chưa). Chỉ riêng phần HIGHLIGHT (ngôi sao/glow đề xuất) vẫn phải đợi có rvSystemRating.
  const clickable = rvRatingPhase === 'pending' || rvRatingPhase === 'loading';
  const btns = RV_RATING_ORDER.map(r => {
    const meta = RV_RATING_META[r];
    let cls = 'rv-rate-btn ' + meta.cls;
    let extra = '';
    let extraAttrs = '';
    if (finalRating) {
      // «Đây là lựa chọn mà người dùng đã chọn» (hoặc hệ thống tự chọn khi hết giờ) — trạng thái
      // CUỐI CÙNG, mạnh hơn hẳn, KHÔNG dùng chung class với .system-rating (Phần 3/9).
      if (r === finalRating) { cls += ' rv-rate-final'; extra = ' ✓'; extraAttrs = ' aria-pressed="true"'; }
    } else if (showSystemGlow && r === rvSystemRating) {
      // «Đây là lựa chọn do hệ thống đề xuất» — class riêng .system-rating (Phần 1), không được
      // hiểu nhầm là bắt buộc (Phần 9) — accessibility: aria-label mô tả rõ đây chỉ là gợi ý (Phần 8).
      cls += ' system-rating';
      extra = ' ★';
      extraAttrs = ` aria-label="System suggested rating: ${meta.label}"`;
    }
    return `<button class="${cls}" ${clickable ? '' : 'disabled'} onclick="rvChooseRating('${r}')"${extraAttrs}>${meta.label}${extra}</button>`;
  }).join('');
  let hint = '&nbsp;';
  // AUDIT V82: nút đã bấm được ngay ở 'loading' (xem `clickable` ở trên) nên gợi ý đổi thành mời
  // bấm luôn, thay vì câu cũ khiến user tưởng phải đợi mới thao tác được.
  if (rvRatingPhase === 'loading') hint = 'Chọn đánh giá của bạn <span class="kbd-hint">· ⌨️ 1-4</span> <span style="opacity:.7">(đang tải gợi ý hệ thống...)</span>';
  else if (rvRatingPhase === 'pending' && rvSystemRating) {
    hint = `Hệ thống đề xuất: <b>${RV_RATING_META[rvSystemRating].label}</b> · Tự động chọn sau <span id="rv-countdown-num">${Math.ceil(rvAutoMs() / 1000)}</span>s <span class="kbd-hint">· ⌨️ 1-4</span>`;
  } else if (finalRating) {
    hint = `Đã chọn: <b>${RV_RATING_META[finalRating].label}</b>${rvUserRating ? '' : ' (hệ thống tự chọn)'}`;
  }
  return `<div class="rv-rating-wrap"><div class="rv-rating-hint">${hint}</div><div class="rv-rating-row">${btns}</div></div>`;
}

// Gọi /api/study/review/preview (CHỈ ĐỌC — không ghi gì lên FSRS) để lấy gợi ý System Rating của
// server cho ĐÚNG lượt trả lời này, dùng lại chung 1 logic getAutomaticFSRSRating với lúc commit
// thật (lib/fsrs-auto-rating.js) — không đoán mò riêng ở client rồi lệch với server.
async function rvFetchSystemRating({ word, selectedAnswer, responseTimeMs, answerChanges }) {
  try {
    const res = await fetch('/api/study/review/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        wordId: { hz: word.hz, l: word.l },
        quizType: rvQuestion.quizType,
        exerciseType: rvQuestion.exerciseFsrs, // V110: để server chấm đúng kiểu (tự nhập) như lúc commit
        selectedAnswer,
        responseTimeMs: Number.isFinite(responseTimeMs) ? Math.round(responseTimeMs) : null,
        answerChanges: Number.isFinite(answerChanges) ? answerChanges : 0,
      }),
    });
    const data = await res.json().catch(() => null);
    if (data && data.ok && RV_RATING_ORDER.includes(data.systemRating)) return data.systemRating;
  } catch {}
  // Mất mạng/lỗi tạm thời — vẫn cần 1 mặc định để countdown chạy được (không chặn UI): lưới an
  // toàn bảo thủ y hệt fallback của getAutomaticFSRSRating (sai → Again; đúng chưa đủ dữ liệu → Good).
  return (rvLastAnswer && rvLastAnswer.correct) ? 'good' : 'again';
}

function rvUpdateCountdownDisplay() {
  const el = document.getElementById('rv-countdown-num');
  if (!el) return;
  el.textContent = String(Math.max(0, Math.ceil((rvCountdownEndAt - Date.now()) / 1000)));
}

// Đếm ngược AUTO_COMMIT_MS — hết giờ mà user chưa bấm nút nào thì tự dùng System Rating làm Final
// Rating (Phần 6/9 của yêu cầu bổ sung). Chỉ cập nhật số giây qua DOM trực tiếp (không gọi render()
// mỗi tick) để tránh vẽ lại cả thẻ mỗi giây (Phần "Mobile UX" — không được gây layout shift/giật).
function rvStartCountdown(attemptId) {
  rvClearCountdown();
  rvCountdownEndAt = Date.now() + rvAutoMs();
  rvUpdateCountdownDisplay();
  rvCountdownTimer = setInterval(() => {
    if (attemptId !== rvAttemptId || currentTab !== 'review' || rvRatingPhase !== 'pending') { rvClearCountdown(); return; }
    if (Date.now() >= rvCountdownEndAt) { rvClearCountdown(); rvCommitRating(attemptId, null); return; }
    rvUpdateCountdownDisplay();
  }, 200);
}

// User bấm tay 1 trong 4 nút trong lúc đang đếm ngược — "User Rating luôn thắng System Rating"
// (Phần 9, quy tắc bắt buộc). Gọi từ onclick trong rvRenderRatingBar().
function rvChooseRating(rating) {
  // AUDIT V82: cho phép chọn ngay cả khi còn đang 'loading' (chờ gợi ý hệ thống) — xem giải thích ở
  // rvRenderRatingBar(). rvCommitRating() không cần rvSystemRating khi đã có chosenRating.
  if ((rvRatingPhase !== 'pending' && rvRatingPhase !== 'loading') || !RV_RATING_ORDER.includes(rating)) return;
  rvCommitRating(rvAttemptId, rating);
}

// Chốt Final Rating (chosenRating do user bấm, hoặc null nếu do countdown hết giờ) rồi gửi lên
// /api/study/review thật. Đặt rvRatingPhase='committing' NGAY (đồng bộ, trước await đầu tiên) để
// chặn commit lần 2 nếu click và hết giờ xảy ra gần như đồng thời (Phần 7 — "không cho timeout
// tiếp tục commit lần thứ hai").
async function rvCommitRating(attemptId, chosenRating) {
  // AUDIT V82: chấp nhận commit từ cả 'loading' lẫn 'pending' (bấm tay lúc đang loading — xem
  // rvChooseRating). Vẫn giữ nguyên chặn commit lần 2 (Phần 7 cũ) vì ngay dòng dưới đổi phase sang
  // 'committing' trước await đầu tiên — lần gọi thứ 2 (vd double-click/countdown trùng lúc) sẽ thấy
  // rvRatingPhase đã khác 'pending'/'loading' và tự thoát.
  if (attemptId !== rvAttemptId || currentTab !== 'review' || (rvRatingPhase !== 'pending' && rvRatingPhase !== 'loading')) return;
  rvClearCountdown();
  const pending = rvPendingReview;
  if (!pending) return;
  rvUserRating = chosenRating;
  rvFinalRating = chosenRating || rvSystemRating; // Quy tắc bắt buộc (Phần 9)
  rvRatingPhase = 'committing';
  render();

  const item = rvQueue.items[0];
  const w = item.word;
  const reviewPromise = submitFsrsReviewAwaited({
    word: w, quizType: rvQuestion.quizType, exerciseType: rvQuestion.exerciseFsrs, sessionId: rvQueue.sessionId,
    selectedAnswer: pending.selectedAnswer,
    responseTimeMs: pending.responseTimeMs, answerChanges: pending.answerChanges,
    rating: rvFinalRating,
    exposure: rvIsIntroExposure(item) ? 'intro' : undefined, // V114: CHỈ lượt chính thức đầu tiên sau giới thiệu (V113 gắn theo `introduced` nên lượt sau cũng bị gắn nhầm)
  }).then(data => {
    if (attemptId !== rvAttemptId || currentTab !== 'review') return;
    if (data && data.ok) {
      rvLastAnswer = { correct: data.answerCorrect, card: data.card, autoRating: data.debug ? data.debug.autoRating : null };
      if (data.rating) rvFinalRating = data.rating; // server luôn là nguồn sự thật cuối (Phần 20)
    }
    rvRatingPhase = 'done';
    render();
  });
  // V114: lượt đầu sau giới thiệu ĐÃ được giao cho submitFsrsReview — hàm đó ghi outbox (write-ahead, kèm idempotencyKey + exposure) ĐỒNG BỘ trước
  // await đầu tiên, nên tới đây payload đã nằm an toàn trong outbox và việc gửi lại sẽ dùng đúng payload cũ. Tắt cờ + lưu ngay: nếu thẻ quay lại
  // hàng đợi (trả lời sai), hoặc trang bị tải lại giữa chừng, lượt sau KHÔNG bị gắn exposure:'intro' nữa.
  if (item.introExposurePending) {
    item.introExposurePending = false;
    if (!rvQueue.practiceOnly) sqPersist(rvStorageMode(), rvQueue, { summary: rvSummary, log: rvLog });
  }
  // AUDIT V82 (Phần 2/12 — "chuyển card nhanh", "không có animation thừa"): giảm khoảng nghỉ tối
  // thiểu từ 1000ms xuống 450ms. Đây chỉ là thời gian TỐI THIỂU để user kịp thấy dòng "Đã lưu lịch
  // ôn" trước khi sang thẻ kế — KHÔNG ảnh hưởng an toàn dữ liệu (reviewPromise vẫn luôn được đợi đủ
  // qua Promise.all, có trần chờ riêng SUBMIT_REVIEW_MAX_WAIT_MS ở study-queue.js).
  await Promise.all([reviewPromise, new Promise(r => setTimeout(r, 450))]);
  if (attemptId !== rvAttemptId || currentTab !== 'review') return;
  rvRatingPhase = 'done';
  rvAdvanceQueue();
}

let rvStyleInjected = false;
function rvInjectStyle() {
  if (rvStyleInjected || typeof document === 'undefined') return;
  rvStyleInjected = true;
  const st = document.createElement('style');
  st.textContent = `
  .rv-typed-rule{font-size:.78rem;color:var(--muted);text-align:center;margin-top:6px;line-height:1.4}
  .rv-why{font-size:.74rem;color:var(--muted);text-align:center;margin:-2px 0 6px;line-height:1.4}
  .rv-type-tag{font-size:.7rem;color:var(--muted);font-weight:700;text-align:center;margin-bottom:4px}
  .rv-cloze{font-size:1.5rem;font-weight:800;text-align:center;margin:10px 0 4px;line-height:1.5;word-break:break-word}
  .rv-cloze-vi{font-size:.9rem;color:var(--muted);text-align:center;margin-bottom:8px}
  .rv-explain{font-size:.85rem;color:var(--muted);text-align:left;background:var(--paper);border:1px solid var(--border);border-radius:10px;padding:8px 12px;margin:8px 0;line-height:1.5}
  .rv-start-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}
  .rv-start-cell{background:var(--paper);border:1px solid var(--border);border-radius:12px;padding:10px;text-align:center}
  .rv-start-num{font-size:1.5rem;font-weight:900}.rv-start-lbl{font-size:.72rem;color:var(--muted);font-weight:700}
  .rv-match{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}
  .rv-match-col{display:flex;flex-direction:column;gap:8px}
  .rv-match-btn{min-height:48px;border:2px solid var(--border);border-radius:12px;background:var(--paper);color:var(--ink);font:inherit;font-weight:700;padding:8px;cursor:pointer;word-break:break-word}
  .rv-match-btn.sel{border-color:var(--l10a,#2980b9);box-shadow:0 0 0 2px var(--l10c,#d6eaf8)}
  .rv-match-btn.done{border-color:var(--l8a,#27ae60);background:var(--l8c,#d5f5e3);opacity:.85}
  .rv-sum-table{width:100%;border-collapse:collapse;font-size:.85rem;margin:8px 0}
  .rv-sum-table td,.rv-sum-table th{padding:5px 6px;border-bottom:1px solid var(--border);text-align:left}
  .rv-sum-weak{display:flex;gap:10px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--border);text-align:left}`;
  document.head.appendChild(st);
}

function rvExplainHtml() {
  const q = rvQuestion;
  if (!q || q.typeId === 'hz2vi' || q.typeId === 'vi2hz') return ''; // 2 dạng này màn đáp án đã hiện đủ chữ/pinyin/nghĩa
  // V110: câu tự nhập — nói rõ bạn đã gõ gì, vì sao đúng/sai (ví dụ: đúng âm nhưng thiếu/sai thanh), và đáp án chuẩn.
  let typedLine = '';
  const t = rvLastAnswer && rvLastAnswer.typed;
  if (q.typed && t) {
    const blank = !t.value;
    typedLine = `<div><b>${blank ? 'Bạn đã bỏ qua câu này' : 'Bạn đã gõ: ' + escapeHtml(t.value)}</b>` +
      `${!blank && AM.VERDICT_TEXT[t.verdict] ? ` — ${escapeHtml(AM.VERDICT_TEXT[t.verdict])}` : ''}` +
      `${t.correct ? '' : `<br>Đáp án chuẩn: ${escapeHtml(q.correctKey)}`}</div>`;
  }
  return `<div class="rv-explain">${typedLine}${q.explanation.map(l => `<div>${escapeHtml(l)}</div>`).join('')}</div>`;
}

function rvQuestionBodyHtml(tagLabel, w) {
  const q = rvQuestion, p = q.prompt;
  let stem;
  if (p.kind === 'audio') {
    stem = `<button id="rv-play" class="listen-play" onclick="speak('${escapeJsAttr(w.hz)}')" title="Phát lại">🔊</button>
      <div class="rv-prompt">${escapeHtml(p.ask)}</div>`;
  } else if (p.kind === 'cloze') {
    stem = `<div class="rv-cloze">${escapeHtml(p.main)}</div>
      ${p.sub ? `<div class="rv-cloze-vi">${escapeHtml(p.sub)}</div>` : ''}
      <div class="rv-prompt">${escapeHtml(p.ask)}</div>`;
  } else if (q.typeId === 'hz2vi') {
    stem = `<div class="rv-hz">${escapeHtml(w.hz)}</div>
      ${showPinyin ? `<div class="rv-py">${escapeHtml(w.py || '')}</div>` : ''}
      <div class="rv-prompt">${escapeHtml(p.ask)}</div>`;
  } else if (q.typeId === 'hz2py') {
    // Chọn pinyin: KHÔNG hiện pinyin của từ ở đề dù người dùng đang bật "Hiện Pinyin" (sẽ lộ đáp án).
    stem = `<div class="rv-hz">${escapeHtml(w.hz)}</div><div class="rv-prompt">${escapeHtml(p.ask)}</div>`;
  } else {
    stem = `<div class="rv-vi" style="font-size:1.3rem;margin:10px 0">${escapeHtml(p.main || '')}</div>
      <div class="rv-prompt">${escapeHtml(p.ask)}</div>`;
  }
  if (q.typed) { // V110: câu TỰ NHẬP — không có nút lựa chọn
    const isPy = q.typed === 'py';
    return `
      <div class="rv-tag">${tagLabel} · ${lessonsLabel(w)}</div>
      <div class="rv-type-tag">${escapeHtml(QE.TYPES[q.typeId].label)}</div>
      ${q.why ? `<div class="rv-why">💡 ${escapeHtml(q.why)}</div>` : ''}
      ${stem}
      <input id="rv-typed" class="type-input" type="text" inputmode="text" enterkeyhint="done"
             ${isPy ? 'lang="vi"' : 'lang="zh-CN"'} autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"
             placeholder="${isPy ? 'Gõ pinyin, ví dụ: nǐ hǎo hoặc ni3 hao3' : 'Gõ chữ Hán (dùng bàn phím tiếng Trung)'}"
             onkeydown="if(event.key==='Enter'){event.preventDefault();rvSubmitTyped(false)}" ${rvSubmitting ? 'disabled' : ''}>
      <div class="rv-typed-rule">${isPy
        ? 'Quy tắc chấm: cần dấu thanh (ǎ) hoặc số thanh (a3). Không phân biệt hoa/thường và khoảng trắng. Gõ thiếu thanh điệu sẽ <b>không</b> được tính đúng.'
        : 'Quy tắc chấm: phải đúng từng chữ (không phân biệt giản/phồn). Khoảng trắng và dấu câu thừa được bỏ qua.'}</div>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:10px">
        <button class="btn btn-primary" onclick="rvSubmitTyped(false)">Kiểm tra</button>
        <button class="btn" style="background:var(--border)" onclick="rvSubmitTyped(true)">Bỏ qua</button>
      </div>`;
  }
  const opts = q.options.map(o =>
    `<button class="quiz-opt" data-v="${escapeHtml(o.key)}" onclick="rvPick(this)" ${rvSubmitting ? 'disabled' : ''}>${escapeHtml(o.label)}</button>`
  ).join('');
  return `
      <div class="rv-tag">${tagLabel} · ${lessonsLabel(w)}</div>
      <div class="rv-type-tag">${escapeHtml(QE.TYPES[q.typeId].label)}</div>
      ${q.why ? `<div class="rv-why">💡 ${escapeHtml(q.why)}</div>` : ''}
      ${stem}
      <div class="quiz-opts" id="rv-opts">${opts}</div>
      <div class="kbd-hint" style="text-align:center;margin-top:2px;">⌨️ 1-4 để chọn</div>`;
}

function rvIntroHtml(tagLabel, w) {
  const ex = rvFindExample(w.hz);
  const audioOk = (typeof skillAudioAvailable === 'function') && skillAudioAvailable();
  return `
      <div class="rv-tag">${tagLabel} · ${lessonsLabel(w)}</div>
      <div class="rv-type-tag">Xem kỹ từ mới trước khi được hỏi</div>
      <div class="rv-hz">${escapeHtml(w.hz)}</div>
      <div class="rv-py">${escapeHtml(w.py || '')}</div>
      <div class="rv-vi">${escapeHtml(w.vi || '')}</div>
      ${w.hanviet ? `<div class="rv-hv">Hán Việt: ${escapeHtml(w.hanviet)}</div>` : ''}
      ${audioOk ? `<button id="rv-play" class="btn btn-sound btn-sm" onclick="speak('${escapeJsAttr(w.hz)}')">🔊 Nghe</button>` : ''}
      ${renderHanziParts(w.hz)}
      ${ex ? `<div class="rv-ex">${escapeHtml(ex.zh)}<br><span style="color:var(--muted);font-size:.85rem;">${escapeHtml(ex.vi || '')}</span></div>` : ''}
      ${wnBlockHtml(w.hz)}
      <div style="text-align:center;margin-top:14px"><button class="btn btn-primary" onclick="rvIntroDone()">Đã xem — kiểm tra ngay</button></div>`;
}

function rvMatchHtml(tagLabel) {
  const st = rvMatch, m = st.m;
  const leftBtns = m.lefts.map((hz, i) => {
    const cls = st.solved.has(hz) ? ' done' : (st.selected === hz ? ' sel' : '');
    return `<button class="rv-match-btn${cls}" ${st.solved.has(hz) || st.done ? 'disabled' : ''} onclick="rvMatchPick('L',${i})">${escapeHtml(hz)}</button>`;
  }).join('');
  const rightBtns = m.rights.map((r, i) => {
    const cls = st.solvedRights.has(r) ? ' done' : '';
    return `<button class="rv-match-btn${cls}" ${st.solvedRights.has(r) || st.done ? 'disabled' : ''} onclick="rvMatchPick('R',${i})">${escapeHtml(r)}</button>`;
  }).join('');
  const wrongN = st.wrong.size;
  return `
      <div class="rv-tag">${tagLabel}</div>
      <div class="rv-type-tag">Ghép cặp</div>
      <div class="rv-prompt">Ghép chữ Hán với ${m.kind === 'vi' ? 'nghĩa' : 'Pinyin'} tương ứng</div>
      <div class="rv-match"><div class="rv-match-col">${leftBtns}</div><div class="rv-match-col">${rightBtns}</div></div>
      ${st.done
        ? `<div class="rv-feedback" style="color:${wrongN ? 'var(--l10a)' : 'var(--l8a)'}">${wrongN ? `Ghép xong · ${wrongN} cặp cần xem lại` : '✅ Ghép đúng hết'}</div>
           <div style="text-align:center;margin-top:10px"><button class="btn btn-primary" onclick="rvMatchContinue()">Tiếp tục</button></div>`
        : `<div class="kbd-hint" style="text-align:center">Chạm 1 chữ Hán bên trái, rồi chạm đáp án bên phải</div>`}`;
}

function rvStartHtml() {
  const i = rvStartInfo;
  const cell = (n, l) => `<div class="rv-start-cell"><div class="rv-start-num">${n}</div><div class="rv-start-lbl">${l}</div></div>`;
  const lessons = !i.lessons.length ? 'Phạm vi đang chọn'
    : (i.lessons.length <= 8 ? `Bài ${i.lessons.join(', ')}` : `Bài ${i.lessons.slice(0, 8).join(', ')} +${i.lessons.length - 8} bài khác`);
  return `<div class="rv-card">
    <div class="rv-tag">🎓 Hôm nay học</div>
    <div style="font-size:1.2rem;font-weight:800;margin:6px 0">${escapeHtml(lessons)}</div>
    <div class="rv-start-grid">
      ${cell(i.newCount, 'Từ mới')}
      ${cell(i.reviewCount, 'Thẻ đến hạn ôn (FSRS)')}
      ${i.extraCount > 0 ? cell(i.extraCount, 'Từ cần luyện thêm') : ''}
      ${cell('~' + i.estimated, 'Số câu dự kiến')}
    </div>
    ${rvBlockedByBacklog ? `<div class="rv-explain">⏳ Đang có ${rvTotalDue} thẻ cần ôn, nên hệ thống tạm chặn học thêm từ mới cho đến khi ôn hết.</div>` : ''}
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:8px">
      <button class="btn btn-primary" onclick="rvBeginSession()">▶️ Bắt đầu học</button>
      ${i.extraCount > 0 ? `<button class="btn" onclick="rvStartWeakPractice()">🎯 Chỉ luyện từ hay sai</button>` : ''}
      <button class="btn" style="background:var(--border)" onclick="goTab('today')">Quay lại</button>
    </div>
  </div>`;
}

function rvSummaryHtml() {
  const total = rvLog.length;
  const right = rvLog.filter(e => e.correct).length;
  const acc = total ? Math.round((right / total) * 100) : 0;
  const end = rvQueue.endTime || Date.now();
  const mins = rvQueue.startTime ? Math.max(1, Math.round((end - rvQueue.startTime) / 60000)) : null;
  const typeLabel = (id) => id === 'match' ? 'Ghép cặp' : ((QE.TYPES[id] || {}).label || id);
  const byType = {};
  for (const e of rvLog) { const b = byType[e.typeId] || (byType[e.typeId] = { n: 0, ok: 0 }); b.n++; if (e.correct) b.ok++; }
  const typeRows = Object.keys(byType).map(id => `<tr><td>${escapeHtml(typeLabel(id))}</td><td>${byType[id].ok}/${byType[id].n}</td><td>${Math.round(byType[id].ok / byType[id].n * 100)}%</td></tr>`).join('');
  const SK = { recognition: 'Nhận diện', recall: 'Nhớ chủ động', listening: 'Nghe', pinyin: 'Pinyin', context: 'Từ trong câu' };
  const bySkill = {};
  for (const e of rvLog) { const b = bySkill[e.skill] || (bySkill[e.skill] = { n: 0, ok: 0 }); b.n++; if (e.correct) b.ok++; }
  // Kỹ năng cần cải thiện: CHỈ khi có ≥3 câu của kỹ năng đó trong buổi và tỉ lệ đúng < 70%; còn lại "chưa đủ dữ liệu".
  const weakSkills = Object.keys(bySkill).filter(k => bySkill[k].n >= 3 && bySkill[k].ok / bySkill[k].n < 0.7).map(k => SK[k] || k);
  const thinSkills = Object.keys(bySkill).filter(k => bySkill[k].n < 3).map(k => SK[k] || k);
  // Từ cần ôn lại: từ có lần trả lời CUỐI CÙNG trong buổi là sai.
  const last = new Map();
  for (const e of rvLog) last.set(e.hz, e);
  const wrongWords = [...last.values()].filter(e => !e.correct);
  const weakHtml = wrongWords.slice(0, 8).map(e => {
    const w = WORDS.find(x => x.hz === e.hz && x.l === e.l) || WORDS.find(x => x.hz === e.hz) || { hz: e.hz };
    return `<div class="rv-sum-weak"><b style="font-size:1.2rem">${escapeHtml(w.hz)}</b><span style="color:var(--muted)">${escapeHtml(w.py || '')}</span><span>${escapeHtml(w.vi || '')}</span></div>`;
  }).join('');
  const counts = (rvSummary.reviewCount || rvSummary.newCount) ? `Đã ôn ${rvSummary.reviewCount} từ, học ${rvSummary.newCount} từ mới.` : '';
  return `<div class="rv-done" style="text-align:left">
    <div style="text-align:center"><div class="rv-done-num">🎉</div>
    <div style="font-size:1.3rem;font-weight:800;margin:10px 0;">Tổng kết buổi học</div>
    ${counts ? `<div style="color:var(--muted);margin-bottom:10px;">${counts}</div>` : ''}</div>
    <div class="rv-start-grid">
      <div class="rv-start-cell"><div class="rv-start-num">${total}</div><div class="rv-start-lbl">Câu đã làm</div></div>
      <div class="rv-start-cell"><div class="rv-start-num">${right} / ${total - right}</div><div class="rv-start-lbl">Đúng / Sai</div></div>
      <div class="rv-start-cell"><div class="rv-start-num">${acc}%</div><div class="rv-start-lbl">Tỉ lệ đúng trong buổi</div></div>
      <div class="rv-start-cell"><div class="rv-start-num">${mins == null ? '—' : mins + ' phút'}</div><div class="rv-start-lbl">Thời gian học</div></div>
    </div>
    <div style="font-weight:800;margin-top:6px">Kết quả theo dạng bài</div>
    <table class="rv-sum-table"><tr><th>Dạng bài</th><th>Đúng</th><th>Tỉ lệ</th></tr>${typeRows}</table>
    <div style="font-weight:800">Kỹ năng cần cải thiện</div>
    <div style="font-size:.9rem;margin:4px 0 8px">${weakSkills.length ? escapeHtml(weakSkills.join(', ')) : 'Chưa phát hiện kỹ năng yếu trong buổi này.'}${thinSkills.length ? `<div style="color:var(--muted);font-size:.8rem">Chưa đủ dữ liệu (dưới 3 câu): ${escapeHtml(thinSkills.join(', '))}</div>` : ''}</div>
    <div style="font-weight:800">Từ cần ôn lại ${wrongWords.length ? `(${wrongWords.length})` : ''}</div>
    ${weakHtml || '<div style="color:var(--muted);font-size:.9rem;margin:4px 0 8px">Không có từ nào sai ở lần trả lời cuối.</div>'}
    <div class="rv-explain">Tỉ lệ đúng trong một buổi chỉ cho biết bạn làm bài ra sao hôm nay — chưa phải mức độ ghi nhớ lâu dài. Độ nhớ dài hạn do lịch ôn FSRS theo dõi qua nhiều ngày.</div>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:10px">
      ${wrongWords.length ? `<button class="btn btn-primary" onclick="rvStartRedoWrong()">🔁 Luyện lại câu sai</button>` : ''}
      <button class="btn ${wrongWords.length ? '' : 'btn-primary'}" onclick="startStudySession(${rvWeakMode}, true)">▶️ Học tiếp</button>
      <button class="btn" onclick="rvRelearnFromStart()">🔁 Học lại từ đầu</button>
      <button class="btn" style="background:var(--border)" onclick="goTab('today')">✅ Kết thúc buổi học</button>
    </div>
  </div>`;
}

function renderReview() {
  rvInjectStyle();
  if (rvStage === 'start' && rvStartInfo) return rvStartHtml();
  if (!rvQueue.items.length) {
    // FIX (audit — màn "Xong phiên học! Đã ôn 0 từ, học 0 từ mới" gây hiểu lầm là lỗi): tách riêng
    // "chưa từng có gì để học" (kèm lý do cụ thể) khỏi "đã thật sự học xong 1 phiên có thẻ".
    if (rvLog.length === 0 && rvSummary.reviewCount === 0 && rvSummary.newCount === 0) {
      const reason = rvBlockedByBacklog
        ? `⏳ Bạn đang có ${rvTotalDue} thẻ CẦN ÔN đến hạn (có thể ở Quyển/bài khác ngoài phạm vi đang chọn) — hệ thống đang chặn học từ mới cho tới khi ôn hết backlog này`
        : `Không có thẻ nào đến hạn ôn hoặc còn trong ngân sách từ mới hôm nay ở phạm vi Quyển/bài đang chọn.`;
      return `<div class="rv-done">
        <div class="rv-done-num">📭</div>
        <div style="font-size:1.3rem;font-weight:800;margin:10px 0;">Chưa có gì để học</div>
        <div style="color:var(--muted);margin-bottom:20px;">${reason}</div>
        <button class="btn btn-primary" onclick="goTab('today')">Về Hôm nay học</button>
      </div>`;
    }
    return rvSummaryHtml();
  }
  const item = rvQueue.items[0];
  const w = item.word || { hz: '', py: '', vi: '', l: 0 };
  const official = rvQueue.items.filter(rvIsOfficial).length;
  const pct = Math.min(100, Math.round((rvQueue.answeredCount / (rvQueue.totalPlanned || 1)) * 100));
  const practice = rvIsPractice(item);
  const tagLabel = rvStageLabel(item);
  let body;
  if (rvPhase === 'intro') {
    body = rvIntroHtml(tagLabel, w);
  } else if (rvPhase === 'match' && rvMatch) {
    body = rvMatchHtml(tagLabel);
  } else if (rvPhase === 'question' && rvQuestion) {
    body = rvQuestionBodyHtml(tagLabel, w);
  } else if (practice) {
    // Màn đáp án của câu LUYỆN BỔ SUNG: không có thanh đánh giá FSRS (đây không phải lượt FSRS).
    const r = rvLastAnswer;
    const exD = rvFindExample(w.hz);
    body = `
      <div class="rv-tag">${tagLabel} · ${lessonsLabel(w)}</div>
      <div class="rv-hz">${escapeHtml(w.hz)}</div>
      <div class="rv-feedback" style="color:${r && r.correct ? 'var(--l8a)' : 'var(--l10a)'};">
        ${r && r.correct ? '✅ Chính xác' : '❌ Chưa đúng — xem lại và thử lại sau ít câu'}
      </div>
      <div class="rv-py">${escapeHtml(w.py || '')}</div>
      ${showMeaning ? `<div class="rv-vi">${escapeHtml(w.vi || '')}</div>` : ''}
      ${w.hanviet ? `<div class="rv-hv">Hán Việt: ${escapeHtml(w.hanviet)}</div>` : ''}
      ${renderHanziParts(w.hz)}
      ${rvExplainHtml()}
      ${(exD && !(rvQuestion && rvQuestion.typeId === 'cloze')) ? `<div class="rv-ex">${escapeHtml(exD.zh)}<br><span style="color:var(--muted);font-size:.85rem;">${escapeHtml(exD.vi || '')}</span></div>` : ''}
      ${wnBlockHtml(w.hz)}
      <div style="text-align:center;margin-top:12px"><button class="btn btn-primary" onclick="rvPracticeContinue()">Tiếp tục</button></div>`;
  } else {
    // Đã có kết quả trắc nghiệm: lộ đáp án đầy đủ + bổ sung "Highlight System Rating" — hiện lại 4
    // nút Again/Hard/Good/Easy, highlight nút hệ thống đề xuất, cho user xác nhận/đổi trước khi
    // commit thật lên FSRS (thay cho hành vi 100% tự động của V67).
    const r = rvLastAnswer;
    const ex = rvFindExample(w.hz);
    // Ở màn "kết quả" của "Hôm nay học", Pinyin và Hán Việt LUÔN hiện để củng cố trí nhớ ngay sau khi biết đáp án.
    let savedLine = '';
    if (rvRatingPhase === 'committing') savedLine = `<div class="rv-saved-line">⏳ Đang lưu...</div>`;
    else if (rvRatingPhase === 'done') savedLine = `<div class="rv-saved-line">${rvSavedLine(r)}</div>`;
    body = `
      <div class="rv-tag">${tagLabel} · ${lessonsLabel(w)}</div>
      <div class="rv-hz">${w.hz}</div>
      <div class="rv-feedback" style="color:${r && r.correct ? 'var(--l8a)' : 'var(--l10a)'};">
        ${r && r.correct ? '✅ Chính xác' : '❌ Chưa đúng'}
      </div>
      <div class="rv-py">${w.py || ''}</div>
      ${showMeaning ? `<div class="rv-vi">${w.vi || ''}</div>` : ''}
      ${w.hanviet ? `<div class="rv-hv">Hán Việt: ${w.hanviet}</div>` : ''}
      ${renderHanziParts(w.hz)}
      ${rvExplainHtml()}
      ${(ex && !(rvQuestion && rvQuestion.typeId === 'cloze')) ? `<div class="rv-ex">${ex.zh}<br><span style="color:var(--muted);font-size:.85rem;">${ex.vi}</span></div>` : ''}
      ${wnBlockHtml(w.hz)}
      ${rvRenderRatingBar()}
      ${savedLine}
      ${(!isGuest && isAdminRole() && r && r.autoRating) ? `<div class="rv-saved-line">🐞 debug: auto rating = ${r.autoRating}</div>` : ''}`;
  }
  const counter = rvPhase === 'intro' ? 'Học từ mới · xem kỹ rồi làm câu kiểm tra'
    : (practice || rvPhase === 'match') ? 'Luyện bổ sung · không tính vào lịch ôn'
    : `Câu ${rvQueue.answeredCount + 1} · còn ${official} thẻ trong hàng đợi`;
  return `
    <div class="rv-progress-wrap"><div class="rv-progress-fill" style="width:${pct}%;"></div></div>
    <div class="rv-counter">${counter}</div>
    <div class="rv-card">${body}</div>
  `;
}

// Đánh dấu đáp án đúng lên từng nút NGAY SAU KHI render xong (Phần 17), giống cách bindQuiz đang
// làm cho tab Trắc nghiệm — để rvPick() biết ngay đáp án vừa chọn đúng hay sai mà không cần chờ
// server trả lời (server vẫn là nguồn sự thật cuối cùng, việc này chỉ để phản hồi UI tức thời).
function bindReview() {
  if (rvStage === 'start' || !rvQueue.items.length) return;
  if (rvPhase === 'intro') {
    // Từ mới: tự phát âm khi có giọng đọc (nếu không có giọng thì không có nút/âm thanh giả).
    if (typeof skillAudioAvailable === 'function' && skillAudioAvailable()) {
      setTimeout(() => { const pb = document.getElementById('rv-play'); if (pb) pb.click(); }, 400);
    }
    return;
  }
  if (rvPhase !== 'question' || !rvQuestion) return;
  if (rvQuestion.typed) { // V110: câu tự nhập — đặt con trỏ vào ô nhập (bàn phím hiện sẵn trên điện thoại)
    setTimeout(() => { const i = document.getElementById('rv-typed'); if (i) i.focus(); }, 120);
    return;
  }
  document.querySelectorAll('#rv-opts .quiz-opt').forEach((b, i) => {
    b._correct = (i === rvQuestion.correctIndex);
  });
  if (rvQuestion.prompt.kind === 'audio') {
    setTimeout(() => { const pb = document.getElementById('rv-play'); if (pb) pb.click(); }, 400);
  }
}

// ── Phần 1/3/4/17/20: user chọn 1 đáp án → khoá UI, hiện đúng/sai tức thời → gửi
//     selectedAnswer + responseTimeMs lên server (server tự xác định lại đúng/sai + tự suy ra
//     FSRS rating + gọi ts-fsrs + lưu). ──
let rvAttemptId = 0; // FIX: đánh dấu lượt trả lời hiện tại — phản hồi server đến TRỄ (sau khi user
                      // đã sang câu khác) sẽ tự bị bỏ qua thay vì ghi đè nhầm màn hình câu sau.
async function rvPick(btn) {
  if (rvSubmitting || rvPhase !== 'question' || !rvQuestion) return;
  if (rvIsPractice(rvQueue.items[0])) return rvPickPractice(btn); // luyện bổ sung: KHÔNG đi đường FSRS
  rvSubmitting = true;
  // "Review nhiễu khi thoát ra vào lại": trừ đi tổng thời gian tab bị ẩn trong lúc câu hỏi này chờ trả lời.
  const responseTimeMs = Math.max(0, Math.round(performance.now() - rvStartedAt - vtHiddenMs())); // Phần 4
  const item = rvQueue.items[0];
  const w = item.word;
  const isCorrectLocally = !!btn._correct;
  const selectedAnswer = btn.dataset.v;
  const attemptId = ++rvAttemptId;

  document.querySelectorAll('#rv-opts .quiz-opt').forEach(b => {
    if (b._correct) b.classList.add('correct');
    else if (b === btn && !isCorrectLocally) b.classList.add('wrong');
    b.disabled = true;
  });
  if (isCorrectLocally) playDing(); else playBuzz();
  speak(w.hz);
  rvRecordAnswer(item, rvQuestion, isCorrectLocally, responseTimeMs, true);

  rvLastAnswer = { correct: isCorrectLocally, card: null, autoRating: null };
  rvPhase = 'answered';
  // Bổ sung "Highlight System Rating": KHÔNG commit thẳng lên FSRS — trước tiên hỏi server gợi ý System
  // Rating (chỉ đọc), rồi hiện 4 nút Again/Hard/Good/Easy + countdown cho user xác nhận.
  rvRatingPhase = 'loading';
  rvSystemRating = null; rvUserRating = null; rvFinalRating = null;
  rvPendingReview = { selectedAnswer, responseTimeMs, answerChanges: rvAnswerChanges };
  rvSubmitting = false;
  render();

  const systemRating = await rvFetchSystemRating({ word: w, selectedAnswer, responseTimeMs, answerChanges: rvAnswerChanges });
  // AUDIT V82: chỉ tiếp tục khi vẫn đang 'loading' (user có thể đã tự bấm rating và commit trước khi gợi ý về).
  if (attemptId !== rvAttemptId || currentTab !== 'review' || rvRatingPhase !== 'loading') return;
  rvSystemRating = systemRating;
  rvRatingPhase = 'pending';
  render();
  rvStartCountdown(attemptId);
}

// Trả lời câu LUYỆN BỔ SUNG (check/extra/redo/drill). KHÔNG gọi /api/study/review(/preview) → không đụng
// lịch FSRS. Chỉ ghi hồ sơ kỹ năng bằng bài luyện bổ sung, đi qua outbox chung (không mất khi mất mạng,
// không ghi trùng khi gửi lại).
function rvPickPractice(btn) {
  rvPhase = 'answered'; // chặn bấm đúp ngay lập tức (rvPick thoát sớm khi rvPhase !== 'question')
  const item = rvQueue.items[0];
  const w = item.word, q = rvQuestion;
  const responseTimeMs = Math.max(0, Math.round(performance.now() - rvStartedAt - vtHiddenMs()));
  const ok = !!btn._correct;
  const attemptId = ++rvAttemptId;
  document.querySelectorAll('#rv-opts .quiz-opt').forEach(b => {
    if (b._correct) b.classList.add('correct');
    else if (b === btn && !ok) b.classList.add('wrong');
    b.disabled = true;
  });
  if (ok) playDing(); else playBuzz();
  speak(w.hz);
  rvLastAnswer = { correct: ok, card: null, autoRating: null };
  rvRatingPhase = null;
  rvRecordAnswer(item, q, ok, responseTimeMs, false);
  submitSkillPractice({ word: w, exerciseType: q.exercisePractice, selectedAnswer: btn.dataset.v, responseTimeMs, source: rvPracticeSource(item), sessionId: rvQueue.sessionId }).catch(() => {});
  render();
  // Đúng và không có giải thích dài → tự sang câu kế sau 2s (đủ đọc). Có giải thích (điền từ, dễ nhầm) hoặc sai
  // → chờ người học bấm "Tiếp tục" để kịp đọc.
  const needsReading = !ok || q.typeId === 'cloze' || q.typeId === 'confusable' || q.typeId === 'hz2py';
  if (!needsReading) {
    setTimeout(() => {
      if (attemptId === rvAttemptId && currentTab === 'review' && rvQueue.items[0] === item
          && rvPhase === 'answered' && !document.getElementById('wn-overlay')) rvAdvanceQueue();
    }, 2000);
  }
}
// ── V110: trả lời câu TỰ NHẬP. Chấm tức thì bằng AM (đúng module server dùng) chỉ để phản hồi nhanh; server vẫn chấm lại.
// Thẻ FSRS chính thức → đi đường preview + chọn rating + /api/study/review (y như trắc nghiệm).
// Luyện bổ sung → chỉ ghi hồ sơ kỹ năng (/api/skills/practice), KHÔNG đổi lịch FSRS.
// "Bỏ qua" = người học chủ động không nhớ ra → tính là sai (khác bấm Kiểm tra khi để trống = bấm nhầm, không tính vào kỹ năng).
const RV_BLANK_MARK = '⨯ (bỏ trống) ⨯';
async function rvSubmitTyped(skip) {
  if (rvSubmitting || rvPhase !== 'question' || !rvQuestion || !rvQuestion.typed) return;
  const inp = document.getElementById('rv-typed');
  const value = skip ? '' : (inp ? inp.value : '');
  if (!skip && !String(value).trim()) { // chưa gõ gì: nhắc nhẹ, KHÔNG tính là câu trả lời
    if (inp) { inp.focus(); inp.placeholder = 'Hãy gõ đáp án, hoặc bấm “Bỏ qua”'; }
    return;
  }
  rvSubmitting = true;
  const q = rvQuestion, item = rvQueue.items[0], w = item.word;
  const responseTimeMs = Math.max(0, Math.round(performance.now() - rvStartedAt - vtHiddenMs()));
  const graded = skip ? { correct: false, verdict: 'empty' } : AM.grade(q.typed, value, q.correctKey);
  const selectedAnswer = skip ? RV_BLANK_MARK : String(value).trim();
  const attemptId = ++rvAttemptId;
  if (graded.correct) playDing(); else playBuzz();
  speak(w.hz);
  rvRecordAnswer(item, q, graded.correct, responseTimeMs, rvIsOfficial(item));
  rvLastAnswer = { correct: graded.correct, card: null, autoRating: null, typed: { value: skip ? '' : String(value).trim(), verdict: graded.verdict, correct: graded.correct } };
  rvPhase = 'answered';
  rvSubmitting = false;

  if (rvIsPractice(item)) { // luyện bổ sung
    rvRatingPhase = null;
    submitSkillPractice({ word: w, exerciseType: q.exercisePractice, selectedAnswer, responseTimeMs, source: rvPracticeSource(item), sessionId: rvQueue.sessionId }).catch(() => {});
    render();
    return; // câu tự nhập luôn có giải thích → chờ người học bấm "Tiếp tục"
  }
  rvRatingPhase = 'loading';
  rvSystemRating = null; rvUserRating = null; rvFinalRating = null;
  rvPendingReview = { selectedAnswer, responseTimeMs, answerChanges: 0 };
  render();
  const systemRating = await rvFetchSystemRating({ word: w, selectedAnswer, responseTimeMs, answerChanges: 0 });
  if (attemptId !== rvAttemptId || currentTab !== 'review' || rvRatingPhase !== 'loading') return;
  rvSystemRating = systemRating;
  rvRatingPhase = 'pending';
  render();
  rvStartCountdown(attemptId);
}

function rvPracticeContinue() {
  const item = rvQueue.items[0];
  if (!item || !rvIsPractice(item) || rvPhase !== 'answered') return;
  rvAdvanceQueue();
}
function rvDrillContinue() { rvPracticeContinue(); } // tên cũ (V105)

// ── Ghép cặp (dạng 7) ──────────────────────────────────────────────────────────────────────────
function rvMatchPick(side, idx) {
  const st = rvMatch;
  if (!st || st.done || rvPhase !== 'match') return;
  if (side === 'L') {
    const hz = st.m.lefts[idx];
    if (st.solved.has(hz)) return;
    st.selected = hz; render(); return;
  }
  const right = st.m.rights[idx];
  if (!st.selected || st.solvedRights.has(right)) return;
  const pair = st.m.pairs.find(p => p.hz === st.selected);
  if (!pair) return;
  if (!(pair.hz in st.answers)) st.answers[pair.hz] = right; // lần chọn ĐẦU TIÊN của chữ này là thứ được ghi nhận
  if (pair.right === right) { st.solved.add(pair.hz); st.solvedRights.add(right); playDing(); }
  else { st.wrong.add(pair.hz); playBuzz(); }
  st.selected = null;
  if (st.solved.size === st.m.pairs.length) rvMatchFinish();
  render();
}
function rvMatchFinish() {
  const st = rvMatch; st.done = true;
  for (const p of st.m.pairs) {
    const ok = !st.wrong.has(p.hz);
    rvLog.push({ hz: p.hz, l: p.l, typeId: 'match', skill: st.m.skill, correct: ok, ms: null, official: false, source: 'match' });
    submitSkillPractice({ word: p.word, exerciseType: st.m.exercisePractice, selectedAnswer: st.answers[p.hz], responseTimeMs: null }).catch(() => {});
  }
}
function rvMatchContinue() {
  if (!rvMatch || !rvMatch.done) return;
  rvLastAnswer = { correct: true, card: null, autoRating: null };
  rvAdvanceQueue();
}

// V71/V78: thẻ Ở ĐẦU hàng đợi (rvQueue.items[0] = currentIndex) bị loại NGAY LẬP TỨC sau khi có kết
// quả server. Đúng → loại vĩnh viễn khỏi phiên. Sai (Again) → chèn lại cách tối thiểu REPEAT_GAP
// thẻ khác, KHÔNG gọi lại server giữa phiên — hàng đợi cạn thật (kể cả các thẻ Again đã được xử lý
// xong) mới coi là hết. Dùng CHUNG field completedCards/answeredCount/endTime/sessionKnownHz với 4 tab kia.
function rvAdvanceQueue() {
  if (currentTab !== 'review') return; // user đã rời màn hình, tránh render nhầm chỗ
  const it = rvQueue.items.shift();
  const ok = !!(rvLastAnswer && rvLastAnswer.correct);
  if (it && it.type === 'match') {
    // bài ghép cặp: luyện bổ sung, không tính tiến độ FSRS.
  } else if (it && it.type === 'check') {
    // Xong câu kiểm tra ngay sau khi xem từ mới → đưa THẺ FSRS CHÍNH THỨC của từ này vào lại sau RV_NEW_GAP thẻ.
    rvQueue.items.splice(Math.min(RV_NEW_GAP, rvQueue.items.length), 0,
      { type: 'new', word: it.word, introduced: true, introExposurePending: true, skillProfile: it.skillProfile, suggestedSkill: it.suggestedSkill, confusions: it.confusions }); // V114: đây là lượt chính thức ĐẦU sau giới thiệu
  } else if (it && rvIsPractice(it)) {
    // extra/redo/drill: sai → hỏi lại tối đa RV_DRILL_MAX_TRIES lần, mỗi lần ĐỔI dạng so với lần sai.
    if (!ok && (it.tries || 0) + 1 < RV_DRILL_MAX_TRIES) {
      const failed = (it.failedTypes || []).concat(rvQuestion ? [rvQuestion.typeId] : []);
      rvQueue.items.splice(Math.min(RV_DRILL_GAP, rvQueue.items.length), 0, Object.assign({}, it, { tries: (it.tries || 0) + 1, failedTypes: failed }));
    }
  } else if (it) {
    rvQueue.answeredCount++;
    if (!Array.isArray(rvQueue.completedCards)) rvQueue.completedCards = [];
    rvQueue.completedCards.push({ hz: it.word.hz, l: it.word.l, correct: ok, at: Date.now() });
    if (ok) { sessionKnownHz.add(it.word.hz); saveSessionKnownHz(); sqPurgeHzFromAllQueues(it.word.hz); } // V74: loại khỏi TẤT CẢ tab khác; FIX: persist qua reload; purge khỏi hàng đợi tab khác
    else rvQueue.items.splice(Math.min(REPEAT_GAP, rvQueue.items.length), 0, Object.assign({}, it, { introExposurePending: false })); // V114: quay lại hàng đợi = KHÔNG còn là lượt đầu sau giới thiệu (introduced vẫn giữ → không hiện lại màn giới thiệu)
  }
  const savedKey = rvStorageMode();
  if (!rvQueue.items.length) {
    rvQueue.endTime = Date.now();
    if (!rvQueue.practiceOnly) {
      ssArchiveSession(savedKey, rvQueue);
      refreshServerMeta(); sqClearPersisted(savedKey); // hết phiên — làm mới streak/known thật, dọn session đã lưu
    }
  } else if (!rvQueue.practiceOnly) {
    sqPersist(savedKey, rvQueue, { summary: rvSummary, log: rvLog }); // FIX (Bug 2 — session persistence): lưu lại sau mỗi câu để refresh không mất tiến trình
  }
  rvPrepareCurrentCard();
  render();
}

// ── V106: nguồn thứ 3 — từ người học hay trả lời sai (từ hồ sơ kỹ năng), trộn xen kẽ vào buổi học ──────
// Giới hạn: ≤ 25% số thẻ chính thức (tối thiểu 1 khi buổi có ≥4 thẻ), ≤ RV_EXTRA_MAX. KHÔNG thay thế và KHÔNG
// chen lên trước thẻ FSRS nào: thẻ chính thức giữ nguyên thứ tự, extra chỉ xen vào giữa.
async function rvFetchWeakWords(limit) {
  if (isGuest || !authToken) return [];
  try {
    const audio = (typeof skillAudioAvailable === 'function' && skillAudioAvailable()) ? 1 : 0;
    const res = await fetch(`/api/skills/practice-words?skill=mixed&weakOnly=1&limit=${limit}&allowListening=${audio}`, { headers: authHeaders() });
    const d = await res.json().catch(() => null);
    if (!d || !d.ok || !Array.isArray(d.words)) return [];
    return d.words;
  } catch { return []; }
}
function rvWordOf(row) { return WORDS.find(x => x.hz === row.hz && x.l === row.l) || WORDS.find(x => x.hz === row.hz) || null; }
async function rvAddExtras(items) {
  const officialN = items.length;
  const cap = officialN ? Math.min(RV_EXTRA_MAX, Math.max(officialN >= 4 ? 1 : 0, Math.floor(officialN / 4))) : RV_EXTRA_MAX;
  if (cap <= 0) return { items, extraCount: 0 };
  const rows = await rvFetchWeakWords(cap + 3);
  const inQueue = new Set(items.map(i => i.word.hz));
  const extras = [];
  for (const r of rows) {
    if (inQueue.has(r.hz) || extras.length >= cap) continue;
    const w = rvWordOf(r); if (!w) continue;
    inQueue.add(r.hz);
    extras.push({ type: 'extra', word: w, targetSkill: r.skill });
  }
  if (!extras.length) return { items, extraCount: 0 };
  const out = []; const step = Math.max(1, Math.ceil(items.length / (extras.length + 1)));
  let ei = 0;
  items.forEach((it, i) => { out.push(it); if ((i + 1) % step === 0 && ei < extras.length) out.push(extras[ei++]); });
  while (ei < extras.length) out.push(extras[ei++]);
  return { items: out, extraCount: extras.length };
}
// Chèn 1 bài ghép cặp (từ chính các từ chính thức của buổi) ở ~70% buổi học — chỉ khi có ≥4 từ khác nhau.
function rvInsertMatch(items) {
  const hzs = [...new Set(items.filter(rvIsOfficial).map(i => i.word.hz))];
  if (hzs.length < 4) return items;
  const pick = hzs.slice(0, 4);
  const out = items.slice();
  out.splice(Math.min(out.length, Math.max(1, Math.floor(out.length * 0.7))), 0, { type: 'match', hzs: pick });
  return out;
}
// Bài hiện tại của màn bắt đầu: các bài ĐANG CHỌN (server) mà buổi này thật sự có từ thuộc về (theo liên kết bài HIỆN TẠI
// `word.lessons`). KHÔNG dùng `word.l` — đó là cột bài cũ, có thể còn số bài đã bị xoá khỏi mục từ vựng.
function rvBuildStartInfo(items, extraCount, scopeLessons) {
  const scope = (Array.isArray(scopeLessons) ? scopeLessons : []).map(Number).filter(Number.isFinite);
  const fromWords = new Set();
  for (const it of items) {
    if (!rvIsOfficial(it) || !it.word || !Array.isArray(it.word.lessons)) continue;
    for (const l of it.word.lessons) fromWords.add(Number(l));
  }
  let lessons = scope.length ? scope.filter(l => fromWords.has(l)) : [...fromWords];
  if (!lessons.length && scope.length) lessons = scope.slice();
  lessons = [...new Set(lessons)].sort((a, b) => a - b);
  const newCount = items.filter(i => i.type === 'new').length;
  const reviewCount = items.filter(i => i.type === 'review').length;
  const matchN = items.filter(i => i.type === 'match').length;
  return { lessons, newCount, reviewCount, extraCount, estimated: reviewCount + newCount * 2 + extraCount + matchN };
}
function rvBeginSession() {
  if (rvStage !== 'start') return;
  rvStage = 'run';
  rvPrepareCurrentCard(); // đo lại responseTime từ lúc người học thực sự bấm "Bắt đầu"
  render();
}

// Luyện bổ sung độc lập (không FSRS, không lưu phiên): từ hay sai / luyện lại câu sai.
function rvBeginPracticeOnly(items) {
  rvQueue = sqCreate();
  rvQueue.practiceOnly = true;
  rvQueue.sessionId = genIdempotencyKey();
  rvQueue.startTime = Date.now();
  rvQueue.dayKey = todayKey();
  rvQueue.lessonFilter = sqSnapshotLessonFilter();
  rvQueue.items = items;
  rvQueue.totalPlanned = items.length;
  rvStage = 'run'; rvStartInfo = null;
  rvPrepareCurrentCard();
  render();
}
async function rvStartWeakPractice() {
  const rows = await rvFetchWeakWords(10);
  const items = [];
  for (const r of rows) { const w = rvWordOf(r); if (w) items.push({ type: 'redo', word: w, targetSkill: r.skill }); }
  if (!items.length) { alert('Chưa có từ nào đủ dữ liệu để kết luận là hay trả lời sai.'); return; }
  rvBeginPracticeOnly(items);
}
// Luyện lại câu sai (dạng 10): các từ có lần trả lời CUỐI trong buổi là sai; hỏi bằng DẠNG KHÁC lần sai.
function rvStartRedoWrong() {
  const last = new Map();
  for (const e of rvLog) last.set(e.hz, e);
  const failedByHz = new Map();
  for (const e of rvLog) if (!e.correct && e.typeId !== 'match') { (failedByHz.get(e.hz) || failedByHz.set(e.hz, new Set()).get(e.hz)).add(e.typeId); }
  const items = [];
  for (const e of last.values()) {
    if (e.correct) continue;
    const w = WORDS.find(x => x.hz === e.hz && x.l === e.l) || WORDS.find(x => x.hz === e.hz);
    if (!w) continue;
    items.push({ type: 'redo', word: w, failedTypes: [...(failedByHz.get(e.hz) || [])], targetSkill: e.skill });
  }
  if (!items.length) { alert('Không có câu sai nào để luyện lại.'); return; }
  rvBeginPracticeOnly(items);
}
