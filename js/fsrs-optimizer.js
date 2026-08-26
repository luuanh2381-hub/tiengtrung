// js/fsrs-optimizer.js — FSRS Personal Optimizer (V82)
// ════════════════════════════════════════════════════
// Modal tự phục vụ cho CHÍNH user đang đăng nhập (giống tinh thần js/settings.js — tự thao tác trên
// tài khoản của mình). Toàn bộ TÍNH TOÁN thật (data quality/train/evaluate/apply/rollback) nằm ở
// server (lib/fsrs/optimizer.js) — file này chỉ gọi API + render, KHÔNG tự tính bất kỳ điểm số nào.
// Không cần dashboard riêng: dùng LẠI đúng .dash-kpi* (js/stats.js) và .auth-*/.btn (mọi modal khác).
// ════════════════════════════════════════════════════
let _optimizerBusy = false;

function openOptimizerModal() {
  if (!isLoggedIn()) return;
  document.getElementById('optimizer-modal').style.display = 'flex';
  loadOptimizerStatus();
}
function closeOptimizerModal() {
  document.getElementById('optimizer-modal').style.display = 'none';
}

function ofmtPct(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
}
function ofmtScore(x) {
  return (x === null || x === undefined || !Number.isFinite(x)) ? '—' : Number(x).toFixed(4);
}
function ofmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
  catch { return '—'; }
}

const OPTIMIZER_READINESS_LABEL = {
  NOT_READY: { icon: '⛔', label: 'Chưa đủ dữ liệu', color: 'var(--fail)' },
  READY: { icon: '🟡', label: 'Sẵn sàng (nên thận trọng)', color: 'var(--l7a)' },
  OPTIMIZABLE: { icon: '🟢', label: 'Sẵn sàng tối ưu', color: 'var(--ok)' },
};

// V83-FIX-v3 (Phần 7) — 4 trạng thái engine tường minh, KHÔNG gộp chung 1 chữ "chưa sẵn sàng" mơ
// hồ giữa native/WASI/unavailable — engineStatus đầy đủ nằm trong s.engineStatus (chỉ hiện chi tiết
// kỹ thuật cho admin, xem renderOptimizerBody bên dưới).
const OPTIMIZER_ENGINE_LABEL = {
  OPTIMIZER_NATIVE_READY: { icon: '⚙️', label: 'Engine: Native (nhanh nhất)', color: 'var(--ok)' },
  OPTIMIZER_WASI_READY: { icon: '🧩', label: 'Engine: WASI (fallback chính thức)', color: 'var(--l7a)' },
  OPTIMIZER_READY: { icon: '✅', label: 'Engine: sẵn sàng', color: 'var(--ok)' },
  OPTIMIZER_UNAVAILABLE: { icon: '⚠️', label: 'Engine: chưa sẵn sàng', color: 'var(--fail)' },
};

