// test/retention-recommend.test.js — kiểm thử V110: phân nhóm trí nhớ dài hạn, khuyến nghị, chấm đáp án tự nhập qua lib/skills.
// Chạy: node test/retention-recommend.test.js
'use strict';
const assert = require('assert');
const S = require('../lib/skills');
const R = require('../lib/skill-recommend');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + '\n     ' + (e && e.message)); }
}
// Tạo 1 dòng thống kê từ chuỗi kết quả (true/false), áp dụng đúng công thức giảm dần của hệ thống.
function stats(results) {
  let st = null;
  for (const ok of results) st = S.applyAttempt(st, ok);
  return st;
}
const T = true, F = false;

console.log('\n[1] Nhóm khoảng cách (retentionBucketOf)');
test('đúng ranh giới các nhóm', () => {
  // V113: 5 nhóm theo yêu cầu: <10 phút | 10 phút–<24 giờ | 1–<3 ngày | 3–<7 ngày | ≥7 ngày
  assert.strictEqual(S.retentionBucketOf(9 / 60, false), 'immediate');
  assert.strictEqual(S.retentionBucketOf(10 / 60, false), 'short');
  assert.strictEqual(S.retentionBucketOf(23.9, false), 'short');
  assert.strictEqual(S.retentionBucketOf(24, false), 'd1');
  assert.strictEqual(S.retentionBucketOf(71.9, false), 'd1');
  assert.strictEqual(S.retentionBucketOf(72, false), 'd3');
  assert.strictEqual(S.retentionBucketOf(24 * 7 - 0.1, false), 'd3');
  assert.strictEqual(S.retentionBucketOf(24 * 7, false), 'd7');
});
test('vừa xem đáp án (check/redo) → luôn "ngay sau học" dù khoảng cách bao lâu', () => {
  assert.strictEqual(S.retentionBucketOf(1000, true), 'immediate');
  assert.strictEqual(S.retentionBucketOf(null, true), 'immediate');
});
test('KHÔNG biết khoảng cách → không xếp nhóm nào (không đoán; null KHÔNG bị coi là 0 giờ)', () => {
  for (const g of [null, undefined, '', -1, NaN]) assert.strictEqual(S.retentionBucketOf(g, false), null, 'gap=' + String(g));
});
test('nguồn "check"/"redo" là nguồn đã thấy đáp án; "extra"/"mode" thì không', () => {
  assert.ok(S.SHOWN_ANSWER_SOURCES.includes('check') && S.SHOWN_ANSWER_SOURCES.includes('redo'));
  assert.ok(!S.SHOWN_ANSWER_SOURCES.includes('extra') && !S.SHOWN_ANSWER_SOURCES.includes('mode'));
});

console.log('\n[2] Tổng hợp trí nhớ dài hạn (summarizeRetention)');
test('chưa có dữ liệu → mọi tỉ lệ null, không bịa', () => {
  const r = S.summarizeRetention([]);
  for (const id of ['immediate', 'short', 'd1', 'd3', 'd7']) assert.strictEqual(r[id].all.rate, null);
});
test('dưới ngưỡng mẫu (MIN_RETENTION_N) → rate null nhưng vẫn báo n', () => {
  const r = S.summarizeRetention([{ bucket: 'd3', kind: 'fsrs', n: S.MIN_RETENTION_N - 1, correct: 5 }]);
  assert.strictEqual(r.d3.all.n, S.MIN_RETENTION_N - 1);
  assert.strictEqual(r.d3.all.rate, null);
});
test('đủ mẫu → rate = correct/n của CHÍNH nhóm đó; tách riêng FSRS và luyện bổ sung', () => {
  const r = S.summarizeRetention([
    { bucket: 'd3', kind: 'fsrs', n: 10, correct: 8 },
    { bucket: 'd3', kind: 'practice', n: 10, correct: 4 },
  ]);
  assert.strictEqual(r.d3.fsrs.rate, 0.8);
  assert.strictEqual(r.d3.practice.rate, 0.4);
  assert.strictEqual(r.d3.all.n, 20); assert.strictEqual(r.d3.all.correct, 12); assert.strictEqual(r.d3.all.rate, 0.6);
});
test('nhóm lạ / kind lạ bị bỏ qua (không làm bẩn số liệu)', () => {
  const r = S.summarizeRetention([{ bucket: 'zzz', kind: 'fsrs', n: 99, correct: 99 }, { bucket: 'd1', kind: 'other', n: 99, correct: 99 }]);
  assert.strictEqual(r.d1.all.n, 0);
});

