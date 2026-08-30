// js/translate.js — Tab Dịch câu (tr*) — luyện câu, tự chấm, KHÔNG qua FSRS (xem SUMMARY)
// ════════════════════════════════════════════════════
// TRANSLATE
// ════════════════════════════════════════════════════
let trItems=[], trIdx=0;

function renderTrans() {
  const filtered = SENTENCES.filter(s=>isLessonInSelection(s.l));
  trItems = shuffle(filtered);
  trIdx=0;
  return `
  <div class="count-row">
    <label>Số câu:</label>
    <select onchange="trSetCount(this.value)">${[5,10,15].map(n=>`<option value="${n}"${n==questionCount?' selected':''}>${n}</option>`).join('')}</select>
  </div>
  <div id="tr-area"></div>`;
}
function trSetCount(v) {
  questionCount=parseInt(v);
  progressState.ui.questionCount = questionCount;
  cacheProgressLocally(); scheduleSync();
  bindTrans();
}
function bindTrans() {
  const filtered = SENTENCES.filter(s=>isLessonInSelection(s.l));
  trItems = shuffle(filtered).slice(0,questionCount);
  trIdx=0; trRenderQ();
}
function trRenderQ() {
  const area = document.getElementById('tr-area'); if(!area) return;
  if(trIdx>=trItems.length){
    area.innerHTML=`<div class="panel center" style="padding:30px"><div style="font-size:2rem">🎉</div><div style="font-weight:700;margin:10px 0">Hoàn thành ${trItems.length} câu!</div><button class="btn btn-primary" onclick="bindTrans()">Làm lại</button></div>`; return;
  }
  const s = trItems[trIdx];
  area.innerHTML=`<div class="panel">
    <div style="font-size:.75rem;color:var(--muted);margin-bottom:8px">${trIdx+1}/${trItems.length} · Dịch sang tiếng Trung</div>
    <div class="trans-vi">${s.vi}</div>
    <div class="trans-hint">💡 Gợi ý: ${escapeHtml(s.hint)}</div>
    <textarea class="trans-input" id="tr-inp" placeholder="Gõ câu tiếng Trung..."></textarea>
    <div class="trans-answer" id="tr-ans">
      <div>📖 Đáp án: ${escapeHtml(s.hz)}</div>
      ${showPinyin?`<div style="font-size:.8rem;margin-top:4px;color:var(--muted)">(bài ${s.l})</div>`:''}
      <button class="btn btn-sound btn-sm" style="margin-top:6px" onclick="speak('${escapeJsAttr(s.hz)}')">🔊 Nghe</button>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
      <button class="btn" style="background:var(--l9b);color:var(--l9a)" onclick="trShowAns()">👁 Xem đáp án</button>
      <button class="btn btn-ok fc-btn" onclick="trNext(true)">✅ Đúng</button>
      <button class="btn btn-fail fc-btn" onclick="trNext(false)">❌ Sai</button>
    </div>
  </div>`;
}
function trShowAns() {
  const a=document.getElementById('tr-ans'); if(a){ a.style.display='block'; speak(trItems[trIdx].hz); }
}
function trNext(ok) { trIdx++; trRenderQ(); }

// ════════════════════════════════════════════════════
// AI DỊCH — Sinh câu & chấm bài bằng Gemini (yêu cầu đăng nhập để tránh lạm dụng quota free)
// ════════════════════════════════════════════════════
