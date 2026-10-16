// lib/skill-recommend.js — KHUYẾN NGHỊ LUYỆN TẬP CÁ NHÂN HOÁ (V110). THUẦN (không DB, không mạng, không AI ngoài).
//
// Nguyên tắc (theo yêu cầu):
//   * Mỗi khuyến nghị là một QUY TẮC rõ ràng, có `why` nêu đúng con số đã dùng → giải thích được, kiểm thử được.
//   * KHÔNG khuyến nghị khi thiếu dữ liệu (kỹ năng < MIN_ATTEMPTS lượt hợp lệ không được gọi là yếu/giỏi).
//   * KHÔNG lặp lại một việc mà người học đã làm nhiều gần đây mà không cải thiện → đổi sang lời khuyên "đổi cách".
//   * Khuyến nghị chỉ là GỢI Ý luyện bổ sung: không bao giờ đổi lịch FSRS, không tăng giới hạn học trong ngày.
//
// Đầu vào lấy từ hồ sơ kỹ năng (word_skill_stats) + nhật ký; module này chỉ diễn giải.

'use strict';

const { MEASURABLE_SKILLS, MIN_ATTEMPTS, classify, MIN_RETENTION_N } = require('./skills');

const SKILL_NAME = {
  recognition: 'Nhận diện chữ Hán', recall: 'Nhớ chủ động (nghĩa → chữ Hán)', listening: 'Nghe',
  pinyin: 'Pinyin', context: 'Dùng từ trong câu', pronunciation: 'Phát âm',
};
const SKILL_ACTION = { // gợi ý dạng bài cho từng kỹ năng — dùng cho nút "Luyện ngay"
  recognition: 'Chữ Hán → Nghĩa', recall: 'Nghĩa → Chữ Hán (chọn hoặc tự gõ)', listening: 'Nghe → Chữ Hán / Nghĩa',
  pinyin: 'Chữ Hán → Pinyin (chọn hoặc tự gõ)', context: 'Điền từ vào câu',
};
const STALL_RECENT_ATTEMPTS = 6; // đã luyện ≥ 6 lượt kỹ năng này trong 7 ngày mà vẫn yếu → không lặp lại cùng lời khuyên
const STABLE_MIN_SKILLS = 3;     // cần ≥ 3 kỹ năng có dữ liệu mới kết luận "ổn định"
const STABLE_MIN_ATTEMPTS = 5;   // và mỗi kỹ năng ≥ 5 lượt
const LATE_DROP_POINTS = 0.2;    // kiểm tra muộn kém hơn ngay-sau-học ≥ 20 điểm % mới gọi là "giảm"

const pct = (x) => Math.round(x * 100) + '%';
const levelText = { weak: 'yếu', developing: 'đang phát triển', good: 'tốt', insufficient: 'chưa đủ dữ liệu' };

