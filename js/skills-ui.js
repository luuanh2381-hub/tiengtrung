// js/skills-ui.js — Tab "Phân tích năng lực" (V104): tổng quan, danh sách từ cần cải thiện, luyện
// theo kỹ năng, tiến bộ theo thời gian. Mọi số liệu lấy từ server (/api/skills/*) theo đúng tài khoản
// đang đăng nhập. Bài luyện ở đây là luyện BỔ SUNG: gửi qua submitSkillPractice() (study-queue.js,
// dùng chung outbox) → KHÔNG đổi lịch ôn FSRS.

const SK_LABEL = { recognition: 'Nhận diện', recall: 'Nhớ chủ động', listening: 'Nghe', pinyin: 'Pinyin', pronunciation: 'Phát âm', context: 'Từ trong câu' };
const SK_MEASURED = ['recognition', 'recall', 'listening', 'pinyin', 'context'];
let skState = { loaded: false, loading: false, error: null, overview: null, weak: [], weakHasMore: false, weakOffset: 0, trend: null, bucket: 'week', practice: null };

function skAudioOk() { return typeof skillAudioAvailable === 'function' && skillAudioAvailable(); }

function renderSkills() {
  if (!isLoggedIn()) {
    return `<div class="panel center" style="padding:24px">Hãy đăng nhập để xem phân tích năng lực theo kỹ năng.</div>`;
  }
  if (skState.practice) return skRenderPractice();
  if (skState.loading && !skState.loaded) return `<div class="panel center" style="padding:24px">⏳ Đang tải phân tích năng lực...</div>`;
  if (skState.error) {
    return `<div class="panel center" style="padding:24px">⚠️ ${escapeHtml(skState.error)}<br><button class="btn" style="margin-top:10px" onclick="skReload()">Thử lại</button></div>`;
  }
  if (typeof saState !== 'undefined' && saState.word) return saRenderWordDetail(); // V110: xem chi tiết 1 từ
  // V110: khuyến nghị lên đầu (hành động được), rồi tổng quan, trí nhớ sau khoảng nghỉ, luyện tập, từ yếu, dạng bài, tiến bộ.
  return saRenderRecs() + skRenderOverview() + saRenderRetention() + skRenderPracticeLauncher() + saRenderWordSearch()
    + skRenderWeakList() + saRenderByType() + skRenderTrend();
}

function bindSkills() {
  if (isLoggedIn() && skState.practice && skState.practice.q && skState.practice.q.typed) { // V110: đặt con trỏ vào ô gõ
    setTimeout(() => { const i = document.getElementById('sk-typed'); if (i) i.focus(); }, 120);
  }
  if (!isLoggedIn() || skState.practice) return;
  if (!skState.loaded && !skState.loading) skReload();
}

async function skFetchJson(url) {
  const res = await fetch(url, { headers: authHeaders() });
  const data = await res.json().catch(() => null);
  if (!data || !data.ok) throw new Error((data && data.error) || 'Không tải được dữ liệu');
  return data;
}

// Tải 3 nguồn SONG SONG (không nối tiếp) rồi vẽ 1 lần.
async function skReload() {
  skState.loading = true; skState.error = null;
  if (currentTab === 'skills') render();
  try {
    const [overview, weak, trend] = await Promise.all([
      skFetchJson('/api/skills/overview'),
      skFetchJson('/api/skills/weak-words?limit=20&offset=0'),
      skFetchJson('/api/skills/trend?days=60&bucket=' + skState.bucket),
    ]);
    skState.overview = overview;
    skState.weak = weak.items || []; skState.weakHasMore = !!weak.hasMore; skState.weakOffset = skState.weak.length;
    skState.trend = trend;
    skState.loaded = true;
    if (typeof saLoadExtras === 'function') saLoadExtras(); // V110: tải nền (không chặn phần chính)
  } catch (e) {
    skState.error = e.message;
  }
  skState.loading = false;
  if (currentTab === 'skills' && !skState.practice) render();
}

async function skLoadMoreWeak() {
  try {
    const d = await skFetchJson('/api/skills/weak-words?limit=20&offset=' + skState.weakOffset);
    skState.weak = skState.weak.concat(d.items || []);
    skState.weakHasMore = !!d.hasMore; skState.weakOffset = skState.weak.length;
    if (currentTab === 'skills') render();
  } catch (e) { alert(e.message); }
}

