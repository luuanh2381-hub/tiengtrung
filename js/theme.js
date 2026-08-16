// js/theme.js — Dark/light theme init + toggle (chạy đầu tiên, tránh chớp sai theme lúc tải trang)
// ════════════════════════════════════════════════════
// GIAO DIỆN: DARK MODE — hoàn toàn độc lập, không đụng tới logic nghiệp vụ bên dưới
// ════════════════════════════════════════════════════
(function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
})();
// Áp dụng theme (sáng/tối) vào cả DOM lẫn localStorage (localStorage vẫn giữ để tránh chớp sai
// theme lúc trang vừa tải xong, trước khi kịp lấy progressState.ui.theme từ DB/cache).
function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  localStorage.setItem('theme', theme === 'dark' ? 'dark' : 'light');
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}
function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const newTheme = isDark ? 'light' : 'dark';
  applyTheme(newTheme);
  progressState.ui.theme = newTheme;
  cacheProgressLocally();
  scheduleSync();
}
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
});

