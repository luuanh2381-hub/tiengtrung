// js/review.js — Tab "Hôm nay học" → phiên ôn tập thật (rv*), auto-rating FSRS, không còn nút Again/Hard/Good/Easy
// ════════════════════════════════════════════════════
// REVIEW SESSION — V67: AUTO FSRS RATING, không còn nút Again/Hard/Good/Easy.
// Flow mới (Phần 1/2/17): hiện chữ Hán → user chọn 1 trong 4 đáp án trắc nghiệm → hệ thống tự
// xác định đúng/sai + đo responseTime → gửi lên server → server tự suy ra FSRS rating, gọi
// ts-fsrs, lưu lịch → lộ đáp án đầy đủ (pinyin/nghĩa/Hán Việt/chiết tự/ví dụ) → tự chuyển câu kế.
// Người dùng KHÔNG bao giờ thấy rating Again/Hard/Good/Easy trong chế độ mặc định (Phần 2/18).
// ════════════════════════════════════════════════════
let rvSession = [];
let rvPhase = 'question'; // 'question' (đang chờ chọn đáp án) | 'answered' (đã có kết quả)
let rvWeakMode = false;
let rvSummary = { reviewCount: 0, newCount: 0 };
let rvExamplePool = [];
let rvSubmitting = false;
let rvOptions = [];      // 4 lựa chọn trắc nghiệm của câu hiện tại (sinh 1 lần/câu, không sinh lại mỗi lần render)
let rvStartedAt = 0;     // performance.now() tại thời điểm câu hỏi THỰC SỰ hiển thị cho user (Phần 4)
let rvAnswerChanges = 0; // UI hiện tại chọn là chốt ngay (không cho đổi trước khi submit) nên luôn 0 (Phần 16/17)
let rvLastAnswer = null; // { correct, card, autoRating } — kết quả lượt vừa submit, để hiện feedback (Phần 18)
let rvTotalPlanned = 0;   // V71: cỡ hàng đợi lúc nạp (để tính % tiến độ; rvSession có thể tạm dài hơn do Again được chèn lại)
let rvAnsweredCount = 0;  // V71: số câu đã trả lời (kể cả Again) trong phiên này
let rvSessionId = null;   // FIX (Bug 2 — session persistence): định danh phiên hiện tại, dùng để lưu/khôi phục qua localStorage
const RV_QUIZ_TYPE = 'hz2vi'; // Phần 1: mặc định hỏi "chữ Hán → nghĩa", khớp đúng ví dụ trong yêu cầu V67

// FIX (Bug 2 — session persistence): lưu lại TOÀN BỘ trạng thái phiên "Hôm nay học" hiện tại
// (items/sessionId/totalPlanned/answeredCount + tóm tắt) — dùng cùng cơ chế sqPersist() ở
// study-queue.js. Khoá riêng theo weakMode ('review' thường vs 'review-weak') để không lẫn 2 loại
// phiên khi khôi phục.
function rvPersist() {
  sqPersist('review' + (rvWeakMode ? '-weak' : ''),
    { sessionId: rvSessionId, items: rvSession, doneHz: new Set(), totalPlanned: rvTotalPlanned, answeredCount: rvAnsweredCount },
    { summary: rvSummary });
}

// V71: khử trùng lặp {type,word} theo word.hz — cùng lý do với sqDedupeByHz (1 chữ Hán có thể gắn
// với 2 "thẻ" khác nhau ở 2 bài khác nhau phía server). V74: lọc thêm sessionKnownHz (study-queue.js)
// để không nạp lại từ vừa trả lời ĐÚNG ở tab Flashcard/Trắc nghiệm/Gõ chữ/Nghe-chọn trong cùng phiên.
function rvDedupeSession(list) {
  const seen = new Set();
  return list.filter(it => {
    if (seen.has(it.word.hz) || sessionKnownHz.has(it.word.hz)) return false;
    seen.add(it.word.hz);
    return true;
  });
}