async function skSetBucket(b) {
  skState.bucket = b;
  try { skState.trend = await skFetchJson('/api/skills/trend?days=60&bucket=' + b); } catch {}
  if (currentTab === 'skills' && !skState.practice) render();
}

function skRenderOverview() {
  const o = skState.overview; if (!o) return '';
  const sk = o.skills || {};
  const weakCell = (key) => {
    const s = sk[key] || { enough: 0, weak: 0 };
    return s.enough > 0 ? `${s.weak}<div class="sk-sub">trong ${s.enough} từ đủ dữ liệu</div>` : `<span class="sk-nodata">Chưa đủ dữ liệu</span>`;
  };
  const enoughLine = SK_MEASURED.map(k => `${SK_LABEL[k]}: ${(sk[k] && sk[k].enough) || 0}`).join(' · ');
  const cell = (label, val) => `<div class="sk-cell"><div class="sk-val">${val}</div><div class="sk-lbl">${label}</div></div>`;
  return `
  <style>
    .sk-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .sk-cell{background:var(--paper);border:1px solid var(--border);border-radius:12px;padding:12px;text-align:center}
    .sk-val{font-size:1.5rem;font-weight:900}.sk-lbl{font-size:.75rem;color:var(--muted);font-weight:700;margin-top:2px}
    .sk-sub{font-size:.68rem;color:var(--muted);font-weight:600}.sk-nodata{font-size:.8rem;color:var(--muted);font-weight:700}
    .sk-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--border)}
    .sk-row:first-child{border-top:0}.sk-hz{font-size:1.5rem;font-weight:800;min-width:56px}
    .sk-info{flex:1;min-width:0}.sk-tag{display:inline-block;font-size:.7rem;font-weight:800;background:var(--l10c);color:var(--l10a);border-radius:8px;padding:2px 8px}
    .sk-bar{height:8px;border-radius:4px;background:var(--active);min-width:2px}
  </style>
  <div class="panel">
    <div class="panel-title">📊 Tổng quan năng lực</div>
    <div class="sk-grid">
      ${cell('Từ đã được kiểm tra theo kỹ năng', o.testedWords)}
      ${cell('Từ cần ôn theo FSRS', o.fsrsDueCount)}
      ${cell('Yếu về nhớ chủ động', weakCell('recall'))}
      ${cell('Yếu về nghe', weakCell('listening'))}
    </div>
    <div style="font-size:.75rem;color:var(--muted);margin-top:10px;line-height:1.5">
      Số từ đủ dữ liệu để đánh giá (≥3 lượt/kỹ năng) — ${enoughLine}.<br>
      Từ chưa có đủ dữ liệu không bị tính là yếu. Phát âm chưa có bài kiểm tra đáng tin nên chưa được đánh giá.
    </div>
  </div>`;
}

function skRenderPracticeLauncher() {
  const audioOk = skAudioOk();
  const btn = (label, onclick, enabled, why) => `
    <button class="btn ${enabled ? 'btn-primary' : ''}" ${enabled ? `onclick="${onclick}"` : 'disabled'} style="width:100%;margin-bottom:8px;text-align:left">
      ${label}${enabled ? '' : `<div style="font-size:.7rem;font-weight:600;opacity:.8">${why}</div>`}
    </button>`;
  return `
  <div class="panel">
    <div class="panel-title">🎯 Luyện theo kỹ năng</div>
    ${btn('🧠 Luyện nhớ chủ động', "skStartPractice('recall')", true, '')}
    ${btn('🎧 Luyện nghe', "skStartPractice('listening')", audioOk, 'Trình duyệt này không có giọng đọc tiếng Trung')}
    ${btn('⌨️ Nhớ chủ động — tự gõ chữ Hán', "skStartPractice('recall-typed')", true, '')}
    ${btn('📖 Luyện từ trong câu', "skStartPractice('context')", true, '')}
    ${btn('🔤 Luyện Pinyin', "skStartPractice('pinyin')", true, '')}
    ${btn('⌨️ Pinyin — tự gõ có dấu thanh', "skStartPractice('pinyin-typed')", true, '')}
    ${btn('🧩 Luyện phân biệt từ dễ nhầm', "skStartPractice('confusable')", true, '')}
    ${btn('⏳ Kiểm tra sau một khoảng nghỉ', "skStartPractice('delayed')", true, '')}
    ${btn('🔀 Luyện tổng hợp', "skStartPractice('mixed')", true, '')}
    <div style="font-size:.72rem;color:var(--muted);line-height:1.5">Luyện bổ sung không thay đổi lịch ôn FSRS. Chỉ dùng các từ bạn đã ôn ít nhất 1 lần. “Phân biệt từ dễ nhầm” chỉ có với các từ thuộc nhóm chữ dễ nhầm; “Kiểm tra sau một khoảng nghỉ” chọn từ đã học ổn định, chưa đến hạn và đã lâu chưa gặp.</div>
  </div>`;
}

