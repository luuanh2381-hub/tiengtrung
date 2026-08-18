// js/study-session.js — V77: "Study Day" (1 ngày) có thể chứa NHIỀU "Study Session" (nhiều phiên:
// sáng/trưa/tối — Yêu cầu 1). Lớp điều phối MỨC CAO NHẤT, dùng CHUNG cho mọi tab luyện tập
// (Review/Flashcard/Trắc nghiệm/Gõ chữ/Nghe-chọn — Yêu cầu 9): quyết định khi nào cần hỏi rõ user
// chọn giữa "Học tiếp" (tiếp tục đúng phiên đang dở) và "Học mới" (đóng phiên dở, mở phiên mới —
// Yêu cầu 2), thay vì tự động resume/ghi đè ngầm. Đơn giản vào tab bình thường (không có gì dang
// dở) hoặc đổi tab qua lại vẫn KHÔNG bị hỏi gì — chỉ hỏi khi phát hiện có tiến trình dang dở thật
// sự (Yêu cầu 6/7: refresh/đổi tab không reset, không tạo hàng đợi mới ngầm).
// ════════════════════════════════════════════════════
const SS_MODE_LABEL = {
  flash: '📖 Flashcard', quiz: '📝 Trắc nghiệm', type: '⌨️ Gõ chữ', listen: '🎧 Nghe chọn',
  review: '🎯 Hôm nay học', 'review-weak': '⚠️ Từ hay quên',
};
const SS_TAB_OF_MODE = { flash: 'flash', quiz: 'quiz', type: 'type', listen: 'listen', review: 'review', 'review-weak': 'review' };

// Home ("Bắt đầu học nhanh" / "Bắt đầu học" / "Luyện từ hay quên") gọi hàm này thay vì goTab()/
// startStudySession() thẳng. mode: 'flash'|'quiz'|'type'|'listen'|'review'|'review-weak'.
function ssEnterMode(mode) {
  if (!isLoggedIn()) { // khách không có Study Session FSRS thật để "dang dở" — vào thẳng như cũ
    if (mode === 'review' || mode === 'review-weak') startStudySession(mode === 'review-weak', false);
    else goTab(mode);
    return;
  }
  const saved = sqReadPersisted(mode);
  const dangling = !!(saved && saved.items && saved.items.length > 0 && saved.answeredCount > 0
    && sqLessonFilterMatches(saved.lessonFilter));
  if (!dangling) {
    if (mode === 'review' || mode === 'review-weak') startStudySession(mode === 'review-weak', false);
    else goTab(mode);
    return;
  }
  ssRenderChooser(mode, saved);
}

// Cập nhật đúng phần "khung" mà goTab() vẫn làm (tab đang chọn, highlight nav, lưu lastTab) NHƯNG
// KHÔNG gọi render()/bindX() — tránh việc bindX() tự ý nạp/khôi phục hàng đợi trước khi user kịp
// chọn Học tiếp/Học mới (tránh 1 lượt tải thừa/đè nhầm trạng thái).
function ssSetActiveTabUI(tab) {
  currentTab = tab;
  progressState.ui.lastTab = (tab === 'review') ? 'today' : tab;
  cacheProgressLocally();
  scheduleSync();
  document.querySelectorAll('#nav button').forEach(b => b.classList.remove('active'));
  const navBtn = document.getElementById('tab-' + tab);
  if (navBtn) navBtn.classList.add('active');
}

function ssRenderChooser(mode, saved) {
  ssSetActiveTabUI(SS_TAB_OF_MODE[mode] || mode);
  const el = document.getElementById('content');
  if (!el) return;
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  const label = SS_MODE_LABEL[mode] || '';
  el.innerHTML = `
    <div class="panel center" style="padding:32px 20px">
      <div style="font-size:1.05rem;font-weight:800;margin-bottom:8px">${label}</div>
      <div style="color:var(--muted);margin-bottom:18px">Bạn đang có 1 phiên học dang dở: đã học ${saved.answeredCount}, còn ${saved.items.length} từ trong hàng đợi.</div>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="ssResumeChoice('${mode}')">▶️ Học tiếp</button>
        <button class="btn" onclick="ssNewChoice('${mode}')">🆕 Học mới</button>
      </div>
    </div>`;
}

// "Học tiếp" (Yêu cầu 2): tiếp tục ĐÚNG phiên đang dở — mọi bindX()/startStudySession() ở trạng
// thái mặc định (không forceNew) đều tự khôi phục đúng phiên đã lưu (Yêu cầu 6/7), nên chỉ cần
// điều hướng vào đúng tab/luồng như bình thường.
function ssResumeChoice(mode) {
  if (mode === 'review' || mode === 'review-weak') { startStudySession(mode === 'review-weak', false); return; }
  goTab(mode);
}

// "Học mới" (Yêu cầu 2): đóng phiên dang dở (ghi nhật ký ngày) rồi mở phiên MỚI — vẫn tôn trọng
// sessionKnownHz/FSRS due (Yêu cầu 3), tự tiếp tục đúng từ CHƯA học kế tiếp (Yêu cầu 4). KHÔNG mất
// dữ liệu: FSRS thật đã ghi trên server ngay lúc trả lời, chỉ riêng hàng đợi/vị trí cục bộ bị thay.
async function ssNewChoice(mode) {
  if (mode === 'review' || mode === 'review-weak') { startStudySession(mode === 'review-weak', true); return; }
  const cfg = {
    flash:  { sq: () => fcQueue, setRestore: v => { fcRestoreAttempted = v; } },
    quiz:   { sq: () => qzQueue, setRestore: v => { qzRestoreAttempted = v; } },
    type:   { sq: () => tyQueue, setRestore: v => { tyRestoreAttempted = v; } },
    listen: { sq: () => lsQueue, setRestore: v => { lsRestoreAttempted = v; } },
  }[mode];
  if (!cfg) { goTab(mode); return; }
  const sq = cfg.sq();
  ssArchiveSession(mode, sq);
  sqClearPersisted(mode);
  sq.items = []; sq.doneHz = new Set(); sq.totalPlanned = 0; sq.answeredCount = 0; sq.completedCards = [];
  // Đã đóng/dọn phiên CŨ ở trên rồi — không cho bindX() (sẽ chạy bên trong goTab()) tự ý phục hồi
  // lại đúng bản vừa bị đóng đó; hàng đợi rỗng + cờ này = bindX() tự nạp thẳng phiên MỚI.
  cfg.setRestore(true);
  goTab(mode); // render() sẽ gọi đúng bindFlash/bindQuiz/bindType/bindListen(), tự sqLoad() phiên mới
}
