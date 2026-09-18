// js/lesson.js — Trang chủ + "Hôm nay học" (dashboard FSRS: due hôm nay, từ mới, bài hiện tại)
// ════════════════════════════════════════════════════
// HOME
// ════════════════════════════════════════════════════
// AUDIT V82 (Phần 1/7 — "Home → Bắt đầu học, một thao tác"): TRƯỚC ĐÂY user phải chuyển sang tab
// "🎯 Hôm nay học" mới thấy số từ due/mới + nút "Bắt đầu học" — Trang chủ chỉ có 4 nút chọn CHẾ ĐỘ
// (không ưu tiên FSRS thật). Giờ thêm 1 khối "at a glance" ngay đầu Trang chủ cho user đã đăng nhập:
// due/mới hôm nay + đúng 1 nút "Bắt đầu học" (đi thẳng vào hàng đợi ôn tập FSRS thật, giống hệt tab
// "Hôm nay học"), rút app xuống còn "mở app → 1 chạm" cho luồng học chính. 4 nút chế độ cũ vẫn giữ
// nguyên bên dưới làm lối vào phụ (khi user chủ động muốn luyện 1 kiểu cụ thể).
function renderHome() {
  return `
  ${isLoggedIn() ? `<div class="panel" id="home-quickstart-panel"><div id="home-quickstart" class="study-empty">Đang tải...</div></div>` : ''}
  <div class="panel">
    <div class="panel-title">Chọn bài học</div>
    ${lessonFilterHtml()}
  </div>
  <div class="panel">
    <div class="panel-title">Bắt đầu học nhanh</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <button class="btn btn-primary" onclick="ssEnterMode('flash')">📖 Flashcard</button>
      <button class="btn" style="background:var(--l8c);color:var(--l8a);" onclick="ssEnterMode('quiz')">📝 Trắc nghiệm</button>
      <button class="btn" style="background:var(--l9c);color:var(--l9a);" onclick="ssEnterMode('listen')">🎧 Nghe chọn</button>
      <button class="btn" style="background:var(--l10c);color:var(--l10a);" onclick="ssEnterMode('type')">⌨️ Gõ chữ</button>
    </div>
  </div>`;
}
function bindHome() {
  if (!isLoggedIn()) return;
  loadHomeQuickstart();
}
async function loadHomeQuickstart() {
  const area = document.getElementById('home-quickstart');
  if (!area) return;
  const data = await fetchTodayDashboard(false);
  if (currentTab !== 'home') return; // user đã rời Trang chủ trong lúc chờ
  const panel = document.getElementById('home-quickstart-panel');
  // Không có gì đáng hiện ở Trang chủ (chưa chọn phạm vi/lỗi mạng) — ẩn hẳn khối này, đừng chiếm
  // chỗ bằng thông báo lỗi mà tab "Hôm nay học" đã giải thích đầy đủ hơn (Phần 1 — giảm nhiễu).
  if (!data || !data.ok || !data.hasScope) { if (panel) panel.remove(); return; }
  if (data.dueCount === 0 && data.newInCurrentLesson === 0) {
    area.innerHTML = `🎉 Đã ôn hết từ đến hạn và học hết từ mới của Bài ${data.currentLesson}!`;
    return;
  }
  area.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:10px;font-size:.85rem;color:var(--muted);font-weight:700;">
      <span>🔴 ${data.dueCount} cần ôn</span><span>🆕 ${data.newInCurrentLesson} từ mới</span>
    </div>
    ${data.blockedByBacklog ? `<div style="font-size:.78rem;color:var(--muted);text-align:center;margin-bottom:10px;">⏳ Từ mới đang tạm khoá vì còn ${data.totalDue} thẻ cần ôn (có thể ở Quyển/bài khác) — tắt "Chỉ học từ mới sau khi hết backlog ôn tập" trong Cài đặt hằng ngày nếu muốn học từ mới ngay.</div>` : ''}
    <button class="btn btn-primary" style="width:100%;font-size:1.05rem;padding:15px;" onclick="ssEnterMode('review')">▶️ Bắt đầu học</button>`;
}

// ════════════════════════════════════════════════════
// HÔM NAY HỌC — dashboard FSRS (Phần 13)
// ════════════════════════════════════════════════════
function renderToday() {
  if (!isLoggedIn()) {
    return `<div class="panel">
      <div class="panel-title">今日学习 · Hôm nay học</div>
      <div class="study-empty">🔒 Cần đăng nhập để dùng hệ thống ôn tập FSRS cá nhân hoá và lưu tiến độ.</div>
      <button class="btn btn-primary" style="width:100%;" onclick="openAuthGate()">Đăng nhập / Đăng ký</button>
    </div>`;
  }
  const ui = progressState.ui;
  return `
  <div class="panel">
    <div class="panel-title">今日学习 · Hôm nay học</div>
    <div id="study-dash-area" class="study-empty">Đang tải...</div>
  </div>
  <div class="panel">
    <div class="panel-title">Cài đặt hằng ngày</div>
    <div class="study-settings-row">
      <span>♾️ Học không giới hạn mỗi ngày</span>
      <input type="checkbox" ${ui.unlimitedStudy ? 'checked' : ''} onchange="updateStudySetting('unlimitedStudy', this.checked)">
    </div>
    <div class="study-settings-row" style="${ui.unlimitedStudy ? 'opacity:.4;' : ''}">
      <span>🔁 Giới hạn ôn tập / ngày</span>
      <input type="number" min="1" value="${ui.dailyReviewLimit}" ${ui.unlimitedStudy ? 'disabled' : ''} onchange="updateStudySetting('dailyReviewLimit', this.value)">
    </div>
    <div class="study-settings-row" style="${ui.unlimitedStudy ? 'opacity:.4;' : ''}">
      <span>🆕 Giới hạn từ mới / ngày</span>
      <input type="number" min="0" value="${ui.dailyNewLimit}" ${ui.unlimitedStudy ? 'disabled' : ''} onchange="updateStudySetting('dailyNewLimit', this.value)">
    </div>
    <div class="study-settings-row" style="${ui.unlimitedStudy ? 'opacity:.4;' : ''}">
      <span>Chỉ học từ mới sau khi hết backlog ôn tập</span>
      <input type="checkbox" ${ui.newOnlyAfterDue ? 'checked' : ''} ${ui.unlimitedStudy ? 'disabled' : ''} onchange="updateStudySetting('newOnlyAfterDue', this.checked)">
    </div>
    ${ui.unlimitedStudy ? '<div style="font-size:.85rem;opacity:.7;margin-top:4px;">Áp dụng cho mọi tab luyện tập (Flashcard/Trắc nghiệm/Gõ chữ/Nghe-chọn) — không còn bị chặn lại trong ngày.</div>' : ''}
  </div>`;
}
function bindToday() {
  if (!isLoggedIn()) return;
  loadStudyDashboard();
}
// AUDIT V82 (Phần 12/14 — chống duplicate request, tái sử dụng dữ liệu): /api/study/today giờ dùng
// CHUNG qua fetchTodayDashboard() (cache TTL ngắn) giữa tab "Hôm nay học" và khối "at a glance" mới
// ở Trang chủ — bấm qua lại 2 tab này liên tục trong vài giây không gọi lại API 2 lần. force=true
// dùng khi user CHỦ ĐỘNG vào "Hôm nay học" (muốn số liệu mới nhất ngay), force=false (mặc định) cho
// Trang chủ (chấp nhận cache vài giây, ưu tiên hiển thị tức thời).
let _todayDashCache = null, _todayDashCacheAt = 0;
const TODAY_DASH_CACHE_TTL_MS = 10000;
// V98 fix ("Hôm nay học"/"Bắt đầu học" ở Trang chủ không theo lựa chọn bài mới): saveSelectionState()
// (js/ui.js) gọi hàm này ngay khi Quyển/bài đang chọn vừa đổi — trước đây chỉ
// sqInvalidateQueuesForSelectionChange() (huỷ hàng đợi luyện tập) được gọi, còn cache dashboard này
// (TTL 10s, dùng chung cho khối "at a glance" Trang chủ VÀ tab "Hôm nay học") không hề bị huỷ — nên
// đổi bài xong, số due/mới hiển thị ngay vẫn là số theo phạm vi CŨ tới khi cache tự hết hạn.
function invalidateTodayDashboardCache() {
  _todayDashCache = null;
  _todayDashCacheAt = 0;
}
async function fetchTodayDashboard(force) {
  if (!force && _todayDashCache && (Date.now() - _todayDashCacheAt) < TODAY_DASH_CACHE_TTL_MS) return _todayDashCache;
  try {
    // V98 fix (cùng lớp bug với "Vấn đề 5" đã sửa ở loadFsrsPracticePool/rvFetchFreshSession —
    // js/study-queue.js/js/review.js): TRƯỚC ĐÂY hàm này fetch thẳng /api/study/today mà không đợi
    // flushProgressSync() — nếu gọi trong vòng 700ms sau khi user vừa đổi Quyển/bài (scheduleSync()
    // còn đang debounce), server vẫn đọc user.progress.ui CŨ, trả về due/new theo phạm vi CŨ. Đây
    // chính là lý do khối "Hôm nay học"/"Bắt đầu học" ở Trang chủ có vẻ "không theo lựa chọn bài" dù
    // cache phía client (ở trên) đã được huỷ đúng lúc.
    await flushProgressSync();
    const res = await fetch('/api/study/today', { headers: authHeaders() });
    const data = await res.json();
    _todayDashCache = data; _todayDashCacheAt = Date.now();
    return data;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
async function loadStudyDashboard() {
  const area = document.getElementById('study-dash-area');
  if (!area) return;
  try {
    const data = await fetchTodayDashboard(true);
    if (currentTab !== 'today') return; // user đã rời tab trong lúc chờ
    if (!data.ok) { area.innerHTML = `<div class="study-empty">${data.error || 'Không tải được dữ liệu'}</div>`; return; }
    if (!data.hasScope) {
      area.innerHTML = `<div class="study-empty">Chưa có từ vựng trong phạm vi Quyển/bài bạn đang chọn.<br>Vào <b>Trang chủ</b> để chọn Quyển/bài trước.</div>`;
      return;
    }
    if (data.dueCount === 0 && data.newInCurrentLesson === 0) {
      area.innerHTML = `<div class="study-empty">🎉 Bạn đã ôn hết từ đến hạn và học hết từ mới của Bài ${data.currentLesson}!<br>Quay lại sau hoặc chọn thêm Quyển/bài ở Trang chủ.</div>`;
      return;
    }
    area.innerHTML = `
      <div class="study-grid">
        <div class="study-stat due"><div class="study-stat-num">🔴 ${data.dueCount}</div><div class="study-stat-label">Từ cần ôn</div></div>
        <div class="study-stat new"><div class="study-stat-num">🆕 ${data.newInCurrentLesson}</div><div class="study-stat-label">Từ mới</div></div>
        <div class="study-stat lesson"><div class="study-stat-num">📖 Bài ${data.currentLesson}</div><div class="study-stat-label">Bài hiện tại</div></div>
        <div class="study-stat weak"><div class="study-stat-num">🔥 ${data.weakCount}</div><div class="study-stat-label">Từ hay quên</div></div>
      </div>
      ${data.blockedByBacklog ? `<div style="font-size:.8rem;color:var(--muted);margin:8px 0;">⏳ Từ mới đang tạm khoá vì còn ${data.totalDue} thẻ cần ôn (có thể ở Quyển/bài khác) — tắt "Chỉ học từ mới sau khi hết backlog ôn tập" trong Cài đặt hằng ngày nếu muốn học từ mới ngay.</div>` : ''}
      <button class="btn btn-primary" style="width:100%;font-size:1.05rem;padding:15px;" onclick="ssEnterMode('review')">▶️ Bắt đầu học</button>
      ${data.weakCount > 0 ? `<button class="btn" style="width:100%;margin-top:8px;background:var(--l10c);color:var(--l10a);" onclick="ssEnterMode('review-weak')">⚠️ Luyện từ hay quên (${data.weakCount})</button>` : ''}
    `;
  } catch (e) {
    area.innerHTML = `<div class="study-empty">Lỗi kết nối: ${e.message}</div>`;
  }
}
function updateStudySetting(key, value) {
  if (key === 'newOnlyAfterDue' || key === 'unlimitedStudy') progressState.ui[key] = !!value;
  else {
    const n = parseInt(value, 10);
    if (Number.isFinite(n) && n >= 0) progressState.ui[key] = n;
  }
  cacheProgressLocally();
  scheduleSync();
  // V100 fix ("Hôm nay học không đổi dù đã chỉnh Cài đặt hằng ngày"): TRƯỚC ĐÂY chỉ unlimitedStudy
  // mới render() lại — đổi dailyReviewLimit/dailyNewLimit/newOnlyAfterDue KHÔNG hề vẽ lại số due/
  // mới, số cũ vẫn đứng yên tới khi user rời tab rồi quay lại. Giờ MỌI thay đổi ở đây đều huỷ cache
  // dashboard rồi vẽ lại ngay (render() tự gọi loadStudyDashboard()/loadHomeQuickstart() tuỳ tab
  // đang mở — xem js/navigation.js); fetchTodayDashboard() cũng tự flushProgressSync() nên server
  // luôn thấy đúng giá trị MỚI NHẤT trước khi tính lại, không dính debounce 700ms của scheduleSync().
  invalidateTodayDashboardCache();
  if (typeof render === 'function') render();
}

