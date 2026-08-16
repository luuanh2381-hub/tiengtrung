// js/logs.js — Tab Nhật ký hoạt động (chỉ admin trở lên)
// ════════════════════════════════════════════════════
// TAB: NHẬT KÝ HOẠT ĐỘNG (chỉ admin trở lên) — gộp theo ngày, server chỉ giữ tối đa 10 ngày gần nhất
// ════════════════════════════════════════════════════
function renderLogs() {
  if (isGuest || !isAdminRole()) {
    return `<div class="panel center" style="padding:40px">Bạn không có quyền truy cập mục này.</div>`;
  }
  return `<div class="panel">
    <div class="panel-title">🧾 Nhật ký hoạt động <span style="text-transform:none;font-weight:600;color:var(--muted);letter-spacing:0;">(server chỉ giữ tối đa 10 ngày gần nhất)</span></div>
    <div id="logs-area" style="color:var(--muted);padding:14px 0;text-align:center;">Đang tải nhật ký...</div>
  </div>`;
}
function bindLogs() {
  if (isGuest || !isAdminRole()) return;
  loadActivityLogs();
}
const LOG_ACTION_STYLE = {
  auth:   { icon: '🔑', bg: 'var(--l9c)',  color: 'var(--l9a)',  label: 'Tài khoản' },
  admin:  { icon: '🛠️', bg: 'var(--l11c)', color: 'var(--l11a)', label: 'Quản trị' },
  vocab:  { icon: '📚', bg: 'var(--l8c)',  color: 'var(--l8a)',  label: 'Từ vựng' },
  system: { icon: '🤖', bg: 'var(--l15c)', color: 'var(--l15a)', label: 'Tự động' },
};
async function loadActivityLogs() {
  const area = document.getElementById('logs-area');
  if (!area) return;
  try {
    const res = await fetch('/api/admin/logs', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { area.textContent = data.error || 'Không tải được nhật ký.'; return; }
    if (!data.days.length) {
      area.innerHTML = '<div style="text-align:center;padding:20px 0;">Chưa có hoạt động nào được ghi lại.</div>';
      return;
    }
    area.innerHTML = data.days.map((d, i) => {
      const dateLabel = new Date(d.date + 'T00:00:00').toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
      const rows = d.logs.map(l => {
        const st = LOG_ACTION_STYLE[l.action] || LOG_ACTION_STYLE.system;
        const who = l.username ? `<b>${l.username}</b>` : '<i>Ẩn danh</i>';
        const errIdx = l.detail.indexOf(' — Lỗi mẫu: ');
        const mainText = errIdx === -1 ? l.detail : l.detail.slice(0, errIdx);
        const errText = errIdx === -1 ? '' : l.detail.slice(errIdx + ' — Lỗi mẫu: '.length);
        const errBlock = errText
          ? `<div style="margin-top:4px;color:#c0392b;font-size:.78rem;">⚠️ ${errText.split(' | ').join('<br>⚠️ ')}</div>`
          : '';
        return `<div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f0f0f0;">
          <span style="font-size:.68rem;font-weight:800;background:${st.bg};color:${st.color};padding:2px 7px;border-radius:8px;white-space:nowrap;">${st.icon} ${st.label}</span>
          <div style="flex:1;font-size:.85rem;">${who} — ${mainText}${errBlock}</div>
          <span style="font-size:.7rem;color:var(--muted);white-space:nowrap;">${l.time}</span>
        </div>`;
      }).join('');
      return `<details ${i === 0 ? 'open' : ''} style="margin-bottom:10px;border:1.5px solid #eee;border-radius:12px;padding:10px 12px;">
        <summary style="cursor:pointer;font-weight:800;font-size:.85rem;display:flex;justify-content:space-between;align-items:center;">
          <span>📅 ${dateLabel}</span>
          <span style="font-size:.72rem;color:var(--muted);font-weight:600;">${d.count} hoạt động</span>
        </summary>
        <div style="margin-top:8px;">${rows}</div>
      </details>`;
    }).join('');
  } catch (e) {
    area.textContent = 'Không kết nối được máy chủ: ' + e.message;
  }
}

