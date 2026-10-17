// js/skills-analysis.js — V110: các khối phân tích bổ sung cho tab "Phân tích năng lực" (js/skills-ui.js):
//   • Khuyến nghị tổng thể (quy tắc rõ ràng, có giải thích)      ← /api/skills/recommendations
//   • Trí nhớ theo khoảng nghỉ (ngay sau học / ~1 ngày / ~1 tuần / ~1 tháng) ← /api/skills/retention
//   • Kết quả theo dạng bài
//   • Chi tiết TỪNG TỪ (kỹ năng, FSRS, lịch sử, dạng hay sai, khuyến nghị riêng) ← /api/skills/word
// Nguyên tắc hiển thị: KHÔNG có điểm tổng hợp duy nhất; thiếu dữ liệu → nói "chưa đủ dữ liệu" và nêu mẫu số, không vẽ biểu đồ gây hiểu nhầm.
// Mọi dữ liệu do server tính; file này chỉ hiển thị. Mọi chuỗi từ server/dữ liệu đều qua escapeHtml.

const SA_MIN_N = 10; // khớp MIN_RETENTION_N ở lib/skills.js (chỉ dùng để giải thích cho người học)
let saState = { recs: null, retention: null, loadedAt: 0, error: null, word: null, wordLoading: false, wordError: null };

const SA_LEVEL = {
  insufficient: { text: 'Chưa đủ dữ liệu', cls: 'sa-lv-none' },
  weak: { text: 'Yếu', cls: 'sa-lv-weak' },
  developing: { text: 'Đang phát triển', cls: 'sa-lv-dev' },
  good: { text: 'Tốt', cls: 'sa-lv-good' },
};
const SA_STATE_TEXT = { 0: 'Từ mới (chưa học)', 1: 'Đang học', 2: 'Đã học (ôn định kỳ)', 3: 'Học lại (đã quên)' };
const SA_SOURCE_TEXT = {
  fsrs: 'Ôn theo lịch FSRS', check: 'Kiểm tra ngay sau khi xem từ', redo: 'Luyện lại câu sai', extra: 'Luyện từ hay sai',
  match: 'Ghép cặp', practice: 'Luyện bổ sung', mode: 'Luyện theo kỹ năng', delayed: 'Kiểm tra sau khoảng nghỉ',
};
// Nhãn dạng bài: lấy từ QE (không trùng lặp danh mục) + các nhãn của tab cũ.
function saTypeLabel(exerciseType) {
  for (const id of Object.keys(QE.TYPES)) {
    const T = QE.TYPES[id];
    if (T.exerciseFsrs === exerciseType || T.exercisePractice === exerciseType) return T.label;
  }
  const extra = {
    'quiz-hz2vi': 'Trắc nghiệm: Chữ Hán → Nghĩa', 'quiz-vi2hz': 'Trắc nghiệm: Nghĩa → Chữ Hán', 'quiz-py2hz': 'Trắc nghiệm: Pinyin → Chữ Hán',
    'type-vi2hz': 'Gõ chữ Hán', 'listen-choose-hz': 'Nghe → chọn chữ Hán', 'practice-match-vi': 'Ghép chữ Hán ↔ nghĩa', 'practice-match-py': 'Ghép chữ Hán ↔ pinyin',
    'review-listen': 'Nghe → Chữ Hán', 'practice-listening': 'Nghe → Chữ Hán',
  };
  return extra[exerciseType] || exerciseType;
}
const saPct = (x) => Math.round(x * 100) + '%';

