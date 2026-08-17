// js/quiz.js — Tab Trắc nghiệm (qz*): 3 chế độ hỏi 漢→Việt/Việt→漢/Âm→漢
// ════════════════════════════════════════════════════
// QUIZ
// ════════════════════════════════════════════════════
let qzQueue = sqCreate(), qzType='漢→Việt', qzScore=0, qzStartedAt=0;
let qzQuestionCount = 30; // số câu riêng cho Trắc nghiệm, mặc định 30 (không dùng chung questionCount với các tab khác)
let qzWordExamples = []; // ví dụ theo từng từ (kho đảm bảo mỗi từ có sẵn vài câu), dùng để minh hoạ từ đang hỏi

function renderQuiz() {
  return `
  <div class="quiz-type-row">
    <div class="count-row" style="margin-bottom:0;">
      <select onchange="qzSetCount(this.value)" title="Số câu">${[5,10,15,20,30].map(n=>`<option value="${n}"${n==qzQuestionCount?' selected':''}>${n}</option>`).join('')}</select>
    </div>
    ${['漢→Việt','Việt→漢','Âm→漢'].map(t=>`<button class="quiz-type-btn${qzType===t?' active':''}" onclick="qzSetType('${t}')">${t}</button>`).join('')}
  </div>
  <div id="qz-area"></div>`;
}

function qzSetCount(v) {
  qzQuestionCount=parseInt(v);
  progressState.ui.qzQuestionCount = qzQuestionCount;
  cacheProgressLocally(); scheduleSync();
  // FIX (Bug 2 gốc — đổi số câu reset tiến trình): trước đây bindQuiz(true) ép nạp lại hàng đợi từ
  // đầu (mất answeredCount/thứ tự đang học dở). 'adjust' chỉ đổi KÍCH THƯỚC hàng đợi hiện có (xem
  // sqAdjustLimit ở study-queue.js) — giữ nguyên phần đã học.
  bindQuiz('adjust');
}
function qzSetType(t) {
  qzType=t;
  progressState.ui.qzType = qzType;
  cacheProgressLocally(); scheduleSync();
  bindQuiz('adjust'); // đổi chiều hỏi không đổi TẬP từ đang học — giữ nguyên hàng đợi (xem qzSetCount)
}

// Tải toàn bộ ví dụ theo từ (kho đảm bảo mỗi từ có sẵn vài câu) cho các bài đang học
async function qzLoadSentencePool() {
  qzWordExamples = [];
  const lessons = lessonsAllMode ? lessonsOfSelection() : [...selectedLessons];
  if (!lessons.length || isGuest || !authToken) return;
  try {
    const res = await fetch('/api/word-examples?lessons=' + lessons.join(','), { headers: authHeaders() });
    const data = await res.json();
    if (data.ok && Array.isArray(data.examples)) qzWordExamples = data.examples;
  } catch {
    // Không có câu ví dụ thì thôi, không chặn phần trắc nghiệm
  }
}
// Chọn NGẪU NHIÊN 1 trong các câu ví dụ có sẵn của đúng từ đang hỏi
function qzFindExample(hz) {
  const matches = qzWordExamples.filter(e => e.hz === hz);
  if (matches.length === 0) return null;
  return matches[Math.floor(Math.random() * matches.length)];
}

