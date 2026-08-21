// js/stats.js — Tab Thống kê (dashboard) + Từ khó (renderDifficult), số liệu thật từ server
// ════════════════════════════════════════════════════
// STATS DASHBOARD (V80)
// ════════════════════════════════════════════════════
// Dùng đúng các API thống kê backend đã có sẵn (trước đây FE chưa từng gọi tới):
//   - /api/fsrs/stats          → KPI tổng quan + phân bổ trạng thái FSRS (New/Learning/Review/Relearning)
//   - /api/study/dashboard     → thời gian học (hôm nay/7 ngày/toàn bộ) + streak dài nhất
//   - /api/study/heatmap       → hoạt động học theo ngày (dùng chung cho line chart + heatmap GitHub-style)
//   - /api/study/known-by-lesson / /api/study/weak-words (đã dùng từ trước) → bar chart theo bài + từ cần củng cố
// Biểu đồ tự vẽ bằng SVG/CSS thuần (không thêm thư viện ngoài) — nhẹ, không phá kiến trúc hiện tại.
let statsRangeDays = 30; // 7 | 30 | 90 | 366 ("Toàn bộ" — giới hạn tối đa backend hỗ trợ cho heatmap)

function renderStats() {
  const bookLabel = [...selectedBookIds].map(id => BOOKS.find(b => b.id === id).name).join(', ');
  const levelSelect = levelSelectHtml();
  const lessonSelect = lessonSelectHtml();
  if (!isLoggedIn()) {
    return `<div class="panel">
      <div id="book-filter" style="margin-bottom:8px;">${levelSelect}${lessonSelect}</div>
      <div class="study-empty">🔒 Cần đăng nhập để xem thống kê thật (dữ liệu FSRS chỉ có khi có tài khoản).</div>
    </div>`;
  }

  const rangeOptions = [[7, '7 ngày'], [30, '30 ngày'], [90, '90 ngày'], [366, 'Toàn bộ']];
  const rangeChips = rangeOptions.map(([d, lbl]) =>
    `<button class="dash-chip${statsRangeDays === d ? ' sel' : ''}" data-days="${d}" onclick="statsRangeDays=${d}; bindStatsActivity();">${lbl}</button>`
  ).join('');

  const kpiSkeleton = Array(8).fill(0).map(() =>
    `<div class="dash-kpi"><div class="dash-kpi-num">⏳</div><div class="dash-kpi-lbl">Đang tải...</div></div>`
  ).join('');

  return `<div class="panel">
    <div class="panel-title">📊 Tổng quan</div>
    <div id="dash-kpi" class="dash-kpi-grid">${kpiSkeleton}</div>
  </div>

  <div class="panel">
    <div class="panel-title">📈 Hoạt động học tập</div>
    <div class="dash-filter-row" id="dash-range-chips">${rangeChips}</div>
    <div id="dash-line"><div class="study-empty">⏳ Đang tải...</div></div>
    <div id="dash-heatmap"></div>
  </div>

  <div class="panel">
    <div id="book-filter" style="margin-bottom:8px;">${levelSelect}${lessonSelect}</div>
    <div class="panel-title">📗 Tiến độ từ vựng theo bài · ${bookLabel}</div>
    <div class="dash-bar-chart" id="dash-bars">⏳ Đang tải...</div>
  </div>

  <div class="panel">
    <div class="panel-title">🧩 Phân bổ trạng thái FSRS</div>
    <div id="dash-donut">⏳ Đang tải...</div>
  </div>

  <div class="panel">
    <div class="panel-title">😓 Từ cần củng cố · ${bookLabel}</div>
    <div id="stats-weak">⏳ Đang tải...</div>
  </div>`;
}