function saStyle() {
  return `<style>
    .sa-rec{border:1px solid var(--border);border-left:4px solid var(--l10a,#2980b9);border-radius:10px;padding:10px 12px;margin:8px 0;background:var(--paper)}
    .sa-rec-t{font-weight:800;font-size:.92rem}.sa-rec-w{font-size:.8rem;color:var(--muted);line-height:1.5;margin-top:3px}
    .sa-note{font-size:.75rem;color:var(--muted);line-height:1.5;margin-top:8px}
    .sa-bar-wrap{flex:1;background:var(--active);border-radius:4px;height:10px;overflow:hidden}.sa-bar-in{height:100%;background:var(--l8a,#27ae60)}
    .sa-brow{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:.78rem}.sa-blbl{width:118px;font-weight:700;line-height:1.25}
    .sa-lv{display:inline-block;font-size:.7rem;font-weight:800;border-radius:8px;padding:2px 8px}
    .sa-lv-none{background:var(--active);color:var(--muted)}.sa-lv-weak{background:#fadbd8;color:#c0392b}
    .sa-lv-dev{background:#fdebd0;color:#b9770e}.sa-lv-good{background:#d5f5e3;color:#1e8449}
    .sa-hist{display:flex;gap:8px;align-items:baseline;font-size:.76rem;padding:4px 0;border-bottom:1px solid var(--border)}
    .sa-hist:last-child{border-bottom:0}
    .sa-table{width:100%;border-collapse:collapse;font-size:.8rem}.sa-table td,.sa-table th{padding:5px 4px;border-bottom:1px solid var(--border);text-align:left}
  </style>`;
}

// ── Tải dữ liệu phụ (song song, KHÔNG chặn phần chính; lỗi chỉ làm mất các khối này) ─────────────────
async function saLoadExtras() {
  try {
    const [recs, retention] = await Promise.all([
      skFetchJson('/api/skills/recommendations?days=90'),
      skFetchJson('/api/skills/retention?days=90'),
    ]);
    saState.recs = recs; saState.retention = retention; saState.error = null; saState.loadedAt = Date.now();
  } catch (e) { saState.error = e.message; }
  if (currentTab === 'skills' && !skState.practice && !saState.word) render();
}

// ── Khuyến nghị tổng thể ────────────────────────────────────────────────────────────────────────
function saActionButton(a) {
  if (!a) return '';
  if (a.kind === 'delayed') return `<button class="btn btn-sm" style="margin-top:6px" onclick="skStartPractice('delayed')">⏳ Kiểm tra sau khoảng nghỉ</button>`;
  if (a.kind === 'practice' && a.skill) {
    const disabled = a.skill === 'listening' && !skAudioOk();
    return `<button class="btn btn-sm" style="margin-top:6px" ${disabled ? 'disabled' : `onclick="skStartPractice('${escapeJsAttr(a.skill)}')"`}>Luyện ngay · ${escapeHtml(a.hint || SK_LABEL[a.skill] || '')}</button>`;
  }
  return '';
}
function saRenderRecs() {
  const r = saState.recs;
  let inner;
  if (!r) inner = saState.error ? `<div class="sa-note">⚠️ Không tải được khuyến nghị: ${escapeHtml(saState.error)} <button class="btn btn-sm" onclick="saLoadExtras()">Thử lại</button></div>` : `<div class="sa-note">⏳ Đang phân tích...</div>`;
  else if (r.status === 'insufficient') inner = `<div class="sa-note">${(r.notes || []).map(escapeHtml).join('<br>')}</div>`;
  else {
    const items = (r.items || []).map(it => `<div class="sa-rec"><div class="sa-rec-t">${escapeHtml(it.title)}</div><div class="sa-rec-w">${escapeHtml(it.why)}</div>${it.stopWhen ? `<div class="sa-note" style="margin:4px 0 0">⏹ ${escapeHtml(it.stopWhen)}</div>` : ''}${saActionButton(it.action)}</div>`).join('');
    const notes = (r.notes || []).map(n => `<div class="sa-note">ℹ️ ${escapeHtml(n)}</div>`).join('');
    inner = (items || `<div class="sa-note">Chưa có việc nào cần luyện thêm theo dữ liệu hiện có.</div>`) + notes;
  }
  return saStyle() + `<div class="panel"><div class="panel-title">💡 Gợi ý cho bạn</div>${inner}
    <div class="sa-note">Gợi ý tính từ quy tắc cố định trên dữ liệu của bạn (không dùng AI ngoài) và chỉ là luyện bổ sung — không thay đổi lịch ôn FSRS.</div></div>`;
}

