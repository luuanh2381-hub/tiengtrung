// js/skills-ui.js — Tab "Phân tích năng lực" (V104): tổng quan, danh sách từ cần cải thiện, luyện
// theo kỹ năng, tiến bộ theo thời gian. Mọi số liệu lấy từ server (/api/skills/*) theo đúng tài khoản
// đang đăng nhập. Bài luyện ở đây là luyện BỔ SUNG: gửi qua submitSkillPractice() (study-queue.js,
// dùng chung outbox) → KHÔNG đổi lịch ôn FSRS.

const SK_LABEL = { recognition: 'Nhận diện', recall: 'Nhớ chủ động', listening: 'Nghe', pronunciation: 'Phát âm', context: 'Từ trong câu' };
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
  return skRenderOverview() + skRenderPracticeLauncher() + skRenderWeakList() + skRenderTrend();
}

function bindSkills() {
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
  const enoughLine = ['recognition', 'recall', 'listening'].map(k => `${SK_LABEL[k]}: ${(sk[k] && sk[k].enough) || 0}`).join(' · ');
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
      Từ chưa có đủ dữ liệu không bị tính là yếu. Phát âm và "từ trong câu" chưa có bài kiểm tra đáng tin nên chưa được đánh giá.
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
    ${btn('📖 Luyện từ trong câu', '', false, 'Chưa có bài điền từ vào câu')}
    ${btn('🔀 Luyện tổng hợp', "skStartPractice('mixed')", true, '')}
    <div style="font-size:.72rem;color:var(--muted);line-height:1.5">Luyện bổ sung không thay đổi lịch ôn FSRS. Chỉ dùng các từ bạn đã ôn ít nhất 1 lần.</div>
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
      <button class="btn btn-sm" onclick="skStartPracticeWord(${i})" ${it.skill === 'listening' && !skAudioOk() ? 'disabled' : ''}>Luyện</button>
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
  const blocks = ['recognition', 'recall', 'listening'].map(k => {
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
async function skStartPractice(kind) {
  const audioOk = skAudioOk();
  try {
    const d = await skFetchJson(`/api/skills/practice-words?skill=${encodeURIComponent(kind)}&limit=10&allowListening=${audioOk ? 1 : 0}`);
    if (!d.words.length) { alert('Chưa có từ phù hợp để luyện kỹ năng này. Hãy ôn thêm từ ở các tab học trước.'); return; }
    skState.practice = { items: d.words, idx: 0, correct: 0, answered: 0, locked: false, opts: null, startedAt: 0 };
    skPrepareQuestion();
    render();
  } catch (e) { alert(e.message); }
}

function skStartPracticeWord(i) {
  const it = skState.weak[i]; if (!it) return;
  skState.practice = { items: [{ ...it, skill: it.skill }], idx: 0, correct: 0, answered: 0, locked: false, opts: null, startedAt: 0 };
  skPrepareQuestion();
  render();
}

function skPrepareQuestion() {
  const p = skState.practice; if (!p || p.idx >= p.items.length) return;
  const it = p.items[p.idx];
  p.opts = rvMakeOpts(it, { answerField: 'hz', mode: it.skill === 'listening' ? 'listening' : 'text' });
  p.locked = false;
  p.startedAt = performance.now();
  vtMarkStart();
}

function skRenderPractice() {
  const p = skState.practice;
  if (p.idx >= p.items.length) {
    return `<div class="panel exam-result">
      <div class="exam-score">${p.correct}/${p.answered}</div>
      <div style="color:var(--muted);margin:6px 0 12px">Đã ghi nhận vào hồ sơ kỹ năng. Lịch ôn FSRS không thay đổi.</div>
      <button class="btn btn-primary" onclick="skEndPractice()">Quay lại phân tích</button></div>`;
  }
  const it = p.items[p.idx];
  const listening = it.skill === 'listening';
  const stem = listening
    ? `<button id="sk-play" class="listen-play" onclick="speak('${escapeJsAttr(it.hz)}')" title="Phát lại">🔊</button><div class="rv-prompt" style="text-align:center">Nghe và chọn chữ Hán đúng</div>`
    : `<div style="font-size:1.4rem;font-weight:800;text-align:center;margin:10px 0">${escapeHtml(it.vi || '')}</div><div class="rv-prompt" style="text-align:center">Chữ Hán nào có nghĩa này?</div>`;
  const opts = p.opts.map(o => `<button class="quiz-opt" data-v="${escapeHtml(o.hz)}" onclick="skPick(this)">${escapeHtml(o.hz)}</button>`).join('');
  return `<div class="panel">
    <div style="font-size:.75rem;color:var(--muted);font-weight:700;margin-bottom:6px">Luyện ${SK_LABEL[it.skill]} · Câu ${p.idx + 1}/${p.items.length}</div>
    ${stem}<div class="quiz-opts" id="sk-opts">${opts}</div>
    <button class="btn" style="margin-top:12px" onclick="skEndPractice()">Dừng luyện</button></div>`;
}

async function skPick(btn) {
  const p = skState.practice; if (!p || p.locked) return;
  p.locked = true;
  const it = p.items[p.idx];
  const responseTimeMs = Math.max(0, performance.now() - p.startedAt - vtHiddenMs());
  const chosen = btn.dataset.v;
  const ok = chosen === it.hz;
  document.querySelectorAll('#sk-opts .quiz-opt').forEach(b => {
    if (b.dataset.v === it.hz) b.classList.add('correct');
    else if (b === btn && !ok) b.classList.add('wrong');
    b.disabled = true;
  });
  if (ok) playDing(); else playBuzz();
  speak(it.hz);
  p.answered++; if (ok) p.correct++;
  await Promise.all([
    submitSkillPractice({
      word: { hz: it.hz, l: it.l },
      exerciseType: it.skill === 'listening' ? 'practice-listening' : 'practice-recall',
      selectedAnswer: chosen, responseTimeMs,
    }),
    new Promise(r => setTimeout(r, 1300)),
  ]);
  if (currentTab !== 'skills' || skState.practice !== p) return;
  p.idx++;
  skPrepareQuestion();
  render();
  if (p.idx < p.items.length && p.items[p.idx].skill === 'listening') setTimeout(() => { const b = document.getElementById('sk-play'); if (b) b.click(); }, 400);
}

function skEndPractice() {
  skState.practice = null;
  skState.loaded = false; // quay lại thì tải lại số liệu mới
  render();
}

// Gọi khi đăng xuất/đổi tài khoản để không lộ dữ liệu của người trước.
function skResetState() {
  skState = { loaded: false, loading: false, error: null, overview: null, weak: [], weakHasMore: false, weakOffset: 0, trend: null, bucket: 'week', practice: null };
}