async function bindStats() {
  if (!isLoggedIn()) return; // đã hiện thông báo "cần đăng nhập" tĩnh ở renderStats()
  let statLessons = lessonsAllMode ? lessonsOfSelection() : [...selectedLessons].sort((a, b) => a - b);
  const all = lessonsAllMode
    ? WORDS.filter(w => selectedBookIds.has(bookOfLesson(w.l)))
    : WORDS.filter(w => selectedLessons.has(w.l));

  try {
    const [knownRes, weakRes, fsrsStatsRes, dashRes] = await Promise.all([
      statLessons.length
        ? fetch('/api/study/known-by-lesson?lessons=' + statLessons.join(','), { headers: authHeaders() }).then(r => r.json())
        : Promise.resolve({ ok: true, known: {} }),
      fetch('/api/study/weak-words', { headers: authHeaders() }).then(r => r.json()),
      fetch('/api/fsrs/stats', { headers: authHeaders() }).then(r => r.json()),
      fetch('/api/study/dashboard', { headers: authHeaders() }).then(r => r.json()),
    ]);
    if (currentTab !== 'stats') return; // user đã rời tab trong lúc chờ tải

    const knownByLesson = (knownRes.ok && knownRes.known) || {};
    const fs = fsrsStatsRes.ok ? fsrsStatsRes : {};
    const dash = dashRes.ok ? dashRes : {};
    const pct = v => (v === null || v === undefined) ? '—' : `${v}%`;

    // ── KPI tổng quan (8 chỉ số, dữ liệu thật 100% — không hard-code) ──
    const studied = fs.totalCardsStudied ?? 0;
    const mature = fs.matureCards ?? 0;
    const learning = Math.max(0, studied - mature);
    const longestNote = dash.longestStreak ? `Kỷ lục: ${dash.longestStreak} ngày` : '';
    const timeStudied = dash.allTime ? fmtDuration(dash.allTime.totalDurationSeconds) : '—';
    const kpiEl = document.getElementById('dash-kpi');
    if (kpiEl) kpiEl.innerHTML = [
      ['📘', studied, 'Tổng từ đã học', ''],
      ['⭐', mature, 'Đã thuộc', ''],
      ['📗', learning, 'Đang học', ''],
      ['🔴', fs.dueCards ?? 0, 'Cần ôn', ''],
      ['🔥', getStreak(), 'Streak (ngày)', longestNote],
      ['🎯', pct(fs.retention), 'Retention', ''],
      ['📈', fs.totalReviews ?? 0, 'Tổng lượt ôn', ''],
      ['⏱️', timeStudied, 'Thời gian học', ''],
    ].map(([icon, num, lbl, sub]) => `<div class="dash-kpi">
        <div class="dash-kpi-num">${icon} ${num}</div>
        <div class="dash-kpi-lbl">${lbl}</div>
        ${sub ? `<div class="dash-kpi-sub">${sub}</div>` : ''}
      </div>`).join('');

    // ── Bar chart: tiến độ từ vựng theo bài (đúng phạm vi Quyển/bài đang chọn) ──
    const barsEl = document.getElementById('dash-bars');
    if (barsEl) {
      const lessonsForBars = isLoggedIn() ? statLessons : statLessons.filter(l => l <= GUEST_MAX_LESSON);
      barsEl.innerHTML = lessonsForBars.length ? lessonsForBars.map(l => {
        const total = WORDS.filter(w => w.l === l).length || 1;
        const known = knownByLesson[l] || 0;
        const p = Math.round(known / total * 100);
        return `<div class="dash-bar-col">
          <div class="dash-bar-pct" style="color:${lessonColor(l)}">${known}/${total}</div>
          <div class="dash-bar-track"><div class="dash-bar-fill" style="height:${Math.max(p, 2)}%;background:${lessonColor(l)}"></div></div>
          <div class="dash-bar-lbl">B${l}</div>
        </div>`;
      }).join('') : '<div class="study-empty">Chưa chọn bài nào — hãy chọn ở bộ lọc phía trên.</div>';
    }

    // ── Donut: phân bổ trạng thái FSRS thật (New/Learning/Review/Relearning) ──
    const donutEl = document.getElementById('dash-donut');
    if (donutEl) donutEl.innerHTML = buildDonutHtml(fs.stateBreakdown || {});

    // ── Từ cần củng cố (rút gọn, xem đầy đủ ở tab Từ khó) ──
    const weakEl = document.getElementById('stats-weak');
    if (weakEl) {
      const scopeHz = new Set(all.map(w => w.hz));
      const weak = ((weakRes.ok && weakRes.words) || []).filter(w => scopeHz.has(w.hz)).slice(0, 6);
      weakEl.innerHTML = (weak.length ? weak.map(w => `<div class="weak-item">
        <span class="weak-hz" style="color:${lessonColor(w.l)}">${w.hz}</span>
        <span class="weak-info">${w.vi}${showPinyin ? ` · ${w.py}` : ''}${showHanViet && w.hanviet ? ` · ${w.hanviet}` : ''} · ${w.lapses || 0} lần quên</span>
        <button class="btn-sound-sm" onclick="speak('${w.hz}')">🔊</button>
      </div>`).join('') : '<div class="study-empty">Chưa có dữ liệu. Hãy bắt đầu học ở "🎯 Hôm nay học"!</div>')
        + `<button class="btn" style="width:100%;margin-top:10px" onclick="goTab('difficult')">😓 Xem tất cả từ khó & ôn riêng →</button>`;
    }
  } catch (e) {
    const kpiEl = document.getElementById('dash-kpi');
    if (kpiEl) kpiEl.innerHTML = `<div class="study-empty" style="grid-column:1/-1">⚠️ Không tải được dữ liệu: ${e.message}</div>`;
  }

  bindStatsActivity(); // line chart + heatmap — tách riêng để đổi bộ lọc thời gian không phải tải lại toàn bộ trang
}