// ── Trí nhớ theo khoảng nghỉ ────────────────────────────────────────────────────────────────────
function saRenderRetention() {
  const r = saState.retention; if (!r) return '';
  const order = ['immediate', 'short', 'd1', 'd3', 'd7'];
  const rows = order.map(id => {
    const b = r.buckets[id]; if (!b) return '';
    const a = b.all;
    const bar = a.rate == null
      ? `<span class="sk-nodata">Chưa đủ dữ liệu (${a.n}/${SA_MIN_N} lượt)</span>`
      : `<div class="sa-bar-wrap"><div class="sa-bar-in" style="width:${Math.max(2, Math.round(a.rate * 100))}%"></div></div><span style="width:92px;text-align:right">${saPct(a.rate)} (${a.correct}/${a.n})</span>`;
    const split = (a.n > 0 && (b.fsrs.n || b.practice.n))
      ? `<div class="sa-note" style="margin:-4px 0 6px 126px">Ôn FSRS: ${b.fsrs.n} lượt${b.fsrs.rate != null ? ' · ' + saPct(b.fsrs.rate) : ''} · Luyện bổ sung: ${b.practice.n} lượt${b.practice.rate != null ? ' · ' + saPct(b.practice.rate) : ''}</div>` : '';
    return `<div class="sa-brow"><span class="sa-blbl">${escapeHtml(b.label)}</span>${bar}</div>${split}`;
  }).join('');
  const total = order.reduce((n, id) => n + (r.buckets[id] ? r.buckets[id].all.n : 0), 0);
  return `<div class="panel"><div class="panel-title">⏳ Nhớ sau khoảng nghỉ</div>
    ${total ? rows : `<div class="sa-note">Chưa có dữ liệu. Học vài phiên (và quay lại sau vài ngày) để hệ thống so sánh được trí nhớ ngay sau học với sau khoảng nghỉ.</div>`}
    <div class="sa-note">Mỗi thanh = tỉ lệ nhớ đúng trong <b>các lượt đã được kiểm tra</b> ở khoảng cách đó (${r.windowDays} ngày gần nhất); chỉ hiện % khi có ≥ ${SA_MIN_N} lượt. Từ chưa được kiểm tra lại <b>không</b> bị tính là quên. Khoảng cách tính từ lần gặp từ trước đó; lượt vừa xem đáp án (kể cả câu đầu sau màn giới thiệu từ mới) được xếp vào “ngay sau khi học”. <b>Giới hạn:</b> các thanh gộp nhiều kỹ năng và dạng câu hỏi có độ khó khác nhau, nên chỉ so sánh để tham khảo — không phải tốc độ quên đo chính xác.</div></div>`;
}

// ── Kết quả theo dạng bài ───────────────────────────────────────────────────────────────────────
function saRenderByType() {
  const r = saState.retention; if (!r || !r.byType || !r.byType.length) return '';
  const agg = {};
  for (const t of r.byType) {
    const a = agg[t.exercise_type] || (agg[t.exercise_type] = { n: 0, ok: 0 });
    a.n += t.n; a.ok += t.correct;
  }
  const rows = Object.keys(agg).sort((x, y) => agg[y].n - agg[x].n).map(k => {
    const a = agg[k];
    return `<tr><td>${escapeHtml(saTypeLabel(k))}</td><td>${a.ok}/${a.n}</td><td>${a.n >= 5 ? saPct(a.ok / a.n) : '<span class="sk-nodata">ít dữ liệu</span>'}</td></tr>`;
  }).join('');
  return `<div class="panel"><div class="panel-title">🧪 Kết quả theo dạng bài</div>
    <table class="sa-table"><tr><th>Dạng bài</th><th>Đúng</th><th>Tỉ lệ</th></tr>${rows}</table>
    <div class="sa-note">Gộp lượt ôn FSRS và luyện bổ sung (${r.windowDays} ngày gần nhất). Dạng có dưới 5 lượt không hiện tỉ lệ.</div></div>`;
}