function skRenderWeakList() {
  const items = skState.weak;
  if (!items.length) {
    return `<div class="panel"><div class="panel-title">😓 Từ cần cải thiện</div>
      <div style="color:var(--muted);font-size:.9rem">Chưa có từ nào đủ dữ liệu để kết luận là yếu. Hãy học thêm ở Trắc nghiệm, Gõ chữ, Nghe – Chọn hoặc Hôm nay học — mỗi kỹ năng cần ít nhất 3 lượt trên cùng một từ.</div></div>`;
  }
  const rows = items.map((it, i) => `
    <div class="sk-row">
      <div class="sk-hz">${escapeHtml(it.hz)}</div>
      <div class="sk-info">
        <div style="font-size:.8rem;color:var(--muted)">${showPinyin ? escapeHtml(it.py || '') : ''}</div>
        <div style="font-weight:700">${escapeHtml(it.vi || '')}</div>
        <div><span class="sk-tag">${SK_LABEL[it.skill] || it.skill}</span>
          <span style="font-size:.72rem;color:var(--muted)"> ${it.correct}/${it.attempts} đúng · ~${Math.round(it.score * 100)}%</span></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="btn btn-sm" onclick="skStartPracticeWord(${i})" ${it.skill === 'listening' && !skAudioOk() ? 'disabled' : ''}>Luyện</button>
        <button class="btn btn-sm" style="background:var(--border)" onclick="saOpenWord('${escapeJsAttr(it.hz)}')">Chi tiết</button>
      </div>
    </div>`).join('');
  return `<div class="panel"><div class="panel-title">😓 Từ cần cải thiện</div>${rows}
    ${skState.weakHasMore ? `<button class="btn" style="width:100%;margin-top:10px" onclick="skLoadMoreWeak()">Xem thêm</button>` : ''}</div>`;
}

function skRenderTrend() {
  const t = skState.trend;
  const toggle = `<div style="display:flex;gap:6px;margin-bottom:10px">
    <button class="quiz-type-btn${skState.bucket === 'day' ? ' active' : ''}" onclick="skSetBucket('day')">Theo ngày</button>
    <button class="quiz-type-btn${skState.bucket === 'week' ? ' active' : ''}" onclick="skSetBucket('week')">Theo tuần</button></div>`;
  const rows = (t && t.rows) || [];
  const blocks = SK_MEASURED.map(k => {
    const pts = rows.filter(r => r.skill === k);
    const total = pts.reduce((a, r) => a + r.attempts, 0);
    // Chỉ vẽ khi đủ nhiều điểm + đủ lượt, tránh biểu đồ gây hiểu nhầm từ vài câu lẻ.
    if (pts.length < 3 || total < 10) {
      return `<div style="margin-bottom:12px"><b>${SK_LABEL[k]}</b><div class="sk-nodata">Chưa đủ dữ liệu để hiển thị xu hướng</div></div>`;
    }
    const bars = pts.slice(-12).map(r => {
      const pct = Math.round((r.correct / r.attempts) * 100);
      return `<div style="display:flex;align-items:center;gap:8px;font-size:.7rem;margin:3px 0">
        <span style="width:70px;color:var(--muted)">${escapeHtml(r.bucket.slice(5))}</span>
        <div style="flex:1"><div class="sk-bar" style="width:${Math.max(pct, 2)}%"></div></div>
        <span style="width:64px;text-align:right">${pct}% (${r.attempts})</span></div>`;
    }).join('');
    return `<div style="margin-bottom:12px"><b>${SK_LABEL[k]}</b>${bars}</div>`;
  }).join('');
  return `<div class="panel"><div class="panel-title">📈 Tiến bộ theo thời gian</div>${toggle}${blocks}
    <div style="font-size:.7rem;color:var(--muted)">Mỗi kỹ năng một biểu đồ riêng — không có điểm tổng hợp. Chỉ tính các lượt ghi nhận kể từ khi có tính năng này.</div></div>`;
}