async function startStudySession(weakMode) {
  rvWeakMode = !!weakMode;
  // FIX (Bug 2 gốc — refresh giữa phiên "Hôm nay học" làm mất tiến trình): nếu vẫn còn 1 phiên hợp
  // lệ (cùng weakMode, lưu chưa quá hạn — xem SQ_SESSION_MAX_AGE_MS) từ trước lúc rời trang/F5, TIẾP
  // TỤC đúng phiên đó thay vì luôn gọi API tạo phiên mới — không mất câu đang học dở, không lặp từ đầu.
  // (rvSession là 1 biến top-level riêng, không phải object dạng sq* — đọc trực tiếp bằng
  // sqReadPersisted() rồi gán tay vào đúng các biến rv*, không tái dùng sqRestoreIntoQueue() vốn
  // dành cho object có field .items/.totalPlanned/... thật sự.)
  const savedKey = 'review' + (rvWeakMode ? '-weak' : '');
  const saved = sqReadPersisted(savedKey);
  if (saved && saved.items.length) {
    const filteredItems = saved.items.filter(it => !sessionKnownHz.has(it.word.hz));
    const purged = saved.items.length - filteredItems.length;
    if (filteredItems.length) {
      rvSession = filteredItems;
      rvSessionId = saved.sessionId;
      rvTotalPlanned = saved.totalPlanned;
      rvAnsweredCount = saved.answeredCount + purged;
      rvSummary = (saved.extra && saved.extra.summary) || rvSummary;
      rvExamplePool = []; rvLastAnswer = null;
      goTab('review');
      rvPrepareCurrentCard();
      render();
      return;
    }
  }
  rvExamplePool = []; rvLastAnswer = null;
  rvAnsweredCount = 0;
  rvSessionId = genIdempotencyKey();
  goTab('review');
  const el = document.getElementById('content');
  if (el) el.innerHTML = `<div class="study-empty">Đang tải phiên học...</div>`;
  try {
    if (rvWeakMode) {
      const res = await fetch('/api/study/weak-words', { headers: authHeaders() });
      const data = await res.json();
      if (!data.ok) { alert(data.error || 'Không tải được từ hay quên'); goTab('today'); return; }
      rvSession = rvDedupeSession(data.words.map(w => ({ type: 'review', word: w })));
      rvSummary = { reviewCount: rvSession.length, newCount: 0 };
    } else {
      const res = await fetch('/api/study/session', { headers: authHeaders() });
      const data = await res.json();
      if (!data.ok) { alert(data.error || 'Không tải được phiên học'); goTab('today'); return; }
      rvSession = rvDedupeSession(data.session || []);
      rvSummary = { reviewCount: data.reviewCount || 0, newCount: data.newCount || 0 };
    }
  } catch (e) {
    alert('Lỗi kết nối: ' + e.message);
    goTab('today');
    return;
  }
  rvTotalPlanned = rvSession.length;
  // Nạp trước kho ví dụ cho các bài xuất hiện trong session (Phần 24) — không chặn hiển thị.
  const lessonsInSession = [...new Set(rvSession.map(it => it.word.l))];
  if (lessonsInSession.length && !isGuest && authToken) {
    fetch('/api/word-examples?lessons=' + lessonsInSession.join(','), { headers: authHeaders() })
      .then(r => r.json()).then(d => { if (d.ok) rvExamplePool = d.examples || []; })
      .catch(() => {});
  }
  rvPersist();
  rvPrepareCurrentCard();
  render();
}

function rvFindExample(hz) {
  const matches = rvExamplePool.filter(e => e.hz === hz);
  if (!matches.length) return null;
  return matches[Math.floor(Math.random() * matches.length)];
}

// Sinh 4 lựa chọn trắc nghiệm cho thẻ Ở ĐẦU hàng đợi, và bắt đầu đo responseTime NGAY tại đây
// (thời điểm câu hỏi thực sự sẵn sàng cho user — Phần 4, không tính thời gian từ lúc mở session).
function rvPrepareCurrentCard() {
  if (!rvSession.length) return;
  const w = rvSession[0].word;
  rvOptions = rvMakeOpts(w);
  rvAnswerChanges = 0;
  rvPhase = 'question';
  rvLastAnswer = null;
  rvStartedAt = performance.now();
}

// Ước lượng còn bao lâu tới lần ôn tiếp theo, chỉ để hiển thị thông tin cho user (Phần 18) —
// KHÔNG dùng để quyết định gì thêm, due thật đã được server/FSRS tính và lưu xong.
function rvSavedLine(r) {
  if (!r) return '';
  if (!r.card || !r.card.due) return '📌 Đã lưu lịch ôn';
  const diffMs = new Date(r.card.due).getTime() - Date.now();
  const diffDays = Math.round(diffMs / 86400000);
  if (diffDays <= 0) return '📌 Đã lưu lịch ôn — sẽ xuất hiện lại rất sớm';
  if (diffDays === 1) return '📌 Đã lưu lịch ôn — ôn lại sau 1 ngày';
  return `📌 Đã lưu lịch ôn — ôn lại sau ${diffDays} ngày`;
}

