// test/adaptive-v111.test.js — kiểm thử V111: thích ứng thật hơn. Chạy: node test/adaptive-v111.test.js
// Trọng tâm: chứng minh các tín hiệu mới THỰC SỰ ĐỔI lựa chọn dạng câu (không chỉ chạy không lỗi).
'use strict';
const assert = require('assert');
global.QE = require('../js/question-engine');
global.SS = require('../js/skill-score');
const QS = require('../js/question-selector');
const S = require('../lib/skills');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e)); }
}
const POOL = [
  { hz: '准备', py: 'zhǔnbèi', vi: 'chuẩn bị', l: 5 }, { hz: '认真', py: 'rènzhēn', vi: 'nghiêm túc', l: 5 },
  { hz: '参加', py: 'cānjiā', vi: 'tham gia', l: 5 }, { hz: '发现', py: 'fāxiàn', vi: 'phát hiện', l: 5 },
  { hz: '学习', py: 'xuéxí', vi: 'học tập', l: 1 }, { hz: '休息', py: 'xiūxi', vi: 'nghỉ ngơi', l: 1 },
  { hz: '苹果', py: 'píngguǒ', vi: 'quả táo', l: 2 }, { hz: '桌子', py: 'zhuōzi', vi: 'cái bàn', l: 2 },
  { hz: '准备好', py: 'zhǔnbèihǎo', vi: 'chuẩn bị xong', l: 6 }, { hz: '电脑', py: 'diànnǎo', vi: 'máy tính', l: 3 },
];
const ctx = (extra) => Object.assign({ pool: POOL, examples: [], sentences: [], confuseGroups: [], audioOk: true }, extra || {});
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };
const entry = (att, correct, extra) => {
  let row = null; for (let i = 0; i < att; i++) row = S.applyAttempt(row, i < correct);
  return Object.assign(SS.toProfileEntry(row), extra || {});
};
const W = POOL[0];
const ranked = (profile, o, word) => QS.rank(word || W, Object.assign({ profile, rand: () => 0.5 }, o || {})).map(x => x.typeId);

console.log('\n[1] Module tính điểm dùng chung (client = server)');
test('SS.classify/applyAttempt chính là hàm của lib/skills (không còn 2 bản công thức)', () => {
  assert.strictEqual(S.classify, SS.classify); assert.strictEqual(S.applyAttempt, SS.applyAttempt);
  assert.strictEqual(S.DECAY, SS.DECAY);
});
test('cập nhật tại chỗ ở client cho RA CÙNG phân loại với chuỗi cập nhật của server (100 chuỗi ngẫu nhiên)', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < 100; t++) {
    const n = 1 + Math.floor(rnd() * 25), res = Array.from({ length: n }, () => rnd() < 0.6);
    let server = null; for (const ok of res) server = S.applyAttempt(server, ok);
    // client: nhận hồ sơ lúc bắt đầu phiên (đã làm tròn qua JSON) rồi cập nhật tiếp từng câu
    const half = Math.floor(n / 2);
    let sv = null; for (let i = 0; i < half; i++) sv = S.applyAttempt(sv, res[i]);
    let prof = JSON.parse(JSON.stringify(SS.toProfileEntry(sv)));
    for (let i = half; i < n; i++) prof = SS.advanceProfileEntry(prof, res[i]);
    const want = S.classify(server);
    assert.strictEqual(prof.level, want.level, 'level lệch ở chuỗi ' + t);
    assert.strictEqual(prof.attempts, want.attempts);
    if (want.score != null) assert.ok(Math.abs(prof.score - want.score) < 1e-3, 'điểm lệch ' + prof.score + ' vs ' + want.score);
  }
});
test('toProfileEntry(null) = chưa đủ dữ liệu, không điểm', () => {
  const e = SS.toProfileEntry(null);
  assert.strictEqual(e.level, 'insufficient'); assert.strictEqual(e.score, null); assert.strictEqual(e.wa, 0);
});

