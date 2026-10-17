// js/skill-score.js — PHÉP TÍNH ĐIỂM KỸ NĂNG THUẦN (V111). Dùng CHUNG:
//   * server (lib/skills.js re-export) — nguồn sự thật khi ghi `word_skill_stats`;
//   * trình duyệt (js/question-selector.js) — cập nhật hồ sơ NGAY SAU MỖI CÂU trong phiên học, để bộ chọn thấy tiến bộ/sai lầm
//     vừa xảy ra thay vì dùng hồ sơ cũ nạp lúc bắt đầu phiên. Chỉ là bản ước lượng cục bộ cho phiên hiện tại; server vẫn ghi
//     và tính lại độc lập, lần tải phiên sau sẽ lấy số thật.
// Dùng chung MỘT công thức nên client và server không thể lệch nhau (trước đây công thức nằm riêng trong lib/skills.js).
//
// Quy tắc điểm (giữ nguyên từ V104): mỗi (từ, kỹ năng) có attempts/correct (đếm thô, không phai) và w_attempts/w_correct
// (mỗi lượt mới nhân số cũ với DECAY rồi cộng lượt mới). Điểm = (w_correct+1)/(w_attempts+2) — Laplace.

const SS = (function () {
  'use strict';
  const DECAY = 0.85;
  const MIN_ATTEMPTS = 3;      // dưới ngưỡng → "chưa đủ dữ liệu", KHÔNG hiện điểm
  const WEAK_THRESHOLD = 0.6;  // đủ dữ liệu và điểm < ngưỡng → "yếu"
  const GOOD_THRESHOLD = 0.75; // ≥ ngưỡng → "tốt"; giữa 2 ngưỡng → "đang phát triển"
  // V113: với Laplace + decay 0.85, CHỈ 3 lượt đúng đã cho điểm 0.78 (≥ GOOD) — quá ít để gọi là "tốt". Nay "tốt" cần thêm
  // đủ số lượt; chưa đủ thì tối đa "đang phát triển". Ngưỡng "yếu" giữ nguyên: 3 lượt sai liên tiếp (điểm 0.22) là tín hiệu đủ rõ.
  const GOOD_MIN_ATTEMPTS = 5;
  // Nhãn BẰNG CHỨNG (độ đầy đủ của dữ liệu — KHÔNG phải xác suất nhớ): quy tắc cố định, xem evidenceOf().
  const STABLE_MIN_ATTEMPTS = 6;   // 'tương đối ổn định': ≥ 6 lượt hợp lệ …
  const STABLE_MIN_DAYS = 3;       // … rải trên ≥ 3 ngày khác nhau …
  const RETESTED_MIN = 2;          // 'đã kiểm tra lại sau khoảng nghỉ': ≥ 2 lượt cách lần trước ≥ DELAYED_GAP_HOURS
  const DELAYED_GAP_HOURS = 24;    // khoảng nghỉ tối thiểu (tính trên cùng từ + cùng kỹ năng, chỉ lượt hợp lệ)

  function estimateScore(wAttempts, wCorrect) {
    const a = Number(wAttempts) || 0;
    const c = Number(wCorrect) || 0;
    return (c + 1) / (a + 2);
  }
  // Độ tin cậy 0..1: n/(n+3). 3 lượt → 0.5, 9 lượt → 0.75, 27 lượt → 0.9.
  function confidenceOf(attempts) {
    const n = Math.max(0, Number(attempts) || 0);
    return n / (n + 3);
  }
  // Trả { status: 'insufficient'|'weak'|'ok', level: insufficient|weak|developing|good, score|null, confidence, attempts }.
  // `status` giữ nguyên vì nhiều nơi đang dùng; `level` là cách gọi thân thiện cho giao diện.
  function classify(row) {
    const attempts = row ? Number(row.attempts) || 0 : 0;
    if (!row || attempts < MIN_ATTEMPTS) {
      return { status: 'insufficient', level: 'insufficient', score: null, confidence: confidenceOf(attempts), attempts };
    }
    const score = estimateScore(row.w_attempts, row.w_correct);
    let level = score < WEAK_THRESHOLD ? 'weak' : (score < GOOD_THRESHOLD ? 'developing' : 'good');
    if (level === 'good' && attempts < GOOD_MIN_ATTEMPTS) level = 'developing'; // chưa đủ lượt để gọi là tốt
    return { status: score < WEAK_THRESHOLD ? 'weak' : 'ok', level, score, confidence: confidenceOf(attempts), attempts };
  }
  // ── V113: BẰNG CHỨNG của một (từ, kỹ năng). Trả { stage, activeDays, delayedN, delayedOk }.
  //   none       : 0 lượt hợp lệ.                                            → "Chưa có dữ liệu"
  //   few        : 1–2 lượt.                                                 → "Dữ liệu còn ít"
  //   developing : ≥ 3 lượt nhưng chưa đạt tiêu chí dưới.                    → "Đang phát triển"
  //   stable     : ≥ 6 lượt, ≥ 3 ngày khác nhau, điểm ≥ GOOD.                → "Tương đối ổn định"
  //   retested   : ≥ 2 lượt sau khoảng nghỉ ≥ 24 giờ (và ≥ 3 lượt tổng).     → "Đã kiểm tra lại sau khoảng nghỉ"
  // Hàng cũ chưa có số ngày (active_days = 0 dù attempts > 0) KHÔNG thể là 'stable' (không biết rải mấy ngày → không đoán).
  // Nhãn CHỈ nói dữ liệu đủ đến đâu; kết quả cao/thấp nằm ở `level`. retested + level weak = "đã kiểm tra lại nhưng vẫn yếu".
  function evidenceOf(row) {
    const attempts = row ? Number(row.attempts) || 0 : 0;
    const activeDays = row ? Number(row.active_days != null ? row.active_days : row.ad) || 0 : 0;
    const delayedN = row ? Number(row.delayed_attempts != null ? row.delayed_attempts : row.dn) || 0 : 0;
    const delayedOk = row ? Number(row.delayed_correct != null ? row.delayed_correct : row.dc) || 0 : 0;
    let stage;
    if (attempts <= 0) stage = 'none';
    else if (attempts < MIN_ATTEMPTS) stage = 'few';
    else if (delayedN >= RETESTED_MIN) stage = 'retested';
    else if (attempts >= STABLE_MIN_ATTEMPTS && activeDays >= STABLE_MIN_DAYS && estimateScore(row.w_attempts, row.w_correct) >= GOOD_THRESHOLD) stage = 'stable';
    else stage = 'developing';
    return { stage, activeDays, delayedN, delayedOk };
  }

  // Bản JS của đúng phép cập nhật mà SQL UPSERT (skill-store.upsertSkillStatTx) thực hiện.
  function applyAttempt(prev, isCorrect) {
    const p = prev || { attempts: 0, correct: 0, w_attempts: 0, w_correct: 0 };
    const ok = isCorrect ? 1 : 0;
    return {
      attempts: p.attempts + 1,
      correct: p.correct + ok,
      w_attempts: p.w_attempts * DECAY + 1,
      w_correct: p.w_correct * DECAY + ok,
    };
  }

  // ── Hồ sơ gửi sang trình duyệt: classify + các số đếm cần để TIẾP TỤC cập nhật tại chỗ ──────────────────────────
  // wa/wc = w_attempts/w_correct (làm tròn 4 chữ số — sai số < 1e-4, không ảnh hưởng phân loại).
  const r4 = (x) => Math.round((Number(x) || 0) * 1e4) / 1e4;
  function toProfileEntry(row) {
    const c = classify(row);
    const ev = evidenceOf(row);
    return Object.assign({}, c, {
      correct: row ? Number(row.correct) || 0 : 0,
      wa: row ? r4(row.w_attempts) : 0,
      wc: row ? r4(row.w_correct) : 0,
      stage: ev.stage, ad: ev.activeDays, dn: ev.delayedN, dc: ev.delayedOk,
    });
  }
  // Cập nhật 1 mục hồ sơ (trình duyệt) sau 1 câu: trả mục MỚI (không sửa mục cũ). entry có thể undefined (chưa có dữ liệu).
  function advanceProfileEntry(entry, isCorrect) {
    const e = entry || {};
    // Hồ sơ KIỂU CŨ (phiên đã lưu cục bộ trước V111) chỉ có status/score/attempts, KHÔNG có wa/wc. Không ghép attempts cũ với
    // wa=0 (mâu thuẫn: "đủ dữ liệu" nhưng điểm rác) và cũng không vứt thông tin đã có. Khôi phục CHÍNH XÁC từ số đã biết:
    //   w_attempts chỉ phụ thuộc số lượt: Σ DECAY^i (i < n) = (1 − DECAY^n)/(1 − DECAY);
    //   w_correct suy từ điểm: score = (wc+1)/(wa+2) ⇒ wc = score·(wa+2) − 1 (sai số do điểm làm tròn 2 chữ số ≈ 0.04).
    // Hồ sơ cũ mà chưa đủ dữ liệu (score null) thì không có gì để khôi phục → đếm lại từ đầu.
    let base = null;
    if (Number.isFinite(e.wa) && Number.isFinite(e.wc)) {
      base = { attempts: Number(e.attempts) || 0, correct: Number(e.correct) || 0, w_attempts: e.wa, w_correct: e.wc };
    } else if (Number.isFinite(e.score) && Number(e.attempts) >= MIN_ATTEMPTS) {
      const n = Number(e.attempts), wa = (1 - Math.pow(DECAY, n)) / (1 - DECAY);
      base = { attempts: n, correct: 0, w_attempts: wa, w_correct: Math.max(0, Math.min(wa, e.score * (wa + 2) - 1)) };
    }
    const next = applyAttempt(base, !!isCorrect);
    // V113: số ngày / lượt sau nghỉ — ước lượng cục bộ theo daysSince của mục cũ (server tính lại chính xác bằng SQL).
    const ok = isCorrect ? 1 : 0, gapDays = Number.isFinite(e.daysSince) ? e.daysSince : null;
    const ad0 = Number(e.ad) || 0, dn0 = Number(e.dn) || 0, dc0 = Number(e.dc) || 0;
    const newDay = gapDays == null || gapDays >= 1, delayed = gapDays != null && gapDays * 24 >= DELAYED_GAP_HOURS;
    next.active_days = ad0 + (newDay ? 1 : 0);
    next.delayed_attempts = dn0 + (delayed ? 1 : 0);
    next.delayed_correct = dc0 + (delayed ? ok : 0);
    const out = toProfileEntry(next);
    out.daysSince = 0; // vừa kiểm tra xong
    return out;
  }

  return { DECAY, MIN_ATTEMPTS, WEAK_THRESHOLD, GOOD_THRESHOLD, GOOD_MIN_ATTEMPTS, STABLE_MIN_ATTEMPTS, STABLE_MIN_DAYS, RETESTED_MIN, DELAYED_GAP_HOURS, estimateScore, confidenceOf, classify, evidenceOf, applyAttempt, toProfileEntry, advanceProfileEntry };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SS;
