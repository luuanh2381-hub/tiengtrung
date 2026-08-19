// js/compare.js — Tab So sánh chữ dễ nhầm (cp*) — KHÔNG qua FSRS (xem SUMMARY)
// ════════════════════════════════════════════════════
// COMPARE / CONFUSABLE CHARACTERS
// ════════════════════════════════════════════════════
let cpTestMode = false, cpTestQueue = [], cpTestIdx = 0, cpTestScore = 0;

function renderCompare() {
  return `
  <div class="panel" style="margin-bottom:14px">
    <div style="font-size:.85rem;color:var(--muted);margin-bottom:10px">🆚 Những chữ Hán dễ nhìn nhầm hoặc đồng âm — đặt cạnh nhau để so sánh và ghi nhớ điểm khác biệt.</div>
    <button class="btn btn-primary" onclick="cpStartTest()">🧠 Kiểm tra nhanh tất cả nhóm</button>
  </div>
  <div id="cp-area">${cpRenderList()}</div>`;
}
function bindCompare() {}

function cpRenderList() {
  const appHz = new Set(WORDS.map(w => w.hz));
  // Bản đồ tra nhanh chữ Hán -> Hán Việt (dùng lại dữ liệu Hán Việt AI đã sinh cho vốn từ của bài học,
  // vì CONFUSE_GROUPS là danh sách chữ tĩnh, tự thân không có sẵn trường hanviet).
  const hvMap = {};
  WORDS.forEach(w => { if (w.hanviet && !hvMap[w.hz]) hvMap[w.hz] = w.hanviet; });
  return CONFUSE_GROUPS.map(g => {
    const itemsHtml = g.chars.map((c,i) => `
      ${i>0?'<span class="confuse-vs">vs</span>':''}
      <div class="confuse-item${appHz.has(c.hz)?' in-vocab':''}">
        <div class="confuse-hz" onclick="speak('${c.hz}')">${c.hz}</div>
        ${showPinyin ? `<div class="confuse-py">${c.py}</div>` : ''}
        ${showHanViet && hvMap[c.hz] ? `<div class="confuse-hv">${hvMap[c.hz]}</div>` : ''}
        <div class="confuse-vi">${c.vi}</div>
        ${appHz.has(c.hz)?'<div class="confuse-badge">✓ trong vốn từ</div>':''}
      </div>`).join('');
    return `<div class="confuse-card">
      <div class="confuse-row">${itemsHtml}</div>
      <div class="confuse-tip">💡 ${g.tip}</div>
    </div>`;
  }).join('');
}

function cpStartTest() {
  cpTestMode = true; cpTestScore = 0; cpTestIdx = 0;
  cpTestQueue = shuffle(CONFUSE_GROUPS.slice());
  cpRenderTestQ();
}

function cpRenderTestQ() {
  const area = document.getElementById('cp-area');
  if (cpTestIdx >= cpTestQueue.length) {
    area.innerHTML = `<div class="panel exam-result">
      <div class="exam-score">${cpTestScore}/${cpTestQueue.length}</div>
      <div class="exam-rank">${qzRank(cpTestScore/cpTestQueue.length)}</div>
      <button class="btn btn-primary" onclick="cpStartTest()">Làm lại</button>
      <button class="btn" onclick="cpExitTest()">Xem danh sách</button>
    </div>`;
    return;
  }
  const g = cpTestQueue[cpTestIdx];
  const target = g.chars[Math.floor(Math.random()*g.chars.length)];
  const opts = shuffle(g.chars.slice());
  const optHtml = opts.map(o => `<button class="confuse-test-opt" onclick="cpPick(this,'${o.hz}','${target.hz}')">${o.hz}</button>`).join('');
  area.innerHTML = `<div class="panel">
    <div style="font-size:.75rem;color:var(--muted);margin-bottom:10px">${cpTestIdx+1}/${cpTestQueue.length} · Chọn đúng chữ Hán</div>
    <div style="text-align:center;font-size:1.05rem;font-weight:700;margin-bottom:6px">${target.vi}</div>
    ${showPinyin ? `<div style="text-align:center;font-size:.85rem;color:var(--muted);font-style:italic;margin-bottom:14px">${target.py}</div>` : ''}
    <div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap">${optHtml}</div>
    <div style="margin-top:14px;text-align:center"><button class="btn" onclick="cpExitTest()">✕ Thoát kiểm tra</button></div>
  </div>`;
}

function cpPick(btn, hz, correctHz) {
  document.querySelectorAll('.confuse-test-opt').forEach(b => b.style.pointerEvents = 'none');
  const isCorrect = hz === correctHz;
  if (isCorrect) { btn.classList.add('correct'); cpTestScore++; }
  else {
    btn.classList.add('wrong');
    document.querySelectorAll('.confuse-test-opt').forEach(b => { if (b.textContent === correctHz) b.classList.add('correct'); });
  }
  speak(correctHz);
  setTimeout(() => { cpTestIdx++; cpRenderTestQ(); }, 1200);
}

function cpExitTest() {
  cpTestMode = false;
  document.getElementById('cp-area').innerHTML = cpRenderList();
}