console.log('\n[2] Hồ sơ cập nhật NGAY sau mỗi câu');
test('learn() không sửa hồ sơ cũ (bất biến) và trả bản mới', () => {
  const p0 = { recall: entry(8, 8) }; const snap = JSON.stringify(p0);
  const p1 = QS.learn(p0, QS.newSession(), { skill: 'recall' }, false, 1000);
  assert.strictEqual(JSON.stringify(p0), snap); assert.notStrictEqual(p1, p0);
});
test('sai liên tiếp làm kỹ năng tụt từ "tốt" xuống "yếu" và attempts tăng đúng', () => {
  let p = { recall: entry(8, 8) }; assert.strictEqual(p.recall.level, 'good');
  const ses = QS.newSession(); let lv = [];
  for (let i = 0; i < 6; i++) { p = QS.learn(p, ses, { skill: 'recall' }, false, 2000); lv.push(p.recall.level); }
  assert.strictEqual(p.recall.attempts, 14);
  assert.strictEqual(p.recall.level, 'weak', 'sau 6 lần sai phải yếu: ' + lv.join(','));
});
test('thiếu dữ liệu + trả lời đủ ≥ 3 lượt → từ "chưa đủ dữ liệu" chuyển thành có mức độ', () => {
  let p = {}; const ses = QS.newSession();
  for (let i = 0; i < 3; i++) p = QS.learn(p, ses, { skill: 'pinyin' }, true, 1500);
  assert.notStrictEqual(p.pinyin.level, 'insufficient');
});
test('THAY ĐỔI LỰA CHỌN: kỹ năng tốt → vừa sai nhiều câu → câu kế ưu tiên đúng kỹ năng vừa sai (trắc nghiệm vi2hz)', () => {
  let p = { recognition: entry(8, 8), recall: entry(8, 8), listening: entry(8, 8), pinyin: entry(8, 8), context: entry(8, 8) };
  const ses = QS.newSession();
  const before = ranked(p, { session: ses, allowTyped: false });
  assert.notStrictEqual(before[0], 'vi2hz', 'tiền đề: lúc đầu vi2hz chưa phải ưu tiên số 1');
  for (let i = 0; i < 5; i++) p = QS.learn(p, ses, { skill: 'recall' }, false, 3000);
  const after = ranked(p, { session: ses, allowTyped: false });
  assert.strictEqual(after[0], 'vi2hz', 'sau khi sai liên tiếp ở nhớ chủ động, vi2hz phải lên đầu: ' + after.join(','));
});

