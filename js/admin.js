// js/admin.js — Tab Quản trị + Quản lý từ vựng (chỉ admin/superadmin)
// ════════════════════════════════════════════════════
// TAB: QUẢN TRỊ (chỉ admin)
// ════════════════════════════════════════════════════
function renderAdmin() {
  if (isGuest || !isAdminRole()) {
    return `<div class="panel center" style="padding:40px">Bạn không có quyền truy cập mục này.</div>`;
  }
  return `<div class="panel">
    <div class="panel-title">📈 Lượt truy cập</div>
    <div id="visits-area" style="color:var(--muted);padding:14px 0;text-align:center;">Đang tải...</div>
  </div>
  <div class="panel">
    <div class="panel-title">🛠️ Quản trị tài khoản${currentRole==='superadmin' ? ' <span style="font-size:.7rem;background:var(--l15c);color:var(--l15a);padding:2px 8px;border-radius:8px;">QUẢN TRỊ CAO NHẤT</span>' : ''}</div>
    <div id="admin-area" style="color:var(--muted);padding:14px 0;text-align:center;">Đang tải danh sách...</div>
  </div>`;
}

// ════════════════════════════════════════════════════
// QUẢN LÝ TỪ VỰNG — tách riêng khỏi tab Quản trị tài khoản
// ════════════════════════════════════════════════════
function renderVocabAdmin() {
  if (isGuest || !isAdminRole()) {
    return `<div class="panel center" style="padding:40px">Bạn không có quyền truy cập mục này.</div>`;
  }
  return `<div class="panel">
    <div class="panel-title">✍️ Thêm 1 từ thủ công</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
      <input type="text" id="vocab-manual-hz" placeholder="Chữ Hán (ví dụ 你好)" style="padding:8px;border-radius:8px;border:1.5px solid #ddd;font-size:.9rem;">
      <input type="text" id="vocab-manual-py" placeholder="Pinyin (ví dụ nǐ hǎo)" style="padding:8px;border-radius:8px;border:1.5px solid #ddd;font-size:.9rem;">
      <input type="text" id="vocab-manual-vi" placeholder="Nghĩa tiếng Việt (ví dụ xin chào)" style="padding:8px;border-radius:8px;border:1.5px solid #ddd;font-size:.9rem;grid-column:1 / -1;">
      <input type="number" id="vocab-manual-l" placeholder="Số bài (ví dụ 1)" min="1" style="padding:8px;border-radius:8px;border:1.5px solid #ddd;font-size:.9rem;">
    </div>
    <label style="display:flex;align-items:center;gap:6px;font-size:.78rem;color:var(--muted);margin-bottom:8px;">
      <input type="checkbox" id="vocab-manual-lyhop"> 🧩 Đây là động từ ly hợp (离合词)
    </label>
    <label style="display:flex;align-items:center;gap:6px;font-size:.78rem;color:var(--muted);margin-bottom:8px;">
      <input type="checkbox" id="vocab-manual-overwrite"> Ghi đè nếu chữ Hán + số bài này đã tồn tại (cập nhật lại pinyin/nghĩa)
    </label>
    <button class="btn btn-sm" style="background:var(--l11c);color:var(--l11a);" onclick="addVocabManual()">➕ Thêm từ này</button>
    <div id="vocab-manual-result" style="font-size:.8rem;color:var(--muted);margin-top:8px;"></div>
  </div>
  <div class="panel">
    <div class="panel-title">📥 Thêm từ vựng mới (Excel)</div>
    <div style="font-size:.78rem;color:var(--muted);margin-bottom:10px;">
      File Excel (.xlsx) cần có dòng tiêu đề với đúng 4 cột: <b>hz</b> (chữ Hán), <b>py</b> (pinyin), <b>vi</b> (nghĩa tiếng Việt), <b>l</b> (số bài học, ví dụ 1, 2, 3...).
    </div>
    <button class="btn btn-sm" style="background:var(--l9c);color:var(--l9a);margin-bottom:10px;" onclick="downloadVocabTemplate()">⬇️ Tải file mẫu</button>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
      <input type="file" id="vocab-file-input" accept=".xlsx,.xls" style="font-size:.8rem;max-width:100%;">
      <button class="btn btn-sm" style="background:var(--l11c);color:var(--l11a);" onclick="uploadVocabExcel()">📤 Tải lên & nhập</button>
    </div>
    <label style="display:flex;align-items:center;gap:6px;font-size:.78rem;color:var(--muted);margin-bottom:10px;">
      <input type="checkbox" id="vocab-excel-overwrite"> Ghi đè nếu chữ Hán + số bài đã tồn tại (cập nhật lại pinyin/nghĩa)
    </label>
    <div id="vocab-import-result" style="font-size:.8rem;color:var(--muted);"></div>
  </div>
  <div class="panel">
    <div class="panel-title">🈶 Nghĩa Hán Việt (mỗi từ có sẵn 1 âm Hán Việt)</div>
    <div style="font-size:.78rem;color:var(--muted);margin-bottom:10px;">
      AI tự sinh âm/nghĩa Hán Việt cho từng từ (vd 学习 → "Học tập"), hiện kèm Pinyin/nghĩa ở mọi nơi trong app (có nút Ẩn/Hiện Hán Việt riêng trên thanh menu).
    </div>
    <button class="btn btn-sm" style="background:var(--l9c);color:var(--l9a);margin-bottom:12px;" id="gen-hanviet-btn" onclick="triggerHanVietGeneration()">🚀 Chạy sinh nghĩa Hán Việt ngay</button>
    <div id="gen-hanviet-result" style="font-size:.8rem;color:var(--muted);margin-bottom:10px;"></div>
    <div id="hanviet-progress-area" style="color:var(--muted);padding:14px 0;text-align:center;">Đang tải...</div>
  </div>
  <div class="panel">
    <div class="panel-title">📖 Ví dụ theo từng từ (đảm bảo mỗi từ có sẵn 3 ví dụ)</div>
    <div style="font-size:.78rem;color:var(--muted);margin-bottom:10px;">
      Khác với câu luyện dịch ở trên (theo cả bài), đây là kho ví dụ minh hoạ hiện trong Trắc nghiệm — mỗi từ được đảm bảo có sẵn 3 câu ví dụ riêng (AI tự kiểm tra câu có đúng chứa từ đó không trước khi lưu). Có thể mất nhiều ngày để phủ hết toàn bộ từ vựng.
    </div>
    <button class="btn btn-sm" style="background:var(--l9c);color:var(--l9a);margin-bottom:12px;" id="gen-word-ex-btn" onclick="triggerWordExampleGeneration()">🚀 Chạy sinh ví dụ theo từ ngay</button>
    <div id="gen-word-ex-result" style="font-size:.8rem;color:var(--muted);margin-bottom:10px;"></div>
    <div id="word-ex-progress-area" style="color:var(--muted);padding:14px 0;text-align:center;">Đang tải...</div>
  </div>
  <div class="panel">
    <div class="panel-title">🧩 Chiết tự bộ thủ (phân tích từng chữ Hán)</div>
    <div style="font-size:.78rem;color:var(--muted);margin-bottom:10px;">
      AI phân tích từng chữ Hán thành các thành phần cấu tạo (bộ thủ), giúp ghi nhớ mặt chữ dễ hơn — hiện trong Flashcard và Trắc nghiệm (chế độ 漢→Việt).
    </div>
    <button class="btn btn-sm" style="background:var(--l9c);color:var(--l9a);margin-bottom:12px;" id="gen-hanzi-btn" onclick="triggerHanziPartsGeneration()">🚀 Chạy sinh chiết tự ngay</button>
    <div id="gen-hanzi-result" style="font-size:.8rem;color:var(--muted);margin-bottom:10px;"></div>
    <div id="hanzi-progress-area" style="color:var(--muted);padding:14px 0;text-align:center;">Đang tải...</div>
  </div>
  <div class="panel">
    <div class="panel-title">📋 Danh sách bài đã có (sửa/xoá từng từ, hoặc xoá cả bài)</div>
    <div id="vocab-list-area" style="color:var(--muted);padding:14px 0;text-align:center;">Đang tải...</div>
  </div>
  <div class="panel">
    <div class="panel-title">🗑️ Xoá toàn bộ dữ liệu</div>
    <button class="btn btn-sm" style="background:#fdecea;color:#c0392b;" onclick="clearAllVocab()">🗑️ Xoá toàn bộ từ đã thêm (Excel + thủ công)</button>
    <div style="font-size:.72rem;color:var(--muted);margin-top:6px;">Chỉ xoá các từ được thêm qua Excel/thủ công — không đụng tới bộ từ vựng gốc có sẵn của app (781 từ Quyển 1, 2).</div>
    <div id="vocab-clear-result" style="font-size:.8rem;color:var(--muted);margin-top:8px;"></div>
  </div>`;
}
function bindVocabAdmin() {
  if (isGuest || !isAdminRole()) return;
  loadVocabAdminList();
  loadHanVietProgress();
  loadWordExampleProgress();
  loadHanziPartsProgress();
}
async function loadHanVietProgress() {
  const area = document.getElementById('hanviet-progress-area');
  if (!area) return;
  try {
    const res = await fetch('/api/admin/hanviet/progress', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { area.textContent = data.error || 'Không tải được dữ liệu.'; return; }
    const pct = data.total ? Math.round(data.done / data.total * 100) : 0;
    area.innerHTML = `
      <div style="display:flex;justify-content:space-between;font-size:.85rem;font-weight:700;margin-bottom:6px;">
        <span>${data.done} / ${data.total} từ đã có nghĩa Hán Việt</span>
        <span style="color:var(--active-dark)">${pct}%</span>
      </div>
      <div class="prog-bar"><div class="prog-fill" style="width:${pct}%;background:var(--active);"></div></div>`;
  } catch (e) {
    area.textContent = 'Không kết nối được máy chủ: ' + e.message;
  }
}
async function triggerHanVietGeneration() {
  const btn = document.getElementById('gen-hanviet-btn');
  const resultEl = document.getElementById('gen-hanviet-result');
  btn.disabled = true;
  btn.textContent = '⏳ Đang chạy... (có thể mất tới 50 giây, đừng rời trang)';
  resultEl.textContent = '';
  try {
    const res = await fetch('/api/admin/generate-hanviet', { method: 'POST', headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { resultEl.innerHTML = `❌ ${data.error || 'Có lỗi xảy ra'}`; }
    else {
      resultEl.innerHTML = `✅ Đã xử lý ${data.batches} lô, thêm ${data.done} từ${data.errors ? `, lỗi: ${data.errors}` : ''}. Còn ${data.totalPending - data.done} từ đang chờ xử lý.` + renderErrorSamples(data.errorSamples);
      loadHanVietProgress();
      refreshVocabHanviet(); // nạp lại nghĩa Hán Việt vào WORDS đã tải để dùng ngay không cần tải lại trang
    }
  } catch (e) {
    resultEl.innerHTML = `❌ Không kết nối được máy chủ: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Chạy sinh nghĩa Hán Việt ngay';
  }
}
async function loadWordExampleProgress() {
  const area = document.getElementById('word-ex-progress-area');
  if (!area) return;
  try {
    const res = await fetch('/api/admin/word-examples/progress', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { area.textContent = data.error || 'Không tải được dữ liệu.'; return; }
    const pct = data.total ? Math.round(data.done / data.total * 100) : 0;
    area.innerHTML = `
      <div style="display:flex;justify-content:space-between;font-size:.85rem;font-weight:700;margin-bottom:6px;">
        <span>${data.done} / ${data.total} từ đã có đủ 3 ví dụ</span>
        <span style="color:var(--active-dark)">${pct}%</span>
      </div>
      <div class="prog-bar"><div class="prog-fill" style="width:${pct}%;background:var(--active);"></div></div>`;
  } catch (e) {
    area.textContent = 'Không kết nối được máy chủ: ' + e.message;
  }
}
// Hiện chi tiết vài lỗi mẫu (không lặp lại) gặp phải khi chạy sinh dữ liệu bằng AI — giúp admin biết
// chính xác vì sao có lỗi (vd thiếu GEMINI_API_KEY, Gemini quá tải, JSON trả về sai định dạng...).
function renderErrorSamples(errorSamples) {
  if (!Array.isArray(errorSamples) || errorSamples.length === 0) return '';
  const items = errorSamples.map(msg => `<li style="margin-bottom:3px;">${msg}</li>`).join('');
  return `<div style="margin-top:8px;padding:10px 12px;background:#fdecea;border-radius:10px;color:#c0392b;font-size:.78rem;">
    <b>Chi tiết lỗi:</b>
    <ul style="margin:6px 0 0;padding-left:18px;">${items}</ul>
  </div>`;
}
async function triggerWordExampleGeneration() {
  const btn = document.getElementById('gen-word-ex-btn');
  const resultEl = document.getElementById('gen-word-ex-result');
  btn.disabled = true;
  btn.textContent = '⏳ Đang chạy... (có thể mất tới 50 giây, đừng rời trang)';
  resultEl.textContent = '';
  try {
    const res = await fetch('/api/admin/generate-word-examples', { method: 'POST', headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { resultEl.innerHTML = `❌ ${data.error || 'Có lỗi xảy ra'}`; }
    else {
      resultEl.innerHTML = `✅ Đã xử lý ${data.batches} lô. Từ xong hoàn toàn: ${data.wordsDone}, cần thử lại: ${data.wordsRetried}${data.errors ? `, lỗi: ${data.errors}` : ''}. Còn ${data.totalPending - data.wordsDone} từ đang chờ xử lý.` + renderErrorSamples(data.errorSamples);
      loadWordExampleProgress();
    }
  } catch (e) {
    resultEl.innerHTML = `❌ Không kết nối được máy chủ: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Chạy sinh ví dụ theo từ ngay';
  }
}
async function loadHanziPartsProgress() {
  const area = document.getElementById('hanzi-progress-area');
  if (!area) return;
  try {
    const res = await fetch('/api/admin/hanzi-parts/progress', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { area.textContent = data.error || 'Không tải được dữ liệu.'; return; }
    const pct = data.total ? Math.round(data.done / data.total * 100) : 0;
    area.innerHTML = `
      <div style="display:flex;justify-content:space-between;font-size:.85rem;font-weight:700;margin-bottom:6px;">
        <span>${data.done} / ${data.total} chữ đã có chiết tự</span>
        <span style="color:var(--active-dark)">${pct}%</span>
      </div>
      <div class="prog-bar"><div class="prog-fill" style="width:${pct}%;background:var(--active);"></div></div>`;
  } catch (e) {
    area.textContent = 'Không kết nối được máy chủ: ' + e.message;
  }
}
async function triggerHanziPartsGeneration() {
  const btn = document.getElementById('gen-hanzi-btn');
  const resultEl = document.getElementById('gen-hanzi-result');
  btn.disabled = true;
  btn.textContent = '⏳ Đang chạy... (có thể mất tới 50 giây, đừng rời trang)';
  resultEl.textContent = '';
  try {
    const res = await fetch('/api/admin/generate-hanzi-parts', { method: 'POST', headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { resultEl.innerHTML = `❌ ${data.error || 'Có lỗi xảy ra'}`; }
    else {
      resultEl.innerHTML = `✅ Đã xử lý ${data.batches} lô, thêm ${data.done} chữ${data.errors ? `, lỗi: ${data.errors}` : ''}. Còn ${data.totalPending - data.done} chữ đang chờ xử lý.` + renderErrorSamples(data.errorSamples);
      loadHanziPartsProgress();
      loadHanziParts(); // nạp lại dữ liệu mới để dùng ngay không cần tải lại trang
    }
  } catch (e) {
    resultEl.innerHTML = `❌ Không kết nối được máy chủ: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Chạy sinh chiết tự ngay';
  }
}
// Sau khi admin chạy sinh Hán Việt xong, các bài đã tải về máy (WORDS) vẫn đang giữ dữ liệu CŨ
// (chưa có hanviet) vì ensureVocabLoaded() bỏ qua từ đã có trong WORDS theo key hz+l. Hàm này tải
// lại đúng các bài đã tải và GHI ĐÈ trường hanviet vào những mục đã có sẵn trong WORDS, để admin
// thấy kết quả ngay mà không cần tải lại trang.
async function refreshVocabHanviet() {
  if (!loadedLessonNumbers.size) return;
  const url = (isGuest || !authToken)
    ? '/api/vocab/public?lessons=' + [...loadedLessonNumbers].join(',')
    : '/api/vocab?lessons=' + [...loadedLessonNumbers].join(',');
  try {
    const res = await fetch(url, (isGuest || !authToken) ? {} : { headers: authHeaders() });
    const data = await res.json();
    if (data.ok && Array.isArray(data.vocab)) {
      const byKey = new Map(data.vocab.map(w => [w.hz + '-' + w.l, w]));
      WORDS.forEach(w => {
        const fresh = byKey.get(w.hz + '-' + w.l);
        if (fresh && fresh.hanviet) w.hanviet = fresh.hanviet;
      });
    }
  } catch {
    // Không tải lại được thì thôi, dữ liệu vẫn đã lưu đúng trong DB, chỉ là chưa hiện ngay trên máy này
  }
}
async function loadVocabAdminList() {
  const area = document.getElementById('vocab-list-area');
  if (!area) return;
  try {
    const res = await fetch('/api/vocab/counts', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { area.textContent = data.error || 'Không tải được danh sách.'; return; }
    const entries = Object.entries(data.counts)
      .map(([l, c]) => [parseInt(l, 10), c])
      .filter(([l, c]) => c > 0)
      .sort((a, b) => a[0] - b[0]);
    if (entries.length === 0) {
      area.innerHTML = `<div style="color:var(--muted);text-align:center;padding:14px 0;">Chưa có bài nào được thêm qua Excel/thủ công.</div>`;
      return;
    }
    area.innerHTML = entries.map(([l, c]) => `
      <div style="border-bottom:1px solid var(--border);">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 2px;gap:8px;">
          <span style="font-weight:700;">Bài ${l} <span style="color:var(--muted);font-weight:600;font-size:.82rem;">(${c} từ)</span></span>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button class="btn btn-sm" style="background:var(--l9c);color:var(--l9a);" onclick="toggleLessonWords(${l})" id="toggle-words-btn-${l}">📝 Xem/Sửa từ</button>
            <button class="btn btn-sm" style="background:#fdecea;color:#c0392b;" onclick="deleteLessonVocab(${l})">🗑️ Xoá bài</button>
          </div>
        </div>
        <div id="lesson-words-${l}" style="display:none;padding:4px 0 10px;"></div>
      </div>`).join('');
    // Bài nào đang mở dở (VD vừa sửa/xoá 1 từ xong) thì tự mở lại đúng bài đó, khỏi phải bấm lại
    for (const l of openLessonWords) {
      const box = document.getElementById(`lesson-words-${l}`);
      const btn = document.getElementById(`toggle-words-btn-${l}`);
      if (box) { box.style.display = 'block'; loadLessonWords(l); }
      if (btn) btn.textContent = '📝 Ẩn danh sách từ';
    }
  } catch (e) {
    area.textContent = 'Không kết nối được máy chủ: ' + e.message;
  }
}

// ── Mở/đóng danh sách từng từ của 1 bài, để sửa/xoá riêng từng từ ──
const openLessonWords = new Set();
async function toggleLessonWords(l) {
  const box = document.getElementById(`lesson-words-${l}`);
  const btn = document.getElementById(`toggle-words-btn-${l}`);
  if (!box) return;
  const isOpen = box.style.display !== 'none';
  if (isOpen) { box.style.display = 'none'; btn.textContent = '📝 Xem/Sửa từ'; openLessonWords.delete(l); return; }
  btn.textContent = '📝 Đang tải...';
  box.style.display = 'block';
  openLessonWords.add(l);
  await loadLessonWords(l);
  btn.textContent = '📝 Ẩn danh sách từ';
}

const lessonWordsListCache = {}; // { [lessonNumber]: [{id,hz,py,vi,l,tag,hanviet}, ...] } — để "Sửa" khỏi phải gọi lại API
async function loadLessonWords(l) {
  const box = document.getElementById(`lesson-words-${l}`);
  if (!box) return;
  box.innerHTML = `<div style="color:var(--muted);padding:10px 0;text-align:center;font-size:.85rem;">Đang tải...</div>`;
  try {
    const res = await fetch('/api/admin/vocab/lesson-words?l=' + l, { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { box.innerHTML = `<div style="color:#c0392b;font-size:.82rem;">${data.error || 'Không tải được'}</div>`; return; }
    lessonWordsListCache[l] = data.words;
    renderLessonWordsList(l, data.words);
  } catch (e) {
    box.innerHTML = `<div style="color:#c0392b;font-size:.82rem;">Không kết nối được máy chủ: ${e.message}</div>`;
  }
}

function renderLessonWordsList(l, words) {
  const box = document.getElementById(`lesson-words-${l}`);
  if (!box) return;
  if (!words.length) {
    box.innerHTML = `<div style="color:var(--muted);text-align:center;padding:8px 0;font-size:.82rem;">Bài này không còn từ nào.</div>`;
    return;
  }
  box.innerHTML = words.map(w => renderWordRow(l, w)).join('');
}

function renderWordRow(l, w) {
  const tagBadge = w.tag === 'ly_hop' ? ' <span style="font-size:.68rem;background:var(--l15c);color:var(--l15a);padding:1px 6px;border-radius:6px;">离合</span>' : '';
  return `
    <div class="word-row" id="word-row-${w.id}" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 8px;background:var(--panel-2, rgba(0,0,0,.02));border-radius:8px;margin-bottom:6px;">
      <div style="min-width:0;">
        <div style="font-weight:700;">${escapeHtml(w.hz)}${tagBadge} <span style="color:var(--muted);font-weight:500;font-size:.82rem;">${escapeHtml(w.py || '')}</span></div>
        <div style="font-size:.82rem;color:var(--muted);">${escapeHtml(w.vi)}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="btn btn-sm" style="background:var(--l11c);color:var(--l11a);" onclick="startEditWord(${l}, ${w.id})">✏️ Sửa</button>
        <button class="btn btn-sm" style="background:#fdecea;color:#c0392b;" onclick="deleteWord(${l}, ${w.id}, '${escapeHtml(w.hz).replace(/'/g, "\\'")}')">🗑️</button>
      </div>
    </div>`;
}

// Lưu lại data gốc của các từ đang hiện, để "Sửa" có sẵn giá trị điền vào form + "Huỷ" khôi phục lại đúng dòng cũ
let lessonWordsCache = {}; // { [id]: word } — dòng gốc của từ đang sửa, dùng khi bấm "Huỷ" để khôi phục lại đúng dòng
function startEditWord(l, id) {
  const row = document.getElementById(`word-row-${id}`);
  if (!row) return;
  const renderForm = (w) => {
    lessonWordsCache[id] = w;
    row.outerHTML = `
      <div class="word-row" id="word-row-${id}" style="padding:8px;background:var(--panel-2, rgba(0,0,0,.03));border-radius:8px;margin-bottom:6px;border:1.5px solid var(--l11c);">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">
          <input type="text" id="edit-hz-${id}" value="${escapeAttr(w.hz)}" placeholder="Chữ Hán" style="padding:7px;border-radius:8px;border:1.5px solid #ddd;font-size:.88rem;">
          <input type="text" id="edit-py-${id}" value="${escapeAttr(w.py || '')}" placeholder="Pinyin" style="padding:7px;border-radius:8px;border:1.5px solid #ddd;font-size:.88rem;">
          <input type="text" id="edit-vi-${id}" value="${escapeAttr(w.vi)}" placeholder="Nghĩa tiếng Việt" style="padding:7px;border-radius:8px;border:1.5px solid #ddd;font-size:.88rem;grid-column:1 / -1;">
          <input type="number" id="edit-l-${id}" value="${w.l}" min="1" placeholder="Số bài" style="padding:7px;border-radius:8px;border:1.5px solid #ddd;font-size:.88rem;">
          <label style="display:flex;align-items:center;gap:6px;font-size:.78rem;color:var(--muted);">
            <input type="checkbox" id="edit-lyhop-${id}" ${w.tag === 'ly_hop' ? 'checked' : ''}> 🧩 Ly hợp từ
          </label>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <button class="btn btn-sm" style="background:var(--l11c);color:var(--l11a);" onclick="saveEditWord(${id})">💾 Lưu</button>
          <button class="btn btn-sm" style="background:var(--border);" onclick="cancelEditWord(${l}, ${id})">Huỷ</button>
          <span id="edit-word-result-${id}" style="font-size:.78rem;color:#c0392b;"></span>
        </div>
      </div>`;
  };
  // Ưu tiên dùng lại dữ liệu vừa tải khi mở danh sách (khỏi gọi lại API); chỉ fetch lại nếu vì lý do
  // gì đó cache không còn (VD người dùng bấm quá nhanh trước khi danh sách kịp tải xong).
  const cached = (lessonWordsListCache[l] || []).find(x => x.id === id);
  if (cached) { renderForm(cached); return; }
  fetch('/api/admin/vocab/lesson-words?l=' + l, { headers: authHeaders() })
    .then(r => r.json())
    .then(data => {
      if (!data.ok) return;
      const w = data.words.find(x => x.id === id);
      if (w) renderForm(w);
    })
    .catch(() => alert('Không tải được dữ liệu từ để sửa.'));
}

function cancelEditWord(l, id) {
  const w = lessonWordsCache[id];
  const row = document.getElementById(`word-row-${id}`);
  if (!row) return;
  if (w) row.outerHTML = renderWordRow(l, w);
  else loadLessonWords(l);
}

async function saveEditWord(id) {
  const resultEl = document.getElementById(`edit-word-result-${id}`);
  const hz = document.getElementById(`edit-hz-${id}`).value.trim();
  const py = document.getElementById(`edit-py-${id}`).value.trim();
  const vi = document.getElementById(`edit-vi-${id}`).value.trim();
  const l = parseInt(document.getElementById(`edit-l-${id}`).value, 10);
  const tag = document.getElementById(`edit-lyhop-${id}`).checked ? 'ly_hop' : null;
  const oldLesson = lessonWordsCache[id] ? lessonWordsCache[id].l : l;
  if (!hz || !vi || !Number.isFinite(l) || l < 1) {
    resultEl.textContent = 'Vui lòng nhập đủ Chữ Hán, Nghĩa và Số bài.';
    return;
  }
  resultEl.style.color = 'var(--muted)';
  resultEl.textContent = 'Đang lưu...';
  try {
    const res = await fetch('/api/admin/vocab/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ id, hz, py, vi, l, tag }),
    });
    const data = await res.json();
    if (!data.ok) { resultEl.style.color = '#c0392b'; resultEl.textContent = '❌ ' + (data.error || 'Có lỗi xảy ra'); return; }
    // Nếu đổi số bài, từ này chuyển sang bài khác — mở sẵn bài mới để thấy ngay kết quả
    if (oldLesson !== l) openLessonWords.add(l);
    loadVocabAdminList(); // nạp lại toàn bộ danh sách bài + tự mở lại các bài đang xem dở
    alert(`Đã lưu từ "${hz}". Tải lại trang để cập nhật dữ liệu học.`);
  } catch (e) {
    resultEl.style.color = '#c0392b';
    resultEl.textContent = '❌ Không kết nối được máy chủ: ' + e.message;
  }
}

async function deleteWord(l, id, hz) {
  if (!confirm(`Xoá từ "${hz}"? Không thể hoàn tác.`)) return;
  try {
    const res = await fetch('/api/admin/vocab/delete-word', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (!data.ok) { alert(data.error || 'Có lỗi xảy ra'); return; }
    loadVocabAdminList(); // nạp lại số đếm theo bài + tự mở lại đúng bài đang xem, cập nhật danh sách từ
  } catch (e) {
    alert('Không kết nối được máy chủ: ' + e.message);
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}
async function deleteLessonVocab(l) {
  if (!confirm(`Xoá toàn bộ từ vựng của Bài ${l}? Không thể hoàn tác.`)) return;
  try {
    const res = await fetch('/api/admin/vocab/delete-lesson', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ l }),
    });
    const data = await res.json();
    if (!data.ok) { alert(data.error || 'Có lỗi xảy ra'); return; }
    alert(`Đã xoá ${data.removed} từ của Bài ${l}. Tải lại trang để cập nhật màn hình chọn bài.`);
    openLessonWords.delete(l);
    loadVocabAdminList();
  } catch (e) {
    alert('Không kết nối được máy chủ: ' + e.message);
  }
}
async function addVocabManual() {
  const resultEl = document.getElementById('vocab-manual-result');
  const hz = document.getElementById('vocab-manual-hz').value.trim();
  const py = document.getElementById('vocab-manual-py').value.trim();
  const vi = document.getElementById('vocab-manual-vi').value.trim();
  const l = parseInt(document.getElementById('vocab-manual-l').value, 10);
  const tag = document.getElementById('vocab-manual-lyhop').checked ? 'ly_hop' : null;
  const overwrite = document.getElementById('vocab-manual-overwrite').checked;
  if (!hz || !vi || !Number.isFinite(l) || l < 1) {
    resultEl.textContent = 'Vui lòng nhập đủ Chữ Hán, Nghĩa và Số bài (số nguyên ≥ 1).';
    return;
  }
  resultEl.textContent = 'Đang thêm...';
  try {
    const res = await fetch('/api/admin/vocab/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ words: [{ hz, py, vi, l, tag }], overwrite }),
    });
    const data = await res.json();
    if (!data.ok) { resultEl.textContent = '❌ ' + (data.error || 'Có lỗi xảy ra'); return; }
    if (data.added > 0) {
      resultEl.innerHTML = `✅ Đã thêm từ <b>${hz}</b>. <span style="color:var(--l9a);">Tải lại trang để dùng ngay.</span>`;
      document.getElementById('vocab-manual-hz').value = '';
      document.getElementById('vocab-manual-py').value = '';
      document.getElementById('vocab-manual-vi').value = '';
      document.getElementById('vocab-manual-l').value = '';
      document.getElementById('vocab-manual-lyhop').checked = false;
      loadVocabAdminList();
    } else if (data.updated > 0) {
      resultEl.innerHTML = `✅ Đã cập nhật lại từ <b>${hz}</b> (bài ${l}). <span style="color:var(--l9a);">Tải lại trang để dùng ngay.</span>`;
    } else {
      resultEl.textContent = `⚠️ Từ "${hz}" ở bài ${l} đã tồn tại rồi. Tick ô "Ghi đè" nếu muốn cập nhật lại pinyin/nghĩa.`;
    }
  } catch (e) {
    resultEl.textContent = '❌ Không kết nối được máy chủ: ' + e.message;
  }
}
// Chuẩn hoá cột "tag" khi đọc file Excel — chấp nhận nhiều cách viết khác nhau (tiếng Việt có dấu,
// không dấu, hoặc chữ Hán) đều quy về 1 giá trị chuẩn duy nhất 'ly_hop' để web hiểu và hiển thị đúng.
function normalizeVocabTag(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (['ly_hop', 'lyhop', 'ly hợp', 'ly hop', 'động từ ly hợp', 'dong tu ly hop', '离合词', '离合动词']
      .some(x => s === x || s.includes('ly hợp') || s.includes('ly hop') || s.includes('离合'))) {
    return 'ly_hop';
  }
  return s; // giữ nguyên các loại tag khác trong tương lai, không chỉ riêng ly hợp
}
function downloadVocabTemplate() {
  const ws = XLSX.utils.json_to_sheet([
    { hz: '你好', py: 'nǐ hǎo', vi: 'xin chào', l: 1, tag: '' },
    { hz: '谢谢', py: 'xièxie', vi: 'cảm ơn', l: 1, tag: '' },
    { hz: '睡觉', py: 'shuìjiào', vi: 'ngủ', l: 1, tag: 'ly_hop' },
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Từ vựng');
  XLSX.writeFile(wb, 'mau-tu-vung.xlsx');
}
async function uploadVocabExcel() {
  const input = document.getElementById('vocab-file-input');
  const resultEl = document.getElementById('vocab-import-result');
  const file = input.files && input.files[0];
  if (!file) { resultEl.textContent = 'Chưa chọn file.'; return; }
  resultEl.textContent = 'Đang đọc file...';
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) { resultEl.textContent = 'File không có dữ liệu.'; return; }
    const words = rows.map(r => ({
      hz: String(r.hz ?? r['Chữ Hán'] ?? '').trim(),
      py: String(r.py ?? r['Pinyin'] ?? '').trim(),
      vi: String(r.vi ?? r['Nghĩa'] ?? '').trim(),
      l: parseInt(r.l ?? r['Bài'], 10),
      tag: normalizeVocabTag(r.tag ?? r['Loại từ'] ?? r['Nhãn'] ?? ''),
    }));
    resultEl.textContent = `Đang nhập ${words.length} dòng...`;
    const overwrite = document.getElementById('vocab-excel-overwrite').checked;
    const res = await fetch('/api/admin/vocab/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ words, overwrite }),
    });
    const data = await res.json();
    if (!data.ok) { resultEl.textContent = '❌ ' + (data.error || 'Có lỗi xảy ra'); return; }
    resultEl.innerHTML = `✅ Đã thêm <b>${data.added}</b> từ mới, cập nhật <b>${data.updated}</b> từ trùng. Bỏ qua ${data.skipped} từ trùng (chưa tick ghi đè), ${data.invalid} dòng thiếu dữ liệu.<br>Tổng số từ đã thêm qua Excel/thủ công: <b>${data.total}</b>.<br><span style="color:var(--l9a);">Tải lại trang để dùng ngay các từ mới.</span>`;
    loadVocabAdminList();
    input.value = '';
  } catch (e) {
    resultEl.textContent = '❌ Không đọc được file: ' + e.message;
  }
}
async function clearAllVocab() {
  if (!confirm('Xoá toàn bộ từ vựng đã thêm qua Excel/thủ công? Không thể hoàn tác. Bộ từ vựng gốc có sẵn của app sẽ KHÔNG bị ảnh hưởng.')) return;
  const resultEl = document.getElementById('vocab-clear-result');
  resultEl.textContent = 'Đang xoá...';
  try {
    const res = await fetch('/api/admin/vocab/clear', { method: 'POST', headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { resultEl.textContent = '❌ ' + (data.error || 'Có lỗi xảy ra'); return; }
    resultEl.innerHTML = `✅ Đã xoá ${data.removed} từ. <span style="color:var(--l9a);">Tải lại trang để cập nhật.</span>`;
    loadVocabAdminList();
  } catch (e) {
    resultEl.textContent = '❌ Không kết nối được máy chủ: ' + e.message;
  }
}
async function bindAdmin() {
  if (isGuest || !isAdminRole()) return;
  await adminLoadVisits();
  await adminLoadUsers();
}
async function adminLoadVisits() {
  const area = document.getElementById('visits-area');
  if (!area) return;
  try {
    const res = await fetch('/api/admin/visits', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { area.textContent = data.error || 'Không tải được thống kê.'; return; }
    const maxCount = Math.max(1, ...data.last14.map(d => d.count));
    const bars = data.last14.map(d => {
      const h = Math.round(d.count / maxCount * 60);
      const label = d.date.slice(5); // MM-DD
      return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;">
        <div style="font-size:.68rem;font-weight:800;color:var(--l9a);">${d.count}</div>
        <div style="width:100%;max-width:18px;height:${Math.max(h,2)}px;background:var(--l9a);border-radius:3px 3px 0 0;"></div>
        <div style="font-size:.62rem;color:var(--muted);">${label}</div>
      </div>`;
    }).join('');
    area.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px;text-align:center;">
        <div><div style="font-size:1.4rem;font-weight:900;color:var(--l9a);">${data.total}</div><div style="font-size:.72rem;color:var(--muted);">Tổng lượt truy cập</div></div>
        <div><div style="font-size:1.4rem;font-weight:900;color:var(--l8a);">${data.today}</div><div style="font-size:.72rem;color:var(--muted);">Hôm nay</div></div>
        <div><div style="font-size:1.4rem;font-weight:900;color:var(--l11a);">${data.totalUsers}</div><div style="font-size:.72rem;color:var(--muted);">Tổng tài khoản</div></div>
      </div>
      <div style="font-size:.72rem;color:var(--muted);margin-bottom:6px;">14 ngày gần nhất</div>
      <div style="display:flex;align-items:flex-end;gap:4px;padding:6px 2px;">${bars}</div>
    `;
  } catch {
    area.textContent = 'Không kết nối được máy chủ.';
  }
}
async function adminLoadUsers() {
  const area = document.getElementById('admin-area');
  if (!area) return;
  area.textContent = 'Đang tải danh sách...';
  try {
    const res = await fetch('/api/admin/users', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { area.textContent = data.error || 'Không tải được danh sách.'; return; }
    area.innerHTML = `<div style="font-size:.78rem;color:var(--muted);margin-bottom:10px;">Tổng ${data.users.length} tài khoản</div>` +
      data.users.map(u => {
        const roleBadge = u.role === 'superadmin'
          ? '<span style="background:var(--l15c);color:var(--l15a);font-size:.68rem;font-weight:800;padding:2px 7px;border-radius:8px;margin-left:6px;">👑 SUPERADMIN</span>'
          : u.role === 'admin'
          ? '<span style="background:var(--l11c);color:var(--l11a);font-size:.68rem;font-weight:800;padding:2px 7px;border-radius:8px;margin-left:6px;">ADMIN</span>'
          : '';
        const canDelete = u.role !== 'superadmin';
        const canReset = u.role !== 'superadmin' || currentRole === 'superadmin';
        const canToggleRole = currentRole === 'superadmin' && u.role !== 'superadmin';
        return `
      <div style="border:1.5px solid #eee;border-radius:12px;padding:10px 12px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <b>${u.username}</b>
            ${roleBadge}
          </div>
          <div style="font-size:.8rem;color:var(--muted);">📚 ${Math.round(u.known/WORDS.length*100)}% (${u.known}/${WORDS.length} từ) · 🔥${u.streak}</div>
        </div>
        <div style="font-size:.72rem;color:var(--muted);margin:4px 0 8px;">Tạo lúc: ${new Date(u.createdAt).toLocaleString('vi-VN')}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${canReset ? `<button class="btn btn-sm" style="background:var(--l9c);color:var(--l9a);" onclick="adminResetUser('${escapeJsAttr(u.key)}','${escapeJsAttr(u.username)}')">🔄 Reset tiến độ</button>` : ''}
          ${canToggleRole ? `<button class="btn btn-sm" style="background:var(--l11c);color:var(--l11a);" onclick="adminToggleRole('${escapeJsAttr(u.key)}','${escapeJsAttr(u.role)}')">${u.role==='admin' ? '⬇️ Bỏ quyền admin' : '⬆️ Cấp quyền admin'}</button>` : ''}
          ${canDelete ? `<button class="btn btn-sm" style="background:#fdecea;color:#c0392b;" onclick="adminDeleteUser('${escapeJsAttr(u.key)}','${escapeJsAttr(u.username)}')">🗑️ Xoá tài khoản</button>` : '<span style="font-size:.72rem;color:var(--muted);align-self:center;">🔒 Được bảo vệ</span>'}
        </div>
      </div>`;
      }).join('');
  } catch {
    area.textContent = 'Không kết nối được máy chủ.';
  }
}
async function adminResetUser(key, username) {
  if (!confirm(`Reset toàn bộ tiến độ học của "${username}"? Không thể hoàn tác.`)) return;
  const res = await fetch(`/api/admin/users/${key}/reset`, { method:'POST', headers: authHeaders() });
  const data = await res.json();
  if (!data.ok) alert(data.error || 'Có lỗi xảy ra');
  adminLoadUsers();
}
async function adminDeleteUser(key, username) {
  if (!confirm(`Xoá vĩnh viễn tài khoản "${username}"? Không thể hoàn tác.`)) return;
  const res = await fetch(`/api/admin/users/${key}/delete`, { method:'POST', headers: authHeaders() });
  const data = await res.json();
  if (!data.ok) alert(data.error || 'Có lỗi xảy ra');
  adminLoadUsers();
}
async function adminToggleRole(key, currentR) {
  const newRole = currentR === 'admin' ? 'user' : 'admin';
  const res = await fetch(`/api/admin/users/${key}/role`, {
    method:'POST',
    headers: { 'Content-Type':'application/json', ...authHeaders() },
    body: JSON.stringify({ role: newRole }),
  });
  const data = await res.json();
  if (!data.ok) alert(data.error || 'Có lỗi xảy ra');
  adminLoadUsers();
}

