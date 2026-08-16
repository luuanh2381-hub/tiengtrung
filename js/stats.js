// js/stats.js — Tab Thống kê + Từ khó (renderStats/renderDifficult), số liệu thật từ server
// ════════════════════════════════════════════════════
// STATS
// ════════════════════════════════════════════════════
// V70 (Task 2 audit — hợp nhất FSRS): số liệu ở tab này giờ lấy THẬT từ server (fsrs_cards +
// review_history của CHÍNH user, qua /api/study/known-by-lesson + /api/study/weak-words) — không
// còn đọc "progress.srs" cục bộ đã bị xoá (dữ liệu đó chỉ tồn tại trên 1 thiết bị, không phải
// nguồn sự thật). Ghi chú: đây là bản vá tối thiểu để tab không vỡ sau khi bỏ SRS cũ; một bản
// Dashboard/Phân tích đầy đủ hơn (retention, mature/young, biểu đồ theo ngày) sẽ thay thế ở Pha C
// (Task 6/7), tận dụng /api/fsrs/stats + /api/study/dashboard + /api/study/heatmap đã có sẵn ở
// backend nhưng frontend chưa từng gọi tới.
function renderStats() {
  const bookLabel = [...selectedBookIds].map(id=>BOOKS.find(b=>b.id===id).name).join(', ');
  const levelSelect = levelSelectHtml();
  const lessonSelect = lessonSelectHtml();
  if (!isLoggedIn()) {
    return `<div class="panel">
      <div id="book-filter" style="margin-bottom:8px;">${levelSelect}${lessonSelect}</div>
      <div class="study-empty">🔒 Cần đăng nhập để xem thống kê thật (dữ liệu FSRS chỉ có khi có tài khoản).</div>
    </div>`;
  }
  return `<div class="panel">
    <div id="book-filter" style="margin-bottom:8px;">${levelSelect}${lessonSelect}</div>
    <div class="panel-title">Tổng quan · ${bookLabel}</div>
    <div id="stats-area" class="stat-grid"><div class="stat-box" style="grid-column:1/-1">⏳ Đang tải dữ liệu FSRS...</div></div>
    <div class="sep"></div>
    <div class="panel-title">Từ đã thuộc theo bài</div>
    <div class="bar-chart" id="stats-bars"></div>
  </div>
  <div class="panel">
    <div class="panel-title">Từ hay quên nhất · ${bookLabel}</div>
    <div id="stats-weak">⏳ Đang tải...</div>
  </div>`;
}

async function bindStats() {
  if (!isLoggedIn()) return; // đã hiện thông báo "cần đăng nhập" tĩnh ở renderStats()
  let statLessons = lessonsAllMode ? lessonsOfSelection() : [...selectedLessons].sort((a,b)=>a-b);
  const all = lessonsAllMode
    ? WORDS.filter(w => selectedBookIds.has(bookOfLesson(w.l)))
    : WORDS.filter(w => selectedLessons.has(w.l));

  try {
    const [knownRes, weakRes, fsrsStatsRes] = await Promise.all([
      statLessons.length
        ? fetch('/api/study/known-by-lesson?lessons=' + statLessons.join(','), { headers: authHeaders() }).then(r=>r.json())
        : Promise.resolve({ ok:true, known:{} }),
      fetch('/api/study/weak-words', { headers: authHeaders() }).then(r=>r.json()),
      fetch('/api/fsrs/stats', { headers: authHeaders() }).then(r=>r.json()),
    ]);
    if (currentTab !== 'stats') return; // user đã rời tab trong lúc chờ tải

    const knownByLesson = (knownRes.ok && knownRes.known) || {};
    const totalKnown = Object.values(knownByLesson).reduce((s,n)=>s+n, 0);
    const fs = fsrsStatsRes.ok ? fsrsStatsRes : {};
    const pct = v => (v === null || v === undefined) ? '—' : `${v}%`;

    const statsArea = document.getElementById('stats-area');
    if (statsArea) statsArea.innerHTML = `
      <div class="stat-box"><div class="stat-num">🔥${getStreak()}</div><div class="stat-lbl">Ngày streak</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--l8a)">⭐${totalKnown}</div><div class="stat-lbl">Từ đã thuộc</div></div>
      <div class="stat-box"><div class="stat-num">${all.length}</div><div class="stat-lbl">Tổng từ trong phạm vi</div></div>
      <div class="stat-box"><div class="stat-num">${fs.totalCardsStudied ?? '—'}</div><div class="stat-lbl">Tổng từ đã học</div></div>
      <div class="stat-box"><div class="stat-num">${(fs.matureCards ?? 0) + (fs.youngCards ?? 0)}</div><div class="stat-lbl">Đang review</div></div>
      <div class="stat-box"><div class="stat-num" style="color:var(--l8a)">${fs.newToday ?? 0}</div><div class="stat-lbl">Từ mới hôm nay</div></div>
      <div class="stat-box"><div class="stat-num">${fs.reviewToday ?? 0}</div><div class="stat-lbl">Review hôm nay</div></div>
      <div class="stat-box"><div class="stat-num">${pct(fs.reviewAccuracy)}</div><div class="stat-lbl">Accuracy</div></div>
      <div class="stat-box"><div class="stat-num">${pct(fs.retention)}</div><div class="stat-lbl">Retention</div></div>
    `;

    const barsEl = document.getElementById('stats-bars');
    if (barsEl) {
      const lessonsForBars = isLoggedIn() ? statLessons : statLessons.filter(l => l <= GUEST_MAX_LESSON);
      barsEl.innerHTML = lessonsForBars.map(l=>{
        const total = WORDS.filter(w=>w.l===l).length || 1;
        const known = knownByLesson[l] || 0;
        const pct = Math.round(known/total*100);
        return `<div class="bar-col">
          <div class="bar-pct" style="color:${lessonColor(l)}">${known}/${total}</div>
          <div class="bar-fill" style="height:${pct*.6}px;background:${lessonColor(l)}"></div>
          <div class="bar-lbl">B${l}</div>
        </div>`;
      }).join('');
    }

    const weakEl = document.getElementById('stats-weak');
    if (weakEl) {
      const scopeHz = new Set(all.map(w=>w.hz));
      const weak = ((weakRes.ok && weakRes.words) || []).filter(w => scopeHz.has(w.hz)).slice(0, 8);
      weakEl.innerHTML = (weak.length ? weak.map(w=>`<div class="weak-item">
        <span class="weak-hz" style="color:${lessonColor(w.l)}">${w.hz}</span>
        <span class="weak-info">${w.vi}${showPinyin?` · ${w.py}`:''}${showHanViet && w.hanviet?` · ${w.hanviet}`:''} · ${w.lapses||0} lần quên</span>
        <button class="btn-sound-sm" onclick="speak('${w.hz}')">🔊</button>
      </div>`).join('') : '<div style="color:var(--muted);font-size:.9rem">Chưa có dữ liệu. Hãy bắt đầu học ở "🎯 Hôm nay học"!</div>')
        + `<button class="btn" style="width:100%;margin-top:10px" onclick="goTab('difficult')">😓 Xem tất cả từ khó & ôn riêng →</button>`;
    }
  } catch (e) {
    const statsArea = document.getElementById('stats-area');
    if (statsArea) statsArea.innerHTML = `<div class="stat-box" style="grid-column:1/-1">⚠️ Không tải được dữ liệu: ${e.message}</div>`;
  }
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

