// lib/skill-adaptive.js — Module ĐỘC LẬP đề xuất KỸ NĂNG nên luyện tiếp cho từng từ.
//
// Module này THUẦN (không DB, không mạng). Nó KHÔNG chọn từ nào được học và KHÔNG sắp xếp lại phiên
// học: việc đó vẫn 100% do FSRS (lib/fsrs/reviewService.js → getStudySession). Module này chỉ trả lời
// câu hỏi "với từ ĐÃ được FSRS chọn này, hôm nay nên hỏi theo dạng nào?".
//
// Quy tắc (theo thứ tự ưu tiên):
//   0. Từ MỚI (chưa từng ôn): luôn 'recognition' — lần đầu gặp thì phải cho nhìn chữ Hán chọn nghĩa,
//      không thể bắt nhớ chủ động/nghe ngay một từ chưa từng học.
//   1. Có kỹ năng ĐỦ dữ liệu và YẾU → chọn kỹ năng yếu nhất (điểm thấp nhất; hoà thì ít lượt hơn).
//   2. Chưa có kỹ năng yếu nhưng còn kỹ năng CHƯA ĐỦ dữ liệu → chọn kỹ năng ít lượt nhất để thu thêm
//      thông tin (cân bằng); hoà thì xoay vòng theo `rotation` để không dồn mãi vào một dạng.
//   3. Mọi kỹ năng đều đủ dữ liệu và ổn → chọn kỹ năng có điểm thấp nhất.
// Chỉ đề xuất trong số `allowedSkills` (kỹ năng hiện có bài tập thực sự chạy được).

'use strict';

const { MEASURABLE_SKILLS, classify } = require('./skills');

// stats: { [skill]: { attempts, correct, w_attempts, w_correct } } — thiếu key = chưa có dữ liệu.
function pickSkillForWord({ isNew, stats, allowedSkills, rotation }) {
  const allowed = (Array.isArray(allowedSkills) ? allowedSkills : MEASURABLE_SKILLS)
    .filter(s => MEASURABLE_SKILLS.includes(s));
  if (!allowed.length) return null;
  if (isNew) return allowed.includes('recognition') ? 'recognition' : allowed[0];

  const s = stats || {};
  const info = allowed.map(skill => ({ skill, ...classify(s[skill]) }));

  const weak = info.filter(x => x.status === 'weak');
  if (weak.length) {
    weak.sort((a, b) => (a.score - b.score) || (a.attempts - b.attempts));
    return weak[0].skill;
  }

  const thin = info.filter(x => x.status === 'insufficient');
  if (thin.length) {
    const minAttempts = Math.min(...thin.map(x => x.attempts));
    const least = thin.filter(x => x.attempts === minAttempts);
    const r = Number.isFinite(rotation) ? Math.abs(Math.trunc(rotation)) : 0;
    return least[r % least.length].skill;
  }

  info.sort((a, b) => a.score - b.score);
  return info[0].skill;
}

// Gắn gợi ý cho cả phiên. KHÔNG đổi thứ tự, KHÔNG thêm/bớt phần tử, KHÔNG chạm vào từ đến hạn.
// items: [{ hz, type: 'review'|'new', wordId }]; profiles: Map|object wordId → stats.
function suggestForSession(items, profiles, allowedSkills) {
  const get = (id) => {
    if (id == null || !profiles) return {};
    return (profiles instanceof Map ? profiles.get(id) : profiles[id]) || {};
  };
  return items.map((it, idx) => ({
    hz: it.hz,
    suggestedSkill: pickSkillForWord({
      isNew: it.type === 'new',
      stats: get(it.wordId),
      allowedSkills,
      rotation: idx,
    }),
  }));
}

module.exports = { pickSkillForWord, suggestForSession };
