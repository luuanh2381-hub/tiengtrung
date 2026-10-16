// js/question-engine.js — BỘ TẠO CÂU HỎI (V106). THUẦN: không DOM, không mạng, không biến toàn cục của
// ứng dụng — mọi phụ thuộc (kho từ, câu ví dụ, bộ chọn nhiễu, âm thanh) truyền qua `ctx` để kiểm thử
// được trong Node và thay thế được mà không đụng giao diện.
//
// Mỗi DẠNG BÀI là 1 mục trong TYPES (module hoá: muốn thêm dạng mới = thêm 1 mục + 1 hàm dựng).
// QE.build(typeId, word, ctx) trả về câu hỏi HỢP LỆ hoặc null (null = không đủ dữ liệu để tạo câu
// không mơ hồ → bộ chọn sẽ bỏ qua dạng đó cho từ đó, KHÔNG tạo câu không thể trả lời).
//
// ĐẢM BẢO của mọi câu hỏi (kiểm bởi QE.validate, có test):
//   * đúng 1 đáp án đúng; các lựa chọn khác nhau từng đôi một (không trùng nhãn, không trùng nghĩa);
//   * đáp án sai KHÔNG thể bị coi là đúng theo dữ liệu hiện có: lọc trùng nghĩa (khi hỏi theo nghĩa),
//     trùng cách đọc (khi hỏi bằng âm thanh), trùng pinyin (khi chọn pinyin), từ đã xuất hiện trong câu (cloze);
//   * phần đề không để lộ đáp án (câu nghe không hiện chữ Hán/Pinyin; cloze đã khoét từ);
//   * vị trí đáp án đúng không lặp liên tiếp cùng một chỗ.
//
// Chỉ dùng dữ liệu CÓ THẬT: pinyin lấy đúng chuỗi `py` của từ (không tự ghép); câu ví dụ lấy từ
// word_examples / SENTENCES (không do AI sinh); câu ví dụ hiện CHƯA có pinyin nên không hiển thị pinyin câu.

