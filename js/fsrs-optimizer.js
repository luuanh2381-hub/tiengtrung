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
  html += `<button class="auth-submit" id="optimizer-run-btn" onclick="runOptimizerNow()" ${isRunning ? 'disabled' : ''}>${isRunning ? '⏳ Đang chạy...' : '🚀 Run Optimizer'}</button>`;
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
async function runOptimizerNow() {
  if (_optimizerBusy) return;
  _optimizerBusy = true;
  const btn = document.getElementById('optimizer-run-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Đang chạy... (vài giây, đừng đóng modal)'; }
  try {
    const res = await fetch('/api/fsrs-optimizer/run', { method: 'POST', headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { showOptimizerError(data.error || 'Có lỗi xảy ra'); await loadOptimizerStatus(); return; }
    await loadOptimizerStatus();
  } catch (e) {
    showOptimizerError('Lỗi kết nối: ' + e.message);
  } finally {
    _optimizerBusy = false;
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
  try {
    const res = await fetch(url, { method: 'POST', headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { showOptimizerError(data.error || 'Có lỗi xảy ra'); return; }
    await loadOptimizerStatus();
  } catch (e) {
    showOptimizerError('Lỗi kết nối: ' + e.message);
  } finally {
    _optimizerBusy = false;
  }
}