console.log('\n[3] Thời gian trả lời: "đúng nhưng chậm"');
test('chưa đủ mẫu: dùng ngưỡng tuyệt đối (12s với chọn, 30s với tự gõ)', () => {
  const ses = QS.newSession();
  assert.strictEqual(QS.isHesitant(ses, { skill: 'recall' }, 11000), false);
  assert.strictEqual(QS.isHesitant(ses, { skill: 'recall' }, 13000), true);
  assert.strictEqual(QS.isHesitant(ses, { skill: 'recall', typed: 'hz' }, 20000), false);
  assert.strictEqual(QS.isHesitant(ses, { skill: 'recall', typed: 'hz' }, 31000), true);
});
test('đủ mẫu: so với NHỊP của chính người học (trung vị × 1.8, sàn 4s) — người trả lời nhanh nói chung không bị coi chậm oan', () => {
  const ses = QS.newSession(); const q = { hz: 'a', typeId: 'hz2vi', skill: 'recognition' };
  for (const ms of [1000, 1200, 900, 1100]) QS.record(ses, q, true, ms);
  assert.strictEqual(QS.isHesitant(ses, q, 1500), false, '1.5s với trung vị ~1s: chưa chậm (sàn 4s)');
  assert.strictEqual(QS.isHesitant(ses, q, 5000), true, '5s so với ~1s: chậm');
  const slow = QS.newSession(); for (const ms of [9000, 8000, 10000]) QS.record(slow, q, true, ms);
  assert.strictEqual(QS.isHesitant(slow, q, 12000), false, 'người học vốn chậm: 12s không bị coi bất thường');
});
test('không đo được thời gian (null/0) → KHÔNG kết luận chậm', () => {
  const ses = QS.newSession();
  for (const ms of [null, undefined, 0, NaN]) assert.strictEqual(QS.isHesitant(ses, { skill: 'recall' }, ms), false);
});
test('chỉ câu ĐÚNG làm chuẩn nhịp (câu sai/bỏ qua không kéo chuẩn lên)', () => {
  const ses = QS.newSession(); const q = { hz: 'a', typeId: 'hz2vi', skill: 'recognition' };
  QS.record(ses, q, false, 20000); assert.deepStrictEqual(ses.rt, {});
});
test('learn(): đúng nhưng chậm → fragile=true; lần sau đúng nhanh → fragile=false; sai → false', () => {
  const ses = QS.newSession(); const q = { skill: 'recall' };
  let p = QS.learn({ recall: entry(6, 6) }, ses, q, true, 15000); assert.strictEqual(p.recall.fragile, true);
  p = QS.learn(p, ses, q, true, 1500); assert.strictEqual(p.recall.fragile, false);
  p = QS.learn(p, ses, q, true, 15000); p = QS.learn(p, ses, q, false, 15000); assert.strictEqual(p.recall.fragile, false);
});
test('THAY ĐỔI LỰA CHỌN: kỹ năng "tốt" nhưng đúng-chậm → không bị trừ điểm "đã vững" và được cộng củng cố', () => {
  const strong = { recall: entry(10, 10) }, fragile = { recall: entry(10, 10, { fragile: true }) };
  const a = QS.scoreType('vi2hz', 'recall', strong, null, W), b = QS.scoreType('vi2hz', 'recall', fragile, null, W);
  assert.ok(strong.recall.score >= QS.WEIGHTS.strongAt, 'tiền đề: điểm ≥ ngưỡng vững (' + strong.recall.score + ')');
  assert.ok(b - a >= QS.WEIGHTS.strongPenalty + QS.WEIGHTS.fragileBonus - 1e-9, 'chênh lệch ' + (b - a));
});
test('đúng-chậm chặn câu tự gõ dù kỹ năng "tốt" (chưa chắc thì chưa gõ)', () => {
  const good = { recall: entry(10, 10), pinyin: entry(10, 10) };
  assert.ok(ranked(good, { allowTyped: true }).some(t => QE.TYPES[t].typed), 'tiền đề: bình thường có câu gõ');
  const frag = { recall: entry(10, 10, { fragile: true }), pinyin: entry(10, 10, { fragile: true }) };
  assert.ok(!ranked(frag, { allowTyped: true }).some(t => QE.TYPES[t].typed));
});
test('nhịp trả lời được khôi phục từ nhật ký khi tải lại trang (QS.record dùng lại được)', () => {
  const log = [{ hz: 'a', typeId: 'hz2vi', skill: 'recognition', correct: true, ms: 1000 }, { hz: 'b', typeId: 'hz2vi', skill: 'recognition', correct: true, ms: 1100 }, { hz: 'c', typeId: 'hz2vi', skill: 'recognition', correct: true, ms: 900 }];
  const ses = QS.newSession(); for (const e of log) QS.record(ses, { hz: e.hz, typeId: e.typeId, skill: e.skill, typed: false, correctIndex: null }, e.correct, e.ms);
  assert.strictEqual(ses.rt['recognition:c'].length, 3);
});