// ── Chi tiết từng từ ────────────────────────────────────────────────────────────────────────────
async function saOpenWord(hz) {
  hz = String(hz || '').trim(); if (!hz) return;
  saState.word = { hz }; saState.wordLoading = true; saState.wordError = null;
  render();
  try {
    const d = await skFetchJson('/api/skills/word?hz=' + encodeURIComponent(hz));
    saState.word = d;
  } catch (e) { saState.wordError = e.message; }
  saState.wordLoading = false;
  if (currentTab === 'skills' && saState.word) render();
}
function saCloseWord() { saState.word = null; saState.wordError = null; render(); }
function saOpenWordFromInput() { const i = document.getElementById('sa-word-input'); if (i && i.value.trim()) saOpenWord(i.value); }

function saRenderWordSearch() {
  return `<div class="panel"><div class="panel-title">🔎 Xem chi tiết một từ</div>
    <div style="display:flex;gap:8px"><input id="sa-word-input" class="type-input" style="flex:1;margin:0" lang="zh-CN" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Gõ chữ Hán, ví dụ: 准备" onkeydown="if(event.key==='Enter')saOpenWordFromInput()">
    <button class="btn btn-primary" onclick="saOpenWordFromInput()">Xem</button></div></div>`;
}

function saRenderWordDetail() {
  const d = saState.word;
  const back = `<button class="btn" style="margin-bottom:10px" onclick="saCloseWord()">← Quay lại phân tích</button>`;
  if (saState.wordLoading) return saStyle() + back + `<div class="panel center" style="padding:24px">⏳ Đang tải...</div>`;
  if (saState.wordError) return saStyle() + back + `<div class="panel center" style="padding:24px">⚠️ ${escapeHtml(saState.wordError)}<br><button class="btn" style="margin-top:10px" onclick="saOpenWord('${escapeJsAttr(d && d.hz || '')}')">Thử lại</button></div>`;
  const w = d.word, c = d.card;
  const head = `<div class="panel" style="text-align:center">
    <div style="font-size:2.4rem;font-weight:900">${escapeHtml(w.hz)}</div>
    <div style="color:var(--muted)">${escapeHtml(w.py || '')}</div>
    <div style="font-weight:700;margin-top:2px">${escapeHtml(w.vi || '')}</div>
    ${w.hanviet ? `<div class="sa-note">Hán Việt: ${escapeHtml(w.hanviet)}</div>` : ''}
    <div style="margin-top:6px"><button class="btn btn-sm btn-sound" onclick="speak('${escapeJsAttr(w.hz)}')">🔊 Nghe</button></div></div>`;

  let fsrs;
  if (!c) fsrs = `<div class="sa-note">Từ này chưa có thẻ FSRS — bạn chưa học nó ở “Hôm nay học”.</div>`;
  else {
    const due = c.due ? new Date(c.due) : null;
    const dueTxt = due ? (due.getTime() <= Date.now() ? '<b>Đã đến hạn ôn</b>' : 'Ôn lại vào ' + escapeHtml(due.toLocaleDateString('vi-VN'))) : '—';
    fsrs = `<div style="font-size:.85rem;line-height:1.7">
      Trạng thái học: <b>${escapeHtml(SA_STATE_TEXT[c.state] || '—')}</b><br>
      Lịch ôn: ${dueTxt}<br>
      Đã ôn ${c.reps} lượt · quên ${c.lapses} lần${c.stability ? ` · độ bền ghi nhớ ~${Math.round(c.stability * 10) / 10} ngày` : ''}
    </div>`;
  }

  const skillRows = SK_MEASURED.map(k => {
    const s = d.skills[k] || { level: 'insufficient', attempts: 0 };
    const lv = SA_LEVEL[s.level] || SA_LEVEL.insufficient;
    const detail = s.level === 'insufficient'
      ? `<span class="sk-nodata">${s.attempts} lượt (cần ≥ 3)</span>`
      : `<span style="font-size:.75rem">${saPct(s.score)} · ${s.correct}/${s.attempts} đúng</span>`;
    const EV = { none: 'Chưa có dữ liệu', few: 'Dữ liệu còn ít', developing: 'Đang phát triển', stable: 'Tương đối ổn định', retested: 'Đã kiểm tra lại sau khoảng nghỉ' };
    const evTxt = s.stage && s.stage !== 'none' ? `<div class="sa-note" style="margin:2px 0 0">Bằng chứng: <b>${EV[s.stage] || ''}</b> · ${s.attempts} lượt${s.activeDays ? ' · ' + s.activeDays + ' ngày' : ''}${s.delayedN ? ` · sau khoảng nghỉ ≥24h: đúng ${s.delayedOk}/${s.delayedN}` : ''}</div>` : '';
    const last = s.lastAttemptAt ? `<div class="sa-note" style="margin:0">gần nhất: ${escapeHtml(new Date(s.lastAttemptAt).toLocaleDateString('vi-VN'))}</div>` : '';
    return `<div class="sa-brow" style="align-items:flex-start"><span class="sa-blbl">${escapeHtml(SK_LABEL[k])}</span><div style="flex:1"><span class="sa-lv ${lv.cls}">${lv.text}</span> ${detail}${evTxt}${last}</div></div>`;
  }).join('');

  const rec = d.recommendation || { items: [] };
  const recHtml = rec.items && rec.items.length
    ? rec.items.map(it => `<div class="sa-rec"><div class="sa-rec-t">${escapeHtml(it.title)}</div><div class="sa-rec-w">${escapeHtml(it.why)}</div>${it.stopWhen ? `<div class="sa-note" style="margin:4px 0 0">⏹ ${escapeHtml(it.stopWhen)}</div>` : ''}${it.action && it.action.kind === 'practice' ? `<button class="btn btn-sm" style="margin-top:6px" ${it.action.skill === 'listening' && !skAudioOk() ? 'disabled' : `onclick="skStartPracticeForWord('${escapeJsAttr(w.hz)}','${escapeJsAttr(it.action.skill)}')"`}>Luyện từ này · ${escapeHtml(it.action.hint || '')}</button>` : ''}</div>`).join('')
    : `<div class="sa-note">${escapeHtml(rec.note || 'Chưa có khuyến nghị.')}</div>`;

  const weakTypes = (d.weakTypes || []).length
    ? `<div style="font-size:.82rem"><b>Dạng bài hay sai:</b> ${d.weakTypes.map(t => `${escapeHtml(saTypeLabel(t.exercise_type))} (${t.wrong}/${t.n} sai)`).join('; ')}</div>`
    : '';
  const hist = (d.history || []).slice(0, 15).map(h => `<div class="sa-hist"><span style="width:44px;color:var(--muted)">${escapeHtml(new Date(h.ts).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }))}</span>
    <span>${h.ok ? '✅' : '❌'}</span><span style="flex:1">${escapeHtml(saTypeLabel(h.exercise_type) || SK_LABEL[h.skill] || '')}<span style="color:var(--muted)"> · ${escapeHtml(SA_SOURCE_TEXT[h.kind] || h.kind)}</span></span>
    ${h.response_time_ms != null ? `<span style="color:var(--muted)">${(h.response_time_ms / 1000).toFixed(1)}s</span>` : ''}</div>`).join('');

  return saStyle() + back + head
    + `<div class="panel"><div class="panel-title">📅 Trạng thái FSRS</div>${fsrs}</div>`
    + `<div class="panel"><div class="panel-title">🎯 Kỹ năng của từ này</div>${skillRows}${weakTypes}
        <div class="sa-note">Mỗi kỹ năng đánh giá riêng; cần ≥ 3 lượt hợp lệ mới kết luận, “tốt” cần ≥ 5 lượt. Lượt vừa xem đáp án (kiểm tra ngay sau học, luyện lại câu sai) không được tính vào điểm. Không có điểm tổng hợp.</div></div>`
    + `<div class="panel"><div class="panel-title">💡 Nên luyện gì?</div>${recHtml}</div>`
    + `<div class="panel"><div class="panel-title">🕘 Lịch sử gần đây</div>${hist || '<div class="sa-note">Chưa có lượt nào ghi nhận kỹ năng cho từ này.</div>'}
        <div class="sa-note">Chỉ liệt kê các lượt từ khi hệ thống ghi nhận kỹ năng; tối đa 15 lượt gần nhất.</div></div>`;
}

function saResetState() {
  saState = { recs: null, retention: null, loadedAt: 0, error: null, word: null, wordLoading: false, wordError: null };
}
