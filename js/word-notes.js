// js/word-notes.js — "✍️ Mẹo nhớ của bạn" (V105): ghi chú liên tưởng RIÊNG cho từng từ.
// Tự nghĩ ra một liên tưởng (hình ảnh, câu chuyện, âm giống tiếng Việt) nhớ lâu hơn đọc liên tưởng có
// sẵn. Dữ liệu lưu trên server theo tài khoản (/api/notes); client giữ 1 bản cache theo hz, tải 1 lần.
// Trình soạn thảo là overlay riêng gắn vào <body> (không nằm trong vùng render() của tab) nên không bị
// vẽ lại mất chữ đang gõ. Khách (chưa đăng nhập) không có ghi chú.

let wnNotes = {};
let wnLoaded = false;
let wnLoading = null;
let wnPausedCountdown = false;
const WN_MAX = 200;

function wnEnsureLoaded() {
  if (typeof isLoggedIn !== 'function' || !isLoggedIn()) return Promise.resolve();
  if (wnLoaded) return Promise.resolve();
  if (wnLoading) return wnLoading;
  wnLoading = (async () => {
    try {
      const res = await fetch('/api/notes', { headers: authHeaders() });
      const data = await res.json().catch(() => null);
      if (data && data.ok && Array.isArray(data.notes)) {
        wnNotes = {};
        for (const n of data.notes) wnNotes[n.hz] = n.note;
        wnLoaded = true;
        wnRefreshBlock();
      }
    } catch {} // mất mạng: bỏ qua, lần sau thử lại
    wnLoading = null;
  })();
  return wnLoading;
}

function wnInner(hz) {
  const note = wnNotes[hz];
  const h = escapeJsAttr(hz);
  if (note) {
    return `<div class="wn-note">✍️ ${escapeHtml(note)}</div>
      <button class="wn-btn" onclick="wnOpenEditor('${h}')">Sửa mẹo nhớ</button>`;
  }
  return `<button class="wn-btn" onclick="wnOpenEditor('${h}')">✍️ Thêm mẹo nhớ của bạn</button>`;
}

// HTML của khối ghi chú để nhúng vào màn hình đáp án/mặt sau thẻ. Rỗng nếu chưa đăng nhập.
function wnBlockHtml(hz) {
  if (typeof isLoggedIn !== 'function' || !isLoggedIn() || !hz) return '';
  wnEnsureLoaded();
  return `<div id="wn-block" class="wn-block" data-hz="${escapeHtml(hz)}">${wnInner(hz)}</div>`;
}

function wnRefreshBlock() {
  const el = document.getElementById('wn-block');
  if (el) el.innerHTML = wnInner(el.dataset.hz);
}

function wnCloseEditor() {
  const ov = document.getElementById('wn-overlay');
  if (ov) ov.remove();
  // Nếu mình đã tạm dừng đếm ngược tự chọn đánh giá của tab Review thì chạy lại.
  if (wnPausedCountdown) {
    wnPausedCountdown = false;
    if (typeof rvRatingPhase !== 'undefined' && rvRatingPhase === 'pending' && currentTab === 'review') rvStartCountdown(rvAttemptId);
  }
}

function wnOpenEditor(hz) {
  if (document.getElementById('wn-overlay')) return;
  // Tạm dừng đếm ngược tự chọn đánh giá khi đang gõ để thẻ không tự chuyển đi giữa chừng.
  if (typeof rvCountdownTimer !== 'undefined' && rvCountdownTimer) { rvClearCountdown(); wnPausedCountdown = true; }
  const existing = wnNotes[hz] || '';
  const ov = document.createElement('div');
  ov.id = 'wn-overlay';
  ov.className = 'wn-overlay';
  ov.innerHTML = `<div class="wn-sheet" role="dialog" aria-label="Mẹo nhớ của bạn">
    <div class="wn-title">✍️ Mẹo nhớ cho <b>${escapeHtml(hz)}</b></div>
    <div class="wn-hint">Tự nghĩ một liên tưởng của riêng bạn: một hình ảnh, một câu chuyện ngắn, hoặc âm nghe giống một từ tiếng Việt.</div>
    <textarea id="wn-text" class="wn-text" maxlength="${WN_MAX}" rows="3" placeholder="Ví dụ: ...">${escapeHtml(existing)}</textarea>
    <div class="wn-count"><span id="wn-count-num">${[...existing].length}</span>/${WN_MAX}</div>
    <div id="wn-error" class="wn-error"></div>
    <div class="wn-actions">
      <button class="btn btn-primary" id="wn-save">Lưu</button>
      ${existing ? '<button class="btn" id="wn-del">Xoá</button>' : ''}
      <button class="btn" id="wn-cancel">Hủy</button>
    </div></div>`;
  document.body.appendChild(ov);
  const ta = document.getElementById('wn-text');
  ta.addEventListener('input', () => { document.getElementById('wn-count-num').textContent = [...ta.value].length; });
  ov.addEventListener('click', (e) => { if (e.target === ov) wnCloseEditor(); });
  document.getElementById('wn-cancel').onclick = wnCloseEditor;
  document.getElementById('wn-save').onclick = () => wnSave(hz, ta.value);
  const del = document.getElementById('wn-del');
  if (del) del.onclick = () => wnSave(hz, '');
  ta.focus();
}

async function wnSave(hz, text) {
  const errEl = document.getElementById('wn-error');
  const saveBtn = document.getElementById('wn-save');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const res = await fetch('/api/notes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ hz, note: text }),
    });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) throw new Error((data && data.error) || 'Không lưu được, thử lại sau');
    if (data.note) wnNotes[hz] = data.note; else delete wnNotes[hz];
    wnCloseEditor();
    wnRefreshBlock();
  } catch (e) {
    if (errEl) errEl.textContent = e.message;
    if (saveBtn) saveBtn.disabled = false;
  }
}

// Đăng xuất/đổi tài khoản: không giữ ghi chú của người trước.
function wnReset() { wnNotes = {}; wnLoaded = false; wnLoading = null; wnCloseEditor(); }

(function wnInjectStyle() {
  if (typeof document === 'undefined' || document.getElementById('wn-style')) return;
  const st = document.createElement('style');
  st.id = 'wn-style';
  st.textContent = `
  .wn-block{margin:8px 0 2px;text-align:left}
  .wn-note{font-size:.95rem;background:var(--paper);border:1px dashed var(--border);border-radius:var(--radius-sm,10px);padding:8px 12px;margin-bottom:6px;line-height:1.45;word-break:break-word}
  .wn-btn{font-size:.8rem;font-weight:700;border:1px solid var(--border);background:transparent;color:var(--muted);border-radius:16px;padding:5px 12px;cursor:pointer}
  .wn-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:flex;align-items:flex-end;justify-content:center}
  .wn-sheet{background:var(--paper,#fff);width:100%;max-width:520px;border-radius:16px 16px 0 0;padding:16px;box-sizing:border-box;padding-bottom:calc(16px + env(safe-area-inset-bottom,0px))}
  .wn-title{font-size:1.05rem;margin-bottom:6px}.wn-hint{font-size:.8rem;color:var(--muted);margin-bottom:8px;line-height:1.4}
  .wn-text{width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:10px;padding:10px;font:inherit;resize:vertical;background:var(--bg,#fff);color:var(--ink)}
  .wn-count{font-size:.72rem;color:var(--muted);text-align:right}.wn-error{color:var(--l10a,#c0392b);font-size:.8rem;min-height:1em}
  .wn-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}`;
  document.head.appendChild(st);
})();