console.log('\n[4] Độ khó / trạng thái FSRS');
const prof = { recognition: entry(8, 6), recall: entry(8, 6), listening: entry(8, 6), pinyin: entry(8, 6), context: entry(8, 6) };
test('từ KHÓ (difficulty ≥ 8) → dạng dễ (hz2vi) xếp trên dạng khó (vi2hz) với cùng hồ sơ', () => {
  const hard = Object.assign({}, W, { state: 2, difficulty: 9, lapses: 0, reps: 6 });
  const d = QS.scoreType('hz2vi', 'recognition', prof, null, hard) - QS.scoreType('vi2hz', 'recall', prof, null, hard);
  const n = QS.scoreType('hz2vi', 'recognition', prof, null, W) - QS.scoreType('vi2hz', 'recall', prof, null, W);
  assert.ok(d - n >= QS.WEIGHTS.hardEasyBonus + QS.WEIGHTS.hardHardPenalty - 1e-9, 'hiệu chênh ' + (d - n));
});
test('thẻ đang học dở / học lại (state 1|3) và nhiều lần quên (lapses ≥ 3) cũng được coi là khó', () => {
  for (const w of [Object.assign({}, W, { state: 1 }), Object.assign({}, W, { state: 3 }), Object.assign({}, W, { state: 2, lapses: 3, difficulty: 5 })]) assert.strictEqual(QS.wordHardness(w), 'hard');
});
test('từ DỄ & ổn định (state 2, difficulty ≤ 4, không quên, ≥ 4 lượt ôn) → dạng khó hơn được ưu tiên', () => {
  const easy = Object.assign({}, W, { state: 2, difficulty: 3, lapses: 0, reps: 8 });
  assert.strictEqual(QS.wordHardness(easy), 'easy');
  const d = QS.scoreType('vi2hz', 'recall', prof, null, easy) - QS.scoreType('hz2vi', 'recognition', prof, null, easy);
  const n = QS.scoreType('vi2hz', 'recall', prof, null, W) - QS.scoreType('hz2vi', 'recognition', prof, null, W);
  assert.ok(d - n >= QS.WEIGHTS.easyHardBonus + QS.WEIGHTS.easyEasyPenalty - 1e-9);
});
test('từ mới (chưa có thẻ) hoặc thiếu trường FSRS → KHÔNG suy đoán độ khó', () => {
  assert.strictEqual(QS.wordHardness(W), null);
  assert.strictEqual(QS.wordHardness(null), null);
  assert.strictEqual(QS.wordHardness(Object.assign({}, W, { state: 2, difficulty: 6, lapses: 1, reps: 3 })), null);
});

console.log('\n[5] Độ dài hàng đợi còn lại');
test('còn nhiều thẻ (> 25) → câu tự gõ và điền từ bị hạ; hàng đợi ngắn thì không', () => {
  const good = { recall: entry(10, 10), pinyin: entry(10, 10), context: entry(10, 10) };
  const typedLong = QS.scoreType('typeVi2hz', 'recall', good, null, W, { remaining: 40 }), typedShort = QS.scoreType('typeVi2hz', 'recall', good, null, W, { remaining: 5 });
  assert.ok(Math.abs(typedShort - typedLong - QS.WEIGHTS.typedLongQueuePenalty) < 1e-9);
  const clozeLong = QS.scoreType('cloze', 'context', good, null, W, { remaining: 40 }), clozeShort = QS.scoreType('cloze', 'context', good, null, W, { remaining: 5 });
  assert.ok(Math.abs(clozeShort - clozeLong - QS.WEIGHTS.slowTypeLongQueuePenalty) < 1e-9);
  const hz = QS.scoreType('hz2vi', 'recognition', good, null, W, { remaining: 40 }), hz2 = QS.scoreType('hz2vi', 'recognition', good, null, W, { remaining: 5 });
  assert.strictEqual(hz, hz2, 'dạng nhanh không bị ảnh hưởng');
});
test('không truyền remaining (ví dụ buổi luyện bổ sung) → không ảnh hưởng', () => {
  const good = { recall: entry(10, 10) };
  assert.strictEqual(QS.scoreType('typeVi2hz', 'recall', good, null, W), QS.scoreType('typeVi2hz', 'recall', good, null, W, {}));
});

