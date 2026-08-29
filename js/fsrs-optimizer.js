// js/fsrs-optimizer.js — FSRS Personal Optimizer (V82, kiến trúc bất đồng bộ từ V85)
// ════════════════════════════════════════════════════
// Modal tự phục vụ cho CHÍNH user đang đăng nhập (giống tinh thần js/settings.js — tự thao tác trên
// tài khoản của mình). Toàn bộ TÍNH TOÁN thật (data quality/train/evaluate/apply/rollback) nằm ở
// server (lib/fsrs/optimizer.js) — file này chỉ gọi API + render, KHÔNG tự tính bất kỳ điểm số nào.
// Không cần dashboard riêng: dùng LẠI đúng .dash-kpi* (js/stats.js) và .auth-*/.btn (mọi modal khác).
//
// V85 — THAY ĐỔI KIẾN TRÚC QUAN TRỌNG: POST /run giờ chỉ TẠO JOB và trả về NGAY (không còn đợi cả
// pipeline train chạy xong trong 1 request HTTP nữa — xem api/index.js + lib/fsrs/optimizer.js).
// File này giờ có thêm 1 trách nhiệm mới: POLL GET /api/fsrs-optimizer/status định kỳ trong lúc job
// đang queued/running để hiện TIẾN ĐỘ THẬT (Queued → Loading reviews → Preparing data → Training →
// Evaluating → Saving → Completed/Failed), KHÔNG bao giờ hiện "Đang chạy..." bất động vĩnh viễn.
// Đóng modal KHÔNG huỷ job (job chạy độc lập ở server) — chỉ dừng polling ở TAB này để đỡ tốn request;
// mở lại modal (hoặc tải lại trang rồi mở modal) luôn gọi lại GET /status để khôi phục ĐÚNG trạng thái
// thật từ DB, không dựa vào biến JS tạm nào cả.
// ════════════════════════════════════════════════════
let _optimizerBusy = false;
let _optimizerPollTimer = null;
const OPTIMIZER_POLL_MS = 2000;

function openOptimizerModal() {
  if (!isLoggedIn()) return;
  document.getElementById('optimizer-modal').style.display = 'flex';
  loadOptimizerStatus();
}
function closeOptimizerModal() {
  document.getElementById('optimizer-modal').style.display = 'none';
  stopOptimizerPolling(); // Job VẪN chạy tiếp ở server — chỉ dừng poll ở tab này để đỡ tốn request.
}

