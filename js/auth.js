// js/auth.js — Đăng nhập/đăng ký/khách/đăng xuất, cache tiến độ cục bộ (progressCache_*), đồng bộ progress.ui lên server (scheduleSync)
// ════════════════════════════════════════════════════
// TÀI KHOẢN / ĐỒNG BỘ TIẾN ĐỘ VỚI SERVER
// ════════════════════════════════════════════════════
let authToken = localStorage.getItem('authToken') || null;
let authUsername = localStorage.getItem('authUsername') || null;
let isGuest = localStorage.getItem('authGuest') === '1';
// "ui" lưu lại trạng thái đang thao tác dở (tab đang xem, Quyển/level + bài đang chọn) —
// được đồng bộ lên server cùng tiến độ học, để mở lại app (kể cả trên máy khác) vẫn đúng chỗ cũ.
function defaultProgress() {
  return { srs: {}, streak: 0, lastDate: null, ui: {
    lastTab: 'home', selectedBookIds: [1], selectedLessons: [], lessonsAllMode: true,
    showPinyin: true, showMeaning: true, showHanViet: true, theme: 'light', ttsRate: 0.65,
    qzType: '漢→Việt', qzQuestionCount: 30, questionCount: 10,
    // Cài đặt hệ thống học FSRS (Phần 22): daily limit + current lesson tự động cập nhật.
    dailyReviewLimit: 50, dailyNewLimit: 10, newOnlyAfterDue: true, currentLesson: null,
  } };
}
function normalizeProgress(p) {
  if (!p || typeof p !== 'object') return defaultProgress();
  if (!p.srs) p.srs = {};
  if (typeof p.streak !== 'number') p.streak = 0;
  if (p.lastDate === undefined) p.lastDate = null;
  if (!p.ui || typeof p.ui !== 'object') p.ui = defaultProgress().ui;
  if (!p.ui.lastTab) p.ui.lastTab = 'home';
  if (!Array.isArray(p.ui.selectedBookIds)) p.ui.selectedBookIds = [1];
  if (!Array.isArray(p.ui.selectedLessons)) p.ui.selectedLessons = [];
  if (typeof p.ui.lessonsAllMode !== 'boolean') p.ui.lessonsAllMode = (p.ui.selectedLessons.length === 0);
  if (typeof p.ui.showPinyin !== 'boolean') p.ui.showPinyin = true;
  if (typeof p.ui.showMeaning !== 'boolean') p.ui.showMeaning = true;
  if (typeof p.ui.showHanViet !== 'boolean') p.ui.showHanViet = true;
  if (p.ui.theme !== 'dark' && p.ui.theme !== 'light') p.ui.theme = 'light';
  if (typeof p.ui.ttsRate !== 'number' || p.ui.ttsRate < 0.3 || p.ui.ttsRate > 1.0) p.ui.ttsRate = 0.65;
  if (!['漢→Việt', 'Việt→漢', 'Âm→漢'].includes(p.ui.qzType)) p.ui.qzType = '漢→Việt';
  if (!Number.isFinite(p.ui.qzQuestionCount)) p.ui.qzQuestionCount = 30;
  if (!Number.isFinite(p.ui.questionCount)) p.ui.questionCount = 10;
  if (!Number.isFinite(p.ui.dailyReviewLimit) || p.ui.dailyReviewLimit < 1) p.ui.dailyReviewLimit = 50;
  if (!Number.isFinite(p.ui.dailyNewLimit) || p.ui.dailyNewLimit < 0) p.ui.dailyNewLimit = 10;
  if (typeof p.ui.newOnlyAfterDue !== 'boolean') p.ui.newOnlyAfterDue = true;
  if (!Number.isFinite(p.ui.currentLesson)) p.ui.currentLesson = null;
  return p;
}
let progressState = defaultProgress();
// Áp dụng lại trạng thái đang thao tác dở (tab, Quyển/level, bài đang chọn, các cài đặt hiển thị)
// từ progressState.ui — gọi mỗi khi mở lại app hoặc đăng nhập xong, để khỏi phải chọn lại từ đầu.
function applyUIState() {
  normalizeProgress(progressState);
  const ui = progressState.ui;
  const validTabs = ['home','today','flash','quiz','type','listen','stats','difficult','compare','hsk','admin','vocab','logs'];
  currentTab = validTabs.includes(ui.lastTab) ? ui.lastTab : 'home';
  selectedBookIds = new Set(ui.selectedBookIds);
  selectedLessons = new Set(ui.selectedLessons);
  lessonsAllMode = ui.lessonsAllMode;
  showPinyin = ui.showPinyin;
  showMeaning = ui.showMeaning;
  showHanViet = ui.showHanViet;
  qzType = ui.qzType;
  qzQuestionCount = ui.qzQuestionCount;
  questionCount = ui.questionCount;
  ttsRate = ui.ttsRate;
  const pyBtn = document.getElementById('py-toggle-btn');
  if (pyBtn) pyBtn.textContent = showPinyin ? 'Ẩn Pinyin' : 'Hiện Pinyin';
  const viBtn = document.getElementById('vi-toggle-btn');
  if (viBtn) viBtn.textContent = showMeaning ? 'Ẩn nghĩa' : 'Hiện nghĩa';
  const hvBtn = document.getElementById('hv-toggle-btn');
  if (hvBtn) hvBtn.textContent = showHanViet ? 'Ẩn Hán Việt' : 'Hiện Hán Việt';
  const speedSlider = document.getElementById('speed-slider');
  if (speedSlider) speedSlider.value = ttsRate;
  const speedVal = document.getElementById('speed-val');
  if (speedVal) speedVal.textContent = ttsRate.toFixed(2);
  applyTheme(ui.theme);
  const navBtn = document.getElementById('tab-' + currentTab);
  if (navBtn) {
    document.querySelectorAll('#nav button').forEach(b => b.classList.remove('active'));
    navBtn.classList.add('active');
  }
}
let authMode = 'login'; // 'login' | 'register'
let syncTimer = null;
let syncOk = true;
let currentRole = 'user';   // 'user' | 'admin' | 'superadmin'
let currentRank = null;     // {name, icon, next:{name,icon,remain}|null}
function isAdminRole() { return currentRole === 'admin' || currentRole === 'superadmin'; }