async function loadOptimizerStatus() {
  const body = document.getElementById('optimizer-body');
  if (!body) return;
  try {
    const res = await fetch('/api/fsrs-optimizer/status', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { body.innerHTML = `<div class="study-empty">⚠️ ${data.error || 'Không tải được'}</div>`; return; }
    renderOptimizerBody(data);
  } catch (e) {
    body.innerHTML = `<div class="study-empty">⚠️ Không kết nối được máy chủ: ${e.message}</div>`;
  }
}

function renderOptimizerBody(s) {
  const body = document.getElementById('optimizer-body');
  const r = s.report || {};
  const readinessInfo = OPTIMIZER_READINESS_LABEL[(s.readiness && s.readiness.status) || 'NOT_READY'] || OPTIMIZER_READINESS_LABEL.NOT_READY;
  const meta = s.candidateMeta || null;
  const isRunning = s.status === 'running';

  let html = '';

  // ── Data quality (Phần 14/20) ──
  html += `<div class="dash-kpi-grid" style="margin-bottom:10px;">
    <div class="dash-kpi"><div class="dash-kpi-num">📊 ${r.validReviews ?? 0}</div><div class="dash-kpi-lbl">Review hợp lệ</div><div class="dash-kpi-sub">/ ${r.totalReviews ?? 0} tổng</div></div>
    <div class="dash-kpi"><div class="dash-kpi-num">🗂️ ${r.uniqueCards ?? 0}</div><div class="dash-kpi-lbl">Số thẻ</div></div>
    <div class="dash-kpi"><div class="dash-kpi-num">📅 ${r.dateRange ? r.dateRange.days : 0}</div><div class="dash-kpi-lbl">Ngày trải dài</div></div>
    <div class="dash-kpi"><div class="dash-kpi-num">🔁 ${r.duplicates ?? 0}</div><div class="dash-kpi-lbl">Trùng lặp</div></div>
  </div>`;

  html += `<div style="text-align:center;font-weight:800;font-size:.82rem;margin-bottom:4px;color:${readinessInfo.color};">${readinessInfo.icon} ${readinessInfo.label}</div>`;
  html += `<div style="color:var(--muted);font-size:.74rem;text-align:center;margin-bottom:14px;line-height:1.5;">${(s.readiness && s.readiness.reason) || ''}</div>`;

  // Diagnostic (Phần 7/11): optimizer engine (native/WASI "@open-spaced-repetition/binding") chưa
  // load được trên server → báo rõ NGAY, không để user bấm Run rồi mới nhận lỗi mơ hồ. Người dùng
  // thường chỉ thấy thông báo chung; ADMIN thấy thêm root cause kỹ thuật ngắn gọn (Phần 7).
  const bindingUnavailable = s.bindingAvailable === false;
  const engineInfo = OPTIMIZER_ENGINE_LABEL[s.optimizerEngineState] || null;
  if (bindingUnavailable) {
    html += `<div style="background:#fff3f0;border:1px solid var(--fail);border-radius:12px;padding:10px 12px;margin-bottom:12px;font-size:.74rem;line-height:1.5;color:var(--fail);">
      ⚠️ Optimizer engine chưa sẵn sàng trên máy chủ (thiếu/không load được dependency chính thức).
      Đây là lỗi triển khai (deployment), không phải lỗi dữ liệu của bạn — vui lòng báo quản trị viên.
      ${(typeof isAdminRole === 'function' && isAdminRole() && s.engineStatus) ? `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--fail);font-family:monospace;font-size:.66rem;word-break:break-word;">
        <b>[Chỉ admin thấy] Root cause:</b> ${(s.engineStatus.error || '').slice(0, 300)}<br>
        node=${s.engineStatus.nodeVersion} platform=${s.engineStatus.platform} arch=${s.engineStatus.arch}${s.engineStatus.glibcVersion ? ' glibc=' + s.engineStatus.glibcVersion : ''}<br>
        native gói kỳ vọng: ${s.engineStatus.nativeBinary || '—'}
      </div>` : ''}
    </div>`;
  } else if (engineInfo) {
    html += `<div style="text-align:center;font-size:.66rem;color:${engineInfo.color};margin-bottom:10px;">${engineInfo.icon} ${engineInfo.label}</div>`;
  }

  // ── Đang dùng weights nào ──
  html += `<div style="background:var(--paper);border-radius:12px;padding:10px 12px;margin-bottom:12px;font-size:.8rem;">
    <div style="display:flex;justify-content:space-between;${s.personalWeightsEnabled ? 'margin-bottom:4px;' : ''}"><span style="color:var(--muted);">Đang dùng</span><b>${s.personalWeightsEnabled ? '🧠 Weights cá nhân' : '⚙️ Weights mặc định'}</b></div>
    ${s.personalWeightsEnabled ? `<div style="display:flex;justify-content:space-between;"><span style="color:var(--muted);">Áp dụng lúc</span><span>${ofmtDate(s.appliedAt)}</span></div>` : ''}
  </div>`;

  // ── Kết quả lần chạy Optimizer gần nhất (Phần 6/7) ──
  if (meta) {
    const recommendBadge = meta.recommend
      ? `<span style="color:var(--ok);font-weight:800;">✅ Nên áp dụng</span>`
      : `<span style="color:var(--muted);font-weight:800;">➖ Chưa tốt hơn đáng kể</span>`;
    html += `<div class="panel-title" style="margin:4px 0 8px;">Kết quả lần chạy gần nhất</div>
    <div class="dash-kpi-grid" style="margin-bottom:8px;">
      <div class="dash-kpi"><div class="dash-kpi-num">${ofmtScore(meta.defaultScore)}</div><div class="dash-kpi-lbl">Default (log-loss)</div></div>
      <div class="dash-kpi"><div class="dash-kpi-num">${ofmtScore(meta.personalScore)}</div><div class="dash-kpi-lbl">Cá nhân (log-loss)</div></div>
    </div>
    <div style="text-align:center;font-size:.85rem;margin-bottom:6px;">Cải thiện trên validation: <b>${ofmtPct(meta.improvement)}</b></div>
    <div style="text-align:center;margin-bottom:10px;">${recommendBadge}</div>
    <div style="color:var(--muted);font-size:.66rem;text-align:center;margin-bottom:12px;">Train ${meta.trainCards ?? '—'} thẻ / Validation ${meta.validationCards ?? '—'} thẻ${meta.optimizerVersion ? ' · optimizer v' + meta.optimizerVersion : ''}</div>`;
  }

  html += `<div id="optimizer-error" class="auth-error"></div>`;

  // ── Nút hành động (Phần 14/15) ──
  html += `<button class="auth-submit" id="optimizer-run-btn" onclick="runOptimizerNow()" ${(isRunning || bindingUnavailable) ? 'disabled' : ''}>${isRunning ? '⏳ Đang chạy...' : (bindingUnavailable ? '⚠️ Optimizer chưa sẵn sàng' : '🚀 Run Optimizer')}</button>`;
  if (s.hasCandidate && !isRunning) {
    html += `<button class="auth-submit" style="margin-top:8px;background:var(--ok);" onclick="applyOptimizerWeights()">✅ Apply Personal Weights</button>`;
  }
  if (s.personalWeightsEnabled && !isRunning) {
    html += `<button class="auth-submit" style="margin-top:8px;background:var(--l7a);box-shadow:0 4px 0 #b25f22;" onclick="resetOptimizerWeights()">↩️ Reset to Default</button>`;
  }
  if (s.canRollback && !isRunning) {
    html += `<button class="auth-submit" style="margin-top:8px;background:var(--l15a);" onclick="rollbackOptimizerWeights()">⏮️ Rollback</button>`;
  }
  if (s.lastError) {
    html += `<div style="color:var(--fail);font-size:.7rem;text-align:center;margin-top:10px;line-height:1.4;">⚠️ Lỗi lần chạy trước: ${s.lastError}</div>`;
  }

  body.innerHTML = html;
}