console.log('\n[3] Chấm đáp án qua gradeAnswer / EXERCISES');
test('trắc nghiệm giữ NGUYÊN hành vi cũ: so chuỗi chính xác (sau trim)', () => {
  const ex = S.resolveExercise('review-hz2py', 'hz2py');
  assert.strictEqual(S.gradeAnswer('zhǔnbèi', 'zhǔnbèi ', ex).answerCorrect, true);
  assert.strictEqual(S.gradeAnswer('zhǔnbèi', 'zhun3bei4', ex).answerCorrect, false); // không phải bài tự nhập → không nới
});
test('tự nhập pinyin: chấp nhận số thanh; từ chối không dấu', () => {
  const ex = S.resolveExercise('review-hz2py-typed', 'hz2py');
  assert.ok(ex && ex.typed === 'py' && ex.fsrs === true);
  assert.strictEqual(S.gradeAnswer('zhǔnbèi', 'zhun3bei4', ex).answerCorrect, true);
  const r = S.gradeAnswer('zhǔnbèi', 'zhunbei', ex);
  assert.strictEqual(r.answerCorrect, false); assert.strictEqual(r.verdict, 'toneless');
});
test('tự nhập chữ Hán: chuẩn hoá khoảng trắng/Unicode', () => {
  const ex = S.resolveExercise('review-vi2hz-typed', 'vi2hz');
  assert.strictEqual(S.gradeAnswer('准备', ' 准 备 ', ex).answerCorrect, true);
  assert.strictEqual(S.gradeAnswer('准备', '準備', ex).answerCorrect, false);
});
test('nhãn typed phải KHỚP quizType thật, nếu không bị loại (client không tự bật chế độ nới)', () => {
  assert.strictEqual(S.resolveExercise('review-hz2py-typed', 'hz2vi'), null);
  assert.strictEqual(S.resolveExercise('review-vi2hz-typed', 'hz2py'), null);
});
test('dạng tự nhập có bản FSRS chính thức và bản luyện bổ sung, cùng kỹ năng', () => {
  assert.strictEqual(S.EXERCISES['practice-recall-typed'].fsrs, false);
  assert.strictEqual(S.EXERCISES['practice-pinyin-typed'].fsrs, false);
  assert.strictEqual(S.EXERCISES['practice-pinyin-typed'].skill, 'pinyin');
});
test('classify có level: insufficient / weak / developing / good', () => {
  assert.strictEqual(S.classify(null).level, 'insufficient');
  assert.strictEqual(S.classify(stats([F, F, F, F])).level, 'weak');
  assert.strictEqual(S.classify(stats([T, T, T, T, T, T])).level, 'good');
  const dev = S.classify(stats([T, T, T, F, T]));
  assert.ok(['developing', 'good', 'weak'].includes(dev.level));
});

