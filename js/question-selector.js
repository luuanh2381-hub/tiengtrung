// js/question-selector.js — BỘ CHỌN DẠNG CÂU HỎI THÍCH ỨNG (V106). THUẦN, tách riêng khỏi giao diện.
//
// Phạm vi: bộ chọn KHÔNG quyết định từ nào được học, thứ tự hay số lượng — việc đó vẫn do FSRS (server) +
// hàng đợi quyết định (thẻ đến hạn không bao giờ bị bỏ). Bộ chọn chỉ trả lời: "với từ ĐÃ được chọn này,
// hỏi DẠNG nào?" rồi dựng câu hỏi bằng QE.build (câu không hợp lệ bị bỏ, thử dạng kế tiếp).
//
// Điểm ưu tiên của một dạng bài T cho từ w (cao hơn = chọn trước) — mọi hệ số ở WEIGHTS để chỉnh/kiểm thử:
//   base(T)
//   + weak        : kỹ năng của T "yếu" (đủ dữ liệu, điểm < 0.6)         → cộng mạnh theo độ yếu
//   + data        : kỹ năng của T "chưa đủ dữ liệu"                      → cộng nhỏ, giảm dần theo số lượt (thu thập thêm)
//   − strong      : kỹ năng của T đã ổn định cao (≥ 0.85)                → trừ nhẹ (không hỏi mãi dạng đã giỏi)
//   − repeatPair  : đã hỏi cặp (từ, dạng) này trong buổi                  → trừ rất mạnh (gần như loại)
//   − sameAsPrev  : trùng dạng với câu ngay trước; − streak khi ≥3 liên tiếp
//   − diversity   : dạng này đã dùng nhiều trong buổi
//   Giảm độ khó: nếu 3/4 câu gần nhất sai → giảm ảnh hưởng của "weak" và ưu tiên dạng dễ (hz2vi) —
//   tránh buổi học dồn toàn từ yếu khiến người học nản.
// Khi dữ liệu kỹ năng chưa đủ: KHÔNG kết luận yếu, chỉ phân phối cân bằng để thu thêm dữ liệu.

