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
    <div class="study-settings-row">
      <span>🔁 Giới hạn ôn tập / ngày</span>
      <input type="number" min="1" value="${ui.dailyReviewLimit}" onchange="updateStudySetting('dailyReviewLimit', this.value)">
    </div>
    <div class="study-settings-row">
      <span>🆕 Giới hạn từ mới / ngày</span>
      <input type="number" min="0" value="${ui.dailyNewLimit}" onchange="updateStudySetting('dailyNewLimit', this.value)">
    </div>
    <div class="study-settings-row">
      <span>Chỉ học từ mới sau khi hết backlog ôn tập</span>
      <input type="checkbox" ${ui.newOnlyAfterDue ? 'checked' : ''} onchange="updateStudySetting('newOnlyAfterDue', this.checked)">
    </div>
    <div style="font-size:.85rem;opacity:.7;margin-top:4px;">
      ${ui.unlimitedStudy
        ? 'Bật: không bị chặn lại vì "đã học đủ hôm nay" — học được nhiều lượt tuỳ ý trong ngày. Mỗi lượt vẫn lấy đúng theo 2 giới hạn ôn tập/từ mới ở trên.'
        : 'Tắt: mỗi ngày chỉ học tối đa đúng 2 giới hạn ở trên (trừ dần theo số đã học trong ngày), hết là phải đợi qua ngày mới.'}
    </div>
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
    // V110: KHÔNG thoát sớm khi hết thẻ/từ mới — người học vẫn cần thấy thống kê và các chế độ luyện bổ sung / kiểm tra lại.
    area.innerHTML = renderTodayPanel(data);
  } catch (e) {
    area.innerHTML = `<div class="study-empty">Lỗi kết nối: ${e.message}</div>`;
  }
}

