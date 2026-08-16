// js/listen.js — Tab Nghe – Chọn (ls*)
// ════════════════════════════════════════════════════
// LISTEN (sentence-based)
// ════════════════════════════════════════════════════
let lsQueue = sqCreate(), lsScore=0, lsStartedAt=0;

function renderListen() {
  return `
  <div class="count-row">
    <label>Số câu:</label>
    <select onchange="lsSetCount(this.value)">${[5,10,15].map(n=>`<option value="${n}"${n==questionCount?' selected':''}>${n}</option>`).join('')}</select>
  </div>
  <div id="ls-area"></div>`;
}
function lsSetCount(v) {
  questionCount=parseInt(v);
  progressState.ui.questionCount = questionCount;
  cacheProgressLocally(); scheduleSync();
  bindListen(true); // đổi số câu → cần nạp lại hàng đợi thật sự
}

function bindListen(forceReload) { _bindListenAsync(forceReload); }
// V70/V71: user ĐÃ ĐĂNG NHẬP nghe-chọn TỪ ĐÚNG hàng đợi FSRS thật (due + new hôm nay), nạp 1 LẦN
// vào lsQueue rồi chống lặp hoàn toàn ở client (xem sqAdvance). KHÁCH vẫn dùng pool theo bài đang
// chọn để thử app.
// V74 (audit lặp câu hỏi): quay lại tab 'listen' giữa phiên đang học dở không được nạp lại hàng đợi
// (trước đây luôn sqLoad() lại mỗi lần render()/goTab() gọi bindListen()) — chỉ vẽ lại câu hiện tại.
async function _bindListenAsync(forceReload) {
  if (!forceReload && lsQueue.items.length > 0) { lsRenderQ(); return; }
  lsScore = 0;
  const area = document.getElementById('ls-area');
  if (isLoggedIn() && area) area.innerHTML = `<div class="panel center" style="padding:24px">⏳ Đang tải hàng đợi FSRS...</div>`;
  const { error } = await sqLoad(lsQueue, questionCount);
  if (currentTab !== 'listen') return; // user đã rời tab trong lúc chờ tải
  if (error) { if (area) area.innerHTML = `<div class="panel center" style="padding:24px">⚠️ ${error}</div>`; return; }
  lsRenderQ();
}

function lsRenderQ() {
  const area = document.getElementById('ls-area'); if(!area) return;
  if (lsQueue.totalPlanned === 0) {
    const msg = isLoggedIn()
      ? '🎉 Không còn thẻ nào đến hạn hoặc từ mới trong ngân sách hôm nay!<br><span style="font-size:.85rem;color:var(--muted)">Vào "🎯 Hôm nay học" để xem/chỉnh giới hạn.</span>'
      : 'Không có từ nào trong phạm vi bài đang chọn!';
    area.innerHTML = `<div class="panel center" style="padding:24px">${msg}</div>`; return;
  }
  if (lsQueue.items.length === 0) {
    area.innerHTML=`<div class="panel exam-result"><div class="exam-score">${lsScore}/${lsQueue.answeredCount}</div><div class="exam-rank">${qzRank(lsScore/lsQueue.answeredCount)}</div><button class="btn btn-primary" onclick="bindListen()">Làm lại</button></div>`;
    if (isLoggedIn()) refreshServerMeta(); // hết phiên — làm mới streak/known thật
    return;
  }
  lsRenderWord(lsQueue.items[0]);
  // auto-play
  setTimeout(()=>{
    const btn = document.getElementById('ls-play');
    if(btn) btn.click();
  }, 400);
}

function lsRenderWord(w) {
  const area = document.getElementById('ls-area');
  const pool = isLoggedIn() ? WORDS.filter(x=>x.hz!==w.hz) : getFilteredWords().filter(x=>x.hz!==w.hz);
  const distractors = shuffle(pool).slice(0,3);
  const opts = shuffle([w,...distractors]);
  const optHtml = opts.map(o=>`
    <button class="listen-opt" onclick="lsPickWord(this,'${o.hz}','${w.hz}')">${o.hz}${showPinyin?`<div style="font-size:.7rem;color:var(--muted)">${o.py}</div>`:''}${showHanViet && o.hanviet?`<div style="font-size:.68rem;color:var(--active-dark);font-weight:600">${o.hanviet}</div>`:''}</button>`).join('');
  area.innerHTML=`<div class="panel">
    <div style="font-size:.75rem;color:var(--muted);margin-bottom:10px">Câu ${lsQueue.answeredCount+1} · còn ${lsQueue.items.length} trong hàng đợi · Nghe và chọn chữ Hán đúng</div>
    <button id="ls-play" class="listen-play" onclick="speak('${w.hz}')" title="Phát lại">🔊</button>
    <div class="listen-opts">${optHtml}</div>
  </div>`;
  lsStartedAt = performance.now(); // Phần 4: đo từ thời điểm câu hỏi hiển thị (trước cả auto-play)
}

// V70/V71: trả lời đi qua ĐÚNG reviewService.reviewCard() (user đã đăng nhập). sqAdvance() đảm
// bảo thẻ vừa đúng bị loại khỏi phiên ngay, thẻ sai chỉ lặp lại sau tối thiểu REPEAT_GAP thẻ khác.
function lsPickWord(btn, chosen, correct) {
  const w = lsQueue.items[0];
  const isCorrectLocally = chosen === correct;
  const responseTimeMs = performance.now() - lsStartedAt;
  document.querySelectorAll('#ls-area .listen-opt').forEach(b=>{
    const bv = b.getAttribute('onclick').match(/'([^']+)','[^']+'/)[1];
    if(bv===correct) b.classList.add('correct');
    else if(b===btn && !isCorrectLocally) b.classList.add('wrong');
    b.disabled=true;
  });
  if(isCorrectLocally) playDing(); else playBuzz();
  // FIX (Task 2 — Optimistic UI): advance ngay bằng kết quả local, submitFsrsReview() chạy nền —
  // không còn chờ round-trip Neon mới bắt đầu đếm giờ chuyển câu.
  if (isCorrectLocally) lsScore++;
  if (isLoggedIn()) {
    submitFsrsReview({ word: w, quizType: fsrsQuizTypeFor('listen'), selectedAnswer: chosen, responseTimeMs });
  } else {
    guestMarkActivity();
  }
  setTimeout(()=>{ sqAdvance(lsQueue, isCorrectLocally); lsRenderQ(); }, 1400);
}