function bindQuiz(forceReload) { _bindQuizAsync(forceReload); }
// V70/V71: user ĐÃ ĐĂNG NHẬP lấy câu hỏi từ ĐÚNG hàng đợi FSRS thật (due + new hôm nay), nạp 1 LẦN
// vào qzQueue rồi đi CHỐNG LẶP hoàn toàn ở client (xem sqAdvance) — không tự ý gọi lại server giữa
// phiên. KHÁCH vẫn dùng pool theo bài đang chọn để thử app, không lưu tiến độ.
// V74 (audit lặp câu hỏi): render()/goTab() gọi bindQuiz() MỖI LẦN vào tab 'quiz' — trước đây luôn
// sqLoad() lại dù đang học dở giữa chừng, xoá mất trạng thái chống lặp (thẻ vừa đúng có thể hiện
// lại sau khi rời rồi quay lại tab). Còn câu trong hàng đợi thì chỉ vẽ lại.
// forceReload nhận 3 giá trị: falsy = vào tab bình thường (giữ nguyên nếu đang có hàng đợi, thử
// khôi phục từ localStorage nếu đây là lần đầu bind trong trang này — FIX Bug 2 "refresh mất tiến
// trình"); 'adjust' = đổi số câu/chiều hỏi, chỉ thay đổi KÍCH THƯỚC hàng đợi hiện có (sqAdjustLimit)
// — không mất tiến trình; true = ép nạp mới hoàn toàn (hiện không còn nơi nào gọi, giữ lại để dự phòng).
let qzRestoreAttempted = false;
async function _bindQuizAsync(forceReload) {
  const area0 = document.getElementById('qz-area');
  if (forceReload === 'adjust' && (qzQueue.items.length > 0 || qzQueue.answeredCount > 0)) {
    const { error } = await sqAdjustLimit(qzQueue, qzQuestionCount);
    if (currentTab !== 'quiz') return;
    if (error) { if (area0) area0.innerHTML = `<div class="panel center" style="padding:24px">⚠️ ${error}</div>`; return; }
    qzRenderQ();
    return;
  }
  if (!forceReload && qzQueue.items.length > 0) { qzRenderQ(); return; }
  if (!forceReload && !qzRestoreAttempted) {
    qzRestoreAttempted = true;
    const extra = sqRestoreIntoQueue('quiz', qzQueue);
    if (extra) { qzScore = extra.score || 0; qzRenderQ(); qzLoadSentencePool().then(() => qzRenderQ()); return; }
  }
  qzScore = 0;
  const area = document.getElementById('qz-area');
  if (isLoggedIn() && area) area.innerHTML = `<div class="panel center" style="padding:24px">⏳ Đang tải hàng đợi FSRS...</div>`;
  const { error } = await sqLoad(qzQueue, qzQuestionCount);
  if (currentTab !== 'quiz') return; // user đã rời tab trong lúc chờ tải
  if (error) { if (area) area.innerHTML = `<div class="panel center" style="padding:24px">⚠️ ${error}</div>`; return; }
  qzRenderQ();
  qzLoadSentencePool().then(() => qzRenderQ()); // nạp xong thì vẽ lại để hiện câu ví dụ nếu có
}

