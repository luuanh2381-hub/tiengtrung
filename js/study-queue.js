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
    // FIX (Vấn đề 5): đảm bảo server đã thấy đúng Quyển/bài MỚI NHẤT (không dính debounce 700ms)
    // trước khi truy vấn — nếu không, server có thể trả nhầm theo lựa chọn CŨ.
    await flushProgressSync();
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
// FIX (Vấn đề 1 — "mất dữ liệu khi mất mạng tạm thời"): TRƯỚC ĐÂY outbox CHỈ được thử gửi lại khi có
// sự kiện 'online', quay lại tab (visibilitychange), hoặc mở app. Nếu tab vẫn đang MỞ VÀ HIỂN THỊ
// nhưng mạng chập chờn vài chục giây (rất hay gặp trên di động, không phải lúc nào cũng bắn đúng
// sự kiện 'offline'/'online'), 1 review bị outbox giữ lại có thể phải chờ RẤT LÂU (tới khi user đổi
// tab/refresh) mới được thử gửi lại — không mất dữ liệu, nhưng độ trễ đồng bộ lên Neon không đảm
// bảo. Thêm nhịp tự thử lại định kỳ khi tab đang hiển thị, để outbox không bao giờ "ngủ quên".
setInterval(() => { if (document.visibilityState === 'visible') flushReviewOutbox(); }, 20000);
window.addEventListener('focus', flushReviewOutbox); // thêm 1 trigger nữa cho các trường hợp visibilitychange không bắn (webview/iframe)
// V74: rời khỏi trang (đổi tab trình duyệt, khoá màn hình, chuyển app khác) phải DỪNG đếm giờ học
// ngay lập tức, không chỉ dừng khi chuyển tab TRONG app (render() đã xử lý việc đó). Quay lại thì
// ensureStudySession() tự nối tiếp đúng phiên cũ nếu còn trong 15 phút (không mất, không đếm bù thời
// gian đã rời đi) — tái dùng đúng 2 hàm đã có, không tạo thêm cơ chế mới.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    ssCheckDayRollover(); // V77 (Study Day/Study Session): app mở qua đêm không đóng tab -> tự chuyển đúng "ngày học" mới
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
  // FIX (Vấn đề 1 — đúng thứ tự lên Neon): nếu outbox đang kẹt sẵn các lượt CŨ hơn (chưa gửi được
  // do mất mạng/lỗi tạm thời trước đó), tranh thủ thử gửi NỀN (không await, không chặn lượt hiện
  // tại) TRƯỚC KHI thêm lượt mới vào outbox — giảm tối đa khoảng thời gian các lượt cũ hơn bị "đứng
  // sau" lượt sắp ghi, tránh trường hợp hiếm: 2 lượt review CÙNG 1 thẻ đến Neon không đúng thứ tự
  // thời gian thật (đặt TRƯỚC addToOutbox để không tự gửi trùng ngay chính payload sắp thêm).
  flushReviewOutbox();
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
// V77 (Yêu cầu 1/3 — tách "Study Day" khỏi "Study Session"): TRƯỚC ĐÂY sessionKnownHz sống trong
// sessionStorage — mất NGAY khi đóng hẳn tab/trình duyệt, nên mở lại app CÙNG NGÀY (vd tối mở lại
// app sau khi đã đóng hẳn lúc trưa) vẫn có thể gặp lại đúng từ vừa hoàn thành ở phiên trước, dù
// chưa đến hạn FSRS. Giờ chuyển sang localStorage + khoá theo ĐÚNG "Study Day" hiện tại
// (todayKey()) — "đã hoàn thành hôm nay" sống suốt CẢ NGÀY, qua mọi lần đóng/mở app, qua MỌI Study
// Session trong ngày (sáng/trưa/tối — đúng Yêu cầu 3/4), chỉ tự hết hiệu lực khi sang ngày mới
// (khoá đổi theo ngày -> set của ngày mới rỗng, không cần dọn tay).
function todayKey() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function sessionKnownHzStoreKey() { return 'dayKnownHz_' + todayKey() + '_' + (authUsername || ''); }
function loadSessionKnownHz() {
  try { return new Set(JSON.parse(localStorage.getItem(sessionKnownHzStoreKey()) || '[]')); }
  catch { return new Set(); }
}
function saveSessionKnownHz() {
  try { localStorage.setItem(sessionKnownHzStoreKey(), JSON.stringify([...sessionKnownHz])); } catch {}
}
let sessionKnownHz = loadSessionKnownHz(); // V77: hz đã hoàn thành (trả lời ĐÚNG) ở BẤT KỲ tab/Study Session nào trong ĐÚNG Study Day hôm nay
let _sessionKnownHzDay = todayKey();
// Gọi định kỳ (xem visibilitychange) — app mở xuyên qua nửa đêm (không đóng tab) phải tự chuyển
// đúng bộ nhớ "hôm nay" của NGÀY MỚI, không tiếp tục chặn nhầm bằng dữ liệu của Study Day hôm qua.
function ssCheckDayRollover() {
  const k = todayKey();
  if (k === _sessionKnownHzDay) return;
  _sessionKnownHzDay = k;
  sessionKnownHz = loadSessionKnownHz();
}

