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
  // FIX (Bug 2 gốc — đổi số câu reset tiến trình): 'adjust' chỉ đổi KÍCH THƯỚC hàng đợi hiện có,
  // giữ nguyên phần đã học — không còn bindType(true) ép nạp lại từ đầu.
  bindType('adjust');
}
function bindType(forceReload) { _bindTypeAsync(forceReload); }
// V70/V71: user ĐÃ ĐĂNG NHẬP gõ đúng hàng đợi FSRS thật (due + new hôm nay), nạp 1 LẦN vào
// tyQueue rồi chống lặp hoàn toàn ở client (xem sqAdvance).
// V74 (audit lặp câu hỏi): quay lại tab 'type' giữa phiên đang học dở không được nạp lại hàng đợi
// (trước đây luôn sqLoad() lại mỗi lần render()/goTab() gọi bindType()) — chỉ vẽ lại câu hiện tại.
// forceReload: falsy = vào tab bình thường (giữ hàng đợi nếu có; lần đầu trong trang thử khôi phục
// từ localStorage — FIX Bug 2 "refresh mất tiến trình"); 'adjust' = đổi số câu, chỉ resize hàng đợi
// hiện có; true = ép nạp mới hoàn toàn (dự phòng).
let tyRestoreAttempted = false;
async function _bindTypeAsync(forceReload) {
  if (forceReload === 'adjust' && (tyQueue.items.length > 0 || tyQueue.answeredCount > 0)) {
    const { error } = await sqAdjustLimit(tyQueue, questionCount);
    if (currentTab !== 'type') return;
    const area1 = document.getElementById('ty-area');
    if (error) { if (area1) area1.innerHTML = `<div class="panel center" style="padding:24px">⚠️ ${error}</div>`; return; }
    tyRenderQ();
    return;
  }
  if (!forceReload && tyQueue.items.length > 0) { tyRenderQ(); return; }
  if (!forceReload && !tyRestoreAttempted) {
    tyRestoreAttempted = true;
    const extra = sqRestoreIntoQueue('type', tyQueue);
    if (extra) { tyScore = extra.score || 0; tyRenderQ(); return; }
  }
  tyScore = 0;
  const area = document.getElementById('ty-area');
  if (isLoggedIn() && area) area.innerHTML = `<div class="panel center" style="padding:24px">⏳ Đang tải hàng đợi FSRS...</div>`;
  const { error } = await sqLoad(tyQueue, questionCount);
  if (currentTab !== 'type') return; // user đã rời tab trong lúc chờ tải
  if (error) { if (area) area.innerHTML = `<div class="panel center" style="padding:24px">⚠️ ${error}</div>`; return; }
  tyRenderQ();
}
function tyRenderQ() {
  sqPersist('type', tyQueue, { score: tyScore }); // FIX (Bug 2 — session persistence): lưu lại mọi lần vẽ để refresh không mất tiến trình
  const area = document.getElementById('ty-area'); if (!area) return;
  if (tyQueue.totalPlanned === 0) {
    const msg = isLoggedIn()
      ? '🎉 Không còn thẻ nào đến hạn hoặc từ mới trong ngân sách hôm nay!<br><span style="font-size:.85rem;color:var(--muted)">Vào "🎯 Hôm nay học" để xem/chỉnh giới hạn.</span>'
      : 'Không có từ nào trong phạm vi bài đang chọn!';
    area.innerHTML = `<div class="panel center" style="padding:24px">${msg}</div>`; return;
  }
  if (tyQueue.items.length === 0) {
    area.innerHTML=`<div class="panel exam-result"><div class="exam-score">${tyScore}/${tyQueue.answeredCount}</div><div class="exam-rank">${qzRank(tyScore/tyQueue.answeredCount)}</div>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:8px">
        <button class="btn btn-primary" onclick="tyContinueSession()">▶️ Học tiếp</button>
        <button class="btn" onclick="tyRelearnFromStart()">🔁 Học lại từ đầu</button>
      </div></div>`;
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
// FIX (Bug 1 gốc — "UI chuyển câu nhưng Neon chưa lưu"): TRƯỚC ĐÂY advance qua setTimeout chạy ĐỘC
// LẬP với submitFsrsReview() (chạy nền, không chờ) — UI có thể chuyển câu (và user refresh/đóng
// tab) trước khi Neon xác nhận đã lưu. Giờ ĐỢI submitFsrsReviewAwaited() (có trần chờ) SONG SONG
// với đúng khoảng nghỉ hiển thị đáp án 1600ms như cũ — mạng nhanh thì thời gian không đổi.
// FIX (chống lặp tuyệt đối — Kiểm tra/Bỏ qua không bị khoá UI như nút trắc nghiệm): thêm cờ
// tySubmitting để chặn bấm "Kiểm tra"/"Bỏ qua"/Enter nhiều lần trong lúc đang đợi — trước đây chỉ
// khoá mỗi ô input, 2 nút vẫn bấm được, có thể gọi sqAdvance() 2 lần chồng nhau cho CÙNG 1 thẻ,
// làm thẻ kế tiếp bị "nuốt" mất 1 câu không hiển thị.
let tySubmitting = false;
async function tyCheck() {
  if (tySubmitting) return;
  const inp = document.getElementById('ty-input'); if(!inp) return;
  tySubmitting = true;
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
  if (okLocally) tyScore++;
  if (isLoggedIn()) {
    await Promise.all([
      submitFsrsReviewAwaited({ word: w, quizType: fsrsQuizTypeFor('type'), selectedAnswer: val || '⨯ (bỏ trống) ⨯', responseTimeMs }),
      new Promise(r => setTimeout(r, 1600)),
    ]);
  } else {
    guestMarkActivity();
    await new Promise(r => setTimeout(r, 1600));
  }
  tySubmitting = false;
  if (currentTab !== 'type' || tyQueue.items[0] !== w) return; // user đã rời tab hoặc hàng đợi đã đổi trong lúc chờ
  sqAdvance(tyQueue, okLocally); tyRenderQ();
}
async function tySkip() {
  if (tySubmitting) return;
  tySubmitting = true;
  const w = tyQueue.items[0];
  const responseTimeMs = performance.now() - tyStartedAt;
  if (isLoggedIn()) {
    await submitFsrsReviewAwaited({ word: w, quizType: fsrsQuizTypeFor('type'), selectedAnswer: '⨯ (bỏ qua) ⨯', responseTimeMs });
  } else {
    guestMarkActivity();
  }
  tySubmitting = false;
  if (currentTab !== 'type' || tyQueue.items[0] !== w) return;
  sqAdvance(tyQueue, false); // bỏ qua luôn tính là chưa nhớ (Again)
  tyRenderQ();
}

// V77 (Yêu cầu 2/8): "Học tiếp" = nạp Study Session MỚI tiếp theo (Yêu cầu 4: tự lấy đúng từ CHƯA
// học kế tiếp, không quay lại đầu danh sách). "Học lại từ đầu" = hành động TƯỜNG MINH riêng (Yêu
// cầu 8), chỉ chạy khi bấm đúng nút này; không đụng tới FSRS thật trên server.
async function tyContinueSession() {
  const { error } = await sqStartNewSession('type', tyQueue, questionCount);
  if (currentTab !== 'type') return;
  if (error) { const a = document.getElementById('ty-area'); if (a) a.innerHTML = `<div class="panel center" style="padding:24px">⚠️ ${error}</div>`; return; }
  tyRenderQ();
}
async function tyRelearnFromStart() {
  const { error } = await sqRelearnFromStart('type', tyQueue, questionCount);
  if (currentTab !== 'type') return;
  if (error) { const a = document.getElementById('ty-area'); if (a) a.innerHTML = `<div class="panel center" style="padding:24px">⚠️ ${error}</div>`; return; }
  tyRenderQ();
}

