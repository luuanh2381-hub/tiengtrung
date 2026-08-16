// js/ui.js — State toàn cục (tab hiện tại, hiện/ẩn Pinyin·nghĩa·Hán Việt) + refreshCurrentCardDisplay() (vẽ lại thẻ đang học mà KHÔNG nạp lại hàng đợi)
// GLOBAL STATE
// ════════════════════════════════════════════════════
let currentTab = 'home'; // được applyUIState() ghi đè lại đúng giá trị đã lưu khi app khởi động
let showPinyin = true;
let showMeaning = true;
let showHanViet = true;
let questionCount = 10;

// FIX (audit lặp từ/mất tiến độ): vẽ lại đúng THẺ ĐANG XEM của tab luyện tập hiện tại, KHÔNG gọi
// API, KHÔNG nạp lại hàng đợi — khác với render() (dùng khi CHUYỂN TAB, hợp lý phải nạp lại).
// Trước đây togglePinyin/toggleMeaning/toggleHanViet gọi thẳng render(), mà render() cho 4 tab
// flash/quiz/type/listen lại dispatch sang bindFlash/bindQuiz/bindType/bindListen — các hàm này
// LUÔN sqLoad() nạp lại hàng đợi mới từ /api/study/session mỗi lần gọi. Hệ quả: user đang học dở
// (đã trả lời vài câu, có thẻ Again đã bị chèn lùi lại theo REPEAT_GAP), chỉ cần bấm "Ẩn Pinyin"
// là toàn bộ hàng đợi bị THAY MỚI — mất tiến độ phiên, thẻ vừa trả lời đúng có thể xuất hiện lại
// (đây nhiều khả năng là nguyên nhân chính gây cảm giác "lặp từ" khi đang học).
function refreshCurrentCardDisplay() {
  if (currentTab === 'flash' && fcQueue.totalPlanned > 0) { fcUpdate(); return; }
  if (currentTab === 'quiz' && qzQueue.totalPlanned > 0) { qzRenderQ(); return; }
  if (currentTab === 'type' && tyQueue.totalPlanned > 0) { tyRenderQ(); return; }
  if (currentTab === 'listen' && lsQueue.totalPlanned > 0) { lsRenderQ(); return; }
  if (currentTab === 'review' && rvSession.length >= 0 && rvTotalPlanned > 0) {
    const el = document.getElementById('content');
    if (el) { el.innerHTML = renderReview(); bindReview(); }
    return;
  }
  render(); // các tab khác (home/today/stats/...) không giữ "hàng đợi" đang học dở, render() bình thường an toàn
}
function togglePinyin() {
  showPinyin = !showPinyin;
  document.getElementById('py-toggle-btn').textContent = showPinyin ? 'Ẩn Pinyin' : 'Hiện Pinyin';
  progressState.ui.showPinyin = showPinyin;
  cacheProgressLocally();
  scheduleSync();
  refreshCurrentCardDisplay();
}
function toggleMeaning() {
  showMeaning = !showMeaning;
  document.getElementById('vi-toggle-btn').textContent = showMeaning ? 'Ẩn nghĩa' : 'Hiện nghĩa';
  progressState.ui.showMeaning = showMeaning;
  cacheProgressLocally();
  scheduleSync();
  refreshCurrentCardDisplay();
}
function toggleHanViet() {
  showHanViet = !showHanViet;
  document.getElementById('hv-toggle-btn').textContent = showHanViet ? 'Ẩn Hán Việt' : 'Hiện Hán Việt';
  progressState.ui.showHanViet = showHanViet;
  cacheProgressLocally();
  scheduleSync();
  refreshCurrentCardDisplay();
}

function goTab(tab) {
  currentTab = tab;
  // Tab 'review' là phiên học FSRS đang chạy dở — không lưu làm lastTab (mở lại app không nên
  // tự nhảy vào giữa 1 session cũ), khi tải lại trang sẽ quay về 'today'.
  progressState.ui.lastTab = (tab === 'review') ? 'today' : tab;
  cacheProgressLocally();
  scheduleSync();
  document.querySelectorAll('#nav button').forEach(b => b.classList.remove('active'));
  const navBtn = document.getElementById('tab-' + tab);
  if (navBtn) navBtn.classList.add('active');
  // Hiệu ứng fade/slide nhẹ CHỈ khi thực sự chuyển tab — không áp dụng khi chỉ đổi lựa chọn
  // trong cùng 1 tab (tránh bị "nháy" mỗi lần bấm chọn bài/Quyển).
  const el = document.getElementById('content');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  render();
}