// ── Chạy bài luyện bổ sung ───────────────────────────────────────────────────────────────────
// Dùng CHUNG bộ tạo/chọn câu hỏi với tab "Hôm nay học" (QE/QS). Câu nào không dựng được hợp lệ (vd từ chưa có
// câu ví dụ cho bài "từ trong câu") thì bị bỏ qua, không tạo câu giả.
let skExamples = [];
function skQCtx() {
  return {
    pool: WORDS.filter(x => isLoggedIn() || x.l <= GUEST_MAX_LESSON),
    examples: skExamples,
    sentences: (typeof SENTENCES !== 'undefined') ? SENTENCES : [],
    confuseGroups: (typeof CONFUSE_GROUPS !== 'undefined') ? CONFUSE_GROUPS : [],
    audioOk: skAudioOk(),
    heavy: (typeof pickHeavyDistractors === 'function') ? pickHeavyDistractors : null,
  };
}
function skTypesFor(skill) { return QE.MCQ_ORDER.concat(rvTypedEnabled() ? QE.TYPED_ORDER : []).filter(t => QE.TYPES[t].skill === skill); } // V110: gồm câu tự nhập khi người học bật

async function skLoadExamplesFor(words) {
  const lessons = [...new Set(words.map(w => w.l))];
  if (!lessons.length || isGuest) { skExamples = []; return; }
  try {
    const res = await fetch('/api/word-examples?lessons=' + lessons.join(','), { headers: authHeaders() });
    const d = await res.json().catch(() => null);
    skExamples = (d && d.ok && d.examples) || [];
  } catch { skExamples = []; }
}

// Tạo trạng thái 1 buổi luyện. `kind` quyết định dạng câu và nguồn ghi nhận ('delayed' → source 'delayed'; còn lại 'mode').
function skMakePractice(items, kind) {
  return { items: items.map(w => ({ ...w })), idx: 0, correct: 0, answered: 0, locked: false, q: null, startedAt: 0,
    kind: kind || 'mixed', sessionId: genIdempotencyKey(), qSession: QS.newSession() };
}
async function skStartPractice(kind) {
  const audioOk = skAudioOk();
  try {
    let d;
    if (kind === 'delayed') {
      d = await skFetchJson('/api/skills/delayed-words?limit=10');
    } else if (kind === 'confusable') {
      // Lấy các từ đã ôn rồi giữ lại những từ THUỘC nhóm chữ dễ nhầm có chú giải (QE.build chỉ dựng được cho các từ này).
      d = await skFetchJson(`/api/skills/practice-words?skill=mixed&limit=30&allowListening=0`);
      const ctx = skQCtx();
      d.words = d.words.filter(it => { const w = WORDS.find(x => x.hz === it.hz); return w && QE.build('confusable', w, ctx); }).slice(0, 10);
    } else {
      const serverSkill = kind === 'recall-typed' ? 'recall' : (kind === 'pinyin-typed' ? 'pinyin' : kind); // chế độ tự gõ dùng cùng danh sách từ của kỹ năng tương ứng
      d = await skFetchJson(`/api/skills/practice-words?skill=${encodeURIComponent(serverSkill)}&limit=10&allowListening=${audioOk ? 1 : 0}`);
      if (kind === 'recall-typed' || kind === 'pinyin-typed') { // chỉ giữ từ dựng được câu tự gõ hợp lệ (đủ dữ liệu, không mơ hồ)
        const ctx = skQCtx(), tid = kind === 'recall-typed' ? 'typeVi2hz' : 'typeHz2py';
        d.words = d.words.filter(it => { const w = WORDS.find(x => x.hz === it.hz); return w && QE.build(tid, w, ctx); });
      }
    }
    if (!d.words.length) {
      alert(kind === 'delayed' ? 'Chưa có từ nào đủ điều kiện kiểm tra sau khoảng nghỉ (cần đã học ổn định, chưa đến hạn ôn và cách lần gặp gần nhất từ 7 ngày).'
        : kind === 'confusable' ? 'Chưa có từ nào của bạn thuộc nhóm chữ dễ nhầm để luyện.'
        : (kind === 'recall-typed' || kind === 'pinyin-typed') ? 'Chưa có từ nào đủ dữ liệu để tạo câu tự gõ không mơ hồ (cần có pinyin chuẩn, và không trùng nghĩa/cách đọc với từ khác).'
        : 'Chưa có từ phù hợp để luyện kỹ năng này. Hãy ôn thêm từ ở các tab học trước.');
      return;
    }
    await skLoadExamplesFor(d.words);
    skState.practice = skMakePractice(d.words, kind);
    skAdvanceToValid();
    if (!skState.practice.q) { skState.practice = null; alert('Chưa tạo được câu hỏi hợp lệ cho chế độ này (có thể thiếu câu ví dụ, âm thanh hoặc dữ liệu pinyin).'); return; }
    if (currentTab !== 'skills') goTab('skills');
    render();
  } catch (e) { alert(e.message); }
}
// Luyện 1 từ theo 1 kỹ năng (từ màn chi tiết từng từ).
async function skStartPracticeForWord(hz, skill) {
  const w = WORDS.find(x => x.hz === hz); if (!w) { alert('Không tìm thấy từ này trong kho từ.'); return; }
  const it = { hz: w.hz, l: w.l, py: w.py, vi: w.vi, skill };
  await skLoadExamplesFor([it]);
  skState.practice = skMakePractice([it], 'word');
  skAdvanceToValid();
  if (!skState.practice.q) { skState.practice = null; alert('Chưa tạo được câu hỏi hợp lệ cho từ này ở kỹ năng đó (thiếu dữ liệu).'); return; }
  saState.word = null;
  render();
}