console.log('\n[4] Khuyến nghị theo từng từ');
test('chưa đủ dữ liệu → KHÔNG khuyến nghị, nêu lý do', () => {
  const r = R.recommendForWord({ stats: { recall: stats([F, F]) } }); // 2 lượt < MIN_ATTEMPTS
  assert.strictEqual(r.status, 'insufficient'); assert.strictEqual(r.items.length, 0); assert.ok(r.note);
});
test('chưa có dữ liệu gì → insufficient', () => assert.strictEqual(R.recommendForWord({}).status, 'insufficient'));
test('nhận diện tốt + nhớ chủ động yếu → ưu tiên nghĩa → chữ Hán, kèm số liệu giải thích', () => {
  const r = R.recommendForWord({ stats: { recognition: stats(Array(8).fill(T)), recall: stats([F, F, T, F, F, F]) } });
  assert.strictEqual(r.items[0].id, 'recall-gap');
  assert.strictEqual(r.items[0].action.skill, 'recall');
  assert.ok(/%/.test(r.items[0].why) && /lượt/.test(r.items[0].why), 'phải nêu số liệu đã dùng');
});
test('đọc được nhưng nghe yếu → khuyến nghị nghe', () => {
  const r = R.recommendForWord({ stats: { recognition: stats(Array(6).fill(T)), listening: stats([F, F, F, T]) } });
  assert.strictEqual(r.items[0].id, 'listening-weak');
});
test('pinyin yếu → khuyến nghị pinyin; kỹ năng chưa đủ dữ liệu KHÔNG bị gọi là yếu', () => {
  const r = R.recommendForWord({ stats: { pinyin: stats([F, F, F, F]), context: stats([F]) } });
  assert.deepStrictEqual(r.items.map(i => i.id), ['pinyin-weak']);
});
test('nhận diện yếu được ưu tiên cao nhất (nền tảng)', () => {
  const r = R.recommendForWord({ stats: { recognition: stats([F, F, F, F]), recall: stats([F, F, F, F]) } });
  assert.strictEqual(r.items[0].id, 'recognition-weak');
});
test('từ hay bị nhầm (đáp án sai lặp ≥ 2) → khuyến nghị riêng, nêu đáp án nhầm', () => {
  const r = R.recommendForWord({ stats: { recall: stats([T, T, T, T]) }, repeatedWrong: [{ wrong_answer: '准背', n: 3 }] });
  const c = r.items.find(i => i.id === 'confusion');
  assert.ok(c && c.why.includes('准背') && c.why.includes('3'));
});
test('CHỐNG LẶP: đã luyện nhiều gần đây mà vẫn yếu → đổi lời khuyên, không lặp lại "luyện thêm"', () => {
  const s = { recognition: stats(Array(6).fill(T)), recall: stats([F, F, F, F, F, F]) };
  const first = R.recommendForWord({ stats: s, recentBySkill: { recall: 1 } });
  const stalled = R.recommendForWord({ stats: s, recentBySkill: { recall: R.STALL_RECENT_ATTEMPTS } });
  assert.strictEqual(first.items[0].id, 'recall-gap');
  assert.strictEqual(stalled.items[0].id, 'recall-gap-stalled');
  assert.strictEqual(stalled.items[0].action, null, 'không còn nút "luyện thêm" cùng bài');
});
test('ổn định ở ≥ 3 kỹ năng → khuyến nghị GIẢM luyện bổ sung', () => {
  const g = stats(Array(8).fill(T));
  const r = R.recommendForWord({ stats: { recognition: g, recall: g, listening: g } });
  assert.strictEqual(r.items[0].id, 'stable');
});
test('chỉ 1–2 kỹ năng tốt → KHÔNG kết luận "ổn định"', () => {
  const g = stats(Array(8).fill(T));
  const r = R.recommendForWord({ stats: { recognition: g, recall: g } });
  assert.ok(!r.items.some(i => i.id === 'stable'));
});