const QE = (function () {
  'use strict';

  // ── Danh mục dạng bài ───────────────────────────────────────────────────────────────────────
  // quizType: chiều câu hỏi mà server (/api/study/review) tự chấm. answerField: đáp án là nghĩa|chữ Hán|pinyin.
  const TYPES = {
    hz2vi:      { id: 'hz2vi',      label: 'Chữ Hán → Nghĩa',        skill: 'recognition', quizType: 'hz2vi', answerField: 'vi', exerciseFsrs: 'review-hz2vi',      exercisePractice: 'practice-recognition' },
    vi2hz:      { id: 'vi2hz',      label: 'Nghĩa → Chữ Hán',        skill: 'recall',      quizType: 'vi2hz', answerField: 'hz', exerciseFsrs: 'review-vi2hz',      exercisePractice: 'practice-recall' },
    listen2hz:  { id: 'listen2hz',  label: 'Nghe → Chữ Hán',         skill: 'listening',   quizType: 'vi2hz', answerField: 'hz', exerciseFsrs: 'review-listen',     exercisePractice: 'practice-listening',    needsAudio: true },
    listen2vi:  { id: 'listen2vi',  label: 'Nghe → Nghĩa',           skill: 'listening',   quizType: 'hz2vi', answerField: 'vi', exerciseFsrs: 'review-listen-vi',  exercisePractice: 'practice-listening-vi', needsAudio: true },
    hz2py:      { id: 'hz2py',      label: 'Chữ Hán → Pinyin',       skill: 'pinyin',      quizType: 'hz2py', answerField: 'py', exerciseFsrs: 'review-hz2py',      exercisePractice: 'practice-pinyin' },
    cloze:      { id: 'cloze',      label: 'Điền từ vào câu',        skill: 'context',     quizType: 'vi2hz', answerField: 'hz', exerciseFsrs: 'review-cloze',      exercisePractice: 'practice-context',      needsExample: true },
    // V110 — câu TỰ NHẬP đáp án (không có lựa chọn). `typed` = 'hz' | 'py': server chấm bằng js/answer-match.js.
    // Có cả bản FSRS chính thức (exerciseFsrs) lẫn bản luyện bổ sung (exercisePractice), cùng kỹ năng với bản trắc nghiệm.
    typeVi2hz:  { id: 'typeVi2hz',  label: 'Nghĩa → Gõ chữ Hán',     skill: 'recall',      quizType: 'vi2hz', answerField: 'hz', exerciseFsrs: 'review-vi2hz-typed', exercisePractice: 'practice-recall-typed', typed: 'hz' },
    typeHz2py:  { id: 'typeHz2py',  label: 'Chữ Hán → Gõ pinyin',    skill: 'pinyin',      quizType: 'hz2py', answerField: 'py', exerciseFsrs: 'review-hz2py-typed', exercisePractice: 'practice-pinyin-typed', typed: 'py' },
    // Chỉ luyện bổ sung (không đi đường FSRS): đáp án chọn trong nhóm chữ dễ nhầm có chú giải kiểm chứng sẵn.
    confusable: { id: 'confusable', label: 'Phân biệt chữ dễ nhầm',  skill: 'recall',      quizType: 'vi2hz', answerField: 'hz', exerciseFsrs: null,                exercisePractice: 'practice-confusable',   practiceOnly: true },
  };
  const MCQ_ORDER = ['hz2vi', 'vi2hz', 'listen2hz', 'listen2vi', 'hz2py', 'cloze']; // thứ tự ưu tiên khi hoà điểm
  const TYPED_ORDER = ['typeVi2hz', 'typeHz2py'];                                   // V110: chỉ được xét khi người gọi bật allowTyped

  // ── Chuẩn hoá ──────────────────────────────────────────────────────────────────────────────
  function normText(s) {
    return String(s == null ? '' : s).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  }
  // Tập nghĩa của 1 từ: tách theo ; , / ， 、 và bỏ phần chú thích trong ngoặc.
  function meaningSet(vi) {
    const out = new Set();
    String(vi || '').replace(/[（(][^）)]*[）)]/g, ' ').split(/[;,，、/]+/).forEach(t => {
      const n = normText(t).replace(/[.!?~"'“”]/g, '').trim();
      if (n) out.add(n);
    });
    const whole = normText(vi);
    if (whole) out.add(whole);
    return out;
  }
  function meaningsOverlap(a, b) {
    const A = meaningSet(a), B = meaningSet(b);
    for (const t of A) if (B.has(t)) return true;
    return false;
  }
  // Khoá pinyin để so sánh: giữ dấu thanh (khác thanh = khác âm), bỏ khoảng trắng/dấu nháy.
  function pyKey(py) { return normText(py).replace(/[\s'’·\-]/g, ''); }

  function defaultRand() { return Math.random(); }
  function shuffled(arr, rand) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function countOccurrences(text, sub) {
    if (!sub) return 0;
    let n = 0, i = 0;
    while ((i = text.indexOf(sub, i)) !== -1) { n++; i += sub.length; }
    return n;
  }

  // ── Chọn nhiễu ─────────────────────────────────────────────────────────────────────────────
  // `eligible(candidate)` loại mọi ứng viên có thể bị coi là đáp án đúng. Ưu tiên bộ chọn nhiễu "nặng"
  // (ctx.heavy = pickHeavyDistractors) — nhưng nhiễu nặng chỉ được dùng SAU khi qua bộ lọc mơ hồ.
  function pickDistractors(word, ctx, need, eligible, preferHeavy) {
    const rand = ctx.rand || defaultRand;
    const seen = new Set([word.hz]);
    const pool = (ctx.pool || []).filter(x => x && x.hz && !seen.has(x.hz) && (seen.add(x.hz), true) && eligible(x));
    let ranked = pool;
    if (preferHeavy && typeof ctx.heavy === 'function' && pool.length) {
      try { ranked = ctx.heavy(word, pool, pool.length, { mode: 'text', answerField: 'hz' }) || pool; } catch { ranked = pool; }
    } else {
      ranked = shuffled(pool, rand);
    }
    return ranked.slice(0, need);
  }

  // Xếp đáp án đúng vào vị trí KHÔNG trùng vị trí đúng của câu trước (nếu có ≥2 vị trí).
  function placeCorrect(correctOpt, distractorOpts, ctx) {
    const rand = ctx.rand || defaultRand;
    const n = distractorOpts.length + 1;
    const recent = ctx.recentCorrectPositions || [];
    const last = recent.length ? recent[recent.length - 1] : -1;
    let positions = [];
    for (let i = 0; i < n; i++) positions.push(i);
    if (n > 1 && last >= 0) {
      const filtered = positions.filter(p => p !== last);
      // 2 câu liền trước cùng 1 vị trí → chắc chắn tránh; còn lại tránh vị trí vừa rồi.
      if (filtered.length) positions = filtered;
    }
    const pos = positions[Math.floor(rand() * positions.length)];
    const rest = shuffled(distractorOpts, rand);
    const options = rest.slice(0, pos).concat([correctOpt], rest.slice(pos));
    return { options, correctIndex: pos };
  }

  function optionOf(field, w) {
    if (field === 'hz') return { key: w.hz, label: w.hz, sub: null };
    if (field === 'py') return { key: w.py, label: w.py, sub: null };
    return { key: w.vi, label: w.vi, sub: null };
  }

  function explain(typeId, word, extra) {
    const hv = word.hanviet ? ` · Hán Việt: ${word.hanviet}` : '';
    const base = `${word.hz} (${word.py || '—'}) = ${word.vi}${hv}`;
    if (typeId === 'confusable' && extra && extra.tip) return [base, extra.tip];
    if (typeId === 'cloze' && extra && extra.sentence) {
      return [
        `Câu hoàn chỉnh: ${extra.sentence.zh}`,
        extra.sentence.vi ? `Nghĩa: ${extra.sentence.vi}` : '',
        base,
        'Pinyin của cả câu: chưa có trong dữ liệu nên chưa hiển thị.',
      ].filter(Boolean);
    }
    if (typeId === 'listen2hz' || typeId === 'listen2vi') return [`Bạn vừa nghe: ${base}`];
    if (typeId === 'hz2py' || typeId === 'typeHz2py') return [`${word.hz} đọc là ${word.py} (${word.vi}).`];
    return [base];
  }

  // ── Dựng từng dạng ─────────────────────────────────────────────────────────────────────────
  function assemble(typeId, word, ctx, prompt, distractors, extra) {
    const T = TYPES[typeId];
    const correct = optionOf(T.answerField, word);
    const placed = placeCorrect(correct, distractors.map(d => optionOf(T.answerField, d)), ctx);
    const q = {
      typeId, hz: word.hz, l: word.l, word,
      skill: T.skill, quizType: T.quizType,
      exerciseFsrs: T.exerciseFsrs, exercisePractice: T.exercisePractice,
      fsrsEligible: !T.practiceOnly,
      prompt,
      options: placed.options, correctIndex: placed.correctIndex, correctKey: correct.key,
      explanation: explain(typeId, word, extra),
      tip: (extra && extra.tip) || null,
      sentence: (extra && extra.sentence) || null,
    };
    return q;
  }

  function buildHz2Vi(word, ctx) {
    const base = normText(word.vi);
    const ds = pickDistractors(word, ctx, 3, x => x.vi && !meaningsOverlap(x.vi, word.vi) && normText(x.vi) !== base, true);
    return assemble('hz2vi', word, ctx, { kind: 'text', main: word.hz, sub: null, ask: `${word.hz} có nghĩa là gì?` }, ds);
  }
  function buildVi2Hz(word, ctx) {
    // Hỏi theo NGHĨA: nhiễu không được trùng nghĩa với đáp án (nếu không có ≥2 đáp án đúng).
    const ds = pickDistractors(word, ctx, 3, x => x.hz && x.vi && !meaningsOverlap(x.vi, word.vi), true);
    return assemble('vi2hz', word, ctx, { kind: 'text', main: word.vi, sub: null, ask: 'Chữ Hán nào có nghĩa này?' }, ds);
  }
  function buildListen2Hz(word, ctx) {
    if (!ctx.audioOk) return null;
    // Hỏi bằng ÂM THANH: nhiễu không được có cùng cách đọc (đồng âm không phân biệt được bằng tai).
    const k = pyKey(word.py);
    if (!k) return null;
    const ds = pickDistractors(word, ctx, 3, x => x.hz && pyKey(x.py) && pyKey(x.py) !== k, true);
    return assemble('listen2hz', word, ctx, { kind: 'audio', audioText: word.hz, ask: 'Nghe và chọn chữ Hán đúng' }, ds);
  }
  function buildListen2Vi(word, ctx) {
    if (!ctx.audioOk) return null;
    const base = normText(word.vi);
    const ds = pickDistractors(word, ctx, 3, x => x.vi && !meaningsOverlap(x.vi, word.vi) && normText(x.vi) !== base, true);
    return assemble('listen2vi', word, ctx, { kind: 'audio', audioText: word.hz, ask: 'Nghe và chọn nghĩa đúng' }, ds);
  }
  function buildHz2Py(word, ctx) {
    const k = pyKey(word.py);
    if (!k) return null; // không có pinyin chuẩn trong dữ liệu → không tự tạo
    const seenKeys = new Set([k]);
    const ds = pickDistractors(word, ctx, 3, x => {
      const kk = pyKey(x.py);
      if (!kk || seenKeys.has(kk)) return false;
      seenKeys.add(kk); return true;
    }, true);
    return assemble('hz2py', word, ctx, { kind: 'text', main: word.hz, sub: null, ask: `${word.hz} đọc là gì?` }, ds);
  }

  // Câu ví dụ hợp lệ cho cloze: chứa từ ĐÚNG 1 lần (khoét 1 chỗ trống không mơ hồ), độ dài vừa phải.
  function findSentences(word, ctx) {
    const out = [];
    for (const e of (ctx.examples || [])) {
      if (e && e.hz === word.hz && e.zh) out.push({ zh: e.zh, vi: e.vi || '', source: 'example' });
    }
    for (const s of (ctx.sentences || [])) {
      if (!s || !s.hz) continue;
      const hints = String(s.hint || '').split(/[、,，]/).map(t => t.trim()).filter(Boolean);
      if (hints.includes(word.hz)) out.push({ zh: s.hz, vi: s.vi || '', source: 'sentence' });
    }
    return out.filter(s => countOccurrences(s.zh, word.hz) === 1 && s.zh.length <= 40);
  }
  function buildCloze(word, ctx) {
    const rand = ctx.rand || defaultRand;
    const sentences = findSentences(word, ctx);
    if (!sentences.length) return null;
    const sentence = sentences[Math.floor(rand() * sentences.length)];
    const sharesChar = (a, b) => { for (const ch of a) if (b.includes(ch)) return true; return false; };
    // Nhiễu: khác nghĩa, không xuất hiện trong câu, không chung chữ với đáp án, cùng độ dài chữ (cùng dạng).
    // Hạn chế còn lại (nói rõ trong báo cáo): không có dữ liệu loại từ/ngữ pháp để chứng minh nhiễu "không
    // vừa câu"; bản dịch tiếng Việt của câu được hiển thị ngay dưới chỗ trống để khử mơ hồ về nghĩa.
    const ds = pickDistractors(word, ctx, 3, x =>
      x.hz && x.vi && !meaningsOverlap(x.vi, word.vi) && !sentence.zh.includes(x.hz) &&
      !sharesChar(x.hz, word.hz) && [...x.hz].length === [...word.hz].length, false);
    const blanked = sentence.zh.replace(word.hz, '＿＿＿');
    return assemble('cloze', word, ctx,
      { kind: 'cloze', main: blanked, sub: sentence.vi || null, ask: 'Chọn từ điền vào chỗ trống' }, ds, { sentence });
  }
  function buildConfusable(word, ctx) {
    const groups = ctx.confuseGroups || [];
    const g = groups.find(gr => gr && Array.isArray(gr.chars) && gr.tip && gr.chars.some(c => c.hz === word.hz));
    if (!g || g.chars.length < 2) return null;
    const others = g.chars.filter(c => c.hz !== word.hz && c.vi && !meaningsOverlap(c.vi, word.vi)).map(c => ({ hz: c.hz, py: c.py, vi: c.vi }));
    if (!others.length) return null;
    const q = assemble('confusable', word, ctx, { kind: 'text', main: word.vi, sub: null, ask: 'Chữ nào có nghĩa này? (các chữ rất dễ nhầm)' }, others.slice(0, 3), { tip: g.tip });
    return q;
  }


  // ── V110: câu tự nhập ───────────────────────────────────────────────────────────────────────
  // Nghĩa → tự gõ chữ Hán. Mơ hồ nếu có từ KHÁC trùng nghĩa: cùng pinyin → không dựng (không thể phân biệt bằng đề);
  // khác pinyin → hiện pinyin làm gợi ý khử mơ hồ (đánh dấu hinted để bộ chọn/hiển thị biết đây là bài có gợi ý).
  function buildTypeVi2Hz(word, ctx) {
    if (!word.vi || !word.hz) return null;
    const pool = (ctx.pool || []).filter(x => x && x.hz && x.hz !== word.hz && x.vi && meaningsOverlap(x.vi, word.vi));
    const k = pyKey(word.py);
    if (pool.some(x => !k || !pyKey(x.py) || pyKey(x.py) === k)) return null; // không đủ dữ liệu để khử mơ hồ
    const hint = pool.length ? word.py : null;
    const q = assembleTyped('typeVi2hz', word, { kind: 'text', main: word.vi, sub: hint ? `Gợi ý pinyin: ${hint}` : null, ask: 'Gõ chữ Hán có nghĩa này' });
    if (q) q.hinted = !!hint;
    return q;
  }
  // Chữ Hán → tự gõ pinyin. Cần pinyin chuẩn hợp lệ trong dữ liệu (không tự ghép/đoán).
  function buildTypeHz2Py(word, ctx) {
    const amod = answerMatcher();
    if (!amod || !word.py || !word.hz) return null;
    const alts = amod.splitAlternatives(word.py);
    if (!alts.length || !alts.every(a => amod.parsePinyin(a))) return null; // pinyin chứa ký tự lạ → không chấm được tin cậy
    return assembleTyped('typeHz2py', word, { kind: 'text', main: word.hz, sub: null, ask: 'Gõ pinyin có dấu thanh (nǐ hǎo) hoặc số thanh (ni3 hao3)' });
  }
  function answerMatcher() {
    if (typeof AM !== 'undefined') return AM;
    try { return (typeof require === 'function') ? require('./answer-match') : null; } catch { return null; }
  }
  function assembleTyped(typeId, word, prompt) {
    const T = TYPES[typeId];
    const correct = optionOf(T.answerField, word);
    return {
      typeId, hz: word.hz, l: word.l, word,
      skill: T.skill, quizType: T.quizType, typed: T.typed,
      exerciseFsrs: T.exerciseFsrs, exercisePractice: T.exercisePractice,
      fsrsEligible: true,
      prompt, options: [], correctIndex: -1, correctKey: correct.key,
      explanation: explain(typeId, word), tip: null, sentence: null,
    };
  }

  const BUILDERS = { typeVi2hz: buildTypeVi2Hz, typeHz2py: buildTypeHz2Py, hz2vi: buildHz2Vi, vi2hz: buildVi2Hz, listen2hz: buildListen2Hz, listen2vi: buildListen2Vi, hz2py: buildHz2Py, cloze: buildCloze, confusable: buildConfusable };

  // ── Kiểm tra hợp lệ (dùng cả trong build và trong test) ────────────────────────────────────
  function validateTyped(q) {
    const T = TYPES[q.typeId];
    if (!q.typed || q.typed !== T.typed) return { ok: false, reason: 'câu tự nhập thiếu kiểu chấm' };
    if (q.options && q.options.length) return { ok: false, reason: 'câu tự nhập không có lựa chọn' };
    if (!normText(q.correctKey)) return { ok: false, reason: 'thiếu đáp án chuẩn' };
    // Đề không được lộ đáp án.
    const stem = JSON.stringify({ m: q.prompt.main, a: q.prompt.ask });
    if (q.typeId === 'typeVi2hz' && stem.includes(q.word.hz)) return { ok: false, reason: 'đề lộ chữ Hán' };
    if (q.typeId === 'typeHz2py' && q.word.py && stem.includes(q.word.py)) return { ok: false, reason: 'đề lộ pinyin' };
    return { ok: true };
  }
  function validate(q, opts) {
    if (q && TYPES[q.typeId] && TYPES[q.typeId].typed) return validateTyped(q);
    const minOptions = (opts && opts.minOptions) || (q && q.typeId === 'confusable' ? 2 : 3);
    if (!q || !q.options) return { ok: false, reason: 'thiếu câu hỏi' };
    if (q.options.length < minOptions) return { ok: false, reason: 'không đủ lựa chọn' };
    if (q.options.length > 4) return { ok: false, reason: 'quá 4 lựa chọn' };
    const keys = q.options.map(o => normText(o.key));
    if (keys.some(k => !k)) return { ok: false, reason: 'lựa chọn rỗng' };
    if (new Set(keys).size !== keys.length) return { ok: false, reason: 'lựa chọn trùng nhau' };
    if (!(q.correctIndex >= 0 && q.correctIndex < q.options.length)) return { ok: false, reason: 'chỉ số đáp án sai' };
    if (q.options[q.correctIndex].key !== q.correctKey) return { ok: false, reason: 'đáp án đúng không khớp' };
    const T = TYPES[q.typeId];
    if (!T) return { ok: false, reason: 'dạng bài lạ' };
    // Không nhiễu nào được "đúng theo dữ liệu".
    const wrong = q.options.filter((o, i) => i !== q.correctIndex);
    if (T.answerField === 'vi' || (T.answerField === 'hz' && q.typeId !== 'listen2hz' && q.typeId !== 'cloze')) {
      // Đáp án là nghĩa, hoặc hỏi theo nghĩa → không được trùng nghĩa với từ gốc.
      for (const o of wrong) {
        const wv = T.answerField === 'vi' ? o.key : (opts && opts.viOf && opts.viOf(o.key));
        if (wv && meaningsOverlap(wv, q.word.vi)) return { ok: false, reason: 'nhiễu trùng nghĩa' };
      }
    }
    if (q.typeId === 'listen2hz') for (const o of wrong) { if (opts && opts.pyOf && pyKey(opts.pyOf(o.key)) === pyKey(q.word.py)) return { ok: false, reason: 'nhiễu đồng âm' }; }
    if (q.typeId === 'hz2py') for (const o of wrong) if (pyKey(o.key) === pyKey(q.word.py)) return { ok: false, reason: 'nhiễu trùng pinyin' };
    // Đề không lộ đáp án.
    if (q.prompt.kind === 'audio') {
      const text = JSON.stringify({ m: q.prompt.main, s: q.prompt.sub, a: q.prompt.ask });
      if (text.includes(q.word.hz) || (q.word.py && text.includes(q.word.py))) return { ok: false, reason: 'đề nghe lộ chữ Hán/Pinyin' };
    }
    if (q.prompt.kind === 'cloze') {
      if (!String(q.prompt.main).includes('＿＿＿')) return { ok: false, reason: 'cloze chưa khoét chỗ trống' };
      if (String(q.prompt.main).includes(q.word.hz)) return { ok: false, reason: 'cloze còn lộ từ' };
    }
    if (q.typeId === 'hz2vi' && q.prompt.ask.includes(q.word.vi)) return { ok: false, reason: 'đề lộ nghĩa' };
    return { ok: true };
  }

  // Dựng + kiểm hợp lệ. `viOf/pyOf` tra từ theo chữ Hán trong kho để kiểm nhiễu (đáp án chữ Hán).
  function build(typeId, word, ctx) {
    ctx = ctx || {};
    const T = TYPES[typeId], b = BUILDERS[typeId];
    if (!T || !b || !word || !word.hz) return null;
    if (T.needsAudio && !ctx.audioOk) return null;
    let q;
    try { q = b(word, ctx); } catch { return null; }
    if (!q) return null;
    const byHz = new Map((ctx.pool || []).map(w => [w.hz, w]));
    byHz.set(word.hz, word);
    const v = validate(q, {
      minOptions: ctx.minOptions,
      viOf: hz => (byHz.get(hz) || {}).vi,
      pyOf: hz => (byHz.get(hz) || {}).py,
    });
    return v.ok ? q : null;
  }

  // ── GHÉP CẶP (dạng 7): chữ Hán ↔ nghĩa | chữ Hán ↔ pinyin ─────────────────────────────────
  // Chỉ nhận các từ có nhãn phải KHÁC nhau hoàn toàn (nghĩa không trùng nghĩa, pinyin không trùng) để
  // mỗi cặp có đúng 1 cách ghép. Cần ≥3 cặp, tối đa 4.
  function buildMatch(words, kind, ctx) {
    ctx = ctx || {};
    const rand = ctx.rand || defaultRand;
    const k = kind === 'py' ? 'py' : 'vi';
    const chosen = [];
    for (const w of shuffled(words || [], rand)) {
      if (!w || !w.hz || !w[k]) continue;
      if (chosen.some(c => c.hz === w.hz)) continue;
      const clash = chosen.some(c => k === 'vi' ? meaningsOverlap(c.vi, w.vi) : pyKey(c.py) === pyKey(w.py));
      if (clash) continue;
      chosen.push(w);
      if (chosen.length === 4) break;
    }
    if (chosen.length < 3) return null;
    return {
      typeId: 'match', kind: k, skill: k === 'vi' ? 'recognition' : 'pinyin',
      exercisePractice: k === 'vi' ? 'practice-match-vi' : 'practice-match-py', fsrsEligible: false,
      pairs: chosen.map(w => ({ hz: w.hz, l: w.l, right: w[k], word: w })),
      rights: shuffled(chosen.map(w => w[k]), rand),
      lefts: shuffled(chosen.map(w => w.hz), rand),
    };
  }

  return { TYPES, MCQ_ORDER, TYPED_ORDER, build, validate, buildMatch, normText, meaningSet, meaningsOverlap, pyKey, findSentences, placeCorrect };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QE;