async function skStartPracticeWord(i) {
  const it = skState.weak[i]; if (!it) return;
  await skLoadExamplesFor([it]);
  skState.practice = skMakePractice([it], 'word');
  skAdvanceToValid();
  if (!skState.practice.q) { skState.practice = null; alert('Chưa tạo được câu hỏi hợp lệ cho từ này.'); return; }
  render();
}

// Dựng câu cho phần tử hiện tại; nếu không dựng được thì bỏ qua sang phần tử kế (không kẹt).
function skAdvanceToValid() {
  const p = skState.practice;
  p.q = null;
  while (p.idx < p.items.length) {
    const it = p.items[p.idx];
    const w = WORDS.find(x => x.hz === it.hz && x.l === it.l) || WORDS.find(x => x.hz === it.hz);
    const ctx = skQCtx();
    // V110: 'confusable' chỉ dùng dạng phân biệt chữ dễ nhầm; 'delayed'/'mixed' để bộ chọn tự chọn dạng (kể cả tự nhập nếu bật);
    // các kỹ năng khác ưu tiên đúng dạng của kỹ năng đó, không dựng được mới thử dạng khác. Truyền qSession để chống lặp trong buổi.
    const forced = { confusable: ['confusable'], 'recall-typed': ['typeVi2hz'], 'pinyin-typed': ['typeHz2py'] }[p.kind]; // chế độ người học CHỌN TƯỜNG MINH → không tự đổi dạng
    const base = { allowPracticeOnly: true, allowTyped: !!forced || rvTypedEnabled(), session: p.qSession, forced: !!forced };
    const only = forced || ((p.kind === 'delayed' || p.kind === 'mixed') ? [] : skTypesFor(it.skill));
    const q = w && ((only.length && QS.choose(w, ctx, { ...base, only })) || (forced ? null : QS.choose(w, ctx, base)));
    if (q) { p.q = q; p.locked = false; p.startedAt = performance.now(); vtMarkStart(); return; }
    p.idx++;
  }
}