console.log('\n[5] Khuyến nghị tổng thể');
const ov = (skills, tested = 20) => ({ testedWords: tested, skills });
const mkSk = (o) => { const s = {}; for (const k of S.MEASURABLE_SKILLS) s[k] = Object.assign({ enough: 0, weak: 0 }, o[k]); return s; };
test('chưa có dữ liệu → insufficient', () => assert.strictEqual(R.recommendGlobal({ overview: ov({}, 0) }).status, 'insufficient'));
test('kỹ năng có ≥ 3 từ yếu → khuyến nghị; 1–2 từ yếu → KHÔNG kết luận', () => {
  const a = R.recommendGlobal({ overview: ov(mkSk({ listening: { enough: 10, weak: 5 } })), retention: S.summarizeRetention([]) });
  assert.strictEqual(a.items[0].id, 'weak-listening');
  const b = R.recommendGlobal({ overview: ov(mkSk({ listening: { enough: 10, weak: 2 } })), retention: S.summarizeRetention([]) });
  assert.ok(!b.items.some(i => i.id === 'weak-listening'));
});
test('thiếu dữ liệu kiểm tra muộn → ghi chú, KHÔNG kết luận trí nhớ dài hạn', () => {
  const r = R.recommendGlobal({ overview: ov(mkSk({})), retention: S.summarizeRetention([{ bucket: 'd3', kind: 'fsrs', n: 3, correct: 3 }]) });
  assert.ok(r.notes.some(n => /Chưa đủ dữ liệu kiểm tra/.test(n)));
  assert.ok(!r.items.some(i => i.id === 'late-drop'));
});
test('kiểm tra muộn kém hơn ngay-sau-học ≥ 20 điểm (cả 2 nhóm đủ mẫu) → tăng ưu tiên kiểm tra lại', () => {
  const ret = S.summarizeRetention([
    { bucket: 'immediate', kind: 'practice', n: 20, correct: 19 },
    { bucket: 'd3', kind: 'fsrs', n: 20, correct: 10 },
  ]);
  const r = R.recommendGlobal({ overview: ov(mkSk({})), retention: ret });
  const it = r.items.find(i => i.id === 'late-drop');
  assert.ok(it && it.action.kind === 'delayed' && /95%/.test(it.why) && /50%/.test(it.why));
});
test('kiểm tra muộn tốt, không kỹ năng yếu → báo ổn định (giảm luyện không cần thiết)', () => {
  const ret = S.summarizeRetention([{ bucket: 'immediate', kind: 'practice', n: 20, correct: 18 }, { bucket: 'd7', kind: 'fsrs', n: 20, correct: 18 }]);
  const full = {}; for (const k of S.MEASURABLE_SKILLS) full[k] = { enough: 12, weak: 0 };
  const r = R.recommendGlobal({ overview: ov(mkSk(full)), retention: ret });
  assert.strictEqual(r.items[0].id, 'stable-overall');
});

console.log('\n[V113] Khuyến nghị: chẩn đoán, điều kiện dừng, mục tiêu chính');
test('kỹ năng thiếu dữ liệu → đề xuất CHẨN ĐOÁN, không gọi là yếu', () => {
  const r = R.recommendGlobal({ overview: ov(mkSk({ recognition: { enough: 20 }, recall: { enough: 20 }, listening: { enough: 1 }, pinyin: { enough: 20 }, context: { enough: 20 } })), retention: S.summarizeRetention([]) });
  const d = r.items.find(i => i.id === 'diagnose-listening');
  assert.ok(d && /chẩn đoán/.test(d.title) && /không có nghĩa là yếu/.test(d.why));
  assert.ok(!r.items.some(i => i.id === 'weak-listening'));
  assert.strictEqual(r.items.filter(i => i.id.startsWith('diagnose-')).length, 1, 'tối đa 1 gợi ý chẩn đoán (chống quá tải)');
});
test('khuyến nghị yếu có việc nổi bật → KHÔNG chen thêm gợi ý chẩn đoán', () => {
  const r = R.recommendGlobal({ overview: ov(mkSk({ recall: { enough: 10, weak: 5 } })), retention: S.summarizeRetention([]) });
  assert.ok(!r.items.some(i => i.id.startsWith('diagnose-')));
});
test('mọi khuyến nghị có hành động đều kèm điều kiện giảm/dừng; primaryGoal = việc đầu tiên có hành động', () => {
  const r = R.recommendGlobal({ overview: ov(mkSk({ recall: { enough: 10, weak: 5 } })), retention: S.summarizeRetention([]) });
  for (const it of r.items.filter(i => i.action)) assert.ok(it.stopWhen && it.stopWhen.length > 10, it.id);
  assert.strictEqual(r.primaryGoal.id, r.items.find(i => i.action).id);
});
test('khuyến nghị từng từ: có stopWhen', () => {
  const rec = R.recommendForWord({ stats: { recall: { attempts: 6, correct: 1, w_attempts: 4, w_correct: 0.5 }, recognition: { attempts: 6, correct: 6, w_attempts: 4, w_correct: 4 } }, recentBySkill: {} });
  assert.ok(rec.items.some(i => i.action && i.stopWhen));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