function authHeaders() {
  return authToken ? { 'Authorization': 'Bearer ' + authToken } : {};
}

function authSwitchTab(mode) {
  authMode = mode;
  document.getElementById('auth-tab-login').classList.toggle('active', mode === 'login');
  document.getElementById('auth-tab-register').classList.toggle('active', mode === 'register');
  document.getElementById('auth-submit').textContent = mode === 'login' ? 'Đăng nhập' : 'Đăng ký';
  document.getElementById('auth-error').classList.remove('show');
}

function authShowError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.add('show');
}

async function authSubmit() {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  const btn = document.getElementById('auth-submit');
  if (!username || !password) { authShowError('Vui lòng nhập đầy đủ thông tin'); return; }
  btn.disabled = true;
  const oldLabel = btn.textContent; btn.textContent = 'Đang xử lý...';
  try {
    const res = await fetch('/api/' + authMode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!data.ok) { authShowError(data.error || 'Có lỗi xảy ra'); return; }
    authToken = data.token; authUsername = data.username; isGuest = false;
    localStorage.setItem('authToken', authToken);
    localStorage.setItem('authUsername', authUsername);
    localStorage.removeItem('authGuest');
    studySession = { id: null, startedAt: 0, lastActivity: 0, cards: 0, correct: 0, wrong: 0 }; // Task 4/5: mỗi tài khoản có phiên học riêng, tránh lẫn phiên cũ
    // V77 (Study Day/Study Session): TRƯỚC ĐÂY đăng nhập luôn XOÁ TRẮNG sessionKnownHz — nghĩa là
    // đăng xuất rồi đăng nhập lại CÙNG NGÀY sẽ vô tình cho phép học lại đúng những từ vừa hoàn
    // thành trước đó (vi phạm Yêu cầu 3). Giờ nạp lại ĐÚNG bộ "đã hoàn thành hôm nay" đã lưu sẵn
    // (khoá theo đúng authUsername + đúng ngày, xem sessionKnownHzStoreKey ở study-queue.js) —
    // không còn xoá trắng, tài khoản này vẫn nhớ đúng những gì đã học trong ngày dù có đăng xuất/
    // đăng nhập lại giữa chừng.
    _sessionKnownHzDay = todayKey();
    sessionKnownHz = loadSessionKnownHz();
    progressState = data.progress || defaultProgress();
    currentRole = data.role || 'user';
    currentRank = data.rank || null;
    serverStreak = data.streak || 0;
    serverLongestStreak = data.longestStreak || 0;
    serverKnownCount = data.known || 0;
    applyUIState();
    cacheProgressLocally();
    closeAuthGate();
    render();
  } catch (e) {
    authShowError('Không kết nối được máy chủ. Kiểm tra mạng và thử lại.');
  } finally {
    btn.disabled = false; btn.textContent = oldLabel;
  }
}

