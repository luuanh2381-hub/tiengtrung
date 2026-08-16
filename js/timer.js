// js/timer.js — Phiên học thật (study_sessions) + đồng hồ đếm giờ hiển thị + heartbeat 20s giữ phiên sống
// Bấm vào bất kỳ tab học nào (Hôm nay học/Flashcard/Trắc nghiệm/Gõ chữ/Nghe-chọn) → mở (hoặc nối
// lại) 1 dòng study_sessions THẬT trên server (POST /api/study/session/start), giữ sống bằng
// heartbeat định kỳ, và tự tăng cards_reviewed/correct/wrong sau MỖI lượt reviewCard() thật —
// dùng CHUNG đúng cơ chế gộp phiên theo khoảng cách 15 phút mà backend đã có sẵn
// (lib/fsrs/analytics.js SESSION_GAP_MS), nên số liệu KHÔNG bị đếm trùng dù có cả recordStudyActivity
// (ngầm, chạy trong reviewService mỗi lần review) lẫn session/start + heartbeat (chủ động, ở đây).
// ════════════════════════════════════════════════════
const STUDY_TABS = new Set(['review','flash','quiz','type','listen']);
const STUDY_SESSION_GAP_MS = 15 * 60 * 1000; // PHẢI khớp SESSION_GAP_MS ở lib/fsrs/analytics.js

let studySession = { id: null, startedAt: 0, lastActivity: 0, cards: 0, correct: 0, wrong: 0 };
let _studyTimerHandle = null, _studyHeartbeatHandle = null;

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
        studySession = { id: data.sessionId, startedAt: now, lastActivity: now, cards: 0, correct: 0, wrong: 0 };
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
  cacheStudySession();
  updateStudyTimerDisplay();
}

function startStudyTimerTick() {
  clearInterval(_studyTimerHandle);
  _studyTimerHandle = setInterval(updateStudyTimerDisplay, 1000);
  updateStudyTimerDisplay();
}

// Dừng ĐẾM HIỂN THỊ khi rời khỏi tab học (Trang chủ, Thống kê,...) — phiên trên server vẫn còn
// hiệu lực trong 15 phút, quay lại tab học sẽ nối tiếp đúng đồng hồ cũ, không mất dữ liệu.
function pauseStudyTimer() {
  clearInterval(_studyTimerHandle); _studyTimerHandle = null;
  clearInterval(_studyHeartbeatHandle); _studyHeartbeatHandle = null;
  const chip = document.getElementById('study-timer-chip');
  if (chip) chip.style.display = 'none';
}

function updateStudyTimerDisplay() {
  const chip = document.getElementById('study-timer-chip');
  if (!chip || !studySession.id) return;
  const secs = Math.max(0, Math.floor((Date.now() - studySession.startedAt) / 1000));
  const hh = Math.floor(secs / 3600), mm = Math.floor((secs % 3600) / 60), ss = secs % 60;
  const pad = n => String(n).padStart(2, '0');
  const time = hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
  chip.style.display = '';
  chip.textContent = `⏱ ${time}` + (studySession.cards ? ` · ${studySession.cards} thẻ` : '');
}

// Heartbeat mỗi 20s trong lúc đang ở tab học — giữ end_time/duration_seconds cập nhật đều trên
// server dù người dùng đang đọc ví dụ/nghe phát âm chứ chưa bấm trả lời câu nào (Task 4/5).
function scheduleStudyHeartbeat() {
  clearInterval(_studyHeartbeatHandle);
  _studyHeartbeatHandle = setInterval(async () => {
    if (!studySession.id) return;
    try {
      const res = await fetch('/api/study/session/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ sessionId: studySession.id }),
      });
      const data = await res.json();
      if (data.ok) { studySession.lastActivity = Date.now(); cacheStudySession(); }
      else { studySession = { id: null, startedAt: 0, lastActivity: 0, cards: 0, correct: 0, wrong: 0 }; } // phiên đã hết hạn phía server — lần sau mở phiên mới
    } catch { /* mất mạng tạm thời — thử lại ở nhịp heartbeat kế tiếp, không xoá phiên */ }
  }, 20000);
}


