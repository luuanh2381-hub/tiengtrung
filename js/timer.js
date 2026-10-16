// js/timer.js — Phiên học thật (study_sessions) + đồng hồ đếm giờ hiển thị + heartbeat 20s giữ phiên sống
// Bấm vào bất kỳ tab học nào (Hôm nay học/Flashcard/Trắc nghiệm/Gõ chữ/Nghe-chọn) → mở (hoặc nối
// lại) 1 dòng study_sessions THẬT trên server (POST /api/study/session/start), giữ sống bằng
// heartbeat định kỳ, và tự tăng cards_reviewed/correct/wrong sau MỖI lượt reviewCard() thật —
// dùng CHUNG đúng cơ chế gộp phiên theo khoảng cách 15 phút mà backend đã có sẵn
// (lib/fsrs/analytics.js SESSION_GAP_MS), nên số liệu KHÔNG bị đếm trùng dù có cả recordStudyActivity
// (ngầm, chạy trong reviewService mỗi lần review) lẫn session/start + heartbeat (chủ động, ở đây).
// ════════════════════════════════════════════════════
// V112 — THỜI GIAN HỌC THỰC (không phải giờ treo tường). Trước đây đồng hồ hiển thị và server đều tính
// (bây giờ − lúc bắt đầu phiên) nên chuyển tab/chuyển app vẫn bị cộng. Nay chỉ cộng dồn khi ĐỒNG THỜI:
//   (1) trình duyệt đang hiển thị (không bị ẩn);  (2) đang ở màn học (xem isStudyContext);
//   (3) có tương tác trong STUDY_IDLE_MS gần nhất (để mở app rồi đi pha cà phê không bị tính).
// Mỗi nhịp 1 giây chỉ cộng tối đa STUDY_TICK_MAX_MS (máy ngủ/tab bị đóng băng rồi chạy lại không cộng 1 cục lớn).
// Heartbeat báo số giây học thực (activeSeconds); server chặn lại bằng thời gian thật + trần (lib/fsrs/study-time.js).
// Cùng một ý niệm "có mặt thật" với js/visibility-timer.js (thời gian trả lời từng câu cho bộ chọn thích ứng/FSRS).
// ════════════════════════════════════════════════════
const STUDY_TABS = new Set(['review','flash','quiz','type','listen']);
const STUDY_SESSION_GAP_MS = 15 * 60 * 1000; // PHẢI khớp SESSION_GAP_MS ở lib/fsrs/analytics.js
const STUDY_IDLE_MS = 90 * 1000;        // không tương tác quá lâu → ngừng cộng giờ (đọc lâu không chạm vẫn được tối đa 90s)
const STUDY_TICK_MAX_MS = 2000;         // mỗi nhịp đếm cộng tối đa 2s (chống cộng bù sau khi tab bị đóng băng/máy ngủ)

// activeMs = tổng thời gian học THỰC của phiên (hiển thị); sentActiveMs = phần đã báo cho server qua heartbeat thành công.
let studySession = { id: null, startedAt: 0, lastActivity: 0, cards: 0, correct: 0, wrong: 0, activeMs: 0, sentActiveMs: 0 };
let _studyTimerHandle = null, _studyHeartbeatHandle = null;
let _studyLastTickAt = 0, _studyLastInteraction = Date.now(), _studyTicksSinceSave = 0, _studyHeartbeatInFlight = false;

// Tab nào tính là "đang học thật": 5 tab học + buổi luyện kỹ năng bổ sung (tab Phân tích khi đang làm bài, V110).
function isStudyContext() {
  if (STUDY_TABS.has(currentTab)) return true;
  return currentTab === 'skills' && typeof skState !== 'undefined' && !!(skState && skState.practice);
}
function noteStudyInteraction() { _studyLastInteraction = Date.now(); }
['pointerdown', 'keydown', 'touchstart', 'input', 'scroll', 'wheel'].forEach(ev =>
  window.addEventListener(ev, noteStudyInteraction, { passive: true, capture: true }));
// Đang CÓ MẶT thật để học? (hiển thị + đúng màn học + còn tương tác gần đây)
function studyIsActiveNow(now) {
  const t = now || Date.now();
  return !document.hidden && isStudyContext() && (t - _studyLastInteraction) <= STUDY_IDLE_MS;
}
const blankStudySession = () => ({ id: null, startedAt: 0, lastActivity: 0, cards: 0, correct: 0, wrong: 0, activeMs: 0, sentActiveMs: 0 });