// Khử trùng lặp theo hz — phòng trường hợp cùng 1 chữ Hán xuất hiện ở nhiều bài (l khác nhau)
// khiến dueCards/newCards phía server chứa 2 "thẻ" khác nhau nhưng CÙNG mặt chữ với người học.
function sqDedupeByHz(words) {
  const seen = new Set();
  return words.filter(w => { if (seen.has(w.hz)) return false; seen.add(w.hz); return true; });
}

// V77 (Yêu cầu 5 — 1 Study Session phải lưu đủ: sessionId/startTime/endTime/completedCards/queue/
// lessonFilter): queue = sq.items; completedCards = sq.completedCards (danh sách {hz,l,correct,at}
// tích luỹ qua sqAdvance, khác doneHz vốn chỉ có ý nghĩa chống lặp trong hàng đợi).
function sqCreate() {
  return {
    items: [], doneHz: new Set(), totalPlanned: 0, answeredCount: 0, sessionId: null,
    startTime: null, endTime: null, completedCards: [], lessonFilter: null, dayKey: null,
  };
}

// Chụp lại đúng Quyển/bài đang chọn tại thời điểm 1 Study Session được tạo — lưu kèm session
// (Yêu cầu 5: field lessonFilter) để phát hiện lựa chọn đã đổi từ lúc đó (dùng khi khôi phục).
function sqSnapshotLessonFilter() {
  return {
    selectedBookIds: [...selectedBookIds].sort((a, b) => a - b),
    selectedLessons: [...selectedLessons].sort((a, b) => a - b),
    lessonsAllMode: !!lessonsAllMode,
  };
}
function sqLessonFilterMatches(saved) {
  if (!saved) return true; // phiên lưu từ TRƯỚC khi có field này — không chặn, coi như khớp
  const now = sqSnapshotLessonFilter();
  return now.lessonsAllMode === saved.lessonsAllMode
    && JSON.stringify(now.selectedBookIds) === JSON.stringify(saved.selectedBookIds || [])
    && JSON.stringify(now.selectedLessons) === JSON.stringify(saved.selectedLessons || []);
}