// Sinh màu theo công thức (golden-angle hue) để hỗ trợ mọi số bài học (1..30+) một cách nhất quán
function lessonHue(l) { return Math.round((l * 137.508) % 360); }
function lessonColor(l) { return l===0 ? 'var(--active)' : `hsl(${lessonHue(l)},58%,42%)`; }
function lessonBg(l)    { return l===0 ? 'var(--l9b)'    : `hsl(${lessonHue(l)},65%,95%)`; }
function lessonTagBg(l) { return `hsl(${lessonHue(l)},58%,86%)`; }
function tagClass(l) { return 'tag-l'+l; } // giữ để tương thích, không còn dùng để tô màu
function lessonTagStyle(l) { return `background:${lessonTagBg(l)};color:${lessonColor(l)};`; }

// Quyển (book) — Quyển 1: bài 1-15, Quyển 2: bài 16-30
let BOOKS = [
  {id:1,  name:'Quyển 1',      from:1,   to:15,  group:'📗 Giáo trình cơ bản'},
  {id:2,  name:'Quyển 2',      from:16,  to:30,  group:'📗 Giáo trình cơ bản'},
  {id:12, name:'Quyển 3',      from:100, to:109, group:'📗 Giáo trình cơ bản'},
  {id:13, name:'Quyển 4',      from:110, to:119, group:'📗 Giáo trình cơ bản'},
  {id:3,  name:'Chuyên ngành', from:31, to:31, group:'🧩 Từ vựng mở rộng'},
  {id:14, name:'Từ nối',       from:90, to:90, group:'🧩 Từ vựng mở rộng'},
  {id:15, name:'Lượng từ',     from:91, to:91, group:'🧩 Từ vựng mở rộng'},
  {id:16, name:'Động từ ly hợp', from:120, to:120, group:'🧩 Từ vựng mở rộng'},
  {id:4,  name:'HSK 1',        from:32, to:32, group:'🎯 Luyện thi HSK'},
  {id:5,  name:'HSK 2',        from:33, to:33, group:'🎯 Luyện thi HSK'},
  {id:6,  name:'HSK 3',        from:34, to:34, group:'🎯 Luyện thi HSK'},
  {id:7,  name:'HSK 4',        from:35, to:35, group:'🎯 Luyện thi HSK'},
  {id:8,  name:'HSK 4+',       from:36, to:36, group:'🎯 Luyện thi HSK'},
  {id:9,  name:'HSK 5',        from:37, to:37, group:'🎯 Luyện thi HSK'},
  {id:10, name:'HSK 6',        from:38, to:38, group:'🎯 Luyện thi HSK'},
  {id:11, name:'HSK 6+',       from:39, to:39, group:'🎯 Luyện thi HSK'},
];
// Tự động nhận diện các số bài có từ vựng trong database nhưng CHƯA thuộc Quyển/level nào ở trên
// (vd admin import Excel với số bài mới, chưa từng khai báo) — tự thêm thành 1 mục chọn riêng,
// không cần sửa code mỗi khi có dữ liệu mới.
function mergeDiscoveredLessonsIntoBooks() {
  const isCovered = (l) => BOOKS.some(b => l >= b.from && l <= b.to);
  const discovered = Object.keys(vocabCounts)
    .map(k => parseInt(k, 10))
    .filter(l => Number.isFinite(l) && vocabCounts[l] > 0 && !isCovered(l))
    .sort((a,b) => a-b);
  for (const l of discovered) {
    // id = 2000+bài — cố định theo số bài (không phải bộ đếm tăng dần) để giữ ổn định giữa các lần
    // mở app, tránh trường hợp cùng 1 id trỏ sang bài khác nhau nếu thứ tự phát hiện thay đổi.
    BOOKS.push({ id: 2000 + l, name: 'Bài ' + l, from: l, to: l, group: '🆕 Từ vựng mới (tự nhận diện)' });
  }
}
function lessonsOfBook(bookId) {
  const b = BOOKS.find(x=>x.id===bookId);
  const arr = [];
  for (let i=b.from;i<=b.to;i++) arr.push(i);
  return arr;
}
function bookOfLesson(l) {
  const b = BOOKS.find(x => l>=x.from && l<=x.to);
  return b ? b.id : 1;
}
// Cho phép chọn NHIỀU Quyển/level cùng lúc qua 1 ô droplist (multi-select)
let selectedBookIds = new Set([1]);
let selectedLessons = new Set(); // các bài đang chọn riêng lẻ (chỉ có ý nghĩa khi lessonsAllMode = false)
let lessonsAllMode = true; // true = học hết tất cả các bài trong (các) Quyển/level đang chọn