// ── V110: bảng điều khiển học tập hằng ngày ─────────────────────────────────────────────────────
// Mọi số đều lấy từ server (không số giả). Phân biệt rõ 3 đơn vị KHÁC NHAU:
//   • TỪ duy nhất  — mỗi từ chỉ đếm 1 lần dù thuộc nhiều nhóm (vừa đến hạn vừa yếu nghe...).
//   • THẺ đến hạn  — số thẻ FSRS tới hạn ôn (1 từ = 1 thẻ ở bài đang chọn).
//   • LƯỢT câu hỏi — mỗi lần trả lời; 1 từ có thể được hỏi nhiều lượt trong 1 buổi.
// Các nhóm "cần củng cố / kỹ năng yếu / kiểm tra lại" có thể TRÙNG nhau → KHÔNG cộng chúng lại; dùng "từ duy nhất".
function tdFmtDuration(sec) {
  const m = Math.round((sec || 0) / 60);
  if (!sec) return '0 phút';
  return m < 1 ? 'dưới 1 phút' : (m < 60 ? m + ' phút' : Math.floor(m / 60) + ' giờ ' + (m % 60) + ' phút');
}
function renderTodayPanel(data) {
  const b = data.breakdown, pr = data.progress, dl = data.daily;
  const nothingToDo = (data.dueCount || 0) === 0 && (data.newInCurrentLesson || 0) === 0;
  const cell = (cls, num, label, sub) => `<div class="study-stat ${cls}"><div class="study-stat-num">${num}</div><div class="study-stat-label">${label}</div>${sub ? `<div style="font-size:.68rem;color:var(--muted);font-weight:600;margin-top:2px">${sub}</div>` : ''}</div>`;

  // Tiến độ nhiệm vụ hôm nay = số thẻ FSRS chính thức đã làm / (đã làm + còn lại có thể làm hôm nay).
  let progressHtml = '';
  if (dl) {
    const done = (dl.reviewToday || 0) + (dl.newToday || 0);
    const planned = done + (data.dueCount || 0) + (data.newInCurrentLesson || 0);
    if (planned > 0) {
      const pct = Math.round((done / planned) * 100);
      progressHtml = `<div style="margin:2px 0 12px">
        <div style="display:flex;justify-content:space-between;font-size:.8rem;font-weight:700"><span>Tiến độ hôm nay</span><span>${done}/${planned} thẻ (${pct}%)</span></div>
        <div style="height:10px;border-radius:5px;background:var(--active);overflow:hidden;margin-top:4px"><div style="height:100%;width:${Math.max(pct, 2)}%;background:var(--l8a,#27ae60)"></div></div>
        <div style="font-size:.7rem;color:var(--muted);margin-top:3px">${dl.unlimited ? 'Chế độ học không giới hạn mỗi ngày' : `Giới hạn ngày: ôn ${dl.reviewLimit} · từ mới ${dl.newLimit}`}</div></div>`;
    }
  }

  const capNote = (data.dueInScope > data.dueCount)
    ? `hôm nay lấy ${data.dueCount}/${data.dueInScope} (theo giới hạn ngày)` : 'theo lịch FSRS';
  const grid = [
    cell('due', `🔴 ${data.dueCount}`, 'Thẻ đến hạn ôn', capNote),
    cell('new', `🆕 ${data.newInCurrentLesson}`, 'Từ mới dự kiến', ''),
    b ? cell('weak', `🧱 ${b.reinforce}`, 'Từ cần củng cố', 'đang học / học lại') : '',
    b ? cell('weak', `🎯 ${b.weakSkill}`, 'Từ có kỹ năng yếu', b.weakSkill ? 'cần ≥3 lượt/kỹ năng để kết luận' : 'chưa phát hiện (hoặc chưa đủ dữ liệu)') : '',
    b ? cell('lesson', `⏳ ${b.delayed}`, 'Cần kiểm tra lại', `đã học, chưa đến hạn, ≥${b.delayedAfterDays} ngày chưa gặp`) : '',
    pr ? cell('lesson', `✅ ${pr.officialAnswers + pr.practiceAnswers}`, 'Lượt câu hỏi hôm nay', `${pr.officialAnswers} ôn chính thức · ${pr.practiceAnswers} luyện thêm`) : '',
  ].join('');

  let unique = '';
  if (b) {
    const total = b.uniqueWords + (data.newInCurrentLesson || 0);
    const overlaps = [];
    if (b.overlap.weakAndDue) overlaps.push(`${b.overlap.weakAndDue} từ vừa đến hạn vừa yếu kỹ năng`);
    if (b.overlap.reinforceAndDue) overlaps.push(`${b.overlap.reinforceAndDue} từ vừa đang học vừa đến hạn`);
    unique = `<div style="font-size:.78rem;color:var(--muted);line-height:1.5;margin:10px 0;background:var(--paper);border:1px solid var(--border);border-radius:10px;padding:8px 10px">
      <b>${total} từ duy nhất</b> cần chú ý (${b.uniqueWords} từ đã học + ${data.newInCurrentLesson || 0} từ mới), trong tổng ${b.knownWords} từ đã học ở phạm vi này.
      ${overlaps.length ? `Một từ có thể thuộc nhiều nhóm nên <b>không cộng các ô trên với nhau</b> (${overlaps.join('; ')}).` : 'Các nhóm trên không trùng nhau.'}
      <br>Phân biệt: <i>từ</i> (mỗi từ đếm 1 lần) · <i>thẻ</i> (lịch FSRS) · <i>lượt</i> (mỗi lần trả lời).</div>`;
  }

  // 8 chế độ học — dùng chung bộ tạo câu hỏi/chấm điểm/ghi kết quả; gom trong mục thu gọn để màn hình không rối.
  const audioOk = (typeof skillAudioAvailable === 'function') && skillAudioAvailable();
  const mode = (icon, label, onclick, enabled, why) => `<button class="btn" ${enabled ? `onclick="${onclick}"` : 'disabled'} style="text-align:left;padding:10px;font-size:.82rem;line-height:1.3">${icon} ${label}${enabled ? '' : `<div style="font-size:.66rem;font-weight:600;opacity:.8">${why}</div>`}</button>`;
  const modes = `<details ${nothingToDo ? 'open' : ''} style="margin-top:12px"><summary style="cursor:pointer;font-weight:800;font-size:.9rem;padding:6px 0">🎛 Chế độ học khác</summary>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
      ${mode('📅', 'Theo lịch FSRS<br><small>chỉ thẻ đến hạn</small>', "startStudyMode('due')", data.dueCount > 0, 'Không có thẻ đến hạn')}
      ${mode('🆕', 'Học từ mới<br><small>xem → kiểm tra</small>', "startStudyMode('new')", data.newInCurrentLesson > 0, 'Không có từ mới hôm nay')}
      ${mode('🧠', 'Nhớ chủ động<br><small>nghĩa → chữ Hán</small>', "skStartPractice('recall')", true, '')}
      ${mode('🎧', 'Luyện nghe<br><small>nghe → chữ Hán / nghĩa</small>', "skStartPractice('listening')", audioOk, 'Máy này không có giọng đọc tiếng Trung')}
      ${mode('🔤', 'Luyện pinyin<br><small>chữ Hán → pinyin</small>', "skStartPractice('pinyin')", true, '')}
      ${mode('📖', 'Dùng từ trong câu<br><small>điền từ vào chỗ trống</small>', "skStartPractice('context')", true, '')}
      ${mode('🧩', 'Phân biệt từ dễ nhầm', "skStartPractice('confusable')", true, '')}
      ${mode('⏳', 'Kiểm tra sau khoảng nghỉ' + (b ? ` (${b.delayed})` : ''), "skStartPractice('delayed')", !b || b.delayed > 0, 'Chưa có từ đủ điều kiện')}
    </div>
    <div style="font-size:.7rem;color:var(--muted);margin-top:6px;line-height:1.5">Chế độ 1–2 vẫn là ôn chính thức theo FSRS (có đổi lịch ôn). Các chế độ còn lại là luyện bổ sung: chỉ ghi hồ sơ kỹ năng, <b>không đổi lịch FSRS</b>.
    <label style="display:flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" ${rvTypedEnabled() ? 'checked' : ''} onchange="rvSetTypedEnabled(this.checked)"> Cho phép câu tự gõ đáp án trong “Bắt đầu học”</label></div>
  </details>`;

  return `
    ${progressHtml}
    <div class="study-grid">${grid}</div>
    ${unique}
    ${data.blockedByBacklog ? `<div style="font-size:.8rem;color:var(--muted);margin:8px 0;">⏳ Từ mới đang tạm khoá vì còn ${data.totalDue} thẻ cần ôn (có thể ở Quyển/bài khác) — tắt "Chỉ học từ mới sau khi hết backlog ôn tập" trong Cài đặt hằng ngày nếu muốn học từ mới ngay.</div>` : ''}
    ${nothingToDo
      ? `<div class="study-empty" style="margin:8px 0">🎉 Bạn đã ôn hết thẻ đến hạn và học hết từ mới của Bài ${escapeHtml(String(data.currentLesson))} hôm nay!<br><span style="font-size:.8rem">Muốn học thêm? Chọn một chế độ luyện bổ sung bên dưới, hoặc chọn thêm Quyển/bài ở Trang chủ.</span></div>`
      : `<button class="btn btn-primary" style="width:100%;font-size:1.05rem;padding:15px;" onclick="ssEnterMode('review')">▶️ Bắt đầu học</button>`}
    ${data.weakCount > 0 ? `<button class="btn" style="width:100%;margin-top:8px;background:var(--l10c);color:var(--l10a);" onclick="ssEnterMode('review-weak')">⚠️ Luyện từ hay quên (${data.weakCount})</button>` : ''}
    ${modes}
    ${b ? '' : `<div style="font-size:.75rem;color:var(--muted);margin-top:8px">Chưa tải được thống kê chi tiết (củng cố / kỹ năng yếu / kiểm tra lại) — chưa đủ dữ liệu hoặc lỗi tạm thời.</div>`}
  `;
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