function authContinueAsGuest() {
  isGuest = true;
  localStorage.setItem('authGuest', '1');
  authToken = null; authUsername = null;
  currentRole = 'user'; currentRank = null;
  pauseStudyTimer(); studySession = { id: null, startedAt: 0, lastActivity: 0, cards: 0, correct: 0, wrong: 0 };
  _sessionKnownHzDay = todayKey();
  sessionKnownHz = loadSessionKnownHz(); // V77: nạp đúng "đã hoàn thành hôm nay" của phiên khách (nếu có), không xoá trắng nữa — xem authSubmit
  localStorage.removeItem('authToken'); localStorage.removeItem('authUsername');
  progressState = loadGuestProgressLocally();
  applyUIState();
  closeAuthGate();
  render();
}

function authOpenMenu() {
  if (isGuest || !authUsername) { openAuthGate(); return; }
  document.getElementById('account-menu-name').textContent = '👤 ' + authUsername;
  document.getElementById('account-menu').style.display = 'flex';
}
function closeAccountMenu() { document.getElementById('account-menu').style.display = 'none'; }

function openChangePassword() {
  document.getElementById('pw-old').value = '';
  document.getElementById('pw-new').value = '';
  document.getElementById('pw-new2').value = '';
  document.getElementById('pw-error').classList.remove('show');
  document.getElementById('pw-modal').style.display = 'flex';
}
function closeChangePassword() { document.getElementById('pw-modal').style.display = 'none'; }