// ── Giới hạn cho khách / chưa đăng nhập: chỉ được học tối đa 5 bài đầu của Quyển 1 ──
const GUEST_MAX_LESSON = 5;
function isLoggedIn() { return !isGuest && !!authToken && !!authUsername; }
function guestLimitNotice() {
  openAuthGate();
}

// Toàn bộ các bài học thuộc những Quyển/level đang được chọn (đã gộp, đã sắp xếp)
function lessonsOfSelection() {
  const set = new Set();
  for (const id of selectedBookIds) for (const l of lessonsOfBook(id)) set.add(l);
  return [...set].sort((a,b)=>a-b);
}

// Lưu lại lựa chọn Quyển/level + bài hiện tại vào progressState.ui (đồng bộ lên server, gộp cả
// khách lẫn tài khoản — cacheProgressLocally tự lưu máy, scheduleSync tự bỏ qua nếu là khách)
function saveSelectionState() {
  progressState.ui.selectedBookIds = [...selectedBookIds];
  progressState.ui.selectedLessons = [...selectedLessons];
  progressState.ui.lessonsAllMode = lessonsAllMode;
  cacheProgressLocally();
  scheduleSync();
}

// Bấm 1 thẻ Quyển/level: bật/tắt trong danh sách đang chọn (giữ lại ít nhất 1 mục luôn được chọn)
function toggleBook(id) {
  if (!isLoggedIn() && id !== 1) { guestLimitNotice(); return; }
  if (selectedBookIds.has(id)) {
    selectedBookIds.delete(id); // cho phép bỏ chọn hết, không bắt buộc giữ lại tối thiểu 1 mục
  } else {
    selectedBookIds.add(id);
  }
  selectedLessons.clear(); lessonsAllMode = true; // đổi Quyển/level thì reset lựa chọn bài cụ thể trước đó
  saveSelectionState();
  render();
  ensureVocabLoaded(selectedBookIds).then(() => render()); // tải đúng phần từ vựng vừa chọn thêm (nếu chưa có)
}

// Bấm "Tất cả": học hết các bài trong (các) Quyển/level đang chọn
function selectAllLessonsInSelection() { selectedLessons.clear(); lessonsAllMode = true; saveSelectionState(); render(); }
// Bấm 1 thẻ bài cụ thể: bật/tắt bài đó (chọn được nhiều bài cùng lúc, có thể bỏ tích hết để không chọn bài nào)
function toggleLessonChip(l) {
  if (!isLoggedIn() && l > GUEST_MAX_LESSON) { guestLimitNotice(); return; }
  lessonsAllMode = false;
  if (selectedLessons.has(l)) selectedLessons.delete(l);
  else selectedLessons.add(l);
  saveSelectionState();
  render();
}

// Cache số từ theo từng Quyển/level — tránh phải lọc lại toàn bộ WORDS mỗi lần vẽ lại danh sách.
// Với các bài chưa tải nội dung về, dùng số đếm nhẹ lấy từ server (vocabCounts) để vẫn hiện
// đúng số từ mà không cần tải cả nội dung (toàn bộ từ vựng giờ đều nạp từ database, kể cả Quyển 1/2).
let _bookCountCache = { len: -1, counts: {} };
function bookWordCount(bookId) {
  if (_bookCountCache.len !== WORDS.length) {
    const counts = {};
    for (const b of BOOKS) counts[b.id] = 0;
    for (const w of WORDS) {
      const b = BOOKS.find(x => w.l >= x.from && w.l <= x.to);
      if (b) counts[b.id]++;
    }
    _bookCountCache = { len: WORDS.length, counts };
  }
  const b = BOOKS.find(x => x.id === bookId);
  if (b && !loadedLessonNumbers.has(b.from)) {
    let sum = 0;
    for (let l = b.from; l <= b.to; l++) sum += vocabCounts[l] || 0;
    return sum;
  }
  return _bookCountCache.counts[bookId] || 0;
}