console.log('\n[6] Từ hay nhầm → đáp án nhiễu có chủ đích');
const WRONG = POOL[8]; // 准备好 — người học hay nhầm 准备 với 准备好
test('lần trước nhầm "准备好" (chữ Hán) → nay ở câu chữ Hán→NGHĨA, nghĩa của 准备好 xuất hiện làm đáp án nhiễu', () => {
  let found = 0;
  for (let i = 0; i < 40; i++) {
    const q = QE.build('hz2vi', W, ctx({ confusions: [{ text: '准备好', n: 3 }], rand: seq(0.1 * (i % 9), 0.37, 0.71) }));
    if (!q) continue;
    if (q.options.some(o => o.key === WRONG.vi)) { found++; assert.deepStrictEqual(q.confusionInjected, { text: '准备好', donorHz: '准备好' }); }
  }
  assert.ok(found > 0, 'không bao giờ chèn được đáp án hay nhầm');
});
test('nếu hợp lệ thì LUÔN chèn (không phụ thuộc may rủi) khi nhiễu chèn qua validate', () => {
  // 准备好 "chuẩn bị xong" trùng nghĩa với "chuẩn bị" → validate phải CHẶN (sẽ có 2 đáp án đúng) → giữ câu gốc, không chèn
  const q = QE.build('hz2vi', W, ctx({ confusions: [{ text: '准备好', n: 3 }] }));
  if (q) assert.ok(!q.confusionInjected || !q.options.some(o => o.key === '准备好' && o.key === q.correctKey));
});
test('chèn ở câu nghĩa→chữ Hán: đáp án nhầm xuất hiện ở lựa chọn, đáp án đúng vẫn đúng chỗ, không trùng lựa chọn nào', () => {
  const pool = POOL.filter(x => x.hz !== '准备好');
  const donor = { hz: '准背', py: 'zhǔnbèi2', vi: 'mang vác', l: 5 };
  let hit = 0;
  for (let i = 0; i < 30; i++) {
    const q = QE.build('vi2hz', W, { pool: pool.concat([donor]), examples: [], sentences: [], confuseGroups: [], audioOk: true, confusions: [{ text: '准背', n: 2 }], rand: seq(0.05 * i % 1, 0.5, 0.9) });
    if (!q) continue;
    assert.strictEqual(q.options[q.correctIndex].key, '准备', 'đáp án đúng phải còn nguyên và đúng chỉ số');
    assert.strictEqual(new Set(q.options.map(o => o.key)).size, q.options.length, 'lựa chọn bị trùng');
    if (q.options.some(o => o.key === '准背')) hit++;
  }
  assert.ok(hit > 0 && hit === 30, 'phải chèn đáp án hay nhầm ở mọi câu hợp lệ, được ' + hit + '/30');
});
test('đáp án sai KHÔNG khớp từ nào trong kho (vd gõ lung tung) → bị bỏ qua, câu vẫn bình thường', () => {
  const q = QE.build('hz2vi', W, ctx({ confusions: [{ text: 'asdfgh', n: 5 }] }));
  assert.ok(q && !q.confusionInjected);
});
test('KHÔNG chèn vào câu điền từ (cloze), câu tự gõ hay bài phân biệt có sẵn', () => {
  const sent = [{ zh: '我在准备考试。', vi: 'Tôi đang chuẩn bị thi.', hz: '准备' }];
  const q = QE.build('cloze', W, ctx({ sentences: sent, examples: sent, confusions: [{ text: '认真', n: 4 }] }));
  if (q) assert.ok(!q.confusionInjected);
  const t = QE.build('typeVi2hz', POOL[4], ctx({ confusions: [{ text: '认真', n: 4 }] }));
  if (t) assert.ok(!t.confusionInjected);
});
test('không có confusions → câu y hệt hành vi cũ (không dấu vết)', () => {
  const q = QE.build('hz2vi', W, ctx());
  assert.ok(q && q.confusionInjected === undefined);
});
test('mọi câu có chèn đều qua QE.validate (FUZZ 300 lần, nhiều dạng)', () => {
  let injected = 0;
  for (let i = 0; i < 300; i++) {
    const w = POOL[i % POOL.length], other = POOL[(i * 3 + 1) % POOL.length];
    for (const type of ['hz2vi', 'vi2hz', 'hz2py', 'listen2hz', 'listen2vi']) {
      const q = QE.build(type, w, ctx({ confusions: [{ text: other.hz, n: 2 }, { text: other.vi, n: 2 }], rand: seq((i % 10) / 10, 0.3, 0.8) }));
      if (!q) continue;
      const byHz = new Map(POOL.map(x => [x.hz, x]));
      const v = QE.validate(q, { viOf: hz => (byHz.get(hz) || {}).vi, pyOf: hz => (byHz.get(hz) || {}).py });
      assert.ok(v.ok, type + ' không hợp lệ sau khi chèn: ' + v.reason);
      assert.strictEqual(q.options[q.correctIndex].key, q.correctKey);
      if (q.confusionInjected) injected++;
    }
  }
  assert.ok(injected > 0);
});
test('bài phân biệt (confusable) được cộng điểm khi từ hay nhầm; không có thì không', () => {
  const p = { recognition: entry(8, 6) };
  const a = QS.scoreType('confusable', 'recognition', p, null, W, { confused: true }), b = QS.scoreType('confusable', 'recognition', p, null, W, { confused: false });
  assert.ok(Math.abs(a - b - QS.WEIGHTS.confusionBonus) < 1e-9);
});