function skRenderPractice() {
  const p = skState.practice;
  if (p.idx >= p.items.length || !p.q) {
    return `<div class="panel exam-result">
      <div class="exam-score">${p.correct}/${p.answered}</div>
      <div style="color:var(--muted);margin:6px 0 12px">Đã ghi nhận vào hồ sơ kỹ năng. Lịch ôn FSRS không thay đổi.</div>
      <button class="btn btn-primary" onclick="skEndPractice()">Quay lại phân tích</button></div>`;
  }
  const q = p.q, pr = q.prompt, w = q.word;
  let stem;
  if (pr.kind === 'audio') {
    stem = `<button id="sk-play" class="listen-play" onclick="speak('${escapeJsAttr(w.hz)}')" title="Phát lại">🔊</button><div class="rv-prompt" style="text-align:center">${escapeHtml(pr.ask)}</div>`;
  } else if (pr.kind === 'cloze') {
    stem = `<div style="font-size:1.4rem;font-weight:800;text-align:center;margin:10px 0">${escapeHtml(pr.main)}</div>${pr.sub ? `<div style="text-align:center;color:var(--muted);font-size:.9rem">${escapeHtml(pr.sub)}</div>` : ''}<div class="rv-prompt" style="text-align:center">${escapeHtml(pr.ask)}</div>`;
  } else if (q.typeId === 'hz2vi' || q.typeId === 'hz2py') {
    stem = `<div style="font-size:2rem;font-weight:800;text-align:center;margin:10px 0">${escapeHtml(w.hz)}</div><div class="rv-prompt" style="text-align:center">${escapeHtml(pr.ask)}</div>`;
  } else {
    stem = `<div style="font-size:1.4rem;font-weight:800;text-align:center;margin:10px 0">${escapeHtml(pr.main || '')}</div><div class="rv-prompt" style="text-align:center">${escapeHtml(pr.ask)}</div>`;
  }
  if (q.typed) { // V110: câu tự nhập
    const isPy = q.typed === 'py';
    return `<div class="panel">
      <div style="font-size:.75rem;color:var(--muted);font-weight:700;margin-bottom:6px">Luyện ${SK_LABEL[q.skill]} · ${escapeHtml(QE.TYPES[q.typeId].label)} · Câu ${p.idx + 1}/${p.items.length}</div>
      ${stem}
      <input id="sk-typed" class="type-input" type="text" inputmode="text" enterkeyhint="done" ${isPy ? 'lang="vi"' : 'lang="zh-CN"'} autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"
             placeholder="${isPy ? 'Gõ pinyin: nǐ hǎo hoặc ni3 hao3' : 'Gõ chữ Hán (bàn phím tiếng Trung)'}" onkeydown="if(event.key==='Enter'){event.preventDefault();skSubmitTyped(false)}">
      <div class="rv-typed-rule">${isPy ? 'Cần dấu thanh (ǎ) hoặc số thanh (a3); gõ thiếu thanh điệu sẽ <b>không</b> được tính đúng.' : 'Phải đúng từng chữ; khoảng trắng/dấu câu thừa được bỏ qua.'}</div>
      <div id="sk-explain" style="font-size:.85rem;color:var(--muted);margin-top:8px"></div>
      <div id="sk-typed-btns" style="display:flex;gap:8px;justify-content:center;margin-top:10px">
        <button class="btn btn-primary" onclick="skSubmitTyped(false)">Kiểm tra</button>
        <button class="btn" style="background:var(--border)" onclick="skSubmitTyped(true)">Bỏ qua</button></div>
      <button class="btn" style="margin-top:12px" onclick="skEndPractice()">Dừng luyện</button></div>`;
  }
  const opts = q.options.map(o => `<button class="quiz-opt" data-v="${escapeHtml(o.key)}" onclick="skPick(this)">${escapeHtml(o.label)}</button>`).join('');
  return `<div class="panel">
    <div style="font-size:.75rem;color:var(--muted);font-weight:700;margin-bottom:6px">Luyện ${SK_LABEL[q.skill]} · Câu ${p.idx + 1}/${p.items.length}</div>
    ${stem}<div class="quiz-opts" id="sk-opts">${opts}</div>
    <div id="sk-explain" style="font-size:.85rem;color:var(--muted);margin-top:8px"></div>
    <button class="btn" style="margin-top:12px" onclick="skEndPractice()">Dừng luyện</button></div>`;
}