// Nạp riêng phần "Hoạt động học tập" (line chart + heatmap), dùng /api/study/heatmap?days=N — gọi lại
// mỗi khi đổi bộ lọc thời gian (7/30/90/Toàn bộ) mà KHÔNG gọi lại các API khác (tránh request thừa).
async function bindStatsActivity() {
  const chipsEl = document.getElementById('dash-range-chips');
  if (chipsEl) {
    [...chipsEl.children].forEach(btn => btn.classList.toggle('sel', Number(btn.dataset.days) === statsRangeDays));
  }
  const lineEl = document.getElementById('dash-line');
  const heatEl = document.getElementById('dash-heatmap');
  if (lineEl) lineEl.innerHTML = '<div class="study-empty">⏳ Đang tải...</div>';
  if (heatEl) heatEl.innerHTML = '';
  try {
    const res = await fetch('/api/study/heatmap?days=' + statsRangeDays, { headers: authHeaders() });
    const data = await res.json();
    if (currentTab !== 'stats') return;
    if (!data.ok) { if (lineEl) lineEl.innerHTML = `<div class="study-empty">⚠️ ${data.error || 'Lỗi tải dữ liệu'}</div>`; return; }
    const series = buildDenseDailySeries(data.heatmap || [], statsRangeDays);
    const hasActivity = series.some(p => p.minutes > 0);
    if (lineEl) lineEl.innerHTML = hasActivity
      ? buildLineChartHtml(series)
      : '<div class="study-empty">Chưa có hoạt động học trong khoảng thời gian này.</div>';
    if (heatEl) heatEl.innerHTML = hasActivity ? buildHeatmapHtml(series) : '';
  } catch (e) {
    if (lineEl) lineEl.innerHTML = `<div class="study-empty">⚠️ Không tải được: ${e.message}</div>`;
  }
}

// ── Helpers: ngày giờ Việt Nam (khớp cách backend tính "ngày" — xem lib/fsrs/analytics.js getStreak) ──
function statsTodayVN() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
}
function statsAddDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
// heatmap API chỉ trả về NGÀY CÓ hoạt động — dựng lại dãy đủ N ngày (0-fill ngày trống) để vẽ biểu
// đồ liên tục, không hard-code số liệu (toàn bộ giá trị vẫn lấy thật từ API, chỉ lấp 0 cho ngày trống).
function buildDenseDailySeries(rows, days) {
  const byDate = new Map(rows.map(r => [r.date, r.minutes]));
  const end = statsTodayVN();
  const n = Math.max(1, Math.min(days, 366));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = statsAddDays(end, -i);
    out.push({ date: d, minutes: byDate.get(d) || 0 });
  }
  return out;
}
function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h${m}p` : `${h}h`;
  if (m > 0) return `${m} phút`;
  return '0 phút';
}
function fmtDateShort(d) {
  const [, m, dd] = d.split('-');
  return `${dd}/${m}`;
}

// Line chart nhẹ bằng SVG thuần (preserveAspectRatio="none" để tự co giãn theo chiều rộng khung —
// không cần thư viện biểu đồ ngoài, đúng yêu cầu "ưu tiên giải pháp nhẹ, phù hợp kiến trúc hiện tại").
function buildLineChartHtml(series) {
  const w = 600, h = 120, pad = 6;
  const max = Math.max(1, ...series.map(p => p.minutes));
  const n = series.length;
  const stepX = n > 1 ? (w - pad * 2) / (n - 1) : 0;
  const pts = series.map((p, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (p.minutes / max) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = pts.join(' ');
  const area = `${pad},${h - pad} ${line} ${(w - pad).toFixed(1)},${h - pad}`;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="line-chart-svg">
      <polyline points="${area}" class="line-chart-area"></polyline>
      <polyline points="${line}" class="line-chart-line"></polyline>
    </svg>
    <div class="dash-line-labels"><span>${fmtDateShort(series[0].date)}</span><span>${fmtDateShort(series[series.length - 1].date)}</span></div>
    <div style="font-size:.68rem;color:var(--muted);margin-top:6px;">Phút học mỗi ngày · cao nhất ${max} phút/ngày</div>`;
}