// V77 (Yêu cầu 1 — nhật ký các Study Session ĐÃ ĐÓNG trong ngày, cho ĐÚNG 1 Study Day): mỗi khi 1
// Study Session bị đóng lại (dù đã học xong hay bị "Học mới"/"Học lại từ đầu" chủ động đóng sớm),
// ghi 1 dòng tóm tắt vào đây — CHỈ để hiển thị/tra cứu, KHÔNG ảnh hưởng dữ liệu FSRS thật (vốn đã
// nằm an toàn trên server ngay tại thời điểm trả lời — xem reviewService.reviewCard).
function ssDayLogKey(mode) { return 'studyDaySessions_' + mode + '_' + (authUsername || '') + '_' + todayKey(); }
function ssArchiveSession(mode, sq) {
  if (!authUsername || !sq || !sq.sessionId || !(sq.answeredCount > 0)) return; // chưa học câu nào thì không đáng ghi nhận
  try {
    const list = JSON.parse(localStorage.getItem(ssDayLogKey(mode)) || '[]');
    list.push({
      sessionId: sq.sessionId,
      startTime: sq.startTime || null,
      endTime: sq.endTime || Date.now(),
      completedCards: Array.isArray(sq.completedCards) ? sq.completedCards.length : (sq.answeredCount || 0),
      lessonFilter: sq.lessonFilter || null,
    });
    localStorage.setItem(ssDayLogKey(mode), JSON.stringify(list.slice(-20))); // tối đa 20 phiên gần nhất/ngày, tránh phình bộ nhớ
  } catch {}
}
function ssGetDayLog(mode) {
  try { return JSON.parse(localStorage.getItem(ssDayLogKey(mode)) || '[]'); } catch { return []; }
}

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
      // V77 (Yêu cầu 5): các field còn lại của 1 Study Session — startTime/endTime/completedCards/
      // lessonFilter — lưu kèm đầy đủ để refresh/khôi phục không mất bất kỳ phần nào của phiên.
      startTime: sq.startTime || null,
      endTime: sq.endTime || null,
      completedCards: Array.isArray(sq.completedCards) ? sq.completedCards : [],
      lessonFilter: sq.lessonFilter || sqSnapshotLessonFilter(),
      dayKey: sq.dayKey || todayKey(),
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
    // V77 (Yêu cầu 1 — 1 Study Session luôn thuộc về ĐÚNG 1 Study Day): 1 phiên còn dang dở từ
    // NGÀY HÔM TRƯỚC không được tự "nối" sang ngày mới coi như đang tiếp tục — sqLoad()/
    // sqStartNewSession() sẽ tự nạp phiên MỚI cho ngày hôm nay. Tiến độ cũ không mất gì (đã ghi
    // FSRS thật trên server ngay lúc trả lời), chỉ riêng hàng đợi/vị trí đang dở của hôm qua thôi.
    if (saved.dayKey && saved.dayKey !== todayKey()) return null;
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
  // V77 (Yêu cầu 5/6): khôi phục ĐỦ các field của Study Session, không chỉ riêng hàng đợi.
  sq.startTime = saved.startTime || Date.now();
  sq.endTime = null;
  sq.completedCards = Array.isArray(saved.completedCards) ? saved.completedCards : [];
  sq.lessonFilter = saved.lessonFilter || sqSnapshotLessonFilter();
  sq.dayKey = saved.dayKey || todayKey();
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
  // FIX (Vấn đề 7 — Review dùng CHUNG object rvQueue, không còn biến rời rvSession/rvTotalPlanned/
  // rvAnsweredCount): items của rvQueue có dạng {type, word} (khác các sq khác lưu thẳng word), nên
  // lọc theo w.word.hz thay vì w.hz.
  if (typeof rvQueue !== 'undefined' && rvQueue.items.length) {
    const head = rvQueue.items[0];
    const rest = rvQueue.items.slice(1).filter(it => it.word.hz !== hz);
    rvQueue.items = [head, ...rest];
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
  if (typeof rvQueue !== 'undefined') { rvQueue.items = []; rvQueue.totalPlanned = 0; rvQueue.answeredCount = 0; rvQueue.completedCards = []; }
  sessionKnownHz = new Set();
  saveSessionKnownHz();
  // Outbox (Yêu cầu 4 — không double submit) có thể còn giữ review CHƯA gửi lên kịp từ TRƯỚC lúc
  // reset — nếu để nguyên, lần flush kế tiếp sẽ "hồi sinh" đúng những gì vừa xoá. Reset phải triệt
  // để nên bỏ luôn các review đang chờ gửi này, không cố gửi lại nữa.
  try { localStorage.removeItem(reviewOutboxKey()); } catch {}
  // FIX (Bug 2 — session persistence): dọn luôn mọi hàng đợi ĐÃ LƯU (localStorage) của cả 5 tab —
  // nếu để sót, refresh sau khi reset sẽ "khôi phục" nhầm đúng những thẻ vừa bị xoá FSRS.
  ['review', 'review-weak', 'flash', 'quiz', 'type', 'listen'].forEach(sqClearPersisted);
  // V77 (Yêu cầu 1): dọn luôn nhật ký Study Session trong ngày — không còn ý nghĩa gì sau khi toàn
  // bộ dữ liệu học tập/FSRS đã bị xoá.
  ['review', 'review-weak', 'flash', 'quiz', 'type', 'listen'].forEach(m => { try { localStorage.removeItem(ssDayLogKey(m)); } catch {} });
}