const QS = (function () {
  'use strict';

  const WEIGHTS = {
    base: { hz2vi: 1.0, vi2hz: 1.0, listen2hz: 1.0, listen2vi: 1.0, hz2py: 0.9, cloze: 1.1, confusable: 0.8, typeVi2hz: 0.9, typeHz2py: 0.9 },
    // V110 — câu TỰ NHẬP là "độ khó tăng dần": chỉ ưu tiên khi người học đã VỮNG kỹ năng đó ở dạng trắc nghiệm.
    typedMasteryBonus: 1.8, typedMinAttempts: 4,           // kỹ năng 'tốt' (≥0.75) và ≥ 4 lượt → cộng
    typedDevelopingPenalty: 0.6, typedNotReadyPenalty: 2.5, // đang phát triển → trừ nhẹ; yếu/thiếu dữ liệu → gần như không gõ
    typedStrugglePenalty: 3, typedLearningPenalty: 1.2, typedHardWordPenalty: 1.0, // đang vật lộn / thẻ đang học dở / từ rất khó
    staleBonusPerWeek: 0.2, staleCap: 0.8,                 // kỹ năng lâu chưa kiểm tra → ưu tiên nhẹ (tối đa +0.8)
    weakMin: 2.0, weakSlope: 3.0,       // weak = weakMin + weakSlope * (0.6 - score)
    dataMax: 1.2,                       // data = dataMax / (1 + attempts)
    strongPenalty: 0.4, strongAt: 0.85,
    repeatPair: 10,
    sameAsPrev: 1.0, streak3: 2.0,
    diversityPerUse: 0.1, diversityCap: 1.0,
    struggleWindow: 4, struggleWrong: 3, struggleWeakDamp: 0.3, struggleEasyBonus: 1.5,
  };
  const WEAK_THRESHOLD = 0.6;

  function newSession() {
    return { asked: {}, history: [], typeCount: {}, recentCorrectPositions: [] };
  }
  function pairKey(hz, typeId) { return hz + '|' + typeId; }

  // Ghi nhận 1 câu đã hỏi xong (gọi sau khi người học trả lời).
  function record(session, q, correct) {
    if (!session || !q) return;
    session.asked[pairKey(q.hz, q.typeId)] = (session.asked[pairKey(q.hz, q.typeId)] || 0) + 1;
    session.typeCount[q.typeId] = (session.typeCount[q.typeId] || 0) + 1;
    session.history.push({ hz: q.hz, typeId: q.typeId, correct: !!correct });
    if (session.history.length > 60) session.history.shift();
    session.recentCorrectPositions.push(q.correctIndex);
    if (session.recentCorrectPositions.length > 4) session.recentCorrectPositions.shift();
  }

  function struggling(session) {
    const h = (session && session.history) || [];
    const last = h.slice(-WEIGHTS.struggleWindow);
    if (last.length < WEIGHTS.struggleWindow) return false;
    return last.filter(x => !x.correct).length >= WEIGHTS.struggleWrong;
  }

  // Mức độ của 1 kỹ năng. Hồ sơ từ server có `level`; hồ sơ cũ/test chỉ có status+score → suy ra cùng quy tắc (0.6 / 0.75).
  function levelOf(p) {
    if (!p || p.status === 'insufficient') return 'insufficient';
    if (p.level) return p.level;
    if (p.status === 'weak') return 'weak';
    return (p.score != null && p.score >= 0.75) ? 'good' : 'developing';
  }

  function scoreType(typeId, skill, profile, session, word) {
    const W = WEIGHTS;
    let s = W.base[typeId] != null ? W.base[typeId] : 1;
    const p = profile && profile[skill];
    const tough = struggling(session);
    const T = QE.TYPES[typeId];
    const isTyped = !!(T && T.typed);
    if (isTyped) {
      // Tự nhập: KHÔNG hưởng thưởng "kỹ năng yếu" của trắc nghiệm (gõ khi chưa vững chỉ gây nản, không thêm thông tin).
      const lvl = levelOf(p);
      if (lvl === 'good' && (p.attempts || 0) >= W.typedMinAttempts) s += W.typedMasteryBonus;
      else if (lvl === 'developing') s -= W.typedDevelopingPenalty;
      else s -= W.typedNotReadyPenalty;
      if (tough) s -= W.typedStrugglePenalty;
      if (word && (word.state === 1 || word.state === 3)) s -= W.typedLearningPenalty; // thẻ đang Learning/Relearning
      if (word && (Number(word.difficulty) >= 8 || Number(word.lapses) >= 3)) s -= W.typedHardWordPenalty;
    } else if (p && p.status === 'weak') {
      const sc = p.score == null ? WEAK_THRESHOLD : p.score;
      s += (W.weakMin + W.weakSlope * Math.max(0, WEAK_THRESHOLD - sc)) * (tough ? W.struggleWeakDamp : 1);
    } else if (!p || p.status === 'insufficient') {
      s += W.dataMax / (1 + ((p && p.attempts) || 0));
    } else if (p.status === 'ok' && p.score != null && p.score >= W.strongAt) {
      s -= W.strongPenalty;
    }
    // Khoảng thời gian từ lần kiểm tra trước: kỹ năng ĐÃ có dữ liệu mà lâu chưa kiểm tra → ưu tiên nhẹ (không áp cho thiếu dữ liệu).
    if (p && p.status !== 'insufficient' && Number.isFinite(p.daysSince) && p.daysSince >= 7) {
      s += Math.min(W.staleCap, W.staleBonusPerWeek * Math.floor(p.daysSince / 7));
    }
    if (session) {
      if (session.asked[pairKey(word.hz, typeId)]) s -= W.repeatPair;
      const h = session.history;
      if (h.length && h[h.length - 1].typeId === typeId) {
        s -= W.sameAsPrev;
        if (h.length >= 3 && h.slice(-3).every(x => x.typeId === typeId)) s -= W.streak3;
      }
      s -= Math.min(W.diversityCap, W.diversityPerUse * (session.typeCount[typeId] || 0));
    }
    if (tough && typeId === 'hz2vi') s += W.struggleEasyBonus;
    return s;
  }

  // Trả về danh sách dạng ứng viên đã xếp theo điểm (giảm dần).
  function rank(word, opts) {
    const o = opts || {};
    const rand = o.rand || Math.random;
    // 'confusable' (chỉ luyện bổ sung) chỉ được xét khi caller cho phép; từ không thuộc nhóm dễ nhầm sẽ không dựng được → tự bị bỏ qua.
    // V110: câu tự nhập (QE.TYPED_ORDER) chỉ được xét khi người gọi bật allowTyped (người học có thể tắt trong cài đặt).
    let types = (o.only && o.only.length ? o.only
      : QE.MCQ_ORDER.concat(o.allowPracticeOnly ? ['confusable'] : [], o.allowTyped ? QE.TYPED_ORDER : [])).slice();
    if (!o.allowTyped) types = types.filter(t => !(QE.TYPES[t] && QE.TYPES[t].typed));
    // V110 — CỔNG CỨNG cho câu tự gõ khi hệ thống TỰ chọn: chỉ khi kỹ năng đó đã 'đang phát triển' hoặc 'tốt' với đủ lượt
    // (trắc nghiệm trước, tự gõ sau). Không dựa vào điểm mềm: nếu trắc nghiệm không dựng được (kho từ quá ít), câu tự gõ
    // không được lặng lẽ thế chỗ cho người chưa vững. `forced` = người học CHỌN TƯỜNG MINH chế độ tự gõ → không bị cổng này chặn.
    if (!o.forced) {
      types = types.filter(t => {
        const T = QE.TYPES[t];
        if (!T || !T.typed) return true;
        const p = o.profile && o.profile[T.skill];
        const lvl = levelOf(p);
        return (lvl === 'good' || lvl === 'developing') && ((p && p.attempts) || 0) >= WEIGHTS.typedMinAttempts;
      });
    }
    if (o.exclude) types = types.filter(t => !o.exclude.includes(t));
    if (!o.allowPracticeOnly) types = types.filter(t => !QE.TYPES[t].practiceOnly);
    if (o.fsrsOnly) types = types.filter(t => QE.TYPES[t].exerciseFsrs);
    const scored = types.map((t, i) => ({
      typeId: t, order: i,
      score: scoreType(t, QE.TYPES[t].skill, o.profile, o.session, word) + rand() * 1e-6, // phá hoà ổn định
    }));
    scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
    return scored;
  }

  // Chọn + dựng câu hỏi. Thử lần lượt các dạng theo điểm; dạng nào không dựng được câu hợp lệ thì bỏ qua.
  // Không dạng nào dựng được (kho từ quá ít) → hạ chuẩn: cho phép 2 lựa chọn với hz2vi; vẫn không được → null.
  function choose(word, qctx, opts) {
    const ranked = rank(word, opts);
    const ctx = Object.assign({}, qctx, { recentCorrectPositions: (opts && opts.session && opts.session.recentCorrectPositions) || [] });
    for (const r of ranked) {
      const q = QE.build(r.typeId, word, ctx);
      if (q) { q.chosenScore = r.score; return q; }
    }
    // Hạ chuẩn (kho từ quá ít) chỉ được dùng hz2vi khi dạng này KHÔNG bị loại (exclude) và nằm trong phạm vi `only`
    // — nếu không, "luyện lại câu sai" sẽ lặng lẽ hỏi lại đúng dạng vừa sai.
    const o = opts || {};
    const allowed = !(o.exclude && o.exclude.includes('hz2vi')) && (!o.only || !o.only.length || o.only.includes('hz2vi'));
    if (!allowed) return null;
    return QE.build('hz2vi', word, Object.assign({}, ctx, { minOptions: 2 })) || null;
  }

  return { WEIGHTS, newSession, record, rank, choose, scoreType, struggling };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QS;
