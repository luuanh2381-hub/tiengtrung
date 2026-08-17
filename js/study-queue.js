// js/study-queue.js — Lõi dùng CHUNG mọi tab luyện tập: submitFsrsReview() (gửi 1 lượt trả lời lên FSRS-6 thật), outbox chống mất dữ liệu khi mất mạng, và sq*() = hàng đợi chống lặp dùng chung (V71)
// ── Ánh xạ chế độ hỏi ở UI → quizType mà server hiểu (Task 2/3: server luôn tự xác định đúng/sai
//     và tự suy FSRS rating — KHÔNG có quizType nào KHÔNG đi qua đây). 'listen' (Nghe-chọn) dùng
//     lại đúng ngữ nghĩa 'vi2hz' (đáp án cần chọn là chữ Hán) vì server chỉ cần biết đáp án đúng
//     là w.hz hay w.vi, không cần phân biệt "nghe" hay "đọc nghĩa" ở tầng so khớp đáp án. ──
function fsrsQuizTypeFor(mode) {
  if (mode === 'Việt→漢' || mode === 'type' || mode === 'listen') return 'vi2hz';
  if (mode === 'Âm→漢') return 'py2hz';
  return 'hz2vi'; // '漢→Việt' hoặc mặc định
}

// ── Lấy pool từ CHÍNH hàng đợi FSRS thật (reviewService + scheduler) của user đang đăng nhập —
//     dùng CHUNG cho Flashcard/Trắc nghiệm/Gõ chữ/Nghe-chọn, giống hệt "Hôm nay học" (Task 2: cấm
//     "review queue riêng"). Vì cùng gọi /api/study/session, 4 tab luyện tập này CHIA SẺ chung 1
//     ngân sách due/new mỗi ngày với "Hôm nay học" — không phải 4 nguồn đếm riêng biệt nữa. ──
async function loadFsrsPracticePool(limit) {
  try {
    const res = await fetch('/api/study/session', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) return { words: [], error: data.error || 'Không tải được hàng đợi FSRS' };
    // FIX (Bug 2 gốc — đổi số câu/số thẻ làm hàng đợi rỗng hoặc thiếu từ): TRƯỚC ĐÂY .slice(0,
    // limit) cắt NGAY TẠI ĐÂY, TRƯỚC KHI sqLoad() lọc sessionKnownHz. Nếu N từ ĐẦU danh sách server
    // trả về đã được trả lời ĐÚNG trong phiên (rất hay gặp khi vừa đổi limit giữa phiên đang học),
    // slice(0, limit) chỉ vớt đúng nhóm "đã học" đó — lọc sessionKnownHz xong hàng đợi trống trơn dù
    // server còn thừa rất nhiều thẻ due/new phía sau. KHÔNG cắt ở đây nữa: trả về NGUYÊN danh sách
    // (đã bị chặn ở mức ngân sách/ngày phía server rồi nên không quá lớn), để sqLoad() lọc
    // sessionKnownHz xong MỚI cắt đúng limit — thứ tự lọc-rồi-cắt, không phải cắt-rồi-lọc.
    const words = (data.session || []).map(it => it.word);
    return { words, blockedByBacklog: !!data.blockedByBacklog, totalDue: data.totalDue || 0 };
  } catch (e) {
    return { words: [], error: e.message };
  }
}