function showOptimizerError(msg) {
  const errEl = document.getElementById('optimizer-error');
  if (!errEl) return;
  errEl.textContent = msg;
  errEl.classList.add('show');
}

// Phần 15: khoá nút ngay khi bấm, không cho double click / chạy song song từ CHÍNH tab này (server
// vẫn có lock riêng ở lib/fsrs/optimizer.js:claimOptimizerRun cho trường hợp nhiều tab/thiết bị).
//
// V83-FIX-v4 — sửa 2 bug thật thấy được trên production:
//   1) Nút kẹt mãi ở "⏳ Đang chạy..." sau 1 lỗi mạng/parse — vì nhánh catch cũ KHÔNG gọi lại
//      loadOptimizerStatus() (chỉ có loadOptimizerStatus() mới render lại nút về trạng thái bình
//      thường). Nay LUÔN gọi loadOptimizerStatus() ở finally, bất kể thành công/thất bại kiểu gì.
//   2) Nếu gọi loadOptimizerStatus() TRƯỚC showOptimizerError(), lỗi vừa hiện sẽ bị XOÁ MẤT ngay lập
//      tức — vì renderOptimizerBody() tạo lại <div id="optimizer-error"> RỖNG mỗi lần render (xem
//      trên). Nay đổi thứ tự: load status XONG rồi mới hiện lỗi vào div MỚI vừa được tạo.
async function runOptimizerNow() {
  if (_optimizerBusy) return;
  _optimizerBusy = true;
  const btn = document.getElementById('optimizer-run-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Đang chạy... (vài giây, đừng đóng modal)'; }
  let errorMsg = null;
  try {
    const res = await fetch('/api/fsrs-optimizer/run', { method: 'POST', headers: authHeaders() });
    // Đọc dạng text TRƯỚC: nếu server/hạ tầng (Vercel) trả về response KHÔNG PHẢI JSON — thường do
    // function bị timeout hoặc crash ở tầng platform (SIGKILL giữa chừng, vượt ngoài try/catch của
    // chính app — app LUÔN trả JSON cho mọi lỗi bắt được bình thường, xem api/index.js:fail()) —
    // báo nguyên nhân khả dĩ dễ hiểu, không chỉ lộ ra "Unexpected token" khó hiểu.
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* xử lý bên dưới */ }
    if (!data) {
      errorMsg = (res.ok ? '' : `Server trả về lỗi HTTP ${res.status}, `) +
        'phản hồi không đúng định dạng JSON — thường do function bị timeout hoặc crash ở tầng hạ ' +
        'tầng (Vercel), không phải lỗi ứng dụng có thể xử lý bình thường. Vào Vercel Dashboard → ' +
        'Deployments → (bản mới nhất) → Logs để xem nguyên nhân thật.' +
        (raw ? ` [Đầu phản hồi: "${raw.slice(0, 100)}"]` : '');
    } else if (!data.ok) {
      errorMsg = data.error || 'Có lỗi xảy ra';
    }
  } catch (e) {
    // fetch() tự nó throw (mất mạng hoàn toàn...) — khác "có response nhưng không phải JSON" ở trên.
    errorMsg = 'Lỗi kết nối: ' + e.message;
  } finally {
    _optimizerBusy = false;
    await loadOptimizerStatus(); // LUÔN refresh — nút hết kẹt ở "Đang chạy...", số liệu luôn đúng thực tế server.
    if (errorMsg) showOptimizerError(errorMsg); // gọi SAU loadOptimizerStatus() — xem giải thích (2) ở trên.
  }
}