async function submitChangePassword() {
  const oldPassword = document.getElementById('pw-old').value;
  const newPassword = document.getElementById('pw-new').value;
  const newPassword2 = document.getElementById('pw-new2').value;
  const errEl = document.getElementById('pw-error');
  const showErr = (msg) => { errEl.textContent = msg; errEl.classList.add('show'); };
  if (!oldPassword || !newPassword) return showErr('Vui lòng nhập đủ thông tin.');
  if (newPassword.length < 4) return showErr('Mật khẩu mới cần tối thiểu 4 ký tự.');
  if (newPassword !== newPassword2) return showErr('Mật khẩu mới nhập lại không khớp.');
  const btn = document.getElementById('pw-submit');
  btn.disabled = true; btn.textContent = 'Đang xử lý...';
  try {
    const res = await fetch('/api/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    const data = await res.json();
    if (!data.ok) { showErr(data.error || 'Đổi mật khẩu thất bại.'); return; }
    closeChangePassword();
    alert('✅ Đổi mật khẩu thành công!');
  } catch (e) {
    showErr('Lỗi kết nối: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Đổi mật khẩu';
  }
}

async function authLogout() {
  try { await fetch('/api/logout', { method: 'POST', headers: authHeaders() }); } catch {}
  authToken = null; authUsername = null; isGuest = false;
  currentRole = 'user'; currentRank = null;
  serverStreak = 0; serverLongestStreak = 0; serverKnownCount = 0;
  pauseStudyTimer(); studySession = { id: null, startedAt: 0, lastActivity: 0, cards: 0, correct: 0, wrong: 0 };
  // V77: KHÔNG còn xoá localStorage "đã hoàn thành hôm nay" của username vừa đăng xuất — dữ liệu
  // này thuộc về đúng Study Day hôm nay của tài khoản đó, phải còn nguyên nếu họ đăng nhập lại
  // trong CÙNG NGÀY (Yêu cầu 3). authUsername đổi về null ngay dưới đây nên set trong bộ nhớ cũng
  // phải đổi theo (không còn ai đăng nhập -> không có "đã hoàn thành hôm nay" nào áp dụng).
  sessionKnownHz = new Set();
  localStorage.removeItem('authToken'); localStorage.removeItem('authUsername'); localStorage.removeItem('authGuest');
  progressState = defaultProgress();
  applyUIState();
  openAuthGate();
}

function openAuthGate() {
  document.getElementById('auth-gate').style.display = 'flex';
  document.getElementById('auth-username').value = '';
  document.getElementById('auth-password').value = '';
  document.getElementById('auth-error').classList.remove('show');
  document.getElementById('tab-admin').style.display = 'none';
  document.getElementById('tab-vocab').style.display = 'none';
  document.getElementById('tab-logs').style.display = 'none';
}
function closeAuthGate() {
  document.getElementById('auth-gate').style.display = 'none';
  updateUserBadge();
  const showAdmin = (!isGuest && isAdminRole()) ? '' : 'none';
  document.getElementById('tab-admin').style.display = showAdmin;
  document.getElementById('tab-vocab').style.display = showAdmin;
  document.getElementById('tab-logs').style.display = showAdmin;
}
function updateUserBadge() {
  const badge = document.getElementById('user-badge');
  if (!badge) return;
  if (isGuest) { badge.innerHTML = '👤 Khách (chỉ lưu máy này)'; return; }
  const rankIcon = currentRank ? currentRank.icon + ' ' : '';
  badge.innerHTML = rankIcon + '👤 ' + authUsername + (currentRole === 'superadmin' ? ' 👑🛠️' : currentRole === 'admin' ? ' 🛠️' : '');
}

// Khách (không đăng nhập): vẫn lưu localStorage như trước, riêng theo trình duyệt
function loadGuestProgressLocally() {
  try { return JSON.parse(localStorage.getItem('guestProgress') || 'null') || { srs: {}, streak: 0, lastDate: null }; }
  catch { return { srs: {}, streak: 0, lastDate: null }; }
}
function cacheProgressLocally() {
  if (isGuest) { localStorage.setItem('guestProgress', JSON.stringify(progressState)); return; }
  if (authUsername) {
    localStorage.setItem('progressCache_' + authUsername, JSON.stringify(progressState));
    localStorage.setItem('roleCache_' + authUsername, currentRole || 'user');
  }
}

// Đồng bộ lên server (gộp các lần lưu liên tiếp trong 700ms để đỡ tốn request)
function scheduleSync() {
  if (isGuest || !authToken) return;
  syncOk = null; updateSyncIndicator();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(progressState),
      });
      const data = await res.json();
      syncOk = !!data.ok;
      if (data.rank) { currentRank = data.rank; updateUserBadge(); }
    } catch { syncOk = false; }
    updateSyncIndicator();
  }, 700);
}
function updateSyncIndicator() {
  const badge = document.getElementById('user-badge');
  if (!badge || isGuest || !authUsername) return;
  const dot = syncOk === false ? '<span class="sync-dot offline"></span>' : (syncOk === null ? '' : '<span class="sync-dot"></span>');
  const rankIcon = currentRank ? currentRank.icon + ' ' : '';
  badge.innerHTML = dot + rankIcon + '👤 ' + authUsername + (currentRole === 'superadmin' ? ' 👑🛠️' : currentRole === 'admin' ? ' 🛠️' : '');
}