// FIX (Task 3 - mat du lieu khi mat mang/dong tab/F5): outbox localStorage cho review gui KHONG
// THANH CONG. Ghi payload vao outbox khi fetch loi; tu gui lai khi co mang / quay lai tab / mo app
// lan sau - review khong con bi mat cam lang nua.
function reviewOutboxKey() { return 'reviewOutbox_' + (authUsername || ''); }
function loadReviewOutbox() {
  try { return JSON.parse(localStorage.getItem(reviewOutboxKey()) || '[]'); } catch { return []; }
}
function saveReviewOutbox(list) {
  try { localStorage.setItem(reviewOutboxKey(), JSON.stringify(list)); } catch {}
}
// FIX (Bug 1 gốc — mất review khi refresh/đóng tab giữa lúc request đang bay): TRƯỚC ĐÂY outbox
// chỉ được ghi trong NHÁNH LỖI của _submitFsrsReviewImpl (add-on-failure) — nếu trang bị đóng/F5
// đúng lúc request ĐANG BAY (chưa kịp thành công lẫn chưa kịp báo lỗi), request bị trình duyệt huỷ
// giữa chừng, nhánh lỗi KHÔNG BAO GIỜ chạy tới, payload KHÔNG BAO GIỜ vào outbox — mất vĩnh viễn dù
// UI đã hiện "đã học". Giờ ghi outbox NGAY TRƯỚC KHI gửi (write-ahead) — an toàn dù request có kịp
// xong hay không; gỡ khỏi outbox theo đúng idempotencyKey khi CÓ kết quả (thành công hoặc lỗi vĩnh
// viễn). Luôn đọc lại localStorage MỚI NHẤT ngay trước khi ghi (KHÔNG giữ 1 bản list cũ qua await)
// để không ghi đè mất các thay đổi đồng thời từ lượt submit/flush khác đang chạy song song.
function addToOutbox(payload) {
  const list = loadReviewOutbox();
  list.push({ payload, queuedAt: Date.now() });
  saveReviewOutbox(list);
}
function removeFromOutbox(idempotencyKey) {
  if (!idempotencyKey) return;
  const list = loadReviewOutbox();
  const next = list.filter(e => e.payload.idempotencyKey !== idempotencyKey);
  if (next.length !== list.length) saveReviewOutbox(next);
}
// V74: phan biet loi TAM THOI (mat mang, hoac server 5xx vi DB/lock tam thoi truc trac) - nen giu
// trong outbox de thu lai - voi loi VINH VIEN (HTTP 200 nhung ok:false vi payload thieu/sai du lieu) -
// khong nen lap lai vo han. Truoc day ca submitFsrsReview lan flushReviewOutbox deu chi xet fetch() co
// throw hay khong, nen 1 loi 500 tam thoi (khong throw, van co JSON hop le) bi coi la "da xong" va mat
// vinh vien: review thanh cong tren UI nhung KHONG duoc luu vao database.
function isRetryableReviewFailure(res, data) {
  if (!res) return true; // fetch throw hang: mat mang/CORS -> luon thu lai
  if (res.status >= 500) return true; // loi server tam thoi -> thu lai
  return !data; // JSON khong doc duoc (vd server crash giua chung) -> coi la tam thoi, thu lai
}
let _flushingOutbox = false;
// FIX (Bug 1 — race điều kiện outbox): TRƯỚC ĐÂY đọc `list` 1 LẦN ở đầu vòng lặp rồi await fetch()
// — trong lúc await đó, 1 lượt submitFsrsReview() KHÁC (user trả lời câu tiếp theo trong lúc outbox
// đang tự gửi lại) có thể ghi thêm/gỡ bớt outbox; khi vòng lặp này quay lại `saveReviewOutbox(list)`
// với bản `list` CŨ đã chụp từ đầu, nó GHI ĐÈ mất đúng thay đổi đồng thời đó. Giờ đọc lại outbox MỚI
// NHẤT ở đầu MỖI vòng lặp, và gỡ đúng 1 mục theo idempotencyKey (không dùng list[0]/shift() dựa vào
// vị trí đã chụp trước đó nữa) — an toàn dù có nhiều nơi cùng đọc/ghi outbox song song.
async function flushReviewOutbox() {
  if (_flushingOutbox || !isLoggedIn()) return;
  _flushingOutbox = true;
  try {
    while (true) {
      const list = loadReviewOutbox();
      if (!list.length) break;
      const entry = list[0];
      let res, data;
      try {
        res = await fetch('/api/study/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(entry.payload),
          keepalive: true, // sống sót qua lúc tab bị đóng/điều hướng giữa chừng request này
        });
        data = await res.json().catch(() => null);
      } catch (e) { break; } // van mat mang - dung, thu lai o lan trigger ke tiep (con nguyen trong outbox)
      if (!data || !data.ok) {
        if (isRetryableReviewFailure(res, data)) break; // loi tam thoi - GIU nguyen trong outbox, thu lai sau
        removeFromOutbox(entry.payload.idempotencyKey); // loi vinh vien (payload sai) - bo qua muc nay de khong ket outbox mai mai
        continue;
      }
      removeFromOutbox(entry.payload.idempotencyKey);
    }
  } finally { _flushingOutbox = false; }
}
window.addEventListener('online', flushReviewOutbox);
// V74: rời khỏi trang (đổi tab trình duyệt, khoá màn hình, chuyển app khác) phải DỪNG đếm giờ học
// ngay lập tức, không chỉ dừng khi chuyển tab TRONG app (render() đã xử lý việc đó). Quay lại thì
// ensureStudySession() tự nối tiếp đúng phiên cũ nếu còn trong 15 phút (không mất, không đếm bù thời
// gian đã rời đi) — tái dùng đúng 2 hàm đã có, không tạo thêm cơ chế mới.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    flushReviewOutbox();
    if (STUDY_TABS.has(currentTab)) ensureStudySession();
  } else if (STUDY_TABS.has(currentTab)) {
    pauseStudyTimer();
  }
});
// Đóng tab/đóng app/điều hướng đi nơi khác: gửi 1 heartbeat cuối cùng (keepalive để sống sót qua lúc
// trang đang bị huỷ) để không mất vài giây/phút học cuối cùng trước khi heartbeat 20s kế tiếp kịp chạy.
window.addEventListener('pagehide', () => {
  if (studySession.id) {
    try {
      fetch('/api/study/session/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ sessionId: studySession.id }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }
  // FIX (Bug 1 — "có flush trước unload"): cố gắng gửi NỐT mọi review còn kẹt trong outbox ngay lúc
  // trang bị đóng/điều hướng đi (vd review vừa write-ahead vào outbox nhưng fetch() gốc trong
  // _submitFsrsReviewImpl chưa kịp xong). Best-effort — KHÔNG await (unload có thể huỷ context
  // trước khi await tiếp tục chạy) — vẫn AN TOÀN dù request này không kịp hoàn tất, vì: (1) outbox
  // đã giữ sẵn payload (write-ahead) nên lần mở app kế tiếp (bootAuth → flushReviewOutbox) vẫn tự
  // gửi lại; (2) idempotencyKey khiến việc gửi trùng (request này VÀ flush lần sau) không tạo 2
  // dòng lịch sử / không chạy FSRS 2 lần.
  try {
    for (const entry of loadReviewOutbox()) {
      fetch('/api/study/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(entry.payload),
        keepalive: true,
      }).catch(() => {});
    }
  } catch {}
});

// FIX (Ưu tiên 6 — API submit phải idempotent): sinh 1 khoá duy nhất cho MỖI lượt trả lời thật.
// Khoá này đi kèm payload xuyên suốt outbox/retry, để server nhận diện 2 lần gửi CÙNG 1 lượt trả
// lời (double-click lọt qua UI-disable, mất phản hồi giữa đường rồi outbox gửi lại, v.v.) và không
// tạo 2 dòng lịch sử / không chạy FSRS 2 lần cho cùng 1 câu trả lời — xem lib/db.js:reviewFsrsCard.
function genIdempotencyKey() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'k_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
}

// FIX (Ưu tiên 6 — chống double-click lọt qua disable UI): theo dõi các lượt đang gửi dở theo
// hz+l+quizType — nếu cùng 1 thẻ/chiều hỏi đang có 1 lượt CHƯA xong mà bị gọi lại lần nữa (double
// click rất nhanh trước khi DOM kịp disable, hoặc code gọi nhầm 2 lần), trả lại CHÍNH promise đang
// chạy thay vì tạo 1 request thứ 2.
const _inFlightReviews = new Map();

// -- Gui 1 luot tra loi len reviewService (FSRS-6 that) - dung CHUNG cho MOI tab luyen tap
// (Review/Flashcard/Trac nghiem/Go chu/Nghe-chon) cua user da dang nhap. Server luon la nguon su
// that cuoi cung cho answerCorrect + rating. --
function submitFsrsReview(args) {
  const w = args.word;
  const inFlightKey = w.hz + '|' + w.l + '|' + args.quizType;
  if (_inFlightReviews.has(inFlightKey)) return _inFlightReviews.get(inFlightKey);
  const p = _submitFsrsReviewImpl(args).finally(() => _inFlightReviews.delete(inFlightKey));
  _inFlightReviews.set(inFlightKey, p);
  return p;
}
// FIX (Bug 1 gốc — write-ahead): ghi outbox NGAY TRƯỚC KHI gửi (không còn "add-on-failure" như
// trước — nếu trang bị đóng/F5 đúng lúc request đang bay, nhánh lỗi/catch không kịp chạy nên
// payload không bao giờ vào outbox, mất vĩnh viễn). Thêm keepalive để request sống sót qua lúc
// trang bị đóng/điều hướng giữa chừng. Gỡ khỏi outbox theo idempotencyKey khi có kết quả xác định
// (thành công HOẶC lỗi vĩnh viễn) — lỗi tạm thời/mất mạng thì GIỮ nguyên trong outbox (đã nằm sẵn
// từ write-ahead, không cần xử lý gì thêm ở nhánh đó).
async function _submitFsrsReviewImpl({ word, quizType, selectedAnswer, responseTimeMs, answerChanges }) {
  const payload = {
    wordId: { hz: word.hz, l: word.l },
    quizType,
    selectedAnswer,
    responseTimeMs: Number.isFinite(responseTimeMs) ? Math.round(responseTimeMs) : null,
    answerChanges: Number.isFinite(answerChanges) ? answerChanges : 0,
    idempotencyKey: genIdempotencyKey(),
  };
  addToOutbox(payload);
  let res, data;
  try {
    res = await fetch('/api/study/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    console.error('Loi ket noi khi luu review - da nam san trong outbox (write-ahead) de gui lai:', e);
    return { ok: false, error: e.message, queued: true }; // đã nằm sẵn trong outbox từ addToOutbox() ở trên
  }
  if (!data || !data.ok) {
    console.error('Khong luu duoc luot review:', data && data.error);
    if (isRetryableReviewFailure(res, data)) {
      // V74: loi server tam thoi (vd 500 do DB/lock) khong duoc coi la "xong" - GIU nguyen trong
      // outbox (da nam san tu write-ahead), neu khong review nay se mat vinh vien du UI da bao "da luu".
      return { ok: false, error: data && data.error, queued: true };
    }
    removeFromOutbox(payload.idempotencyKey); // loi vinh vien (payload sai) - bo khoi outbox, khong lap lai mai mai
    return data || { ok: false, error: 'Phan hoi khong hop le tu server' };
  }
  removeFromOutbox(payload.idempotencyKey); // thanh cong - go khoi outbox
  bumpStudySessionCounters(!!data.answerCorrect); // Task 4: cards_reviewed/dung/sai tang dan theo THOI GIAN THUC
  return data;
}

// FIX (Bug 1 — "UI không được chuyển câu khi Neon chưa lưu"): wrapper CHỜ submitFsrsReview() thay
// vì để bindX() chạy nền không chờ như trước — dùng ở mọi bindX() trước khi advance sang câu kế
// tiếp. Vẫn có TRẦN chờ tối đa (không treo UI vô hạn nếu mạng chết hẳn) — an toàn về dữ liệu dù rơi
// vào nhánh timeout, vì payload đã write-ahead vào outbox NGAY từ đầu _submitFsrsReviewImpl, không
// phụ thuộc gì vào việc caller có đợi đủ lâu hay không; outbox tự gửi lại ở lần online/quay lại
// tab/mở app kế tiếp (xem flushReviewOutbox).
const SUBMIT_REVIEW_MAX_WAIT_MS = 6000;
function submitFsrsReviewAwaited(args) {
  return Promise.race([
    submitFsrsReview(args),
    new Promise(resolve => setTimeout(() => resolve({ ok: false, timedOut: true, queued: true }), SUBMIT_REVIEW_MAX_WAIT_MS)),
  ]);
}

// ════════════════════════════════════════════════════
// V71 (Audit lặp từ) — HÀNG ĐỢI CHỐNG LẶP dùng CHUNG cho MỌI tab học (Hôm nay học/Flashcard/Trắc
// nghiệm/Gõ chữ/Nghe-chọn). Xem báo cáo audit đính kèm để biết nguyên nhân gốc; đây là cơ chế sửa.
// Quy tắc: (1) thẻ vừa trả lời ĐÚNG bị loại khỏi phiên NGAY LẬP TỨC, không nạp lại trong phiên
// này; (2) thẻ bị SAI (Again) được chèn lại nhưng cách tối thiểu REPEAT_GAP thẻ khác; (3) hàng đợi
// nạp 1 LẦN từ đúng /api/study/session (FSRS thật), không random toàn bộ database, không tự ý gọi
// lại server giữa chừng 1 phiên trừ khi hàng đợi đã cạn hẳn.
//
// V74 (audit lặp câu hỏi — bổ sung): quy tắc (1) ở trên trước đây chỉ đúng BÊN TRONG 1 lần nạp
// hàng đợi. Có 2 lỗ hổng khiến thẻ vừa trả lời ĐÚNG vẫn hiện lại: (a) mỗi tab (Flashcard/Trắc
// nghiệm/Gõ chữ/Nghe-chọn) tự giữ 1 hàng đợi RIÊNG — trả lời đúng ở tab này rồi chuyển sang tab
// khác vẫn có thể gặp lại đúng từ đó, vì hàng đợi mới nạp từ server chưa kịp phản ánh lượt vừa
// ghi (submitFsrsReview chạy nền, không await); (b) bindFlash/bindQuiz/bindType/bindListen gọi lại
// sqLoad() MỌI LẦN được gọi, kể cả khi chỉ đơn giản rời tab rồi quay lại giữa phiên đang học dở —
// làm mất hẳn trạng thái chống lặp cũ. sessionKnownHz dưới đây là 1 Set DÙNG CHUNG cho TẤT CẢ tab
// (kể cả "Hôm nay học", xem rvDedupeSession/rvAdvance ở review.js), tồn tại suốt phiên đăng nhập
// hiện tại (reset khi đăng nhập/vào khách/đăng xuất — xem auth.js): hz nào đã trả lời ĐÚNG ở BẤT
// KỲ tab nào thì bị loại khỏi TẤT CẢ hàng đợi khác cho tới khi phiên kết thúc. Không đụng tới logic
// FSRS thật (due/stability/difficulty) — chỉ lọc phía client trước khi hiển thị.
// ════════════════════════════════════════════════════
const REPEAT_GAP = 10; // N: số thẻ tối thiểu trước khi 1 thẻ bị Again được lặp lại

// FIX (Ưu tiên 2 — "Reload trang rồi gặp lại từ vừa học"): sessionKnownHz TRƯỚC ĐÂY chỉ là biến JS
// trong bộ nhớ — F5/tải lại trang xoá sạch, nên các từ vừa trả lời ĐÚNG trong phiên có thể hiện lại
// ngay sau reload dù vẫn cùng 1 phiên đăng nhập. Persist qua sessionStorage (tự xoá khi ĐÓNG hẳn
// tab/trình duyệt — đúng nghĩa "phiên hiện tại", khác localStorage là vĩnh viễn) để reload giữ
// nguyên trạng thái chống lặp; đăng nhập/đăng xuất/đổi user vẫn reset đúng như trước (auth.js).
function sessionKnownHzStoreKey() { return 'sessionKnownHz_' + (authUsername || ''); }
function loadSessionKnownHz() {
  try { return new Set(JSON.parse(sessionStorage.getItem(sessionKnownHzStoreKey()) || '[]')); }
  catch { return new Set(); }
}
function saveSessionKnownHz() {
  try { sessionStorage.setItem(sessionKnownHzStoreKey(), JSON.stringify([...sessionKnownHz])); } catch {}
}
let sessionKnownHz = loadSessionKnownHz(); // V74: hz đã trả lời ĐÚNG ở BẤT KỲ tab luyện tập nào trong phiên hiện tại

// Khử trùng lặp theo hz — phòng trường hợp cùng 1 chữ Hán xuất hiện ở nhiều bài (l khác nhau)
// khiến dueCards/newCards phía server chứa 2 "thẻ" khác nhau nhưng CÙNG mặt chữ với người học.
function sqDedupeByHz(words) {
  const seen = new Set();
  return words.filter(w => { if (seen.has(w.hz)) return false; seen.add(w.hz); return true; });
}

function sqCreate() { return { items: [], doneHz: new Set(), totalPlanned: 0, answeredCount: 0, sessionId: null }; }

// ════════════════════════════════════════════════════
// FIX (Bug 2 gốc — "Session Persistence"): TRƯỚC ĐÂY qzQueue/fcQueue/tyQueue/lsQueue/rvSession +
// answeredCount/totalPlanned CHỈ tồn tại trong biến JS (bộ nhớ) — F5/tải lại trang xoá sạch toàn bộ
// vị trí/thứ tự/tiến trình đang học dở, dù sessionKnownHz (ở trên) đã chống lặp được các từ trả lời
// ĐÚNG. Lưu TOÀN BỘ trạng thái hàng đợi (sessionId, items còn lại, doneHz, totalPlanned,
// answeredCount + dữ liệu phụ như điểm số) vào localStorage sau MỖI lần đổi — khôi phục ĐÚNG session
// cũ khi mở lại trang thay vì luôn tạo session mới. Hết hạn sau SQ_SESSION_MAX_AGE_MS để không "hồi
// sinh" một session bỏ dở quá lâu (lúc đó thẻ due/mới trên server có thể đã khác nhiều).
// ════════════════════════════════════════════════════
const SQ_SESSION_MAX_AGE_MS = 45 * 60 * 1000; // 45 phút

function sqStorageKey(mode) { return 'sqState_' + mode + '_' + (authUsername || ''); }

function sqPersist(mode, sq, extra) {
  if (!authUsername) return;
  try {
    localStorage.setItem(sqStorageKey(mode), JSON.stringify({
      sessionId: sq.sessionId,
      items: sq.items,
      doneHz: [...sq.doneHz],
      totalPlanned: sq.totalPlanned,
      answeredCount: sq.answeredCount,
      savedAt: Date.now(),
      extra: extra || {},
    }));
  } catch {}
}
function sqClearPersisted(mode) {
  try { localStorage.removeItem(sqStorageKey(mode)); } catch {}
}
function sqReadPersisted(mode) {
  if (!authUsername) return null;
  try {
    const raw = localStorage.getItem(sqStorageKey(mode));
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || !Array.isArray(saved.items) || !saved.sessionId) return null;
    if (Date.now() - (saved.savedAt || 0) > SQ_SESSION_MAX_AGE_MS) return null;
    return saved;
  } catch { return null; }
}
// Khôi phục session đã lưu VÀO ĐÚNG object hàng đợi (sq) truyền vào — lọc lại bằng sessionKnownHz
// phòng trường hợp bản lưu đã CŨ hơn 1 lượt "trả lời đúng ở tab khác" xảy ra sau khi lưu (v.d. tab
// này chưa kịp render/persist lại sau khi bị sqPurgeHzFromAllQueues sửa ở tab khác) — những thẻ bị
// lọc ra vì lý do đó được tính luôn vào answeredCount (coi như đã xong, tránh lệch tổng số).
function sqRestoreIntoQueue(mode, sq) {
  const saved = sqReadPersisted(mode);
  if (!saved || !saved.items.length) return null;
  const filteredItems = saved.items.filter(w => !sessionKnownHz.has((w.hz || (w.word && w.word.hz))));
  const purged = saved.items.length - filteredItems.length;
  if (!filteredItems.length) return null;
  sq.items = filteredItems;
  sq.doneHz = new Set(saved.doneHz);
  sq.totalPlanned = saved.totalPlanned;
  sq.answeredCount = saved.answeredCount + purged;
  sq.sessionId = saved.sessionId;
  return saved.extra || {};
}

// FIX (Bug 2 gốc — đổi số câu/số thẻ reset toàn bộ tiến trình): thay vì sqLoad() lại từ đầu (huỷ
// hàng đợi đang học dở, reset answeredCount/totalPlanned về 0), CHỈ điều chỉnh KÍCH THƯỚC hàng đợi
// hiện có theo limit MỚI — giữ nguyên thứ tự + tiến trình đã làm (Ví dụ: đã học 1-40/100, đổi 10
// câu → 20 câu, tiếp tục từ 41, KHÔNG quay lại từ 1). Tăng limit → nạp thêm từ CÙNG nguồn FSRS thật
// (lọc trùng với hàng đợi hiện tại + sessionKnownHz) rồi nối vào cuối. Giảm limit → cắt bớt phần
// CHƯA học ở cuối hàng đợi, không đụng tới phần đã trả lời/thẻ đang hiển thị.
async function sqAdjustLimit(sq, newLimit) {
  const remainingWanted = Math.max(0, newLimit - sq.answeredCount);
  if (sq.items.length > remainingWanted) {
    sq.items = sq.items.slice(0, Math.max(remainingWanted, Math.min(sq.items.length, 1)));
    sq.totalPlanned = sq.answeredCount + sq.items.length;
    return { ok: true };
  }
  if (sq.items.length >= remainingWanted) {
    sq.totalPlanned = sq.answeredCount + sq.items.length;
    return { ok: true };
  }
  const currentHz = new Set(sq.items.map(w => w.hz));
  const stillNeeded = remainingWanted - sq.items.length;
  if (!isLoggedIn()) {
    const extra = sqDedupeByHz(shuffle(getFilteredWords()))
      .filter(w => !sessionKnownHz.has(w.hz) && !currentHz.has(w.hz))
      .slice(0, stillNeeded);
    sq.items = sq.items.concat(extra);
    sq.totalPlanned = sq.answeredCount + sq.items.length;
    return { ok: true };
  }
  const { words, error } = await loadFsrsPracticePool(remainingWanted + sq.answeredCount);
  if (error) return { error };
  const extra = sqDedupeByHz(words).filter(w => !sessionKnownHz.has(w.hz) && !currentHz.has(w.hz)).slice(0, stillNeeded);
  sq.items = sq.items.concat(extra);
  sq.totalPlanned = sq.answeredCount + sq.items.length;
  return { ok: true };
}

// FIX (Ưu tiên 1 — "một từ đã hoàn thành trong phiên hiện tại không được xuất hiện lại ở tab
// khác"): TRƯỚC ĐÂY sessionKnownHz chỉ được lọc tại thời điểm sqLoad() nạp hàng đợi — nếu 1 từ đã
// nạp SẴN vào hàng đợi của tab A (còn ở phía sau, chưa tới lượt) rồi bị trả lời ĐÚNG ở tab B, hàng
// đợi tab A vẫn giữ nguyên từ đó cho tới khi user quay lại tab A và gặp lại nó. Purge NGAY khỏi
// MỌI hàng đợi khác (trừ vị trí index 0 — thẻ đang hiển thị/đang được xử lý kết quả của chính lượt
// vừa trả lời) mỗi khi có 1 hz được thêm vào sessionKnownHz.
function sqPurgeHzFromAllQueues(hz) {
  const queues = [
    typeof fcQueue !== 'undefined' ? fcQueue : null,
    typeof qzQueue !== 'undefined' ? qzQueue : null,
    typeof tyQueue !== 'undefined' ? tyQueue : null,
    typeof lsQueue !== 'undefined' ? lsQueue : null,
  ];
  for (const sq of queues) {
    if (!sq || !sq.items || !sq.items.length) continue;
    // Giữ nguyên items[0] (thẻ đang hiển thị/đang chờ hẹn giờ chuyển câu) — chỉ lọc phần CÒN LẠI
    // phía sau, tránh đổi câu đang hiện giữa chừng trước mặt user.
    const head = sq.items[0];
    const rest = sq.items.slice(1).filter(w => w.hz !== hz);
    sq.items = [head, ...rest];
  }
  if (typeof rvSession !== 'undefined' && rvSession.length) {
    const head = rvSession[0];
    const rest = rvSession.slice(1).filter(it => it.word.hz !== hz);
    rvSession = [head, ...rest];
  }
}

// V76 (Yêu cầu 6/7 — js/settings.js gọi hàm này SAU KHI server xác nhận đã Reset FSRS / Xoá toàn
// bộ dữ liệu học tập thành công): dọn sạch MỌI hàng đợi + trạng thái chống lặp đang giữ trong bộ
// nhớ trình duyệt, để không còn thẻ/due nào "sống sót" từ trước lúc reset — không cần reload trang,
// tab đang mở khi quay lại sẽ tự sqLoad()/loadFsrsPracticePool() lại từ đầu (thấy đúng "New" hết).
function sqResetAllQueuesAndSessionState() {
  const queues = [
    typeof fcQueue !== 'undefined' ? fcQueue : null,
    typeof qzQueue !== 'undefined' ? qzQueue : null,
    typeof tyQueue !== 'undefined' ? tyQueue : null,
    typeof lsQueue !== 'undefined' ? lsQueue : null,
  ];
  for (const sq of queues) {
    if (!sq) continue;
    sq.items = []; sq.totalPlanned = 0; sq.answeredCount = 0; sq.doneHz = new Set();
  }
  if (typeof rvSession !== 'undefined') rvSession = [];
  if (typeof rvTotalPlanned !== 'undefined') rvTotalPlanned = 0;
  if (typeof rvAnsweredCount !== 'undefined') rvAnsweredCount = 0;
  sessionKnownHz = new Set();
  saveSessionKnownHz();
  // Outbox (Yêu cầu 4 — không double submit) có thể còn giữ review CHƯA gửi lên kịp từ TRƯỚC lúc
  // reset — nếu để nguyên, lần flush kế tiếp sẽ "hồi sinh" đúng những gì vừa xoá. Reset phải triệt
  // để nên bỏ luôn các review đang chờ gửi này, không cố gửi lại nữa.
  try { localStorage.removeItem(reviewOutboxKey()); } catch {}
  // FIX (Bug 2 — session persistence): dọn luôn mọi hàng đợi ĐÃ LƯU (localStorage) của cả 5 tab —
  // nếu để sót, refresh sau khi reset sẽ "khôi phục" nhầm đúng những thẻ vừa bị xoá FSRS.
  ['review', 'review-weak', 'flash', 'quiz', 'type', 'listen'].forEach(sqClearPersisted);
}

// Nạp hàng đợi 1 LẦN cho 1 lượt "vào tab" — dùng chung bởi mọi tab luyện tập (đăng nhập: FSRS
// thật qua loadFsrsPracticePool; khách: pool cục bộ theo bài đang chọn). V74: lọc thêm
// sessionKnownHz để không nạp lại từ vừa trả lời ĐÚNG ở 1 tab KHÁC trong cùng phiên.
async function sqLoad(sq, limit) {
  sq.doneHz = new Set(); sq.answeredCount = 0; sq.sessionId = genIdempotencyKey();
  if (isLoggedIn()) {
    const { words, error } = await loadFsrsPracticePool(limit);
    if (error) return { error };
    // FIX (Bug 2 — thứ tự lọc/cắt): lọc sessionKnownHz TRƯỚC, cắt limit SAU (xem loadFsrsPracticePool
    // ở trên — trước đây cắt limit TRƯỚC khi lọc, có thể làm hàng đợi trống oan dù server còn thẻ).
    sq.items = sqDedupeByHz(words).filter(w => !sessionKnownHz.has(w.hz)).slice(0, limit);
  } else {
    sq.items = sqDedupeByHz(shuffle(getFilteredWords())).filter(w => !sessionKnownHz.has(w.hz)).slice(0, limit);
  }
  sq.totalPlanned = sq.items.length;
  return { ok: true };
}

// Gọi SAU KHI có kết quả (server hoặc tự chấm ở khách) cho thẻ đang ở ĐẦU hàng đợi.
function sqAdvance(sq, isCorrect) {
  const w = sq.items.shift();
  if (!w) return;
  sq.answeredCount++;
  if (isCorrect) {
    sq.doneHz.add(w.hz); // loại vĩnh viễn khỏi phiên này — không bao giờ lặp lại nữa
    sessionKnownHz.add(w.hz); // V74: loại khỏi TẤT CẢ tab khác trong cùng phiên (chống lặp CHÉO tab)
    saveSessionKnownHz(); // FIX (Ưu tiên 2): persist ngay để F5/reload không mất trạng thái chống lặp
    sqPurgeHzFromAllQueues(w.hz); // FIX (Ưu tiên 1): loại NGAY khỏi các hàng đợi tab khác đang giữ sẵn từ này phía sau
  } else {
    const pos = Math.min(REPEAT_GAP, sq.items.length); // chèn lại cách tối thiểu N thẻ khác
    sq.items.splice(pos, 0, w);
  }
}