// Heatmap kiểu GitHub bằng CSS grid thuần (7 hàng = 7 ngày trong tuần, cột = tuần, cuộn ngang trên mobile).
function buildHeatmapHtml(series) {
  const first = new Date(series[0].date + 'T00:00:00Z');
  const firstDow = first.getUTCDay(); // 0 = Chủ nhật
  const padded = Array(firstDow).fill(null).concat(series);
  const max = Math.max(1, ...series.map(p => p.minutes));
  const cells = padded.map(p => {
    if (!p) return '<div class="dash-heat-cell heat-0" style="visibility:hidden"></div>';
    if (p.minutes <= 0) return `<div class="dash-heat-cell heat-0" title="${p.date}: 0 phút"></div>`;
    const opacity = Math.min(1, 0.28 + (p.minutes / max) * 0.72);
    return `<div class="dash-heat-cell" style="opacity:${opacity.toFixed(2)}" title="${p.date}: ${p.minutes} phút"></div>`;
  }).join('');
  return `<div class="dash-heatmap-lbl">🗓️ Heatmap hoạt động</div>
    <div class="dash-heatmap-wrap"><div class="dash-heatmap-grid">${cells}</div></div>`;
}

// Donut trạng thái FSRS bằng conic-gradient CSS thuần (không cần SVG arc-math/thư viện).
function buildDonutHtml(sb) {
  const parts = [
    { key: 'newCount', lbl: 'New (mới)', color: 'var(--l9a)' },
    { key: 'learningCount', lbl: 'Learning (đang học)', color: 'var(--l7a)' },
    { key: 'reviewCount', lbl: 'Review (đang ôn)', color: 'var(--active)' },
    { key: 'relearningCount', lbl: 'Relearning (học lại)', color: 'var(--l10a)' },
  ];
  const total = parts.reduce((s, p) => s + (sb[p.key] || 0), 0);
  if (!total) return '<div class="study-empty">Chưa có thẻ FSRS nào — hãy bắt đầu học để xem phân bổ trạng thái.</div>';
  let acc = 0;
  const stops = parts.map(p => {
    const val = sb[p.key] || 0;
    const from = acc / total * 100;
    acc += val;
    const to = acc / total * 100;
    return `${p.color} ${from.toFixed(2)}% ${to.toFixed(2)}%`;
  }).join(', ');
  const legend = parts.map(p => `<div class="dash-legend-item">
      <span class="dash-legend-dot" style="background:${p.color}"></span>${p.lbl}<span class="dash-legend-val">${sb[p.key] || 0}</span>
    </div>`).join('');
  return `<div class="dash-donut-row">
    <div class="dash-donut-outer">
      <div class="dash-donut" style="background:conic-gradient(${stops})"></div>
      <div class="dash-donut-hole"><div><b>${total}</b><span>thẻ</span></div></div>
    </div>
    <div class="dash-legend">${legend}</div>
  </div>`;
}

