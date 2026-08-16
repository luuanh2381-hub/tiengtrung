// js/hsk.js — Tab theo dõi tiến độ luyện thi HSK1-4
// ════════════════════════════════════════════════════
// HSK4 PROGRESS TRACKER
// ════════════════════════════════════════════════════
// QUAN TRỌNG: KHÔNG dùng danh sách HSK_OFFICIAL viết cứng trong code JS nữa (danh sách đó chỉ là
// ước lượng, không khớp 100% với dữ liệu thật). Thay vào đó, lấy đúng dữ liệu HSK1/HSK2/HSK3/HSK4
// mà chính người dùng đã đẩy lên database ở các "bài" đặc biệt 32/33/34/35 (đúng như cách trang
// "🎯 Luyện thi HSK" ở Trang chủ đang đếm số từ) — coi đây là chuẩn để tính toán.
const HSK_LEVEL_LESSON = { 1: 32, 2: 33, 3: 34, 4: 35 };

function renderHSK() {
  return `<div class="panel">
    <div id="hsk-area" style="text-align:center;color:var(--muted);padding:24px 0;">Đang tải dữ liệu HSK1-4 từ database...</div>
  </div>`;
}

async function bindHSK() {
  const area = document.getElementById('hsk-area');
  if (!area) return;
  try {
    const lessons = Object.values(HSK_LEVEL_LESSON).join(',');
    // V74 (Ưu tiên 5 - hiệu năng): 2 fetch dưới đây độc lập nhau (không fetch nào cần kết quả của
    // fetch kia) nhưng trước đây await nối tiếp — gộp Promise.all để chạy song song, bớt 1 round-trip
    // chờ mạng. Không đổi dữ liệu/giao diện hiển thị.
    // V70 (Task 2 audit — hợp nhất FSRS): "đã thuộc" giờ lấy THẬT từ fsrs_cards (state=Review) qua
    // /api/study/known-by-lesson — thay cho "progress.srs[hz].step>=3" cục bộ đã bị xoá. Khách
    // (chưa đăng nhập) không có tài khoản FSRS nên luôn hiện 0/tổng — đúng thực tế, không giả vờ.
    const [data, knownByLesson] = await Promise.all([
      fetch('/api/vocab?lessons=' + lessons, { headers: authHeaders() }).then(r => r.json()),
      isLoggedIn()
        ? fetch('/api/study/known-by-lesson?lessons=' + lessons, { headers: authHeaders() })
            .then(r => r.json()).then(d => (d.ok && d.known) || {}).catch(() => ({}))
        : Promise.resolve({}),
    ]);
    if (!data.ok) { area.textContent = data.error || 'Không tải được dữ liệu HSK.'; return; }
    if (currentTab !== 'hsk') return; // user đã rời tab trong lúc chờ tải

    const lessonToLevel = {};
    Object.entries(HSK_LEVEL_LESSON).forEach(([lvl, l]) => { lessonToLevel[l] = Number(lvl); });
    const byLevel = { 1: [], 2: [], 3: [], 4: [] };
    for (const w of data.vocab) {
      const lvl = lessonToLevel[w.l];
      if (lvl) byLevel[lvl].push(w);
    }

    const cov = {};
    let totalWords = 0, totalKnown = 0;
    [1, 2, 3, 4].forEach(lvl => {
      const list = byLevel[lvl];
      const lessonNum = HSK_LEVEL_LESSON[lvl];
      const known = Math.min(knownByLesson[lessonNum] || 0, list.length);
      cov[lvl] = { total: list.length, known };
      totalWords += list.length; totalKnown += known;
    });

    if (totalWords === 0) {
      area.innerHTML = `⚠️ Chưa có dữ liệu HSK1-4 trong database (bài 32-35 đang trống). Vào Quản trị → Từ vựng để nhập từ HSK cho các bài này.`;
      return;
    }

    const knownPct = Math.round(totalKnown / totalWords * 100);
    const levelRows = [1, 2, 3, 4].map(lvl => {
      const c = cov[lvl];
      const p = c.total ? Math.round(c.known / c.total * 100) : 0;
      return `<div class="hsk-level-row">
        <div class="hsk-level-label">
          <span class="lv">HSK ${lvl}</span>
          <span class="ct">${c.known}/${c.total} từ đã thuộc (${p}%)</span>
        </div>
        <div class="prog-bar"><div class="prog-fill" style="width:${p}%;background:${lessonColor(6 + lvl)}"></div></div>
      </div>`;
    }).join('');

    area.outerHTML = `<div id="hsk-area">
      <div class="hsk-hero">
        <div class="hsk-hero-num">${totalKnown}/${totalWords}</div>
        <div class="hsk-hero-sub">từ đã thuộc trên tổng số từ HSK1-4 trong database (${knownPct}%)</div>
        <div class="hsk-bigbar"><div class="hsk-bigbar-fill" style="width:${knownPct}%"></div></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">Chi tiết theo cấp độ</div>
      ${levelRows}
      <div class="hsk-note">
        📌 Danh sách từ HSK1-4 lấy TRỰC TIẾP từ dữ liệu bạn đã nhập vào database (bài 32=HSK1, 33=HSK2, 34=HSK3, 35=HSK4) — đúng số liệu đang hiện ở mục "🎯 Luyện thi HSK" trên Trang chủ. "Đã thuộc" là từ đã vượt mốc ôn ≥1 ngày trong SRS.
      </div>
    </div>`;
  } catch (e) {
    area.textContent = 'Không kết nối được máy chủ: ' + e.message;
  }
}