function studySessionStorageKey() { return 'studySession_' + (authUsername || ''); }

function cacheStudySession() {
  if (!authUsername) return;
  try { localStorage.setItem(studySessionStorageKey(), JSON.stringify(studySession)); } catch {}
}
function loadCachedStudySession() {
  if (!authUsername) return null;
  try { return JSON.parse(localStorage.getItem(studySessionStorageKey()) || 'null'); } catch { return null; }
}

// Gọi mỗi khi vào 1 tab học — idempotent: nếu đã có phiên hợp lệ (kể cả vừa khôi phục từ
// localStorage sau khi reload trang) thì chỉ tiếp tục đếm giờ, KHÔNG tạo phiên mới vô nghĩa.
async function ensureStudySession() {
  if (!isLoggedIn()) { pauseStudyTimer(); return; } // khách không có tài khoản → không có phiên thật
  const now = Date.now();
  // Phiên trong bộ nhớ nhưng đã bỏ ngỏ quá 15 phút (tab để mở qua đêm, hoặc vắng lâu) → coi như hết phiên, mở phiên MỚI —
  // khớp quy tắc gộp phiên 15 phút của server; trước đây phiên cũ bị kéo dài vô hạn trong cùng 1 lần mở trang.
  if (studySession.id && studySession.lastActivity && (now - studySession.lastActivity) > STUDY_SESSION_GAP_MS) studySession = blankStudySession();
  if (!studySession.id) {
    const cached = loadCachedStudySession();
    if (cached && cached.id && (now - cached.lastActivity) <= STUDY_SESSION_GAP_MS) {
      studySession = cached; // Task 5: "reload vẫn khôi phục được session" — cùng 1 sessionId, KHÔNG reset đồng hồ về 0
    }
  }
  if (!studySession.id) {
    try {
      const res = await fetch('/api/study/session/start', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() } });
      const data = await res.json();
      if (data.ok) {
        studySession = Object.assign(blankStudySession(), { id: data.sessionId, startedAt: now, lastActivity: now });
        cacheStudySession();
      }
    } catch (e) { console.error('Không mở được phiên học:', e); }
  }
  startStudyTimerTick();
  scheduleStudyHeartbeat();
}

function bumpStudySessionCounters(isCorrect) {
  if (!studySession.id) return;
  studySession.cards++;
  if (isCorrect) studySession.correct++; else studySession.wrong++;
  studySession.lastActivity = Date.now();
  noteStudyInteraction(); // trả lời một câu chắc chắn là có tương tác
  cacheStudySession();
  updateStudyTimerDisplay();
}

function startStudyTimerTick() {
  // Idempotent: render() gọi ensureStudySession() sau MỖI lần vẽ lại (mỗi câu hỏi). Tạo lại interval ở đây vừa làm mất tới 1s
  // mỗi lần, vừa (với heartbeat) có thể khiến nhịp 20s không bao giờ kịp chạy nếu cứ vài giây lại vẽ lại.
  if (_studyTimerHandle) { updateStudyTimerDisplay(); return; }
  _studyLastTickAt = Date.now(); // không cộng bù khoảng từ lần tick trước (có thể rất xa)
  _studyTimerHandle = setInterval(studyTick, 1000);
  updateStudyTimerDisplay();
}

// Mỗi giây: chỉ khi ĐANG CÓ MẶT thật mới cộng dồn (tối đa STUDY_TICK_MAX_MS/nhịp).
function studyTick() {
  const now = Date.now();
  const dt = _studyLastTickAt ? Math.min(Math.max(0, now - _studyLastTickAt), STUDY_TICK_MAX_MS) : 0;
  _studyLastTickAt = now;
  if (studySession.id && dt > 0 && studyIsActiveNow(now)) {
    studySession.activeMs = (studySession.activeMs || 0) + dt;
    if (++_studyTicksSinceSave >= 5) { _studyTicksSinceSave = 0; cacheStudySession(); } // lưu mỗi ~5s, không ghi localStorage mỗi giây
  }
  updateStudyTimerDisplay();
}