function stopOptimizerPolling() {
  if (_optimizerPollTimer) { clearInterval(_optimizerPollTimer); _optimizerPollTimer = null; }
}
// Chỉ poll khi modal đang MỞ (đỡ tốn request khi user không nhìn) — job vẫn tiếp tục ở server dù có
// poll hay không; mở lại modal sẽ tự phát hiện lại đúng trạng thái qua loadOptimizerStatus().
function ensureOptimizerPolling(shouldPoll) {
  const modalOpen = document.getElementById('optimizer-modal').style.display !== 'none';
  if (shouldPoll && modalOpen) {
    if (!_optimizerPollTimer) _optimizerPollTimer = setInterval(loadOptimizerStatus, OPTIMIZER_POLL_MS);
  } else {
    stopOptimizerPolling();
  }
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

// (V87: bảng nhãn engine 4-trạng-thái cũ đã được thay bằng checkOptimizerEngineDiagnostics() —
// GET /status không còn tự thăm dò engine nữa, xem AUDIT-REPORT-V87-FAILED-TO-FETCH.md)

// V85 — nhãn TIẾN ĐỘ THẬT (Phần "PROGRESS") — khớp đúng thứ tự stage mà worker thật sự đi qua
// (lib/fsrs/optimizer.js:runOptimizerJob). KHÔNG có nhãn nào là fake/nội suy.
const OPTIMIZER_STAGE_LABEL = {
  queued: '🕓 Trong hàng đợi...',
  loading_reviews: '📥 Đang tải lịch sử ôn tập...',
  preparing_data: '🧮 Đang kiểm tra chất lượng dữ liệu...',
  // V86: checkpoint giữa 2 bước (Phần VI) — dữ liệu train đã chuẩn bị xong, đang chờ (hoặc vừa được
  // kích hoạt lại) bước train — KHÔNG phải lỗi, chỉ là ranh giới giữa 2 invocation.
  prepared: '🧮 Đã chuẩn bị xong dữ liệu, đang tiếp tục...',
  training: '🧠 Đang train (optimizer chính thức)...',
  evaluating: '📊 Đang đánh giá default vs cá nhân...',
  saving: '💾 Đang lưu kết quả...',
  completed: '✅ Hoàn tất',
  failed: '⚠️ Thất bại',
};

// V87 (Phần IV) — GET /diagnostics chỉ gọi khi ADMIN CHỦ ĐỘNG bấm nút (KHÔNG BAO GIỜ tự động/định kỳ
// — khác hẳn loadOptimizerStatus()). ?probe=1 nghĩa là chấp nhận rủi ro thật (Phần XIII — nếu native
// binary hỏng tới mức crash process, CHÍNH lượt gọi này có thể làm 1 invocation chết — nhưng chỉ ảnh
// hưởng admin đang bấm, không ảnh hưởng user thường vì route này tách biệt hoàn toàn khỏi /status).
async function checkOptimizerEngineDiagnostics() {
  const el = document.getElementById('optimizer-diag-result');
  if (!el) return;
  el.textContent = '⏳ Đang kiểm tra (probe=1 — có gọi thật native binding)...';
  let res;
  try {
    res = await fetch('/api/fsrs-optimizer/diagnostics?probe=1', { headers: authHeaders() });
  } catch (e) {
    console.error('[fsrs-optimizer] diagnostics network error', { url: '/api/fsrs-optimizer/diagnostics', method: 'GET', name: e.name, message: e.message });
    el.textContent = `⚠️ Không kết nối được máy chủ khi kiểm tra engine (${e.message}) — nếu vừa PASS trước đó rồi mất kết nối ngay lúc probe, có thể native binary vừa làm crash worker này, hãy thử tải lại trang.`;
    return;
  }
  let data = null;
  try { data = await res.json(); } catch { /* để lại data=null, xử lý bên dưới */ }
  if (!data || !data.ok) {
    el.textContent = `⚠️ ${(data && data.error) || ('Lỗi server (mã ' + res.status + ')')}`;
    return;
  }
  const d = data.diagnostics;
  const state = !d.probed ? 'chưa probe'
    : !d.available ? 'KHÔNG khả dụng'
    : d.engine === 'native' ? 'Native ✅'
    : d.engine === 'wasi' ? 'WASI ✅'
    : 'sẵn sàng (không rõ engine)';
  el.innerHTML = `Engine: <b>${state}</b> · package=${d.packageVersion || '—'} (resolvable=${d.packageResolvable}) · node=${d.node} ${d.platform}/${d.arch}${d.glibc ? ' glibc=' + d.glibc : ''}` +
    (d.loadError ? `<br><span style="color:var(--fail);">${String(d.loadError).slice(0, 300)}</span>` : '');
}

async function loadOptimizerStatus() {
  const body = document.getElementById('optimizer-body');
  if (!body) return;
  let res;
  try {
    res = await fetch('/api/fsrs-optimizer/status', { headers: authHeaders() });
  } catch (e) {
    // V87 (Phần XVII) — fetch() TỰ THROW (TypeError, vd "Failed to fetch") nghĩa là KHÔNG CÓ response
    // nào tới được ở tầng mạng (mất mạng/DNS/CORS/server không phản hồi TCP) — CHỈ trường hợp NÀY mới
    // đúng là "không kết nối được máy chủ". Không log token — chỉ log tên/thông điệp lỗi + URL/method.
    console.error('[fsrs-optimizer] network error', { url: '/api/fsrs-optimizer/status', method: 'GET', name: e.name, message: e.message });
    body.innerHTML = `<div class="study-empty">⚠️ Không kết nối được máy chủ (mất mạng hoặc server không phản hồi). Thử tải lại trang.</div>`;
    return;
  }

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    // Có HTTP response THẬT (res.status cụ thể) nhưng body không phải JSON hợp lệ — lỗi SERVER, khác
    // hẳn lỗi mạng — KHÔNG được gộp chung thành "Không kết nối được máy chủ" (Phần XVII).
    console.error('[fsrs-optimizer] non-JSON response', { url: '/api/fsrs-optimizer/status', status: res.status });
    body.innerHTML = `<div class="study-empty">⚠️ Lỗi server (phản hồi không hợp lệ, mã ${res.status}). Thử tải lại trang.</div>`;
    return;
  }

  if (res.status === 401 || !data.ok) {
    body.innerHTML = `<div class="study-empty">⚠️ ${data.error || (res.status === 401 ? 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.' : ('Lỗi server (mã ' + res.status + ')'))}</div>`;
    stopOptimizerPolling();
    return;
  }

  renderOptimizerBody(data);
  const isActive = data.status === 'queued' || data.status === 'running';
  ensureOptimizerPolling(isActive);
}