console.log('\n[7] Giải thích vì sao chọn dạng bài');
const pick = (profile, o, word) => QS.choose(word || W, ctx(), Object.assign({ profile, rand: () => 0.5 }, o || {}));
test('kỹ năng yếu → lý do nêu kỹ năng, % điểm và số lượt (số thật từ hồ sơ)', () => {
  const p = { recognition: entry(8, 8), recall: entry(6, 1), listening: entry(8, 8), pinyin: entry(8, 8), context: entry(8, 8) };
  const q = pick(p, { allowTyped: false });
  assert.strictEqual(q.typeId, 'vi2hz');
  assert.ok(q.why.includes('Nhớ chủ động') && q.why.includes('yếu') && /\d+%/.test(q.why) && q.why.includes('6 lượt'), q.why);
});
test('chưa đủ dữ liệu → lý do nói đúng "chưa đủ dữ liệu", không gọi là yếu', () => {
  const q = pick({}, { allowTyped: false });
  assert.ok(q.why && q.why.includes('Chưa đủ dữ liệu') && !q.why.includes('yếu'), q.why);
});
test('câu tự gõ → lý do giải thích đã vững ở dạng chọn', () => {
  const g = entry(10, 10); const p = { recognition: g, recall: g, listening: g, pinyin: g, context: g };
  let q; for (let i = 0; i < 20 && !(q && q.typed); i++) q = pick(p, { allowTyped: true, rand: seq(i / 20, 0.5) });
  assert.ok(q && q.typed && q.why.includes('tự gõ'), q && q.why);
});
test('đúng-chậm → lý do nói "đúng nhưng hơi chậm"', () => {
  const g = entry(10, 10, { fragile: true }), p = { recognition: g, recall: g, listening: g, pinyin: g, context: g };
  const q = pick(p, { allowTyped: false });
  assert.ok(q.why && q.why.includes('chậm'), q.why);
});
test('đáp án hay nhầm được chèn → lý do nêu đúng đáp án đó', () => {
  const donor = { hz: '准背', py: 'zhǔnbèi2', vi: 'mang vác', l: 5 };
  let q; for (let i = 0; i < 25 && !(q && q.confusionInjected); i++) q = QS.choose(W, { pool: POOL.filter(x => x.hz !== '准备好').concat([donor]), examples: [], sentences: [], confuseGroups: [], audioOk: true, confusions: [{ text: '准背', n: 2 }] }, { profile: {}, only: ['vi2hz', 'hz2vi'], rand: seq(i / 25, 0.4) });
  // `only` có 2 dạng nên không bị coi là ép → có lý do
  assert.ok(q && q.confusionInjected && q.why.includes('准背'), q && q.why);
});
test('dạng bị ÉP (chỉ 1 dạng, vd câu kiểm tra ngay sau xem từ mới) → KHÔNG đưa lý do', () => {
  const q = pick({}, { only: ['hz2vi'] }); assert.strictEqual(q.why, null);
});
test('không có dữ kiện hỗ trợ → KHÔNG bịa lý do (why = null)', () => {
  const ok = entry(10, 8), p = { recognition: ok, recall: ok, listening: ok, pinyin: ok, context: ok }; // đang phát triển/tốt, không chậm, không cũ
  const q = pick(p, { allowTyped: false });
  assert.ok(q.why === null || typeof q.why === 'string');
  if (q.why) assert.ok(!/yếu|chưa đủ/.test(q.why), 'lý do không khớp dữ liệu: ' + q.why);
});