// FIX (Vấn đề 5 — "Chọn bài học không hoạt động"): scheduleSync() debounce 700ms rồi mới đẩy
// progress.ui (gồm selectedBookIds/selectedLessons/lessonsAllMode) lên server. Nếu user vừa đổi
// Quyển/bài rồi bấm "Bắt đầu học"/vào tab luyện tập NGAY (trong vòng 700ms), server truy vấn
// /api/study/session vẫn đọc user.progress.ui CŨ (bản debounce chưa kịp chạy) — lấy nhầm đúng bộ
// lọc CŨ, trông như "chọn bài học không hoạt động". flushProgressSync() huỷ debounce hiện tại và
// đẩy NGAY, trả về promise để nơi gọi await được — đảm bảo server luôn thấy đúng lựa chọn MỚI NHẤT
// trước khi truy vấn bất kỳ dữ liệu học nào phụ thuộc vào nó (gọi ở loadFsrsPracticePool() và
// rvFetchFreshSession() ngay trước khi fetch /api/study/session).
async function flushProgressSync() {
  if (isGuest || !authToken) return;
  clearTimeout(syncTimer);
  syncOk = null; updateSyncIndicator();
  try {
    const res = await fetch('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(progressState),
    });
    const data = await res.json();
    syncOk = !!data.ok;
    if (data.rank) { currentRank = data.rank; updateUserBadge(); }
  } catch { syncOk = false; }
  updateSyncIndicator();
}

// Khởi động: nếu đã đăng nhập trước đó trên máy này, vào thẳng app bằng dữ liệu lưu tạm
// (không phải đợi mạng phản hồi mới cho vào — đây là nguyên nhân gây ra màn hình đăng nhập
// hiện thoáng qua vài giây mỗi lần mở app), rồi âm thầm đồng bộ lại với server phía sau.
async function bootAuth() {
  if (isGuest) {
    progressState = loadGuestProgressLocally();
    applyUIState();
    closeAuthGate();
    return;
  }
  if (authToken && authUsername) {
    flushReviewOutbox(); // FIX (Task 3): tự gửi lại review còn kẹt trong outbox từ phiên trước (F5/mất mạng/đóng tab)
    const cachedRaw = localStorage.getItem('progressCache_' + authUsername);
    let enteredWithCache = false;
    if (cachedRaw) {
      try {
        progressState = JSON.parse(cachedRaw);
        currentRole = localStorage.getItem('roleCache_' + authUsername) || 'user';
        applyUIState();
        closeAuthGate();
        render();
        enteredWithCache = true;
      } catch {}
    }
    try {
      const res = await fetch('/api/progress', { headers: authHeaders() });
      const data = await res.json();
      if (data.ok) {
        progressState = data.progress || defaultProgress();
        currentRole = data.role || 'user';
        currentRank = data.rank || null;
        // V70 (Task 2 audit): streak/known THẬT từ server (study_sessions/fsrs_cards) — trước đây
        // client bỏ qua 2 trường này và tự tính streak cục bộ bằng SRS cũ đã bị xoá.
        serverStreak = data.streak || 0;
        serverLongestStreak = data.longestStreak || 0;
        serverKnownCount = data.known || 0;
        // Chỉ áp trạng thái tab/lựa chọn nếu đây là lần đầu vào (chưa có cache) — tránh việc
        // đang xem dở 1 tab rồi tự nhảy sang tab khác khi dữ liệu server về chậm hơn 1 chút.
        if (!enteredWithCache) applyUIState();
        cacheProgressLocally();
        closeAuthGate();
        if (enteredWithCache) { syncOk = true; updateSyncIndicator(); render(); }
        else render();
        return;
      }
      // Token không còn hợp lệ (vd tài khoản đã bị xoá, hoặc phiên đăng nhập hết hạn)
      if (!enteredWithCache) openAuthGate();
      else { syncOk = false; updateSyncIndicator(); }
    } catch {
      // Không có mạng / server chưa phản hồi kịp — nếu đã vào bằng cache thì cứ để vậy, đồng bộ lại sau
      if (!enteredWithCache) openAuthGate();
      else { syncOk = false; updateSyncIndicator(); }
    }
    return;
  }
  openAuthGate();
}

