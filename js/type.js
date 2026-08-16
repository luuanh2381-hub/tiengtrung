// js/type.js — Tab Gõ chữ / điền khuyết (ty*)
// ════════════════════════════════════════════════════
// TYPE
// ════════════════════════════════════════════════════
let tyQueue = sqCreate(), tyScore=0, tyStartedAt=0;

function renderType() {
  return `
  <div class="count-row">
    <label>Số câu:</label>
    <select onchange="tySetCount(this.value)">${[5,10,15,20].map(n=>`<option value="${n}"${n==questionCount?' selected':''}>${n}</option>`).join('')}</select>
  </div>
  <div id="ty-area"></div>`;
}
function tySetCount(v) {
  questionCount=parseInt(v);
  progressState.ui.questionCount = questionCount;
  cacheProgressLocally(); scheduleSync();
  bindType(true); // đổi số câu → cần nạp lại hàng đợi thật sự
}
function bindType(forceReload) { _bindTypeAsync(forceReload); }
// V70/V71: user ĐÃ ĐĂNG NHẬP gõ đúng hàng đợi FSRS thật (due + new hôm nay), nạp 1 LẦN vào
// tyQueue rồi chống lặp hoàn toàn ở client (xem sqAdvance).
// V74 (audit lặp câu hỏi): quay lại tab 'type' giữa phiên đang học dở không được nạp lại hàng đợi
// (trước đây luôn sqLoad() lại mỗi lần render()/goTab() gọi bindType()) — chỉ vẽ lại câu hiện tại.
async function _bindTypeAsync(forceReload) {
  if (!forceReload && tyQueue.items.length > 0) { tyRenderQ(); return; }
  tyScore = 0;
  const area = document.getElementById('ty-area');
  if (isLoggedIn() && area) area.innerHTML = `<div class="panel center" style="padding:24px">⏳ Đang tải hàng đợi FSRS...</div>`;
  const { error } = await sqLoad(tyQueue, questionCount);
  if (currentTab !== 'type') return; // user đã rời tab trong lúc chờ tải
  if (error) { if (area) area.innerHTML = `<div class="panel center" style="padding:24px">⚠️ ${error}</div>`; return; }
  tyRenderQ();
}
function tyRenderQ() {
  const area = document.getElementById('ty-area'); if (!area) return;
  if (tyQueue.totalPlanned === 0) {
    const msg = isLoggedIn()
      ? '🎉 Không còn thẻ nào đến hạn hoặc từ mới trong ngân sách hôm nay!<br><span style="font-size:.85rem;color:var(--muted)">Vào "🎯 Hôm nay học" để xem/chỉnh giới hạn.</span>'
      : 'Không có từ nào trong phạm vi bài đang chọn!';
    area.innerHTML = `<div class="panel center" style="padding:24px">${msg}</div>`; return;
  }
  if (tyQueue.items.length === 0) {
    area.innerHTML=`<div class="panel exam-result"><div class="exam-score">${tyScore}/${tyQueue.answeredCount}</div><div class="exam-rank">${qzRank(tyScore/tyQueue.answeredCount)}</div><button class="btn btn-primary" onclick="bindType()">Làm lại</button></div>`;
    if (isLoggedIn()) refreshServerMeta(); // hết phiên — làm mới streak/known thật
    return;
  }
  const w = tyQueue.items[0];
  area.innerHTML=`<div class="panel">
    <div style="font-size:.75rem;color:var(--muted);margin-bottom:8px">Câu ${tyQueue.answeredCount+1} · còn ${tyQueue.items.length} trong hàng đợi</div>
    <div class="type-q">
      <div style="font-size:.9rem;color:var(--muted);margin-bottom:4px">Gõ chữ Hán nghĩa là:</div>
      <div style="font-size:1.4rem;font-weight:700;margin-bottom:6px">${w.vi}</div>
      ${showPinyin?`<div class="fc-py" style="margin-bottom:4px">Gợi ý: ${w.py}</div>`:''}
      ${showHanViet && w.hanviet?`<div class="fc-hv" style="margin-bottom:10px">Hán Việt: ${w.hanviet}</div>`:''}
    </div>
    <input class="type-input" id="ty-input" placeholder="Gõ chữ Hán..." onkeydown="if(event.key==='Enter')tyCheck()">
    <div id="ty-fb"></div>
    <div style="display:flex;gap:8px;margin-top:10px;justify-content:center">
      <button class="btn btn-primary" onclick="tyCheck()">Kiểm tra</button>
      <button class="btn" style="background:var(--border)" onclick="tySkip()">Bỏ qua</button>
    </div>
  </div>`;
  setTimeout(()=>{ const i=document.getElementById('ty-input'); if(i)i.focus(); },100);
  tyStartedAt = performance.now(); // Phần 4: đo từ thời điểm câu hỏi hiển thị
}
// V70/V71: trả lời/bỏ qua đi qua ĐÚNG reviewService.reviewCard() (user đã đăng nhập). sqAdvance()
// đảm bảo thẻ vừa đúng bị loại khỏi phiên ngay, thẻ sai/bỏ qua chỉ lặp lại sau tối thiểu
// REPEAT_GAP thẻ khác — không tự ý gọi lại server giữa chừng phiên.
function tyCheck() {
  const inp = document.getElementById('ty-input'); if(!inp) return;
  const val = inp.value.trim();
  const w = tyQueue.items[0];
  const okLocally = val === w.hz;
  const responseTimeMs = performance.now() - tyStartedAt;
  const fb = document.getElementById('ty-fb');
  fb.className='type-feedback '+(okLocally?'ok':'bad');
  fb.textContent = okLocally ? `✅ Đúng! ${w.hz}` : `❌ Sai. Đáp án: ${w.hz} (${w.py})`;
  if (okLocally) playDing(); else playBuzz();
  speak(w.hz);
  inp.disabled=true;
  // FIX (Task 2 — Optimistic UI): advance ngay bằng kết quả local, KHÔNG await Neon trước khi hẹn
  // giờ chuyển câu. submitFsrsReview() chạy nền song song với timeout hiển thị feedback.
  if (okLocally) tyScore++;
  if (isLoggedIn()) {
    submitFsrsReview({ word: w, quizType: fsrsQuizTypeFor('type'), selectedAnswer: val || '⨯ (bỏ trống) ⨯', responseTimeMs });
  } else {
    guestMarkActivity();
  }
  setTimeout(()=>{ sqAdvance(tyQueue, okLocally); tyRenderQ(); }, 1600);
}
function tySkip() {
  const w = tyQueue.items[0];
  const responseTimeMs = performance.now() - tyStartedAt;
  // FIX (Task 2 — Optimistic UI): trước đây await xong mới advance → "Bỏ qua" bị treo chờ Neon.
  // Advance ngay lập tức, gửi review chạy nền.
  if (isLoggedIn()) {
    submitFsrsReview({ word: w, quizType: fsrsQuizTypeFor('type'), selectedAnswer: '⨯ (bỏ qua) ⨯', responseTimeMs });
  } else {
    guestMarkActivity();
  }
  sqAdvance(tyQueue, false); // bỏ qua luôn tính là chưa nhớ (Again)
  tyRenderQ();
}