function renderReview() {
  if (!rvSession.length) {
    return `<div class="rv-done">
      <div class="rv-done-num">🎉</div>
      <div style="font-size:1.3rem;font-weight:800;margin:10px 0;">Xong phiên học!</div>
      <div style="color:var(--muted);margin-bottom:20px;">Đã ôn ${rvSummary.reviewCount} từ, học ${rvSummary.newCount} từ mới.</div>
      <button class="btn btn-primary" onclick="goTab('today')">Về Hôm nay học</button>
    </div>`;
  }
  const item = rvSession[0];
  const w = item.word;
  const pct = Math.min(100, Math.round((rvAnsweredCount / (rvTotalPlanned||1)) * 100));
  const tagLabel = item.type === 'new' ? '🆕 Từ mới' : '🔁 Ôn tập';
  let body;
  if (rvPhase === 'question') {
    // Chỉ 1 bước duy nhất: nhìn chữ Hán → chọn nghĩa đúng (Phần 1/17). Không có bước "tự nhớ rồi
    // bấm Đúng/Sai" riêng như v66 — hệ thống tự xác định đúng/sai khi user chọn đáp án.
    const optHtml = rvOptions.map(o =>
      `<button class="quiz-opt" data-v="${o.vi}" onclick="rvPick(this,'${o.hz}')" ${rvSubmitting ? 'disabled' : ''}>${o.vi}</button>`
    ).join('');
    body = `
      <div class="rv-tag">${tagLabel} · Bài ${w.l}</div>
      <div class="rv-hz">${w.hz}</div>
      ${showPinyin ? `<div class="rv-py">${w.py || ''}</div>` : ''}
      <div class="rv-prompt">${w.hz} là gì?</div>
      <div class="quiz-opts" id="rv-opts">${optHtml}</div>`;
  } else {
    // Đã có kết quả: lộ đáp án đầy đủ + trạng thái lưu FSRS. KHÔNG hiện Again/Hard/Good/Easy
    // (Phần 2/18) — chỉ hiện khi bật chế độ debug/advanced dành cho admin (Phần 19/22).
    const r = rvLastAnswer;
    const ex = rvFindExample(w.hz);
    body = `
      <div class="rv-tag">${tagLabel} · Bài ${w.l}</div>
      <div class="rv-hz">${w.hz}</div>
      <div class="rv-feedback" style="color:${r && r.correct ? 'var(--l8a)' : 'var(--l10a)'};">
        ${r && r.correct ? '✅ Chính xác' : '❌ Chưa đúng'}
      </div>
      ${showPinyin ? `<div class="rv-py">${w.py || ''}</div>` : ''}
      ${showMeaning ? `<div class="rv-vi">${w.vi || ''}</div>` : ''}
      ${showHanViet && w.hanviet ? `<div class="rv-hv">Hán Việt: ${w.hanviet}</div>` : ''}
      ${renderHanziParts(w.hz)}
      ${ex ? `<div class="rv-ex">${ex.zh}<br><span style="color:var(--muted);font-size:.85rem;">${ex.vi}</span></div>` : ''}
      <div class="rv-saved-line">${rvSavedLine(r)}</div>
      ${(!isGuest && isAdminRole() && r && r.autoRating) ? `<div class="rv-saved-line">🐞 debug: auto rating = ${r.autoRating}</div>` : ''}`;
  }
  return `
    <div class="rv-progress-wrap"><div class="rv-progress-fill" style="width:${pct}%;"></div></div>
    <div class="rv-counter">Câu ${rvAnsweredCount + 1} · còn ${rvSession.length} trong hàng đợi</div>
    <div class="rv-card">${body}</div>
  `;
}

// Đánh dấu đáp án đúng lên từng nút NGAY SAU KHI render xong (Phần 17), giống cách bindQuiz đang
// làm cho tab Trắc nghiệm — để rvPick() biết ngay đáp án vừa chọn đúng hay sai mà không cần chờ
// server trả lời (server vẫn là nguồn sự thật cuối cùng, việc này chỉ để phản hồi UI tức thời).
function bindReview() {
  if (rvPhase !== 'question' || !rvSession.length) return;
  const w = rvSession[0].word;
  document.querySelectorAll('#rv-opts .quiz-opt').forEach(b => {
    b._correct = (b.dataset.v === w.vi);
  });
}

// ── Phần 1/3/4/17/20: user chọn 1 đáp án → khoá UI, hiện đúng/sai tức thời → gửi
//     selectedAnswer + responseTimeMs lên server (server tự xác định lại đúng/sai + tự suy ra
//     FSRS rating + gọi ts-fsrs + lưu). ──
let rvAttemptId = 0; // FIX: đánh dấu lượt trả lời hiện tại — phản hồi server đến TRỄ (sau khi user
                      // đã sang câu khác) sẽ tự bị bỏ qua thay vì ghi đè nhầm màn hình câu sau.
