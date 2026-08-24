// js/app.js — Hàm tiện ích chung + khởi động app (bootAuth, tải từ vựng, render lần đầu)
// ════════════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════════════
function shuffle(arr) {
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
  return a;
}

// ════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════
fetch('/api/visit', { method: 'POST' }).catch(() => {}); // ghi nhận lượt truy cập, không chặn nếu lỗi

// Số từ theo từng bài lấy từ server (payload rất nhỏ — chỉ vài số), dùng để hiện số từ ở màn
// chọn Quyển/level mà KHÔNG cần tải cả nội dung từ vựng. Bài 1-30 (781 từ có sẵn) đã nhúng
// sẵn trong app nên không cần tính qua server.
let vocabCounts = {};
async function loadVocabCounts() {
  try {
    const res = await fetch('/api/vocab/counts');
    const data = await res.json();
    if (data.ok && data.counts) vocabCounts = data.counts;
  } catch {
    // Không tải được thì màn chọn Quyển/level tạm không hiện số từ, không chặn app
  }
}

// Bài nào đã tải nội dung từ vựng về máy rồi (tránh tải lại lần 2 khi chọn lại)
let loadedLessonNumbers = new Set();

// Tải về ĐÚNG phần từ vựng cần cho các Quyển/level đang chọn (thay vì tải hết mọi thứ).
// Toàn bộ từ vựng giờ nạp từ database, kể cả Quyển 1/2 — khách (chưa đăng nhập) dùng API công khai
// riêng, server tự giới hạn chỉ được Bài 1-5 (giới hạn dùng thử của khách).
async function ensureVocabLoaded(bookIds) {
  const needed = [];
  for (const id of bookIds) {
    let b = BOOKS.find(x => x.id === id);
    // Bài tự nhận diện (id = 2000+bài) có thể chưa kịp gộp vào BOOKS nếu vocabCounts còn đang tải song song —
    // suy ra trực tiếp từ id để không phải chờ mergeDiscoveredLessonsIntoBooks() chạy trước.
    if (!b && id >= 2000) b = { from: id - 2000, to: id - 2000 };
    if (!b) continue;
    for (let l = b.from; l <= b.to; l++) {
      if (!loadedLessonNumbers.has(l)) needed.push(l);
    }
  }
  if (needed.length === 0) return;
  const url = (isGuest || !authToken)
    ? '/api/vocab/public?lessons=' + needed.join(',')
    : '/api/vocab?lessons=' + needed.join(',');
  try {
    const res = await fetch(url, (isGuest || !authToken) ? {} : { headers: authHeaders() });
    const data = await res.json();
    if (data.ok && Array.isArray(data.vocab)) {
      const seen = new Set(WORDS.map(w => w.hz + '-' + w.l));
      for (const w of data.vocab) {
        const key = w.hz + '-' + w.l;
        if (seen.has(key)) continue;
        seen.add(key);
        WORDS.push(w);
      }
      _bookCountCache.len = -1; // WORDS vừa đổi -> tính lại cache số từ theo Quyển
    }
    needed.forEach(l => loadedLessonNumbers.add(l));
  } catch {
    // Không tải được thì các bài đó tạm hiện thiếu từ, không chặn app — sẽ thử lại khi chọn lại
  }
}

// Nếu máy đã có cache tiến độ từ lần trước (trường hợp phổ biến nhất: mở lại app đã đăng nhập
// rồi) hoặc đang ở chế độ khách, bootAuth() sẽ khôi phục selectedBookIds NGAY LẬP TỨC (đồng bộ,
// trước khi có await nào chạy) — nên có thể bắt đầu tải từ vựng SONG SONG với việc xác thực lại
// token với server, thay vì đợi round-trip xác thực xong mới bắt đầu tải như trước (tốn thêm hẳn
// 1 lượt đi-về mạng mỗi lần mở app). Chỉ trường hợp lần đầu đăng nhập trên máy này (chưa có cache)
// mới cần đợi bootAuth xong để biết đúng Quyển/bài đã chọn trước khi tải.
const hasCachedProgress = isGuest || (authToken && authUsername && !!localStorage.getItem('progressCache_' + authUsername));
const bootPromise = bootAuth();
const vocabLoadPromise = hasCachedProgress
  ? Promise.all([loadVocabCounts(), ensureVocabLoaded(selectedBookIds)])
  : bootPromise.then(() => Promise.all([loadVocabCounts(), ensureVocabLoaded(selectedBookIds)]));

bootPromise.then(async () => {
  await vocabLoadPromise;
  mergeDiscoveredLessonsIntoBooks(); // tự nhận diện các bài mới chưa có trong danh mục, thêm vào mục chọn
  render(); // V74: xoá lời gọi updateStreak() mồ côi (hàm không tồn tại) từng làm crash callback này,
            // khiến render()/loadHanziParts() bên dưới không bao giờ chạy sau khi tải xong vocab.

  loadHanziParts().then(() => render()); // tải chiết tự bộ thủ ngầm phía sau, không chặn hiển thị ban đầu
});

// ── Widget liên hệ Zalo (nổi góc màn hình) ──
// AUDIT V82 (Phần 6 — "không bottom controls bị che"): widget nổi cố định góc dưới-phải TRƯỚC ĐÂY
// là 1 pill dài (icon + chữ "Hỗ trợ") có thể đè lên nút cuối cùng của hàng rating/flashcard trên
// màn hình nhỏ. Thu gọn thành 1 nút tròn nhỏ (chỉ icon, giữ tooltip "title" để không mất thông tin),
// tự né safe-area (home indicator/notch bo góc) bằng env(), giảm hẳn diện tích có thể che nội dung.
(function initZaloWidget() {
  const ZALO_PHONE = '0987086700';
  if (localStorage.getItem('zaloWidgetHidden') === '1') return; // đã bị người dùng tắt trước đó
  const wrap = document.createElement('div');
  wrap.id = 'zalo-widget';
  wrap.style.cssText = 'position:fixed;right:max(12px, env(safe-area-inset-right));bottom:max(12px, env(safe-area-inset-bottom));z-index:500;display:flex;align-items:center;';
  wrap.innerHTML = `
    <a href="https://zalo.me/${ZALO_PHONE}" target="_blank" rel="noopener"
       title="Nhắn Zalo hỗ trợ"
       style="display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;
              background:#0068ff;box-shadow:0 4px 14px rgba(0,0,0,.25);text-decoration:none;">
      <svg width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <text x="50%" y="58%" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="16" fill="#fff">Za</text>
      </svg>
    </a>
    <button id="zalo-widget-close" title="Ẩn nút này"
      style="width:17px;height:17px;border-radius:50%;background:#fff;border:1px solid #ccc;color:#666;
             font-size:10px;line-height:1;cursor:pointer;margin-left:-8px;margin-top:-26px;
             box-shadow:0 1px 4px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;flex-shrink:0;">✕</button>`;
  document.body.appendChild(wrap);
  document.getElementById('zalo-widget-close').addEventListener('click', (e) => {
    e.preventDefault();
    localStorage.setItem('zaloWidgetHidden', '1');
    wrap.remove();
  });
})();