async function applyOptimizerWeights() {
  if (!confirm('Áp dụng weights cá nhân?\n\nLịch ôn tập/thống kê hiện tại KHÔNG bị reset — chỉ ảnh hưởng cách tính lịch cho các lượt ôn TIẾP THEO.')) return;
  await postOptimizerAction('/api/fsrs-optimizer/apply');
}
async function rollbackOptimizerWeights() {
  if (!confirm('Khôi phục về trạng thái weights TRƯỚC lần Apply/Reset gần nhất?')) return;
  await postOptimizerAction('/api/fsrs-optimizer/rollback');
}
async function resetOptimizerWeights() {
  if (!confirm('Quay lại dùng weights MẶC ĐỊNH (chung, không cá nhân hoá)?')) return;
  await postOptimizerAction('/api/fsrs-optimizer/reset');
}

async function postOptimizerAction(url) {
  if (_optimizerBusy) return;
  _optimizerBusy = true;
  let errorMsg = null;
  try {
    const res = await fetch(url, { method: 'POST', headers: authHeaders() });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* xử lý bên dưới */ }
    if (!data) {
      errorMsg = (res.ok ? '' : `Server trả về lỗi HTTP ${res.status}, `) +
        'phản hồi không đúng định dạng JSON (có thể do timeout/crash hạ tầng).' +
        (raw ? ` [Đầu phản hồi: "${raw.slice(0, 100)}"]` : '');
    } else if (!data.ok) {
      errorMsg = data.error || 'Có lỗi xảy ra';
    }
  } catch (e) {
    errorMsg = 'Lỗi kết nối: ' + e.message;
  } finally {
    _optimizerBusy = false;
    await loadOptimizerStatus(); // xem giải thích thứ tự ở runOptimizerNow() phía trên
    if (errorMsg) showOptimizerError(errorMsg);
  }
}