// ── Theo TỪNG TỪ ───────────────────────────────────────────────────────────────────────────────
// stats: { [skill]: {attempts, correct, w_attempts, w_correct} } ; recentBySkill: { [skill]: số lượt trong 7 ngày gần nhất }
// repeatedWrong: [{ wrong_answer, n }] — đáp án sai lặp lại ≥ 2 lần (từ hay bị nhầm)
function recommendForWord({ stats, recentBySkill, repeatedWrong } = {}) {
  const profile = {};
  for (const sk of MEASURABLE_SKILLS) profile[sk] = classify((stats || {})[sk]);
  const enough = MEASURABLE_SKILLS.filter(sk => profile[sk].level !== 'insufficient');
  const recent = recentBySkill || {};
  const items = [];

  if (!enough.length) {
    return {
      status: 'insufficient', profile, items: [],
      note: `Chưa đủ dữ liệu: cần ít nhất ${MIN_ATTEMPTS} lượt kiểm tra hợp lệ ở một kỹ năng trước khi đưa ra khuyến nghị.`,
    };
  }

  const L = (sk) => profile[sk].level;
  const detail = (sk) => `${SKILL_NAME[sk]}: ${pct(profile[sk].score)} (${profile[sk].attempts} lượt)`;
  const basicsOk = L('recognition') === 'good' || L('recognition') === 'developing';

  // Thêm 1 khuyến nghị cho kỹ năng yếu; nếu đã luyện nhiều gần đây mà vẫn yếu → lời khuyên ĐỔI CÁCH, không lặp lại.
  function pushWeak(sk, priority, id, title, whyHead) {
    if ((recent[sk] || 0) >= STALL_RECENT_ATTEMPTS) {
      items.push({
        id: id + '-stalled', priority: priority - 1, skill: sk, action: null,
        title: `${SKILL_NAME[sk]} chưa tiến bộ dù đã luyện nhiều`,
        why: `${whyHead} Bạn đã làm ${recent[sk]} lượt kỹ năng này trong 7 ngày qua mà điểm vẫn thấp — lặp lại bài cũ chưa hiệu quả. ` +
             'Hãy xem lại từ cùng mẹo nhớ của bạn, hoặc nghỉ vài ngày rồi kiểm tra lại.',
      });
    } else {
      items.push({ id, priority, skill: sk, action: { kind: 'practice', skill: sk, hint: SKILL_ACTION[sk] }, title, why: whyHead });
    }
  }

  if (L('recognition') === 'weak') {
    pushWeak('recognition', 100, 'recognition-weak', 'Nhận diện chữ Hán còn yếu — ôn lại nghĩa trước',
      `${detail('recognition')} — nền tảng này cần vững trước khi luyện nhớ chủ động hay nghe.`);
  }
  if (repeatedWrong && repeatedWrong.length) {
    const top = repeatedWrong[0];
    items.push({
      id: 'confusion', priority: 90, skill: null, action: { kind: 'practice', skill: 'recall', hint: SKILL_ACTION.recall },
      title: 'Bạn hay nhầm từ này với một đáp án khác',
      why: `Bạn đã chọn/gõ “${top.wrong_answer}” sai ${top.n} lần cho từ này. Hãy so sánh hai đáp án cạnh nhau rồi luyện lại nghĩa → chữ Hán.`,
    });
  }
  if (L('recall') === 'weak' && basicsOk) {
    pushWeak('recall', 80, 'recall-gap', 'Nhận diện tốt nhưng nhớ chủ động còn yếu',
      `${detail('recognition')} nhưng ${detail('recall')} — bạn nhận ra khi thấy chữ nhưng khó tự nhớ lại. Tăng bài nghĩa → chữ Hán.`);
  } else if (L('recall') === 'weak') {
    pushWeak('recall', 75, 'recall-weak', 'Nhớ chủ động còn yếu', `${detail('recall')}.`);
  }
  if (L('listening') === 'weak') {
    pushWeak('listening', 70, 'listening-weak', basicsOk ? 'Đọc được nhưng nghe còn yếu' : 'Nghe còn yếu',
      basicsOk ? `${detail('recognition')} nhưng ${detail('listening')} — tăng bài nghe → chữ Hán / nghĩa.` : `${detail('listening')}.`);
  }
  if (L('pinyin') === 'weak') {
    pushWeak('pinyin', 60, 'pinyin-weak', 'Liên kết chữ Hán ↔ pinyin còn yếu',
      `${detail('pinyin')} — tăng bài chữ Hán → pinyin (có thể thử tự gõ pinyin có dấu thanh).`);
  }
  if (L('context') === 'weak') {
    pushWeak('context', 50, 'context-weak', 'Dùng từ trong câu còn yếu', `${detail('context')} — luyện điền từ vào câu.`);
  }

  const dataSkills = enough.filter(sk => profile[sk].attempts >= STABLE_MIN_ATTEMPTS);
  const allGood = dataSkills.length >= STABLE_MIN_SKILLS && dataSkills.every(sk => L(sk) === 'good') && enough.every(sk => L(sk) !== 'weak');
  if (!items.length && allGood) {
    items.push({
      id: 'stable', priority: 1, skill: null, action: null,
      title: 'Từ này đang ổn định — không cần luyện bổ sung',
      why: `${dataSkills.length} kỹ năng đều tốt (${dataSkills.map(sk => `${SKILL_NAME[sk]} ${pct(profile[sk].score)}`).join('; ')}). Cứ để lịch ôn FSRS lo phần còn lại.`,
    });
  }
  if (!items.length) {
    return { status: 'no-action', profile, items: [], note: 'Chưa có kỹ năng nào yếu rõ rệt. Tiếp tục ôn theo lịch FSRS; các kỹ năng còn thiếu dữ liệu sẽ được kiểm tra dần.' };
  }
  items.sort((a, b) => b.priority - a.priority);
  return { status: 'ok', profile, items };
}