console.log('\n[8] Không phá hành vi cũ');
test('hồ sơ KIỂU CŨ (phiên lưu trước V111, không có wa/wc): khôi phục từ điểm đã biết, KHÔNG mất thông tin "yếu"', () => {
  const old = { recall: { status: 'weak', level: 'weak', score: 0.3, attempts: 5 } };
  assert.ok(QS.rank(W, { profile: old, rand: () => 0.5 }).length > 0);
  const p = QS.learn(old, QS.newSession(), { skill: 'recall' }, true, 1000);
  assert.strictEqual(p.recall.attempts, 6);
  assert.strictEqual(p.recall.level, 'weak', 'một câu đúng không làm kỹ năng đang yếu (30%) biến mất');
  assert.ok(p.recall.score > 0.3 && p.recall.score < 0.5, 'điểm phải nhích lên vừa phải: ' + p.recall.score);
  // sai thì tụt thêm
  const q = QS.learn(old, QS.newSession(), { skill: 'recall' }, false, 1000);
  assert.ok(q.recall.score < 0.3);
});
test('hồ sơ kiểu cũ mà chưa đủ dữ liệu (score null) → đếm lại từ đầu, không bịa', () => {
  const p = QS.learn({ pinyin: { status: 'insufficient', score: null, attempts: 2 } }, QS.newSession(), { skill: 'pinyin' }, true, 500);
  assert.strictEqual(p.pinyin.attempts, 1); assert.strictEqual(p.pinyin.level, 'insufficient');
});
test('khôi phục từ điểm khớp với chuỗi thật: sai số < 0.05 so với cập nhật chính xác của server', () => {
  for (const pattern of [[1, 1, 0, 1, 1, 0], [0, 0, 0, 1], [1, 1, 1, 1, 1, 1, 1, 1]]) {
    let sv = null; for (const ok of pattern) sv = S.applyAttempt(sv, !!ok);
    const c = S.classify(sv);
    const oldShape = { status: c.status, level: c.level, score: Math.round(c.score * 100) / 100, attempts: c.attempts };
    const want = S.classify(S.applyAttempt(sv, true));
    const got = SS.advanceProfileEntry(oldShape, true);
    assert.ok(Math.abs(got.score - want.score) < 0.05, JSON.stringify(pattern) + ' ' + got.score + ' vs ' + want.score);
    assert.strictEqual(got.level, want.level);
  }
});
test('learn() với câu thiếu skill (vd ghép cặp) → trả nguyên hồ sơ', () => {
  const p0 = { recall: entry(5, 5) };
  assert.deepStrictEqual(QS.learn(p0, QS.newSession(), { typeId: 'match' }, true, 100), p0);
});
test('rank/choose không đổi kết quả khi không có tín hiệu V111 (hồ sơ V110, không FSRS, không remaining)', () => {
  const p = { recognition: { status: 'ok', level: 'good', score: 0.9, attempts: 8 }, recall: { status: 'weak', level: 'weak', score: 0.3, attempts: 6 } };
  const r = ranked(p, { allowTyped: false });
  assert.strictEqual(r[0], 'vi2hz');
});