function renderOptimizerBody(s) {
  const body = document.getElementById('optimizer-body');
  const r = s.report || {};
  const readinessInfo = OPTIMIZER_READINESS_LABEL[(s.readiness && s.readiness.status) || 'NOT_READY'] || OPTIMIZER_READINESS_LABEL.NOT_READY;
  const meta = s.candidateMeta || null;
  const isQueued = s.status === 'queued';
  const isRunning = s.status === 'running';
  const isActive = isQueued || isRunning;
  const isFailed = s.status === 'failed';

  let html = '';

  // ── V85: dải TIẾN ĐỘ THẬT khi job đang queued/running (Phần "PROGRESS" — thay hẳn "Đang chạy..."
  //     bất động cũ). Ẩn hẳn khối này khi job không active để không chiếm chỗ vô ích. ──
  if (isActive && s.job) {
    const stageLabel = OPTIMIZER_STAGE_LABEL[s.job.stage] || OPTIMIZER_STAGE_LABEL[isQueued ? 'queued' : 'loading_reviews'];
    // V86 (Phần XV) — job đang được TỰ ĐỘNG THỬ LẠI (attempt>1, xem recoverStaleJobsForUser/
    // failOrRequeue ở lib/fsrs/optimizer.js) vẫn ở status queued/running BÌNH THƯỜNG — KHÔNG BAO GIỜ
    // hiện "thất bại"/"worker đã chết" trong lúc đang tự phục hồi. Chỉ thêm 1 dòng phụ cho biết.
    const isRetrying = Number(s.job.attempt) > 1;
    const retryNote = isRetrying
      ? `<div style="color:var(--muted);font-size:.72rem;text-align:center;margin-top:2px;">🔁 Đang thử lại (lần ${s.job.attempt}/${s.job.maxAttempts || 3}) sau 1 sự cố hạ tầng tạm thời...</div>`
      : '';
    const prog = s.job.progress;
    const progText = (prog && Number.isFinite(prog.current) && Number.isFinite(prog.total) && prog.total > 0)
      ? ` (${prog.current}/${prog.total})` : '';
    const pct = (prog && Number.isFinite(prog.current) && Number.isFinite(prog.total) && prog.total > 0)
      ? Math.min(100, Math.round((prog.current / prog.total) * 100)) : (isQueued ? 5 : null);
    html += `<div style="background:var(--paper);border-radius:12px;padding:12px 14px;margin-bottom:12px;">
      <div style="font-weight:800;font-size:.85rem;text-align:center;margin-bottom:8px;">${stageLabel}${progText}</div>
      <div style="height:8px;border-radius:6px;background:rgba(0,0,0,.08);overflow:hidden;">
        <div style="height:100%;border-radius:6px;background:var(--ok);transition:width .4s;width:${pct === null ? '35' : pct}%;${pct === null ? 'animation:optimizer-indeterminate 1.4s ease-in-out infinite;' : ''}"></div>
      </div>
      ${retryNote}
      <div style="color:var(--muted);font-size:.68rem;text-align:center;margin-top:8px;">Bạn có thể đóng cửa sổ này — job vẫn tiếp tục chạy, mở lại để xem tiếp.</div>
    </div>
    <style>@keyframes optimizer-indeterminate{0%{margin-left:0%;}50%{margin-left:55%;}100%{margin-left:0%;}}</style>`;
  }

  // ── Data quality (Phần 14/20) — nếu chỉ là ước tính (chưa từng Run) thì ghi rõ, không nhận vơ là số chính xác. ──
  html += `<div class="dash-kpi-grid" style="margin-bottom:${r.approximate ? '2px' : '10px'};">
    <div class="dash-kpi"><div class="dash-kpi-num">📊 ${r.validReviews ?? 0}</div><div class="dash-kpi-lbl">Review hợp lệ</div><div class="dash-kpi-sub">/ ${r.totalReviews ?? 0} tổng</div></div>
    <div class="dash-kpi"><div class="dash-kpi-num">🗂️ ${r.uniqueCards ?? 0}</div><div class="dash-kpi-lbl">Số thẻ</div></div>
    <div class="dash-kpi"><div class="dash-kpi-num">📅 ${r.dateRange ? r.dateRange.days : 0}</div><div class="dash-kpi-lbl">Ngày trải dài</div></div>
    <div class="dash-kpi"><div class="dash-kpi-num">🔁 ${r.duplicates ?? 0}</div><div class="dash-kpi-lbl">Trùng lặp</div></div>
  </div>`;
  if (r.approximate) {
    html += `<div style="color:var(--muted);font-size:.64rem;text-align:center;margin-bottom:10px;">(Ước tính nhanh — số chính xác sẽ có ngay sau khi Run)</div>`;
  }

  html += `<div style="text-align:center;font-weight:800;font-size:.82rem;margin-bottom:4px;color:${readinessInfo.color};">${readinessInfo.icon} ${readinessInfo.label}</div>`;
  html += `<div style="color:var(--muted);font-size:.74rem;text-align:center;margin-bottom:14px;line-height:1.5;">${(s.readiness && s.readiness.reason) || ''}</div>`;

  // V87 (Phần IV/XVII) — GET /status KHÔNG còn thăm dò native optimizer nữa (đã sửa tận gốc bug
  // "Failed to fetch" — xem lib/fsrs/optimizer.js:getOptimizerStatus + AUDIT-REPORT-V87-FAILED-TO-
  // FETCH.md). s.bindingAvailable/s.optimizerEngineState giờ LUÔN null/'UNKNOWN' trừ khi có ai đó CHỦ
  // ĐỘNG gọi GET /diagnostics (admin, xem checkOptimizerEngineDiagnostics() bên dưới) — vì vậy KHÔNG
  // còn hiện cảnh báo "Engine chưa sẵn sàng" tự động ở đây nữa (trước đây có thể HIỆN SAI nếu chính
  // request lấy trạng thái engine đó làm hỏng cả status — nghịch lý cần tránh). Admin có nút riêng để
  // tự kiểm tra khi cần (có rủi ro thật nếu native binary hỏng — Phần XIII — nên KHÔNG tự động).
  if (isAdminRole()) {
    html += `<div style="text-align:center;margin-bottom:10px;">
      <button type="button" style="font-size:.66rem;color:var(--muted);background:none;border:1px solid var(--muted);border-radius:8px;padding:3px 10px;cursor:pointer;" onclick="checkOptimizerEngineDiagnostics()">🔎 [Admin] Kiểm tra engine native/WASI</button>
      <div id="optimizer-diag-result" style="font-size:.66rem;color:var(--muted);margin-top:4px;word-break:break-word;"></div>
    </div>`;
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

  // ── Nút hành động (Phần 14/15). V85: label đổi tuỳ trạng thái JOB THẬT (queued/running/failed) —
  //     "Đang chạy..." CHỈ hiện khi job THẬT SỰ đang chạy (poll xác nhận liên tục), không kẹt mãi;
  //     job failed → nút đổi thành "Thử lại" (Retry, Phần "MOBILE UX"). ──
  const runBtnLabel = isQueued ? '🕓 Đang xếp hàng...'
    : isRunning ? '⏳ Đang chạy...'
    : bindingUnavailable ? '⚠️ Optimizer chưa sẵn sàng'
    : isFailed ? '🔁 Thử lại'
    : '🚀 Run Optimizer';
  html += `<button class="auth-submit" id="optimizer-run-btn" onclick="runOptimizerNow()" ${(isActive || bindingUnavailable) ? 'disabled' : ''}>${runBtnLabel}</button>`;
  if (s.hasCandidate && !isActive) {
    html += `<button class="auth-submit" style="margin-top:8px;background:var(--ok);" onclick="applyOptimizerWeights()">✅ Apply Personal Weights</button>`;
  }
  if (s.personalWeightsEnabled && !isActive) {
    html += `<button class="auth-submit" style="margin-top:8px;background:var(--l7a);box-shadow:0 4px 0 #b25f22;" onclick="resetOptimizerWeights()">↩️ Reset to Default</button>`;
  }
  if (s.canRollback && !isActive) {
    html += `<button class="auth-submit" style="margin-top:8px;background:var(--l15a);" onclick="rollbackOptimizerWeights()">⏮️ Rollback</button>`;
  }
  if (isFailed && s.lastError) {
    // s.lastError: server ĐÃ tự chọn đúng câu cho đúng vai trò (user thường = câu chung an toàn;
    // admin = lỗi nội bộ đầy đủ — xem lib/fsrs/optimizer.js:getOptimizerStatus, Phần "ERROR SECURITY").
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

// V85 — runOptimizerNow() giờ CHỈ tạo job (POST /run trả về NGAY, 202) rồi bắt đầu poll trạng thái
// THẬT qua loadOptimizerStatus()/ensureOptimizerPolling() — KHÔNG còn đợi cả pipeline train chạy
// xong trong 1 lần fetch() như trước (đó chính là nguyên nhân UI treo ở "Đang chạy..." khi request
// dài bị Vercel timeout). "Đang chạy..." giờ luôn được XÁC NHẬN LẠI mỗi 2 giây qua poll — nếu job
// chết giữa chừng, server tự chuyển 'failed' (heartbeat/stale-job recovery) và lần poll kế tiếp sẽ
// hiện đúng trạng thái đó + nút "Thử lại", không bao giờ kẹt vĩnh viễn.
//
// Giữ nguyên cách xử lý response KHÔNG PHẢI JSON (Phần "ERROR SECURITY"/hạ tầng) từ bản trước — vẫn
// hữu ích vì request TẠO JOB (nhẹ) vẫn có thể gặp lỗi hạ tầng dù hiếm hơn nhiều so với trước đây.
async function runOptimizerNow() {
  if (_optimizerBusy) return;
  _optimizerBusy = true;
  const btn = document.getElementById('optimizer-run-btn');
  if (btn) { btn.disabled = true; btn.textContent = '🕓 Đang tạo job...'; }
  let errorMsg = null;
  try {
    const res = await fetch('/api/fsrs-optimizer/run', { method: 'POST', headers: authHeaders() });
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
    await loadOptimizerStatus(); // Job đã queued (hoặc đang có job active từ trước) → tự bắt đầu poll.
    if (errorMsg) showOptimizerError(errorMsg);
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