function qzRenderQ() {
  sqPersist('quiz', qzQueue, { score: qzScore }); // FIX (Bug 2 — session persistence): lưu lại mọi lần vẽ để refresh không mất tiến trình
  const area = document.getElementById('qz-area');
  if (!area) return;
  if (qzQueue.totalPlanned === 0) {
    const msg = isLoggedIn()
      ? '🎉 Không còn thẻ nào đến hạn hoặc từ mới trong ngân sách hôm nay!<br><span style="font-size:.85rem;color:var(--muted)">Vào "🎯 Hôm nay học" để xem/chỉnh giới hạn.</span>'
      : 'Không có từ nào trong phạm vi bài đang chọn!';
    area.innerHTML = `<div class="panel center" style="padding:24px">${msg}</div>`;
    return;
  }
  if (qzQueue.items.length === 0) {
    area.innerHTML = `<div class="panel exam-result">
      <div class="exam-score">${qzScore}/${qzQueue.answeredCount}</div>
      <div class="exam-rank">${qzRank(qzScore/qzQueue.answeredCount)}</div>
      <button class="btn btn-primary" onclick="bindQuiz()">Làm lại</button>
    </div>`;
    if (isLoggedIn()) refreshServerMeta(); // hết phiên — làm mới streak/known thật
    return;
  }
  const w = qzQueue.items[0];
  const opts = rvMakeOpts(w); // V70: dùng chung bộ sinh nhiễu với "Hôm nay học" (pool = toàn bộ WORDS)
  let qHtml, optHtml;
  if (qzType === '漢→Việt') {
    qHtml = `<div class="fc-hz">${w.hz}</div>${showPinyin?`<div class="fc-py">${w.py}</div>`:''}${showHanViet && w.hanviet?`<div class="fc-hv">Hán Việt: ${w.hanviet}</div>`:''}`;
    optHtml = opts.map(o=>`<button class="quiz-opt" data-v="${o.vi}" onclick="qzPick(this,'${o.hz}')">${o.vi}</button>`).join('');
  } else if (qzType === 'Việt→漢') {
    qHtml = `<div class="fc-vi" style="font-size:1.3rem">${w.vi}</div>`;
    optHtml = opts.map(o=>`<button class="quiz-opt" data-v="${o.hz}" onclick="qzPick(this,'${o.hz}')">${o.hz}${showPinyin?`<div class="quiz-sub">${o.py}</div>`:''}${showHanViet && o.hanviet?`<div class="quiz-hv">${o.hanviet}</div>`:''}</button>`).join('');
  } else {
    qHtml = `<div class="fc-py" style="font-size:1.4rem;font-style:normal;color:var(--ink)">${w.py}</div>`;
    optHtml = opts.map(o=>`<button class="quiz-opt" data-v="${o.hz}" onclick="qzPick(this,'${o.hz}')">${o.hz}</button>`).join('');
  }
  const example = qzFindExample(w.hz);
  const exampleHtml = example
    ? `<div style="font-size:.82rem;color:var(--muted);text-align:center;padding:0 12px 4px;line-height:1.5;">📖 <b style="color:var(--ink)">${example.zh.replace(w.hz, `<span style="color:var(--active-dark);font-weight:800">${w.hz}</span>`)}</b>${showMeaning ? `<br>${example.vi}` : ''}</div>`
    : '';
  // Chỉ hiện chiết tự bộ thủ khi chữ Hán đã hiện sẵn trong câu hỏi (漢→Việt) — các chế độ khác
  // (Việt→漢, Âm→漢) chữ Hán chính là đáp án cần đoán, hiện chiết tự sẽ lộ đáp án.
  const partsHtml = qzType === '漢→Việt' ? renderHanziParts(w.hz, true) : '';
  area.innerHTML = `
    <div class="panel">
      <div style="font-size:.75rem;color:var(--muted);font-weight:700;margin-bottom:6px">Câu ${qzQueue.answeredCount+1} · còn ${qzQueue.items.length} trong hàng đợi · ${Math.round(qzScore/(qzQueue.answeredCount||1)*100)}% đúng</div>
      <div class="quiz-q">${qHtml}</div>
      ${exampleHtml}
      ${partsHtml}
      <div class="quiz-opts" id="qz-opts">${optHtml}</div>
    </div>`;
  document.querySelectorAll('#qz-opts .quiz-opt').forEach(b=>{
    b._correct = (b.dataset.v === (qzType==='漢→Việt' ? w.vi : w.hz));
  });
  qzStartedAt = performance.now(); // Phần 4: đo từ thời điểm câu hỏi THỰC SỰ hiển thị
}

