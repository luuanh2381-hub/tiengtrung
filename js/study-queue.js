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
    const words = (data.session || []).map(it => it.word).slice(0, limit);
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
function queueReviewOutbox(payload) {
  const list = loadReviewOutbox();
  list.push({ payload, queuedAt: Date.now() });
  saveReviewOutbox(list);
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
async function flushReviewOutbox() {
  if (_flushingOutbox || !isLoggedIn()) return;
  _flushingOutbox = true;
  try {
    let list = loadReviewOutbox();
    while (list.length) {
      let res, data;
      try {
        res = await fetch('/api/study/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(list[0].payload),
        });
        data = await res.json().catch(() => null);
      } catch (e) { break; } // van mat mang - dung, thu lai o lan trigger ke tiep (con nguyen trong outbox)
      if (!data || !data.ok) {
        if (isRetryableReviewFailure(res, data)) break; // loi tam thoi - GIU nguyen trong outbox, thu lai sau
        // loi vinh vien (payload sai) - bo qua muc nay de khong ket outbox mai mai
      }
      list.shift();
      saveReviewOutbox(list);
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
  if (!studySession.id) return;
  try {
    fetch('/api/study/session/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ sessionId: studySession.id }),
      keepalive: true,
    }).catch(() => {});
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
// that cuoi cung cho answerCorrect + rating. Noi GOI ham nay KHONG duoc await truoc khi chuyen
// cau (Task 2 - khong cho Neon); neu mat mang, payload vao outbox de tu gui lai (Task 3). --
function submitFsrsReview(args) {
  const w = args.word;
  const inFlightKey = w.hz + '|' + w.l + '|' + args.quizType;
  if (_inFlightReviews.has(inFlightKey)) return _inFlightReviews.get(inFlightKey);
  const p = _submitFsrsReviewImpl(args).finally(() => _inFlightReviews.delete(inFlightKey));
  _inFlightReviews.set(inFlightKey, p);
  return p;
}
async function _submitFsrsReviewImpl({ word, quizType, selectedAnswer, responseTimeMs, answerChanges }) {
  const payload = {
    wordId: { hz: word.hz, l: word.l },
    quizType,
    selectedAnswer,
    responseTimeMs: Number.isFinite(responseTimeMs) ? Math.round(responseTimeMs) : null,
    answerChanges: Number.isFinite(answerChanges) ? answerChanges : 0,
    idempotencyKey: genIdempotencyKey(),
  };
  let res, data;
  try {
    res = await fetch('/api/study/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload),
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    console.error('Loi ket noi khi luu review - da xep vao outbox de gui lai:', e);
    queueReviewOutbox(payload);
    return { ok: false, error: e.message, queued: true };
  }
  if (!data || !data.ok) {
    console.error('Khong luu duoc luot review:', data && data.error);
    if (isRetryableReviewFailure(res, data)) {
      // V74: loi server tam thoi (vd 500 do DB/lock) khong duoc coi la "xong" - phai xep vao outbox,
      // neu khong review nay se mat vinh vien du UI da bao "da luu".
      queueReviewOutbox(payload);
      return { ok: false, error: data && data.error, queued: true };
    }
    return data || { ok: false, error: 'Phan hoi khong hop le tu server' };
  }
  bumpStudySessionCounters(!!data.answerCorrect); // Task 4: cards_reviewed/dung/sai tang dan theo THOI GIAN THUC
  return data;
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

function sqCreate() { return { items: [], doneHz: new Set(), totalPlanned: 0, answeredCount: 0 }; }

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
}

// Nạp hàng đợi 1 LẦN cho 1 lượt "vào tab" — dùng chung bởi mọi tab luyện tập (đăng nhập: FSRS
// thật qua loadFsrsPracticePool; khách: pool cục bộ theo bài đang chọn). V74: lọc thêm
// sessionKnownHz để không nạp lại từ vừa trả lời ĐÚNG ở 1 tab KHÁC trong cùng phiên.
async function sqLoad(sq, limit) {
  sq.doneHz = new Set(); sq.answeredCount = 0;
  if (isLoggedIn()) {
    const { words, error } = await loadFsrsPracticePool(limit);
    if (error) return { error };
    sq.items = sqDedupeByHz(words).filter(w => !sessionKnownHz.has(w.hz));
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