// ── Tổng thể ───────────────────────────────────────────────────────────────────────────────────
// overview: { testedWords, skills: { [skill]: {enough, weak} } }   (skill-store.getOverview)
// retention: kết quả summarizeRetention()                           (skill-store.getRetention().buckets)
function recommendGlobal({ overview, retention } = {}) {
  const items = [];
  const notes = [];
  const tested = overview ? overview.testedWords : 0;
  if (!tested) {
    return { status: 'insufficient', items: [], notes: ['Chưa có dữ liệu kiểm tra kỹ năng. Hãy học vài phiên trong “Hôm nay học” để hệ thống có cơ sở đánh giá.'] };
  }

  // 1) Kỹ năng có nhiều từ yếu nhất (cần ≥ 3 từ yếu mới nêu, tránh kết luận từ 1–2 từ).
  const weakBySkill = MEASURABLE_SKILLS
    .map(sk => ({ sk, weak: overview.skills && overview.skills[sk] ? overview.skills[sk].weak : 0, enough: overview.skills && overview.skills[sk] ? overview.skills[sk].enough : 0 }))
    .filter(x => x.weak >= 3)
    .sort((a, b) => b.weak - a.weak);
  weakBySkill.slice(0, 2).forEach((x, i) => items.push({
    id: 'weak-' + x.sk, priority: 80 - i * 10, skill: x.sk, action: { kind: 'practice', skill: x.sk, hint: SKILL_ACTION[x.sk] },
    title: `${x.weak} từ còn yếu ở “${SKILL_NAME[x.sk]}”`,
    why: `Trong ${x.enough} từ đã đủ dữ liệu ở kỹ năng này, ${x.weak} từ có điểm dưới ${pct(0.6)}. Luyện: ${SKILL_ACTION[x.sk]}.`,
  }));

  // 2) Trí nhớ dài hạn: so kiểm tra muộn (≥ 3 ngày) với ngay-sau-học — chỉ khi CẢ HAI nhóm đủ mẫu.
  let late = { n: 0, correct: 0 };
  if (retention) {
    for (const id of ['week', 'month']) {
      const b = retention[id] && retention[id].all;
      if (b) { late.n += b.n; late.correct += b.correct; }
    }
  }
  const lateRate = late.n >= MIN_RETENTION_N ? late.correct / late.n : null;
  const immRate = retention && retention.immediate ? retention.immediate.all.rate : null;
  if (lateRate == null) {
    notes.push(`Chưa đủ dữ liệu kiểm tra sau khoảng nghỉ dài (cần ≥ ${MIN_RETENTION_N} lượt; hiện có ${late.n}). Hệ thống không suy đoán trí nhớ dài hạn khi chưa đủ mẫu.`);
  } else if (immRate != null && immRate - lateRate >= LATE_DROP_POINTS) {
    items.push({
      id: 'late-drop', priority: 85, skill: null, action: { kind: 'delayed' },
      title: 'Kết quả giảm khi kiểm tra sau nhiều ngày',
      why: `Ngay sau khi học: ${pct(immRate)}; sau ≥ 3 ngày: ${pct(lateRate)} (${late.correct}/${late.n} lượt). Nên tăng ưu tiên “Kiểm tra sau một khoảng nghỉ”.`,
    });
  } else if (!items.length) {
    items.push({
      id: 'stable-overall', priority: 1, skill: null, action: null,
      title: 'Kết quả đang ổn định',
      why: `Không có kỹ năng nào có ≥ 3 từ yếu, và kiểm tra sau nhiều ngày đạt ${pct(lateRate)} (${late.correct}/${late.n} lượt). Không cần thêm bài luyện bổ sung.`,
    });
  }
  items.sort((a, b) => b.priority - a.priority);
  return { status: items.length ? 'ok' : 'no-action', items, notes };
}

module.exports = { recommendForWord, recommendGlobal, SKILL_NAME, STALL_RECENT_ATTEMPTS, LATE_DROP_POINTS };