// FIX (chọn bài học không lọc đúng — "Sau khi refresh hoặc quay lại học, bài đã chọn bị mất" /
// "Review, Quiz, Flashcard, Typing hoặc Listening không dùng đúng bài đã chọn"): mỗi tab luyện tập
// chỉ sqLoad() lại nếu hàng đợi ĐANG RỖNG (xem bindFlash/bindQuiz/bindType/bindListen — cố tình giữ
// nguyên hàng đợi khi rời/quay lại tab để không mất tiến trình đang học dở, V74). Hệ quả PHỤ chưa
// được xử lý trước đây: đổi Quyển/bài đang chọn ở Trang chủ KHÔNG hề đụng tới các hàng đợi này —
// hàng đợi cũ (và bản đã lưu localStorage, sống tới 45 phút — xem SQ_SESSION_MAX_AGE_MS) vẫn còn
// nguyên, nạp theo đúng lựa chọn CŨ, nên quay lại/refresh vào các tab luyện tập vẫn thấy y hệt từ
// của lựa chọn trước đó — như thể bài vừa chọn không có tác dụng. Gọi hàm này ngay khi lựa chọn
// Quyển/bài THAY ĐỔI (xem saveSelectionState ở js/ui.js) để buộc lần vào tab kế tiếp phải nạp mới
// hoàn toàn theo đúng lựa chọn hiện tại.
// Khác sqResetAllQueuesAndSessionState (dùng cho Reset FSRS/Xoá dữ liệu): hàm này CHỈ đổi lựa chọn
// bài học, không phải sự kiện xoá dữ liệu, nên KHÔNG đụng tới sessionKnownHz (chống lặp trong phiên
// đăng nhập hiện tại) hay outbox (review chưa gửi kịp lên server) — cả 2 thứ đó không liên quan gì
// tới việc đang chọn bài nào.
function sqInvalidateQueuesForSelectionChange() {
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
  if (typeof rvQueue !== 'undefined') { rvQueue.items = []; rvQueue.totalPlanned = 0; rvQueue.answeredCount = 0; rvQueue.completedCards = []; }
  ['review', 'review-weak', 'flash', 'quiz', 'type', 'listen'].forEach(sqClearPersisted);
}

// Nạp hàng đợi 1 LẦN cho 1 lượt "vào tab" — dùng chung bởi mọi tab luyện tập (đăng nhập: FSRS
// thật qua loadFsrsPracticePool; khách: pool cục bộ theo bài đang chọn). V74: lọc thêm
// sessionKnownHz để không nạp lại từ vừa trả lời ĐÚNG ở 1 tab KHÁC trong cùng phiên.
// V77 (Yêu cầu 1/5/8): opts.ignoreDayDedupe (mặc định false) — CHỈ true khi gọi từ
// sqRelearnFromStart() ("Học lại từ đầu", hành động TƯỜNG MINH do user chủ động bấm) — bỏ qua lọc
// sessionKnownHz cho riêng lượt nạp này để cố ý ôn lại đúng những từ vừa hoàn thành trong ngày.
// Mọi lượt gọi khác (vào tab bình thường, "Học tiếp", "Học mới") LUÔN tôn trọng sessionKnownHz
// (Yêu cầu 3: không lấy lại từ đã hoàn thành hôm nay nếu chưa đến hạn FSRS).
async function sqLoad(sq, limit, opts) {
  const ignoreDayDedupe = !!(opts && opts.ignoreDayDedupe);
  sq.doneHz = new Set(); sq.answeredCount = 0; sq.sessionId = genIdempotencyKey();
  sq.startTime = Date.now(); sq.endTime = null; sq.completedCards = [];
  sq.dayKey = todayKey(); sq.lessonFilter = sqSnapshotLessonFilter();
  const dedupeSet = ignoreDayDedupe ? new Set() : sessionKnownHz;
  if (isLoggedIn()) {
    const { words, error } = await loadFsrsPracticePool(limit);
    if (error) return { error };
    // FIX (Bug 2 — thứ tự lọc/cắt): lọc sessionKnownHz TRƯỚC, cắt limit SAU (xem loadFsrsPracticePool
    // ở trên — trước đây cắt limit TRƯỚC khi lọc, có thể làm hàng đợi trống oan dù server còn thẻ).
    sq.items = sqDedupeByHz(words).filter(w => !dedupeSet.has(w.hz)).slice(0, limit);
  } else {
    sq.items = sqDedupeByHz(shuffle(getFilteredWords())).filter(w => !dedupeSet.has(w.hz)).slice(0, limit);
  }
  sq.totalPlanned = sq.items.length;
  return { ok: true };
}