// ════════════════════════════════════════════════════
// V70 (Task 2 audit — hợp nhất FSRS): TOÀN BỘ hệ "SRS cục bộ" tự viết cũ (step cứng 10p/1h/1
// ngày/3 ngày/7 ngày, lưu trong progressState.srs) đã bị XOÁ khỏi client cho user ĐÃ ĐĂNG NHẬP.
// Lý do: nó là "review queue riêng" / "SRS cũ" chạy song song với FSRS-6 thật (Task 2 cấm), và
// thực ra backend đã ngừng lưu progress.srs từ trước (xem api/index.js `/api/progress` POST —
// "V69: chỉ còn ui, KHÔNG còn srs/streak") — client chỉ chưa được cập nhật theo kịp, khiến dữ
// liệu cũ này chỉ tồn tại "ảo" trên 1 thiết bị, không đồng bộ, không phải nguồn sự thật thật sự.
//
// Từ giờ:
//   - User ĐÃ ĐĂNG NHẬP: streak/known/độ ưu tiên từ đến hạn... đều lấy từ SERVER (FSRS-6 thật,
//     reviewService + fsrs_cards + review_history + study_sessions) — xem serverStreak/
//     serverKnownCount bên dưới + loadFsrsPracticePool()/submitFsrsReview() dùng ở các tab luyện tập.
//   - KHÁCH (chưa đăng nhập): KHÔNG có tài khoản nên không thể có thẻ FSRS thật trên server. Giữ
//     lại 1 cơ chế cực tối giản CHỈ để tính streak hiển thị cục bộ trên máy khách đó (không giả vờ
//     đây là spaced-repetition thật) — xem guestMarkActivity() bên dưới.
// ════════════════════════════════════════════════════
let serverStreak = 0, serverLongestStreak = 0, serverKnownCount = 0;

// Streak hiển thị: user thật → số streak SERVER tính (từ study_sessions thật, Phần 11 Task 6);
// khách → đếm cục bộ đơn giản, chỉ để có con số vui mắt, không phải dữ liệu học tập thật.
function getStreak() { return isGuest ? (progressState.streak || 0) : serverStreak; }

// Chỉ dùng cho KHÁCH: đánh dấu "hôm nay có luyện tập" để tăng streak hiển thị cục bộ. Không tạo
// thẻ SRS/step nào cả — khách luyện Flashcard/Trắc nghiệm/Gõ chữ/Nghe-chọn chỉ để thử, không có
// lịch ôn tập thật (cần đăng nhập mới có FSRS thật, xem app.js `renderToday`).
function guestMarkActivity() {
  if (!isGuest) return;
  const today = new Date().toDateString();
  if (progressState.lastDate === today) return;
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  progressState.streak = (progressState.lastDate === yesterday) ? (progressState.streak || 0) + 1 : 1;
  progressState.lastDate = today;
  cacheProgressLocally();
}

// Gọi lại /api/progress để làm mới streak/known thật sau khi vừa hoàn thành 1 lượt/1 phiên luyện
// tập ở BẤT KỲ tab nào (Task 2: mọi tab đều là "nguồn sự thật" như nhau) — không gọi sau MỖI câu
// trả lời (tốn request), chỉ gọi khi kết thúc 1 phiên/1 thẻ để badge không bị cũ quá lâu.
let _refreshMetaTimer = null;
function refreshServerMeta() {
  if (isGuest || !authToken) return;
  clearTimeout(_refreshMetaTimer);
  _refreshMetaTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/progress', { headers: authHeaders() });
      const data = await res.json();
      if (data.ok) {
        serverStreak = data.streak || 0;
        serverLongestStreak = data.longestStreak || 0;
        serverKnownCount = data.known || 0;
        currentRank = data.rank || currentRank;
        const badge = document.getElementById('streak-badge');
        if (badge) badge.textContent = '🔥 ' + getStreak() + ' ngày';
        updateUserBadge();
      }
    } catch { /* im lặng — không chặn luồng học vì lỗi làm mới badge */ }
  }, 900);
}

