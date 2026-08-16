// js/settings.js — Reset FSRS / Xoá toàn bộ dữ liệu học tập (Yêu cầu 6/7/9 của V76)
// ════════════════════════════════════════════════════
// 2 hành động PHÁ HUỶ DỮ LIỆU, tự phục vụ cho CHÍNH tài khoản đang đăng nhập (khác nút reset của
// admin trong js/admin.js vốn thao tác trên tài khoản NGƯỜI KHÁC). Dùng chung 1 modal xác nhận
// (#danger-confirm-modal, index.html) — nội dung/màu đổi động theo `kind` để không lặp code.
// Bắt buộc gõ đúng chữ "RESET" mới cho xác nhận (Yêu cầu 6/7). Sau khi server báo thành công, dọn
// sạch mọi cache/hàng đợi phía client (afterDangerActionSuccess) để thấy đúng trạng thái mới ngay,
// không cần tải lại trang.
// ════════════════════════════════════════════════════
const DANGER_ACTIONS = {
  'fsrs-reset': {
    title: '🔄 Reset FSRS',
    desc: 'Xóa lịch ôn tập và dữ liệu ghi nhớ FSRS. Toàn bộ từ sẽ quay lại trạng thái "Mới" — tài khoản, mật khẩu, cài đặt và từ vựng không bị ảnh hưởng.',
    confirmQuestion: 'Bạn có chắc muốn reset toàn bộ FSRS?',
    endpoint: '/api/fsrs/reset',
    danger: false, // Yêu cầu 9: cảnh báo NHẸ
    successMsg: '✅ Đã reset FSRS — toàn bộ từ quay về trạng thái Mới.',
  },
  'wipe-data': {
    title: '🗑️ Xoá toàn bộ dữ liệu học tập',
    desc: 'Đưa tài khoản về trạng thái như người dùng mới (lịch ôn tập, thống kê, streak, cài đặt học...). Tài khoản, email và mật khẩu vẫn giữ nguyên.',
    confirmQuestion: 'Bạn có chắc muốn xóa toàn bộ dữ liệu học tập?\nHành động này không thể hoàn tác.',
    endpoint: '/api/user/reset-learning-data',
    danger: true, // Yêu cầu 9: màu NGUY HIỂM
    successMsg: '✅ Đã xoá toàn bộ dữ liệu học tập — tài khoản như mới.',
  },
};
let _dangerKind = null;

function openDangerConfirm(kind) {
  if (!isLoggedIn() || !DANGER_ACTIONS[kind]) return;
  _dangerKind = kind;
  const cfg = DANGER_ACTIONS[kind];
  closeAccountMenu();
  document.getElementById('danger-confirm-title').textContent = cfg.title;
  document.getElementById('danger-confirm-desc').textContent = cfg.desc;
  document.getElementById('danger-confirm-question').textContent = cfg.confirmQuestion;
  const btn = document.getElementById('danger-confirm-submit');
  btn.disabled = false;
  btn.textContent = 'Xác nhận';
  btn.style.background = cfg.danger ? 'var(--fail)' : 'var(--l7a)';
  btn.style.boxShadow = cfg.danger ? '0 4px 0 #c23a3a' : '0 4px 0 #b25f22';
  document.getElementById('danger-confirm-input').value = '';
  document.getElementById('danger-confirm-error').classList.remove('show');
  document.getElementById('danger-confirm-modal').style.display = 'flex';
}
function closeDangerConfirm() {
  document.getElementById('danger-confirm-modal').style.display = 'none';
  _dangerKind = null;
}

async function submitDangerConfirm() {
  const cfg = DANGER_ACTIONS[_dangerKind];
  if (!cfg) return;
  const typed = document.getElementById('danger-confirm-input').value.trim();
  const errEl = document.getElementById('danger-confirm-error');
  const showErr = (msg) => { errEl.textContent = msg; errEl.classList.add('show'); };
  errEl.classList.remove('show');
  // Yêu cầu 6/7: bắt buộc gõ đúng chữ RESET (phân biệt hoa/thường) trước khi thực hiện.
  if (typed !== 'RESET') return showErr('Vui lòng gõ đúng chữ RESET (viết hoa) để xác nhận.');
  const btn = document.getElementById('danger-confirm-submit');
  btn.disabled = true; btn.textContent = 'Đang xử lý...'; // Yêu cầu 9: hiển thị loading
  try {
    const res = await fetch(cfg.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() } });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) { showErr((data && data.error) || 'Có lỗi xảy ra, thử lại sau.'); return; }
    await afterDangerActionSuccess();
    closeDangerConfirm();
    alert(cfg.successMsg); // Yêu cầu 9: thông báo thành công
  } catch (e) {
    showErr('Lỗi kết nối: ' + e.message); // Yêu cầu 9: thông báo thất bại
  } finally {
    btn.disabled = false; btn.textContent = 'Xác nhận';
  }
}

// Dọn sạch mọi cache/hàng đợi/phiên đang giữ trong bộ nhớ trình duyệt sau khi server XÁC NHẬN đã
// xoá xong — để KHÔNG cần reload trang vẫn thấy đúng trạng thái mới (Yêu cầu 6/7: không còn thẻ
// FSRS cũ nào "sống sót"; localStorage/sessionStorage liên quan FSRS cũng được dọn theo).
async function afterDangerActionSuccess() {
  sqResetAllQueuesAndSessionState(); // js/study-queue.js — mọi hàng đợi Flashcard/Trắc nghiệm/Gõ chữ/Nghe-chọn/Hôm nay học + sessionKnownHz + outbox
  pauseStudyTimer(); // js/timer.js — phiên học đang chạy dở (nếu có) không còn ý nghĩa sau reset
  studySession = { id: null, startedAt: 0, lastActivity: 0, cards: 0, correct: 0, wrong: 0 };
  try { localStorage.removeItem(studySessionStorageKey()); } catch {}
  if (authUsername) { try { localStorage.removeItem('progressCache_' + authUsername); } catch {} }
  // Nạp lại progress/streak/known/rank THẬT từ server (không dùng bản debounce của
  // refreshServerMeta() vì cần progress.ui mới ngay — Xoá toàn bộ dữ liệu học tập có reset cả nó).
  try {
    const res = await fetch('/api/progress', { headers: authHeaders() });
    const data = await res.json();
    if (data.ok) {
      progressState = data.progress || progressState;
      currentRank = data.rank || null;
      serverStreak = data.streak || 0;
      serverLongestStreak = data.longestStreak || 0;
      serverKnownCount = data.known || 0;
      applyUIState();
      cacheProgressLocally();
    }
  } catch { /* im lặng — UI vẫn đã dọn sạch queue/cache phía trên, chỉ riêng badge có thể chậm cập nhật */ }
  updateUserBadge();
  const badge = document.getElementById('streak-badge');
  if (badge) badge.textContent = '🔥 ' + getStreak() + ' ngày';
  render();
}