// V77 (Yêu cầu 2 — "Học mới" tạo phiên MỚI): đóng/ghi nhật ký phiên đang có (nếu còn dang dở) rồi
// nạp phiên MỚI — vẫn tôn trọng sessionKnownHz/FSRS due như mọi lượt nạp khác (Yêu cầu 3), và vì
// nguồn NEW word phía server (getNewWordsByLessonOrder) chỉ trả từ CHƯA có fsrs_cards, phiên mới
// luôn tự động tiếp tục đúng từ CHƯA học tiếp theo — KHÔNG bao giờ quay lại đầu danh sách (Yêu cầu 4).
async function sqStartNewSession(mode, sq, limit) {
  ssArchiveSession(mode, sq);
  sqClearPersisted(mode);
  const result = await sqLoad(sq, limit);
  if (result.ok) sqPersist(mode, sq);
  return result;
}

// V77 (Yêu cầu 8 — "Học lại từ đầu" PHẢI là hành động rõ ràng, KHÔNG được tự động thực hiện): nạp
// lại hàng đợi từ vị trí đầu tiên, CỐ Ý bỏ qua sessionKnownHz CHỈ cho riêng lượt nạp này, để user
// chủ động ôn lại đúng những từ vừa học/ôn trong ngày. KHÔNG đụng tới dữ liệu FSRS thật trên server
// (due/stability/difficulty/...) — trả lời lại vẫn đi qua đúng reviewService.reviewCard() như mọi
// lượt khác, chỉ tạo thêm 1 lượt review hợp lệ mới, không phải "xoá tiến trình cũ" (Yêu cầu: không
// được reset tiến trình học trước đó). Hàm này CHỈ được gọi từ 1 nút bấm tường minh của user.
async function sqRelearnFromStart(mode, sq, limit) {
  ssArchiveSession(mode, sq);
  sqClearPersisted(mode);
  const result = await sqLoad(sq, limit, { ignoreDayDedupe: true });
  if (result.ok) sqPersist(mode, sq);
  return result;
}

// Có 1 Study Session còn dang dở (đã trả lời ít nhất 1 câu, còn thẻ chưa học trong hàng đợi, đúng
// Study Day hôm nay) hay không — dùng để quyết định có cần hỏi rõ "Học tiếp"/"Học mới" hay không
// (Yêu cầu 2) thay vì tự động resume/ghi đè ngầm.
function sqHasDanglingSession(mode) {
  const saved = sqReadPersisted(mode);
  return !!(saved && saved.items && saved.items.length > 0 && saved.answeredCount > 0 && sqLessonFilterMatches(saved.lessonFilter));
}

// Gọi SAU KHI có kết quả (server hoặc tự chấm ở khách) cho thẻ đang ở ĐẦU hàng đợi.
function sqAdvance(sq, isCorrect) {
  const w = sq.items.shift();
  if (!w) return;
  sq.answeredCount++;
  // V77 (Yêu cầu 5 — completedCards): tích luỹ đúng danh sách thẻ đã hoàn thành của Study Session
  // này, khác doneHz (chỉ dùng nội bộ để chống lặp trong hàng đợi hiện tại).
  if (!Array.isArray(sq.completedCards)) sq.completedCards = [];
  sq.completedCards.push({ hz: w.hz, l: w.l, correct: !!isCorrect, at: Date.now() });
  if (isCorrect) {
    sq.doneHz.add(w.hz); // loại vĩnh viễn khỏi phiên này — không bao giờ lặp lại nữa
    sessionKnownHz.add(w.hz); // V77: loại khỏi TẤT CẢ tab khác + tất cả Study Session khác TRONG NGÀY (chống lặp cả chéo tab lẫn chéo phiên)
    saveSessionKnownHz(); // FIX (Ưu tiên 2): persist ngay để F5/reload không mất trạng thái chống lặp
    sqPurgeHzFromAllQueues(w.hz); // FIX (Ưu tiên 1): loại NGAY khỏi các hàng đợi tab khác đang giữ sẵn từ này phía sau
  } else {
    const pos = Math.min(REPEAT_GAP, sq.items.length); // chèn lại cách tối thiểu N thẻ khác
    sq.items.splice(pos, 0, w);
  }
  if (sq.items.length === 0) sq.endTime = Date.now(); // V77 (Yêu cầu 5): hàng đợi cạn thật -> Study Session kết thúc, ghi endTime
}