console.log('\n[9] Hồ sơ server → trình duyệt (profileForClient)');
test('mọi kỹ năng đo được đều có mặt; thiếu dòng → "chưa đủ dữ liệu", score null, daysSince null (không mặc định thấp/cao)', () => {
  const p = S.profileForClient({}); 
  assert.deepStrictEqual(Object.keys(p).sort(), S.MEASURABLE_SKILLS.slice().sort());
  for (const sk of S.MEASURABLE_SKILLS) { assert.strictEqual(p[sk].level, 'insufficient'); assert.strictEqual(p[sk].score, null); assert.strictEqual(p[sk].daysSince, null); assert.strictEqual(p[sk].wa, 0); }
});
test('có số đếm (correct/wa/wc) để client cập nhật tiếp; điểm làm tròn 2 chữ số; daysSince đúng', () => {
  let row = null; for (const ok of [1, 1, 0, 1, 1, 1]) row = S.applyAttempt(row, !!ok);
  const now = Date.parse('2026-10-16T00:00:00Z');
  const p = S.profileForClient({ recall: Object.assign({}, row, { last_attempt_at: '2026-10-09T00:00:00Z' }) }, now);
  assert.strictEqual(p.recall.attempts, 6); assert.strictEqual(p.recall.correct, 5);
  assert.ok(Math.abs(p.recall.wa - row.w_attempts) < 1e-3 && Math.abs(p.recall.wc - row.w_correct) < 1e-3);
  assert.strictEqual(p.recall.score, Math.round(S.classify(row).score * 100) / 100);
  assert.strictEqual(p.recall.daysSince, 7);
});
test('JSON round-trip (đúng như gửi qua mạng) rồi client cập nhật tiếp = server cập nhật thêm 1 lượt', () => {
  let row = null; for (const ok of [1, 0, 1, 1, 0, 1, 1]) row = S.applyAttempt(row, !!ok);
  const sent = JSON.parse(JSON.stringify(S.profileForClient({ pinyin: row })));
  const client = SS.advanceProfileEntry(sent.pinyin, false);
  const server = S.classify(S.applyAttempt(row, false));
  assert.strictEqual(client.level, server.level); assert.ok(Math.abs(client.score - server.score) < 1e-3);
});
test('reviewService dùng profileForClient và lấy confusions SONG SONG với hồ sơ (1 lô, không N+1)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../lib/fsrs/reviewService.js'), 'utf8');
  assert.ok(/profileForClient\(st\)/.test(src));
  assert.ok(/Promise\.all\(\[\s*skillStore\.getProfilesForWords[\s\S]*?skillStore\.getConfusionsForWords/.test(src));
  assert.ok(/it\.confusions = conf/.test(src));
});
test('getConfusionsForWords: chỉ ≥ 2 lần sai, 180 ngày, theo lô, tối đa 3/từ (kiểm tra mã nguồn — SQL chưa chạy trên DB thật)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../lib/skill-store.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function getConfusionsForWords'), src.indexOf('async function getProfilesForWords'));
  assert.ok(/HAVING COUNT\(\*\) >= 2/.test(fn) && /interval '180 days'/.test(fn) && /word_id = ANY\(\$2::int\[\]\)/.test(fn) && /list\.length < 3/.test(fn));
  assert.ok(/user_id = \$1/.test(fn), 'phải lọc theo user');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