// ════════════════════════════════════════════════════
// MY DIFFICULT WORDS (Từ khó của tôi) — Ưu tiên 3
// Dữ liệu 100% lấy từ /api/study/weak-words (lịch sử học thật: fsrs_cards + review_history), không
// tự bịa/ước lượng gì thêm ở client. "Ôn riêng" tái dùng ĐÚNG startStudySession(true) đã có sẵn —
// đi qua cùng 1 hàng đợi FSRS thật như mọi tab khác, không tạo luồng chấm điểm riêng.
// ════════════════════════════════════════════════════
let difficultSortBy = 'wrong'; // 'wrong' | 'difficulty' | 'recent' | 'stale'

function formatRelativeTime(iso) {
  if (!iso) return 'chưa học lần nào';
  const d = new Date(iso);
  if (isNaN(d)) return 'chưa học lần nào';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'hôm nay';
  if (days === 1) return 'hôm qua';
  if (days < 30) return `${days} ngày trước`;
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function renderDifficult() {
  if (!isLoggedIn()) {
    return `<div class="panel">
      <div class="study-empty">🔒 Cần đăng nhập để xem từ khó thật (dữ liệu lấy từ lịch sử học của tài khoản, không có ở chế độ khách).</div>
    </div>`;
  }
  return `<div class="panel">
    <div class="panel-title">😓 Từ khó của tôi</div>
    <div style="font-size:.85rem;color:var(--muted);margin-bottom:10px">Những từ bạn hay trả lời sai hoặc FSRS đánh giá là khó nhớ, tính từ lịch sử học thật trên tài khoản.</div>
    <button class="btn btn-primary" style="width:100%;margin-bottom:12px" onclick="startStudySession(true)">🎯 Ôn riêng các từ khó ngay</button>
    <div class="count-row">
      <span style="font-size:.82rem;color:var(--muted)">Sắp xếp theo:</span>
      <select id="difficult-sort" onchange="difficultSortBy=this.value; bindDifficult()">
        <option value="wrong">Số lần sai (nhiều nhất)</option>
        <option value="difficulty">Độ khó FSRS (cao nhất)</option>
        <option value="recent">Học gần đây nhất</option>
        <option value="stale">Lâu chưa học nhất</option>
      </select>
    </div>
    <div id="difficult-list">⏳ Đang tải...</div>
  </div>`;
}

async function bindDifficult() {
  if (!isLoggedIn()) return;
  const sel = document.getElementById('difficult-sort');
  if (sel) sel.value = difficultSortBy;
  const listEl = document.getElementById('difficult-list');
  try {
    const res = await fetch('/api/study/weak-words', { headers: authHeaders() });
    const data = await res.json();
    if (currentTab !== 'difficult') return; // user đã rời tab trong lúc chờ tải
    if (!data.ok) { if (listEl) listEl.innerHTML = `⚠️ ${data.error || 'Lỗi tải dữ liệu'}`; return; }
    const words = (data.words || []).slice().sort((a, b) => {
      if (difficultSortBy === 'difficulty') return (b.difficulty || 0) - (a.difficulty || 0);
      if (difficultSortBy === 'recent') return new Date(b.last_review || 0) - new Date(a.last_review || 0);
      if (difficultSortBy === 'stale') return new Date(a.last_review || 0) - new Date(b.last_review || 0);
      return (b.wrongCount || 0) - (a.wrongCount || 0); // mặc định: số lần sai
    });
    if (!listEl) return;
    listEl.innerHTML = words.length ? words.map(w => `<div class="weak-item">
        <span class="weak-hz" style="color:${lessonColor(w.l)}">${w.hz}</span>
        <span class="weak-info">${w.vi}${showPinyin ? ` · ${w.py}` : ''}${showHanViet && w.hanviet ? ` · ${w.hanviet}` : ''}<br>
          ❌ ${w.wrongCount || 0} lần sai · 🕐 học gần nhất: ${formatRelativeTime(w.last_review)}</span>
        <button class="btn-sound-sm" onclick="speak('${w.hz}')">🔊</button>
      </div>`).join('')
      : '<div class="study-empty">🎉 Chưa có từ khó nào — bạn đang học rất tốt! Hãy tiếp tục ở "🎯 Hôm nay học".</div>';
  } catch (e) {
    if (listEl) listEl.innerHTML = `⚠️ Không tải được: ${e.message}`;
  }
}
