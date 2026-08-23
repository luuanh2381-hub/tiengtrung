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
const RV_QUIZ_TYPE = 'hz2vi'; // Phần 1: mặc định hỏi "chữ Hán → nghĩa", khớp đúng ví dụ trong yêu cầu V67

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
async function startStudySession(weakMode, forceNew) {
  rvWeakMode = !!weakMode;
  const savedKey = rvStorageMode();
  if (!forceNew) {
    // FIX (Vấn đề 3 — "Học tiếp" phải khôi phục ĐỦ queue/currentIndex/lessonFilter/completedCards/
    // answeredCards/seenCards): đọc thẳng qua sqReadPersisted() dùng chung với 4 tab kia, rồi gán
    // trực tiếp vào rvQueue (thay vì trước đây copy tay từng field vào các biến rời rvSession/...).
    const saved = sqReadPersisted(savedKey);
    if (saved && saved.items.length && sqLessonFilterMatches(saved.lessonFilter)) {
      const filteredItems = saved.items.filter(it => !sessionKnownHz.has(it.word.hz));
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
  rvQueue.sessionId = genIdempotencyKey();
  rvQueue.startTime = Date.now();
  rvQueue.lessonFilter = sqSnapshotLessonFilter();
  rvQueue.dayKey = todayKey();
  goTab('review');
  const el = document.getElementById('content');
  if (el) el.innerHTML = `<div class="study-empty">Đang tải phiên học...</div>`;
  const { list, error, reviewCount, newCount, blockedByBacklog, totalDue } = await rvFetchFreshSession(false);
  if (error) { alert(error); goTab('today'); return; }
  rvQueue.items = list;
  rvSummary = { reviewCount: reviewCount || 0, newCount: newCount || 0 };
  rvBlockedByBacklog = !!blockedByBacklog;
  rvTotalDue = totalDue || 0;
  rvQueue.totalPlanned = rvQueue.items.length;
  // Nạp trước kho ví dụ cho các bài xuất hiện trong session (Phần 24) — không chặn hiển thị.
  const lessonsInSession = [...new Set(rvQueue.items.map(it => it.word.l))];
  if (lessonsInSession.length && !isGuest && authToken) {
    fetch('/api/word-examples?lessons=' + lessonsInSession.join(','), { headers: authHeaders() })
      .then(r => r.json()).then(d => { if (d.ok) rvExamplePool = d.examples || []; })
      .catch(() => {});
  }
  sqPersist(savedKey, rvQueue, { summary: rvSummary });
  rvPrepareCurrentCard();
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

// Sinh 4 lựa chọn trắc nghiệm cho thẻ Ở ĐẦU hàng đợi (currentIndex = rvQueue.items[0]), và bắt đầu
// đo responseTime NGAY tại đây (thời điểm câu hỏi thực sự sẵn sàng cho user — Phần 4).
function rvPrepareCurrentCard() {
  if (!rvQueue.items.length) return;
  const w = rvQueue.items[0].word;
  rvOptions = rvMakeOpts(w);
  rvAnswerChanges = 0;
  rvPhase = 'question';
  rvLastAnswer = null;
  // Bổ sung "Highlight System Rating": dọn sạch trạng thái rating của câu TRƯỚC ĐÓ trước khi hiện
  // câu mới — tránh còn sót highlight/countdown của câu cũ.
  rvClearCountdown();
  rvRatingPhase = null; rvSystemRating = null; rvUserRating = null; rvFinalRating = null; rvPendingReview = null;
  rvStartedAt = performance.now();
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
  const clickable = rvRatingPhase === 'pending';
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
  if (rvRatingPhase === 'loading') hint = '⏳ Đang tính gợi ý hệ thống...';
  else if (rvRatingPhase === 'pending' && rvSystemRating) {
    hint = `Hệ thống đề xuất: <b>${RV_RATING_META[rvSystemRating].label}</b> · Tự động chọn sau <span id="rv-countdown-num">${Math.ceil(RV_AUTO_COMMIT_MS / 1000)}</span>s`;
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
        quizType: RV_QUIZ_TYPE,
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
  rvCountdownEndAt = Date.now() + RV_AUTO_COMMIT_MS;
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
  if (rvRatingPhase !== 'pending' || !RV_RATING_ORDER.includes(rating)) return;
  rvCommitRating(rvAttemptId, rating);
}

// Chốt Final Rating (chosenRating do user bấm, hoặc null nếu do countdown hết giờ) rồi gửi lên
// /api/study/review thật. Đặt rvRatingPhase='committing' NGAY (đồng bộ, trước await đầu tiên) để
// chặn commit lần 2 nếu click và hết giờ xảy ra gần như đồng thời (Phần 7 — "không cho timeout
// tiếp tục commit lần thứ hai").
async function rvCommitRating(attemptId, chosenRating) {
  if (attemptId !== rvAttemptId || currentTab !== 'review' || rvRatingPhase !== 'pending') return;
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
    word: w, quizType: RV_QUIZ_TYPE, selectedAnswer: pending.selectedAnswer,
    responseTimeMs: pending.responseTimeMs, answerChanges: pending.answerChanges,
    rating: rvFinalRating,
  }).then(data => {
    if (attemptId !== rvAttemptId || currentTab !== 'review') return;
    if (data && data.ok) {
      rvLastAnswer = { correct: data.answerCorrect, card: data.card, autoRating: data.debug ? data.debug.autoRating : null };
      if (data.rating) rvFinalRating = data.rating; // server luôn là nguồn sự thật cuối (Phần 20)
    }
    rvRatingPhase = 'done';
    render();
  });
  await Promise.all([reviewPromise, new Promise(r => setTimeout(r, 1000))]);
  if (attemptId !== rvAttemptId || currentTab !== 'review') return;
  rvRatingPhase = 'done';
  rvAdvanceQueue();
}

function renderReview() {
  if (!rvQueue.items.length) {
    // FIX (audit — màn "Xong phiên học! Đã ôn 0 từ, học 0 từ mới" gây hiểu lầm là lỗi): tách riêng
    // "chưa từng có gì để học" (kèm lý do cụ thể) khỏi "đã thật sự học xong 1 phiên có thẻ".
    if (rvSummary.reviewCount === 0 && rvSummary.newCount === 0) {
      const reason = rvBlockedByBacklog
        ? `⏳ Bạn đang có ${rvTotalDue} thẻ CẦN ÔN đến hạn (có thể ở Quyển/bài khác ngoài phạm vi đang chọn) — hệ thống đang chặn học từ mới cho tới khi ôn hết backlog này (cài đặt "Chỉ học từ mới sau khi hết backlog ôn tập" đang bật). Vào Cài đặt hằng ngày để tắt, hoặc chọn đúng Quyển/bài đang có thẻ due để ôn trước.`
        : `Không có thẻ nào đến hạn ôn hoặc còn trong ngân sách từ mới hôm nay ở phạm vi Quyển/bài đang chọn.`;
      return `<div class="rv-done">
        <div class="rv-done-num">📭</div>
        <div style="font-size:1.3rem;font-weight:800;margin:10px 0;">Chưa có gì để học</div>
        <div style="color:var(--muted);margin-bottom:20px;">${reason}</div>
        <button class="btn btn-primary" onclick="goTab('today')">Về Hôm nay học</button>
      </div>`;
    }
    return `<div class="rv-done">
      <div class="rv-done-num">🎉</div>
      <div style="font-size:1.3rem;font-weight:800;margin:10px 0;">Xong phiên học!</div>
      <div style="color:var(--muted);margin-bottom:20px;">Đã ôn ${rvSummary.reviewCount} từ, học ${rvSummary.newCount} từ mới.</div>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="startStudySession(${rvWeakMode}, true)">▶️ Học tiếp</button>
        <button class="btn" onclick="rvRelearnFromStart()">🔁 Học lại từ đầu</button>
        <button class="btn" style="background:var(--border)" onclick="goTab('today')">Về Hôm nay học</button>
      </div>
    </div>`;
  }
  const item = rvQueue.items[0];
  const w = item.word;
  const pct = Math.min(100, Math.round((rvQueue.answeredCount / (rvQueue.totalPlanned||1)) * 100));
  const tagLabel = item.type === 'new' ? '🆕 Từ mới' : '🔁 Ôn tập';
  let body;
  if (rvPhase === 'question') {
    // Chỉ 1 bước duy nhất: nhìn chữ Hán → chọn nghĩa đúng (Phần 1/17). Không có bước "tự nhớ rồi
    // bấm Đúng/Sai" riêng như v66 — hệ thống tự xác định đúng/sai khi user chọn đáp án.
    const optHtml = rvOptions.map(o =>
      `<button class="quiz-opt" data-v="${o.vi}" onclick="rvPick(this,'${o.hz}')" ${rvSubmitting ? 'disabled' : ''}>${o.vi}</button>`
    ).join('');
    body = `
      <div class="rv-tag">${tagLabel} · Bài ${w.l}</div>
      <div class="rv-hz">${w.hz}</div>
      ${showPinyin ? `<div class="rv-py">${w.py || ''}</div>` : ''}
      <div class="rv-prompt">${w.hz} là gì?</div>
      <div class="quiz-opts" id="rv-opts">${optHtml}</div>`;
  } else {
    // Đã có kết quả trắc nghiệm: lộ đáp án đầy đủ + bổ sung "Highlight System Rating" — hiện lại 4
    // nút Again/Hard/Good/Easy, highlight nút hệ thống đề xuất, cho user xác nhận/đổi trước khi
    // commit thật lên FSRS (thay cho hành vi 100% tự động của V67).
    const r = rvLastAnswer;
    const ex = rvFindExample(w.hz);
    // YÊU CẦU (theo yêu cầu người dùng): riêng ở màn "kết quả" (đã trả lời) của "Hôm nay học",
    // Pinyin và Hán Việt LUÔN hiện để củng cố trí nhớ ngay sau khi biết đáp án — không theo nút
    // "Ẩn Pinyin"/"Ẩn Hán Việt" ở thanh công cụ (2 nút đó vẫn áp dụng bình thường cho MỌI chỗ
    // khác: màn câu hỏi ở trên, Flashcard, Trắc nghiệm, Gõ chữ, Nghe chọn). showMeaning (nghĩa
    // tiếng Việt) không đổi — vẫn theo đúng nút "Ẩn nghĩa" như trước.
    let savedLine = '';
    if (rvRatingPhase === 'committing') savedLine = `<div class="rv-saved-line">⏳ Đang lưu...</div>`;
    else if (rvRatingPhase === 'done') savedLine = `<div class="rv-saved-line">${rvSavedLine(r)}</div>`;
    body = `
      <div class="rv-tag">${tagLabel} · Bài ${w.l}</div>
      <div class="rv-hz">${w.hz}</div>
      <div class="rv-feedback" style="color:${r && r.correct ? 'var(--l8a)' : 'var(--l10a)'};">
        ${r && r.correct ? '✅ Chính xác' : '❌ Chưa đúng'}
      </div>
      <div class="rv-py">${w.py || ''}</div>
      ${showMeaning ? `<div class="rv-vi">${w.vi || ''}</div>` : ''}
      ${w.hanviet ? `<div class="rv-hv">Hán Việt: ${w.hanviet}</div>` : ''}
      ${renderHanziParts(w.hz)}
      ${ex ? `<div class="rv-ex">${ex.zh}<br><span style="color:var(--muted);font-size:.85rem;">${ex.vi}</span></div>` : ''}
      ${rvRenderRatingBar()}
      ${savedLine}
      ${(!isGuest && isAdminRole() && r && r.autoRating) ? `<div class="rv-saved-line">🐞 debug: auto rating = ${r.autoRating}</div>` : ''}`;
  }
  return `
    <div class="rv-progress-wrap"><div class="rv-progress-fill" style="width:${pct}%;"></div></div>
    <div class="rv-counter">Câu ${rvQueue.answeredCount + 1} · còn ${rvQueue.items.length} trong hàng đợi</div>
    <div class="rv-card">${body}</div>
  `;
}

// Đánh dấu đáp án đúng lên từng nút NGAY SAU KHI render xong (Phần 17), giống cách bindQuiz đang
// làm cho tab Trắc nghiệm — để rvPick() biết ngay đáp án vừa chọn đúng hay sai mà không cần chờ
// server trả lời (server vẫn là nguồn sự thật cuối cùng, việc này chỉ để phản hồi UI tức thời).
function bindReview() {
  if (rvPhase !== 'question' || !rvQueue.items.length) return;
  const w = rvQueue.items[0].word;
  document.querySelectorAll('#rv-opts .quiz-opt').forEach(b => {
    b._correct = (b.dataset.v === w.vi);
  });
}

// ── Phần 1/3/4/17/20: user chọn 1 đáp án → khoá UI, hiện đúng/sai tức thời → gửi
//     selectedAnswer + responseTimeMs lên server (server tự xác định lại đúng/sai + tự suy ra
//     FSRS rating + gọi ts-fsrs + lưu). ──
let rvAttemptId = 0; // FIX: đánh dấu lượt trả lời hiện tại — phản hồi server đến TRỄ (sau khi user
                      // đã sang câu khác) sẽ tự bị bỏ qua thay vì ghi đè nhầm màn hình câu sau.
async function rvPick(btn, hz) {
  if (rvSubmitting || rvPhase !== 'question') return;
  rvSubmitting = true;
  const responseTimeMs = Math.round(performance.now() - rvStartedAt); // Phần 4
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

  // Hiện đáp án NGAY bằng kết quả đã biết ở client (đáp án đúng đã nhúng sẵn trong DOM) — không đợi
  // Neon mới hiện đúng/sai, giữ UI phản hồi tức thời.
  rvLastAnswer = { correct: isCorrectLocally, card: null, autoRating: null };
  rvPhase = 'answered';
  // Bổ sung "Highlight System Rating": KHÔNG commit thẳng lên FSRS nữa — trước tiên hỏi server gợi
  // ý System Rating (chỉ đọc), rồi hiện 4 nút Again/Hard/Good/Easy + countdown cho user xác nhận.
  rvRatingPhase = 'loading';
  rvSystemRating = null; rvUserRating = null; rvFinalRating = null;
  rvPendingReview = { selectedAnswer, responseTimeMs, answerChanges: rvAnswerChanges };
  rvSubmitting = false;
  render();

  const systemRating = await rvFetchSystemRating({ word: w, selectedAnswer, responseTimeMs, answerChanges: rvAnswerChanges });
  if (attemptId !== rvAttemptId || currentTab !== 'review') return; // user đã sang câu khác/rời tab trong lúc chờ
  rvSystemRating = systemRating;
  rvRatingPhase = 'pending';
  render();
  rvStartCountdown(attemptId);
}

// V71/V78: thẻ Ở ĐẦU hàng đợi (rvQueue.items[0] = currentIndex) bị loại NGAY LẬP TỨC sau khi có kết
// quả server. Đúng → loại vĩnh viễn khỏi phiên. Sai (Again) → chèn lại cách tối thiểu REPEAT_GAP
// thẻ khác, KHÔNG gọi lại server giữa phiên — hàng đợi cạn thật (kể cả các thẻ Again đã được xử lý
// xong) mới coi là hết. Hàm này tương đương sqAdvance() ở study-queue.js nhưng thao tác trên item
// dạng {type,word} thay vì thẳng word — vẫn dùng CHUNG đúng field completedCards/answeredCount/
// endTime/sessionKnownHz với 4 tab kia (Vấn đề 6/7), chỉ khác cách truy cập .word.hz.
function rvAdvanceQueue() {
  if (currentTab !== 'review') return; // user đã rời màn hình, tránh render nhầm chỗ
  const it = rvQueue.items.shift();
  if (it) {
    rvQueue.answeredCount++;
    const isCorrect = !!(rvLastAnswer && rvLastAnswer.correct);
    if (!Array.isArray(rvQueue.completedCards)) rvQueue.completedCards = [];
    rvQueue.completedCards.push({ hz: it.word.hz, l: it.word.l, correct: isCorrect, at: Date.now() });
    if (isCorrect) { sessionKnownHz.add(it.word.hz); saveSessionKnownHz(); sqPurgeHzFromAllQueues(it.word.hz); } // V74: loại khỏi TẤT CẢ tab khác; FIX: persist qua reload; purge khỏi hàng đợi tab khác
    else rvQueue.items.splice(Math.min(REPEAT_GAP, rvQueue.items.length), 0, it);
  }
  const savedKey = rvStorageMode();
  if (!rvQueue.items.length) {
    rvQueue.endTime = Date.now();
    ssArchiveSession(savedKey, rvQueue);
    refreshServerMeta(); sqClearPersisted(savedKey); // hết phiên — làm mới streak/known thật, dọn session đã lưu
  } else {
    sqPersist(savedKey, rvQueue, { summary: rvSummary }); // FIX (Bug 2 — session persistence): lưu lại sau mỗi câu để refresh không mất tiến trình
  }
  rvPrepareCurrentCard();
  render();
}