// V70/V71: mỗi lượt trả lời đi qua ĐÚNG reviewService.reviewCard() (user đã đăng nhập). Server tự
// xác định đúng/sai + suy FSRS rating. sqAdvance() đảm bảo thẻ vừa đúng bị loại khỏi phiên ngay,
// thẻ sai chỉ lặp lại sau tối thiểu REPEAT_GAP thẻ khác — KHÔNG bao giờ tự gọi lại server giữa
// chừng phiên (hàng đợi cạn thật mới coi là hết phiên, xem qzRenderQ).
async function qzPick(btn, hz) {
  const w = qzQueue.items[0];
  const isCorrectLocally = btn._correct;
  const responseTimeMs = performance.now() - qzStartedAt;
  document.querySelectorAll('#qz-opts .quiz-opt').forEach(b=>{
    if (b._correct) b.classList.add('correct');
    else if (b === btn && !isCorrectLocally) b.classList.add('wrong');
    b.disabled=true;
  });
  if (isCorrectLocally) playDing(); else playBuzz();
  speak(w.hz);
  if (isCorrectLocally) qzScore++;
  // FIX (Bug 1 gốc — "UI chuyển câu nhưng Neon chưa lưu"): TRƯỚC ĐÂY submitFsrsReview() chạy NỀN,
  // KHÔNG chờ, nên UI có thể chuyển câu (và user có thể refresh/đóng tab) trước khi Neon xác nhận
  // đã lưu — mất dữ liệu. Giờ ĐỢI submitFsrsReviewAwaited() (có trần chờ, xem study-queue.js) SONG
  // SONG với đúng khoảng nghỉ hiển thị đáp án 1400ms như cũ — mạng nhanh thì tổng thời gian KHÔNG
  // đổi so với trước (vẫn 1400ms), mạng chậm thì đợi thêm chứ không chuyển câu "hụt".
  if (isLoggedIn()) {
    await Promise.all([
      submitFsrsReviewAwaited({ word: w, quizType: fsrsQuizTypeFor(qzType), selectedAnswer: btn.dataset.v, responseTimeMs }),
      new Promise(r => setTimeout(r, 1400)),
    ]);
  } else {
    guestMarkActivity();
    await new Promise(r => setTimeout(r, 1400));
  }
  if (currentTab !== 'quiz' || qzQueue.items[0] !== w) return; // user đã rời tab hoặc hàng đợi đã đổi trong lúc chờ
  sqAdvance(qzQueue, isCorrectLocally); qzRenderQ();
}

// Nhóm từ theo chủ đề ngữ nghĩa (cùng phạm trù dễ gây nhầm lẫn khi học, dù chữ Hán không liên quan)
const SEMANTIC_GROUPS = [
  ['白','白色','黑','红','绿','蓝'],
  ['东边','西边','南边','北边','里边','外边','上边','下边','前边','后边','左边','右边','中间','里'],
  ['星期一','星期二','星期三','星期四','星期五','星期六','星期天','星期'],
  ['爸爸','妈妈','哥哥','姐姐','弟弟','妹妹'],
  ['一','二','三','四','五','六','七','八','九','十','百','千','万','零'],
  ['人民币','美元','港币','日元','欧元'],
  ['早上','上午','中午','下午','晚上','早','晚'],
  ['今天','明天','昨天','今年','去年','明年','后年'],
  ['中国','中文','英国','英文','美国','法国','法文','德国','德语','韩国','韩文','日本（国）','日文','俄国','俄文','西班牙语','西班牙文','阿拉伯语','日语','英语','法语','俄语','韩国语'],
  ['个','位','本','张','支','辆','件','条','层','座','道','遍','片','斤','公斤','瓶','块'],
];
let _semanticMap = null;
function getSemanticMap() {
  if (_semanticMap) return _semanticMap;
  _semanticMap = {};
  SEMANTIC_GROUPS.forEach(g => {
    g.forEach(h => {
      if (!_semanticMap[h]) _semanticMap[h] = new Set();
      g.forEach(h2 => { if (h2 !== h) _semanticMap[h].add(h2); });
    });
  });
  return _semanticMap;
}

// Bản đồ tra nhanh: chữ Hán -> tập các chữ Hán "dễ nhầm" cùng nhóm (từ CONFUSE_GROUPS)
let _confuseMap = null;
function getConfuseMap() {
  if (_confuseMap) return _confuseMap;
  _confuseMap = {};
  CONFUSE_GROUPS.forEach(g => {
    const hzs = g.chars.map(c => c.hz);
    hzs.forEach(h => {
      if (!_confuseMap[h]) _confuseMap[h] = new Set();
      hzs.forEach(h2 => { if (h2 !== h) _confuseMap[h].add(h2); });
    });
  });
  return _confuseMap;
}

