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
  // FIX (Bug 2 gốc — đổi số câu reset tiến trình): 'adjust' chỉ đổi KÍCH THƯỚC hàng đợi hiện có,
  // giữ nguyên phần đã học — không còn bindListen(true) ép nạp lại từ đầu.
  bindListen('adjust');
}

function bindListen(forceReload) { _bindListenAsync(forceReload); }
// V70/V71: user ĐÃ ĐĂNG NHẬP nghe-chọn TỪ ĐÚNG hàng đợi FSRS thật (due + new hôm nay), nạp 1 LẦN
// vào lsQueue rồi chống lặp hoàn toàn ở client (xem sqAdvance). KHÁCH vẫn dùng pool theo bài đang
// chọn để thử app.
// V74 (audit lặp câu hỏi): quay lại tab 'listen' giữa phiên đang học dở không được nạp lại hàng đợi
// (trước đây luôn sqLoad() lại mỗi lần render()/goTab() gọi bindListen()) — chỉ vẽ lại câu hiện tại.
// forceReload: falsy = vào tab bình thường (giữ hàng đợi nếu có; lần đầu trong trang thử khôi phục
// từ localStorage — FIX Bug 2 "refresh mất tiến trình"); 'adjust' = đổi số câu, chỉ resize hàng đợi
// hiện có; true = ép nạp mới hoàn toàn (dự phòng).
let lsRestoreAttempted = false;
async function _bindListenAsync(forceReload) {
  if (forceReload === 'adjust' && (lsQueue.items.length > 0 || lsQueue.answeredCount > 0)) {
    const { error } = await sqAdjustLimit(lsQueue, questionCount);
    if (currentTab !== 'listen') return;
    const area1 = document.getElementById('ls-area');
    if (error) { if (area1) area1.innerHTML = `<div class="panel center" style="padding:24px">⚠️ ${error}</div>`; return; }
    lsRenderQ();
    return;
  }
  if (!forceReload && lsQueue.items.length > 0) { lsRenderQ(); return; }
  if (!forceReload && !lsRestoreAttempted) {
    lsRestoreAttempted = true;
    const extra = sqRestoreIntoQueue('listen', lsQueue);
    if (extra) { lsScore = extra.score || 0; lsRenderQ(); return; }
  }
  lsScore = 0;
  const area = document.getElementById('ls-area');
  if (isLoggedIn() && area) area.innerHTML = `<div class="panel center" style="padding:24px">⏳ Đang tải hàng đợi FSRS...</div>`;
  const { error } = await sqLoad(lsQueue, questionCount);
  if (currentTab !== 'listen') return; // user đã rời tab trong lúc chờ tải
  if (error) { if (area) area.innerHTML = `<div class="panel center" style="padding:24px">⚠️ ${error}</div>`; return; }
  lsRenderQ();
}

function lsRenderQ() {
  sqPersist('listen', lsQueue, { score: lsScore }); // FIX (Bug 2 — session persistence): lưu lại mọi lần vẽ để refresh không mất tiến trình
  const area = document.getElementById('ls-area'); if(!area) return;
  if (lsQueue.totalPlanned === 0) {
    const msg = isLoggedIn()
      ? '🎉 Không còn thẻ nào đến hạn hoặc từ mới trong ngân sách hôm nay!<br><span style="font-size:.85rem;color:var(--muted)">Vào "🎯 Hôm nay học" để xem/chỉnh giới hạn.</span>'
      : 'Không có từ nào trong phạm vi bài đang chọn!';
    area.innerHTML = `<div class="panel center" style="padding:24px">${msg}</div>`; return;
  }
  if (lsQueue.items.length === 0) {
    area.innerHTML=`<div class="panel exam-result"><div class="exam-score">${lsScore}/${lsQueue.answeredCount}</div><div class="exam-rank">${qzRank(lsScore/lsQueue.answeredCount)}</div>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:8px">
        <button class="btn btn-primary" onclick="lsContinueSession()">▶️ Học tiếp</button>
        <button class="btn" onclick="lsRelearnFromStart()">🔁 Học lại từ đầu</button>
      </div></div>`;
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
// FIX (Bug 1 gốc — "UI chuyển câu nhưng Neon chưa lưu"): ĐỢI submitFsrsReviewAwaited() (có trần
// chờ, xem study-queue.js) SONG SONG với đúng khoảng nghỉ hiển thị đáp án 1400ms như cũ, thay vì để
// submitFsrsReview() chạy nền không chờ như trước — mạng nhanh thì thời gian không đổi.
async function lsPickWord(btn, chosen, correct) {
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
  if (isCorrectLocally) lsScore++;
  if (isLoggedIn()) {
    await Promise.all([
      submitFsrsReviewAwaited({ word: w, quizType: fsrsQuizTypeFor('listen'), selectedAnswer: chosen, responseTimeMs }),
      new Promise(r => setTimeout(r, 1400)),
    ]);
  } else {
    guestMarkActivity();
    await new Promise(r => setTimeout(r, 1400));
  }
  if (currentTab !== 'listen' || lsQueue.items[0] !== w) return; // user đã rời tab hoặc hàng đợi đã đổi trong lúc chờ
  sqAdvance(lsQueue, isCorrectLocally); lsRenderQ();
}

// V77 (Yêu cầu 2/8): "Học tiếp" = nạp Study Session MỚI tiếp theo (Yêu cầu 4: tự lấy đúng từ CHƯA
// học kế tiếp, không quay lại đầu danh sách). "Học lại từ đầu" = hành động TƯỜNG MINH riêng (Yêu
// cầu 8), chỉ chạy khi bấm đúng nút này; không đụng tới FSRS thật trên server.
async function lsContinueSession() {
  const { error } = await sqStartNewSession('listen', lsQueue, questionCount);
  if (currentTab !== 'listen') return;
  if (error) { const a = document.getElementById('ls-area'); if (a) a.innerHTML = `<div class="panel center" style="padding:24px">⚠️ ${error}</div>`; return; }
  lsRenderQ();
}
async function lsRelearnFromStart() {
  const { error } = await sqRelearnFromStart('listen', lsQueue, questionCount);
  if (currentTab !== 'listen') return;
  if (error) { const a = document.getElementById('ls-area'); if (a) a.innerHTML = `<div class="panel center" style="padding:24px">⚠️ ${error}</div>`; return; }
  lsRenderQ();
}

