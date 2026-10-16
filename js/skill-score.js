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
    const level = score < WEAK_THRESHOLD ? 'weak' : (score < GOOD_THRESHOLD ? 'developing' : 'good');
    return { status: score < WEAK_THRESHOLD ? 'weak' : 'ok', level, score, confidence: confidenceOf(attempts), attempts };
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
    return Object.assign({}, c, {
      correct: row ? Number(row.correct) || 0 : 0,
      wa: row ? r4(row.w_attempts) : 0,
      wc: row ? r4(row.w_correct) : 0,
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
    const out = toProfileEntry(next);
    out.daysSince = 0; // vừa kiểm tra xong
    return out;
  }

  return { DECAY, MIN_ATTEMPTS, WEAK_THRESHOLD, GOOD_THRESHOLD, estimateScore, confidenceOf, classify, applyAttempt, toProfileEntry, advanceProfileEntry };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SS;