async function skPick(btn) {
  const p = skState.practice; if (!p || p.locked || !p.q) return;
  p.locked = true;
  const q = p.q, w = q.word;
  const responseTimeMs = Math.max(0, performance.now() - p.startedAt - vtHiddenMs());
  const chosen = btn.dataset.v;
  const ok = chosen === q.correctKey;
  document.querySelectorAll('#sk-opts .quiz-opt').forEach(b => {
    if (b.dataset.v === q.correctKey) b.classList.add('correct');
    else if (b === btn && !ok) b.classList.add('wrong');
    b.disabled = true;
  });
  const ex = document.getElementById('sk-explain');
  if (ex) ex.innerHTML = q.explanation.map(l => `<div>${escapeHtml(l)}</div>`).join('');
  if (ok) playDing(); else playBuzz();
  speak(w.hz);
  p.answered++; if (ok) p.correct++;
  QS.record(p.qSession, q, ok, responseTimeMs);
  const reading = q.explanation.length > 1 ? 3500 : 1500; // câu có giải thích dài cần thời gian đọc
  await Promise.all([
    submitSkillPractice({ word: { hz: w.hz, l: w.l }, exerciseType: q.exercisePractice, selectedAnswer: chosen, responseTimeMs, source: skSource(p), sessionId: p.sessionId }),
    new Promise(r => setTimeout(r, reading)),
  ]);
  if (currentTab !== 'skills' || skState.practice !== p) return;
  p.idx++;
  skAdvanceToValid();
  render();
  if (p.q && p.q.prompt.kind === 'audio') setTimeout(() => { const b = document.getElementById('sk-play'); if (b) b.click(); }, 400);
}

function skSource(p) { return p && p.kind === 'delayed' ? 'delayed' : 'mode'; }
// V110: trả lời câu tự nhập trong buổi luyện bổ sung (chỉ ghi hồ sơ kỹ năng; KHÔNG đổi FSRS). Chấm tức thì bằng AM; server chấm lại.
async function skSubmitTyped(skip) {
  const p = skState.practice; if (!p || p.locked || !p.q || !p.q.typed) return;
  const inp = document.getElementById('sk-typed');
  const value = skip ? '' : (inp ? inp.value : '');
  if (!skip && !String(value).trim()) { if (inp) { inp.focus(); inp.placeholder = 'Hãy gõ đáp án, hoặc bấm “Bỏ qua”'; } return; }
  p.locked = true;
  const q = p.q, w = q.word;
  const responseTimeMs = Math.max(0, performance.now() - p.startedAt - vtHiddenMs());
  const graded = skip ? { correct: false, verdict: 'empty' } : AM.grade(q.typed, value, q.correctKey);
  if (inp) inp.disabled = true;
  const btns = document.getElementById('sk-typed-btns'); if (btns) btns.querySelectorAll('button').forEach(b => b.disabled = true);
  const ex = document.getElementById('sk-explain');
  if (ex) {
    const said = skip ? 'Bạn đã bỏ qua câu này' : 'Bạn đã gõ: ' + escapeHtml(String(value).trim());
    const why = (!skip && AM.VERDICT_TEXT[graded.verdict]) ? ' — ' + escapeHtml(AM.VERDICT_TEXT[graded.verdict]) : '';
    ex.innerHTML = `<div style="color:${graded.correct ? 'var(--l8a)' : 'var(--l10a)'};font-weight:700">${graded.correct ? '✅ Chính xác' : '❌ Chưa đúng'}</div>`
      + `<div>${said}${why}</div>` + (graded.correct ? '' : `<div>Đáp án chuẩn: ${escapeHtml(q.correctKey)}</div>`)
      + q.explanation.map(l => `<div>${escapeHtml(l)}</div>`).join('');
  }
  if (graded.correct) playDing(); else playBuzz();
  speak(w.hz);
  p.answered++; if (graded.correct) p.correct++;
  QS.record(p.qSession, q, graded.correct, responseTimeMs);
  await Promise.all([
    submitSkillPractice({ word: { hz: w.hz, l: w.l }, exerciseType: q.exercisePractice, selectedAnswer: skip ? RV_BLANK_MARK : String(value).trim(), responseTimeMs, source: skSource(p), sessionId: p.sessionId }),
    new Promise(r => setTimeout(r, graded.correct ? 2200 : 4000)),
  ]);
  if (currentTab !== 'skills' || skState.practice !== p) return;
  p.idx++;
  skAdvanceToValid();
  render();
}

function skEndPractice() {
  skState.practice = null;
  skState.loaded = false; // quay lại thì tải lại số liệu mới
  render();
}

// Gọi khi đăng xuất/đổi tài khoản để không lộ dữ liệu của người trước.
function skResetState() {
  skState = { loaded: false, loading: false, error: null, overview: null, weak: [], weakHasMore: false, weakOffset: 0, trend: null, bucket: 'week', practice: null };
  if (typeof saResetState === 'function') saResetState(); // V110
}