async function rvPick(btn, hz) {
  if (rvSubmitting || rvPhase !== 'question') return;
  rvSubmitting = true;
  const responseTimeMs = Math.round(performance.now() - rvStartedAt); // Phần 4
  const item = rvSession[0];
  const w = item.word;
  const isCorrectLocally = !!btn._correct;
  const selectedAnswer = btn.dataset.v;
  const attemptId = ++rvAttemptId;

  document.querySelectorAll('#rv-opts .quiz-opt').forEach(b => {
    if (b._correct) b.classList.add('correct');
    else if (b === btn && !isCorrectLocally) b.classList.add('wrong');
    b.disabled = true;
  });
  if (isCorrectLocally) playDing(); else playBuzz();
  speak(w.hz);

  // Hiện đáp án NGAY bằng kết quả đã biết ở client (đáp án đúng đã nhúng sẵn trong DOM) — không đợi
  // Neon mới hiện đúng/sai, giữ UI phản hồi tức thời.
  rvLastAnswer = { correct: isCorrectLocally, card: null, autoRating: null };
  rvPhase = 'answered';
  rvSubmitting = false;
  render();

  // FIX (Bug 1 gốc — "UI chuyển câu nhưng Neon chưa lưu"): TRƯỚC ĐÂY setTimeout(rvAdvance, 1600)
  // chạy ĐỘC LẬP với submitFsrsReview() (chạy nền, không chờ) — câu tiếp theo có thể hiện ra (và
  // user có thể refresh/đóng tab) trước khi Neon xác nhận đã lưu. Giờ ĐỢI submitFsrsReviewAwaited()
  // (có trần chờ, xem study-queue.js) SONG SONG với đúng khoảng nghỉ hiển thị đáp án 1600ms như cũ.
  const reviewPromise = submitFsrsReviewAwaited({ word: w, quizType: RV_QUIZ_TYPE, selectedAnswer, responseTimeMs, answerChanges: rvAnswerChanges })
    .then(data => {
      // Chỉ cập nhật lại màn hình nếu user VẪN đang xem đúng câu này (chưa bị rvAdvance chuyển đi).
      if (attemptId !== rvAttemptId || rvPhase !== 'answered' || currentTab !== 'review') return;
      if (data && data.ok) {
        rvLastAnswer = { correct: data.answerCorrect, card: data.card, autoRating: data.debug ? data.debug.autoRating : null };
        render(); // cập nhật dòng "đã lưu lịch ôn sau N ngày" cho chính xác (nếu kịp trước khi advance)
      }
    });
  await Promise.all([reviewPromise, new Promise(r => setTimeout(r, 1600))]);
  if (attemptId !== rvAttemptId || currentTab !== 'review') return; // user đã sang câu khác/rời tab trong lúc chờ
  rvAdvance();
}

// V71: thẻ Ở ĐẦU hàng đợi bị loại NGAY LẬP TỨC sau khi có kết quả server. Đúng → loại vĩnh viễn
// khỏi phiên (rvSession.shift() ngay dưới đây đã là nguồn sự thật duy nhất cho "còn lại gì trong
// phiên" — V76 dọn bỏ biến rvDoneHz vì trước đây chỉ được .add() chứ không hề được đọc ở đâu, tức
// không hề ảnh hưởng "từ tiếp theo là từ nào", Yêu cầu 2). Sai (Again) → chèn lại cách tối thiểu
// REPEAT_GAP thẻ khác, KHÔNG gọi lại server giữa phiên — hàng đợi cạn thật (kể cả các thẻ Again đã
// được xử lý xong) mới coi là hết.
function rvAdvance() {
  if (currentTab !== 'review') return; // user đã rời màn hình, tránh render nhầm chỗ
  const it = rvSession.shift();
  if (it) {
    rvAnsweredCount++;
    const isCorrect = !!(rvLastAnswer && rvLastAnswer.correct);
    if (isCorrect) { sessionKnownHz.add(it.word.hz); saveSessionKnownHz(); sqPurgeHzFromAllQueues(it.word.hz); } // V74: loại khỏi TẤT CẢ tab khác; FIX (Ưu tiên 2): persist qua reload; FIX (Ưu tiên 1): purge khỏi hàng đợi tab khác
    else rvSession.splice(Math.min(REPEAT_GAP, rvSession.length), 0, it);
  }
  if (!rvSession.length) { refreshServerMeta(); sqClearPersisted('review' + (rvWeakMode ? '-weak' : '')); } // hết phiên — làm mới streak/known thật, dọn session đã lưu
  else rvPersist(); // FIX (Bug 2 — session persistence): lưu lại sau mỗi câu để refresh không mất tiến trình
  rvPrepareCurrentCard();
  render();
}