// Thẻ chọn Quyển/level, nhóm theo từng loại (Giáo trình cơ bản / Từ vựng mở rộng / Luyện thi HSK...)
// Có thể chạm nhiều thẻ để chọn cùng lúc.
function levelSelectHtml() {
  const loggedIn = isLoggedIn();
  const groups = [];
  for (const b of BOOKS) if (!groups.includes(b.group)) groups.push(b.group);
  return groups.map(g => {
    // Ẩn các bài không còn từ nào (0 từ) khỏi màn chọn — trừ khi đang được chọn sẵn,
    // để tránh tình trạng "bài thừa" còn sót lại sau khi xoá/nhập lại dữ liệu.
    const booksInGroup = BOOKS.filter(b => b.group === g)
      .filter(b => bookWordCount(b.id) > 0 || selectedBookIds.has(b.id));
    if (booksInGroup.length === 0) return '';
    const cards = booksInGroup.map(b => {
      const locked = !loggedIn && b.id !== 1;
      const sel = selectedBookIds.has(b.id);
      const count = bookWordCount(b.id);
      return `<button class="book-card${sel?' sel':''}${locked?' locked':''}" onclick="toggleBook(${b.id})">
        ${locked?'<span class="book-card-lock">🔒</span>':''}
        <span class="book-card-name">${b.name}</span>
        <span class="book-card-count">${count} từ</span>
      </button>`;
    }).join('');
    return `<div class="book-group">
      <div class="book-group-label">${g}</div>
      <div class="book-grid">${cards}</div>
    </div>`;
  }).join('');
}

// Chip chọn bài cụ thể — CHỈ áp dụng cho các Quyển có nhiều hơn 1 bài (Quyển 1, Quyển 2).
// Chuyên ngành / HSK... mỗi mục chỉ có đúng 1 bài nên không cần (và không hiện) phần chọn thêm này.
function lessonSelectHtml() {
  const multiLessonIds = [...selectedBookIds].filter(id => {
    const b = BOOKS.find(x => x.id === id);
    return b && (b.to > b.from);
  });
  if (multiLessonIds.length === 0) return '';
  const set = new Set();
  for (const id of multiLessonIds) for (const l of lessonsOfBook(id)) set.add(l);
  const lessons = [...set].sort((a,b)=>a-b);
  const loggedIn = isLoggedIn();
  const allBtn = `<button class="lbtn${lessonsAllMode?' sel':''}" style="${lessonsAllMode ? `border-color:var(--active);background:var(--active);color:#fff;` : `border-color:var(--active);background:${lessonBg(0)};color:var(--active);`}" onclick="selectAllLessonsInSelection()">Tất cả</button>`;
  const chips = lessons.map(l => {
    const sel = !lessonsAllMode && selectedLessons.has(l);
    const locked = !loggedIn && l > GUEST_MAX_LESSON;
    const style = sel
      ? `border-color:${lessonColor(l)};background:${lessonColor(l)};color:#fff;`
      : `border-color:${lessonColor(l)};background:${lessonBg(l)};color:${lessonColor(l)};`;
    return `<button class="lbtn${sel?' sel':''}${locked?' locked':''}" style="${style}${locked?'opacity:.5;':''}" onclick="toggleLessonChip(${l})">${locked?'🔒 ':''}Bài ${l}</button>`;
  }).join('');
  return `<div style="font-size:.72rem;color:var(--muted);font-weight:700;margin:8px 0 4px;">Chọn bài cụ thể (có thể bỏ tích hết để không chọn bài nào)</div>
    <div id="lesson-filter">${allBtn}${chips}</div>`;
}