// Từ nối/hư từ tiếng Việt hay lặp lại trong bản dịch — bỏ qua để so khớp ngữ nghĩa chính xác hơn
const VI_STOPWORDS = new Set(['và','là','có','của','một','rất','này','đó','với','hay','cũng','cần','cho','khi','ra','lên','xuống','trong','ngoài','trước','sau','gì','nào','thế','làm','đi','đến','ở','ạ','thì','còn','sẽ','đã','đang','bị','được','như','các','những','vì','nên','mà','nếu','nữa','chỉ','vẫn','phải','không','hoặc']);
function viTokens(vi) {
  return (vi || '').toLowerCase()
    .replace(/[()]/g, '')
    .split(/[,\/;]|\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 1 && !VI_STOPWORDS.has(t));
}

// V67: dùng chung cho cả tab Trắc nghiệm (pool = getFilteredWords, theo đúng phạm vi bài user
// đang chọn) và phiên Review/FSRS (pool = toàn bộ WORDS, vì 1 thẻ due có thể thuộc bài NGOÀI
// phạm vi filter hiện tại — lesson-priority chỉ quyết định NEW word, không giới hạn distractors).
function makeQuizOpts(w, pool) {
  const all = pool;
  const confuseSet = getConfuseMap()[w.hz];
  const wTokens = viTokens(w.vi);
  // Chấm điểm mức độ "dễ nhầm" của mỗi từ so với từ đang hỏi:
  // 1) cùng nhóm dễ nhầm đã định nghĩa (hình dạng/âm giống nhau) > 2) trùng ký tự Hán
  // > 3) trùng từ khoá trong nghĩa (ngữ nghĩa giống nhau) > 4) cùng phân loại/bài học > 5) độ dài giống nhau
  const scored = all.filter(x => x.hz !== w.hz).map(x => {
    let s = 0;
    if (confuseSet && confuseSet.has(x.hz)) s += 12;
    const semSet = getSemanticMap()[w.hz];
    if (semSet && semSet.has(x.hz)) s += 8;
    for (const c of w.hz) { if (x.hz.includes(c)) s += 3; }
    const xTokens = viTokens(x.vi);
    s += xTokens.filter(t => wTokens.includes(t)).length * 4;
    if (w.cat && x.cat === w.cat) s += 3;
    if (x.l === w.l) s += 1;
    if (x.hz.length === w.hz.length) s += 0.5;
    return {x, s};
  });
  scored.sort((a,b) => b.s - a.s);
  // Các từ điểm rất cao (trùng nhóm dễ nhầm đã định nghĩa, hoặc trùng nhiều ký tự/nghĩa) luôn được ưu tiên chọn,
  // phần còn lại mới xáo trộn ngẫu nhiên để câu hỏi không lặp lại y hệt mỗi lần
  const mustInclude = scored.filter(p => p.s >= 8).slice(0, 3).map(p => p.x);
  const restPool = scored.filter(p => p.s < 8).slice(0, 12).map(p => p.x);
  let distractors = mustInclude.slice(0, 3);
  if (distractors.length < 3) {
    distractors = distractors.concat(shuffle(restPool).slice(0, 3 - distractors.length));
  }
  return shuffle([w, ...distractors]);
}
function rvMakeOpts(w) { return makeQuizOpts(w, WORDS.filter(x => isLoggedIn() || x.l <= GUEST_MAX_LESSON)); }

function qzRank(r) {
  if(r>=.9) return '🏆 Xuất sắc'; if(r>=.7) return '👍 Tốt'; if(r>=.5) return '📚 Cần ôn'; return '🔄 Học lại';
}