// Dừng ĐẾM HIỂN THỊ + heartbeat (không gọi mạng — dùng được cả khi đăng xuất/reset). Phiên trên server vẫn còn hiệu lực
// trong 15 phút; quay lại sẽ nối tiếp ĐÚNG số giờ học thực đã cộng, không cộng bù thời gian vắng mặt.
function pauseStudyTimer() {
  clearInterval(_studyTimerHandle); _studyTimerHandle = null;
  clearInterval(_studyHeartbeatHandle); _studyHeartbeatHandle = null;
  cacheStudySession();
  const chip = document.getElementById('study-timer-chip');
  if (chip) chip.style.display = 'none';
}
// Rời màn học (sang tab khác, ẩn trình duyệt): báo NỐT số giây học thực chưa gửi rồi dừng. Có mạng.
function leaveStudyContext(keepalive) {
  if (!_studyTimerHandle && !_studyHeartbeatHandle) return; // đã dừng rồi — render() gọi hàm này ở MỌI lần vẽ tab không phải tab học
  if (studySession.id) sendStudyHeartbeat({ force: true, keepalive: !!keepalive });
  pauseStudyTimer();
}

function updateStudyTimerDisplay() {
  const chip = document.getElementById('study-timer-chip');
  if (!chip || !studySession.id) return;
  const secs = Math.max(0, Math.floor((studySession.activeMs || 0) / 1000)); // thời gian HỌC THỰC, không phải giờ treo tường
  const hh = Math.floor(secs / 3600), mm = Math.floor((secs % 3600) / 60), ss = secs % 60;
  const pad = n => String(n).padStart(2, '0');
  const time = hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
  chip.style.display = '';
  chip.style.opacity = studyIsActiveNow() ? '' : '.55'; // mờ đi khi đang tạm dừng (ẩn tab / không tương tác)
  chip.textContent = `⏱ ${time}` + (studySession.cards ? ` · ${studySession.cards} thẻ` : '');
}

// Số giây học thực chưa báo server (làm tròn xuống: phần lẻ giữ lại cho lần sau, không mất không thừa).
function studyUnsentSeconds() {
  return Math.max(0, Math.floor(((studySession.activeMs || 0) - (studySession.sentActiveMs || 0)) / 1000));
}
// Gửi heartbeat kèm activeSeconds. force: gửi cả khi hiện không "đang có mặt" (để báo nốt phần còn lại / đồng bộ lại mốc thời gian
// sau khi vắng — lúc đó activeSeconds≈0 nên server dời mốc mà KHÔNG cộng khoảng vắng). Không gửi chồng 2 request cùng lúc.
async function sendStudyHeartbeat(opts) {
  const o = opts || {};
  if (!studySession.id || _studyHeartbeatInFlight) return;
  const delta = studyUnsentSeconds();
  if (!o.force && delta === 0 && !studyIsActiveNow()) return; // không có gì để báo và đang không học → đừng đụng server
  _studyHeartbeatInFlight = true;
  try {
    const res = await fetch('/api/study/session/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ sessionId: studySession.id, activeSeconds: delta }),
      keepalive: !!o.keepalive,
    });
    const data = await res.json();
    if (data.ok) {
      studySession.sentActiveMs = (studySession.sentActiveMs || 0) + delta * 1000;
      studySession.lastActivity = Date.now();
      cacheStudySession();
    } else {
      studySession = blankStudySession(); // phiên đã hết hạn phía server — lần sau mở phiên mới
    }
  } catch { /* mất mạng tạm thời — phần chưa gửi vẫn nằm trong activeMs, gửi ở nhịp kế tiếp, không mất */ }
  finally { _studyHeartbeatInFlight = false; }
}

// Heartbeat mỗi 20s trong lúc đang ở màn học — giữ end_time/duration_seconds cập nhật đều trên server dù người dùng đang
// đọc ví dụ/nghe phát âm chứ chưa bấm trả lời câu nào. CHỈ gửi khi đang có mặt thật (ẩn tab/rời màn học thì không gửi).
function scheduleStudyHeartbeat() {
  if (_studyHeartbeatHandle) return; // idempotent (xem startStudyTimerTick)
  _studyHeartbeatHandle = setInterval(() => sendStudyHeartbeat(), 20000);
}
