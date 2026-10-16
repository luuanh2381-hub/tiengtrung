#!/usr/bin/env node
// test/question-engine.test.js — kiểm thử BỘ TẠO CÂU HỎI (QE) và BỘ CHỌN (QS) của V106. Không cần DB/mạng.
// Trọng tâm: mọi câu hỏi sinh ra đều HỢP LỆ (không đáp án trùng/mơ hồ, không lộ đáp án) trên dữ liệu có
// cả các ca khó (đồng nghĩa, đồng âm, từ cùng chữ), và bộ chọn hành xử đúng theo kỹ năng/chống lặp.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0; const pending = [];
const test = (n, f) => pending.push({ n, f });
async function runAll() {
  for (const { n, f } of pending) {
    try { await f(); passed++; console.log('  ✅ ' + n); }
    catch (e) { failed++; console.log('  ❌ ' + n + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
}
const ctxVm = vm.createContext({ console, Math });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/question-engine.js'), 'utf8'), ctxVm);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/question-selector.js'), 'utf8'), ctxVm);
const QE = vm.runInContext('QE', ctxVm), QS = vm.runInContext('QS', ctxVm);

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// Kho từ có các ca khó thật: đồng nghĩa (học/学习), đồng âm (在/再), cùng chữ đầu (学校/学生).
const base = [
  { hz: '认真', py: 'rènzhēn', vi: 'nghiêm túc', l: 5, hanviet: 'nhận chân' },
  { hz: '准备', py: 'zhǔnbèi', vi: 'chuẩn bị', l: 5 }, { hz: '参加', py: 'cānjiā', vi: 'tham gia', l: 5 },
  { hz: '发现', py: 'fāxiàn', vi: 'phát hiện', l: 5 }, { hz: '学习', py: 'xuéxí', vi: 'học, học tập', l: 1 },
  { hz: '学', py: 'xué', vi: 'học', l: 1 }, { hz: '学校', py: 'xuéxiào', vi: 'trường học', l: 1 },
  { hz: '学生', py: 'xuésheng', vi: 'học sinh', l: 1 }, { hz: '休息', py: 'xiūxi', vi: 'nghỉ ngơi', l: 1 },
  { hz: '苹果', py: 'píngguǒ', vi: 'quả táo', l: 2 }, { hz: '桌子', py: 'zhuōzi', vi: 'cái bàn', l: 2 },
  { hz: '天气', py: 'tiānqì', vi: 'thời tiết', l: 2 }, { hz: '在', py: 'zài', vi: 'ở, đang', l: 3 },
  { hz: '再', py: 'zài', vi: 'lại, nữa', l: 3 }, { hz: '买', py: 'mǎi', vi: 'mua', l: 3 }, { hz: '卖', py: 'mài', vi: 'bán', l: 3 },
  { hz: '汤', py: 'tāng', vi: 'súp', l: 7 }, { hz: '包子', py: 'bāozi', vi: 'bánh bao', l: 7 },
];
const filler = [];
'电影音乐歌舞画书笔纸椅窗门灯车船飞机桥路山河海湖'.split('').forEach((c, i) => filler.push({ hz: c + c, py: 'fil' + i + 'ān', vi: 'vật số ' + i, l: 8 }));
const POOL = base.concat(filler);
const W = (hz) => POOL.find(w => w.hz === hz);
const EXAMPLES = [
  { hz: '学习', zh: '我每天学习汉语。', vi: 'Mỗi ngày tôi học tiếng Hán.' },
  { hz: '参加', zh: '参加参加会议。', vi: 'Tham gia họp.' },           // chứa từ 2 lần → KHÔNG được dùng cho cloze
];
const SENTENCES = [{ vi: 'Buổi sáng tôi ăn bánh bao và uống súp.', hz: '早上我吃包子，喝汤。', hint: '早上、包子、汤', l: 7 }];
const GROUPS = [{ chars: [{ hz: '买', py: 'mǎi', vi: 'mua' }, { hz: '卖', py: 'mài', vi: 'bán' }], tip: '卖 = 买 + nét thêm ở trên.' }];
const ctx = (over, seed) => Object.assign({ pool: POOL, examples: EXAMPLES, sentences: SENTENCES, confuseGroups: GROUPS, audioOk: true, rand: rng(seed || 7) }, over || {});
const viOf = hz => (W(hz) || {}).vi;

console.log('\n[1] Từng dạng bài');
test('hz2vi: 4 lựa chọn khác nhau, đúng 1 đáp án, nhiễu không trùng nghĩa (học ≠ học tập)', () => {
  const q = QE.build('hz2vi', W('学习'), ctx());
  assert.ok(q); assert.strictEqual(q.options.length, 4);
  assert.strictEqual(q.options[q.correctIndex].key, '学习'.length ? 'học, học tập' : '');
  for (const o of q.options) if (o.key !== q.correctKey) assert.ok(!QE.meaningsOverlap(o.key, 'học, học tập'), o.key);
  assert.strictEqual(q.quizType, 'hz2vi'); assert.strictEqual(q.exerciseFsrs, 'review-hz2vi');
});
test('vi2hz: nhiễu không trùng nghĩa với đề (hỏi "học" thì 学习 không được là nhiễu)', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const q = QE.build('vi2hz', W('学'), ctx({}, seed));
    assert.ok(q);
    assert.ok(!q.options.some(o => o.key === '学习'), 'seed ' + seed);
  }
});
test('listen2hz: không có nhiễu đồng âm (在 vs 再) và đề không lộ chữ Hán/Pinyin', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const q = QE.build('listen2hz', W('在'), ctx({}, seed));
    assert.ok(q); assert.ok(!q.options.some(o => o.key === '再'));
    // phần HIỂN THỊ của đề (audioText chỉ để phát âm thanh, không hiện ra)
    const shown = JSON.stringify([q.prompt.main, q.prompt.sub, q.prompt.ask]);
    assert.ok(!shown.includes('在') && !shown.includes('zài'));
    assert.strictEqual(q.prompt.kind, 'audio');
  }
});
test('listen2hz / listen2vi: không có âm thanh → KHÔNG tạo câu', () => {
  assert.strictEqual(QE.build('listen2hz', W('认真'), ctx({ audioOk: false })), null);
  assert.strictEqual(QE.build('listen2vi', W('认真'), ctx({ audioOk: false })), null);
});
test('listen2vi: đáp án là nghĩa, quizType hz2vi, kỹ năng listening', () => {
  const q = QE.build('listen2vi', W('认真'), ctx());
  assert.ok(q); assert.strictEqual(q.correctKey, 'nghiêm túc'); assert.strictEqual(q.quizType, 'hz2vi'); assert.strictEqual(q.skill, 'listening');
});
test('hz2py: dùng ĐÚNG chuỗi pinyin trong dữ liệu; nhiễu có pinyin khác hẳn; từ thiếu pinyin → null', () => {
  const q = QE.build('hz2py', W('在'), ctx());
  assert.ok(q); assert.strictEqual(q.correctKey, 'zài');
  const keys = q.options.map(o => QE.pyKey(o.key)); assert.strictEqual(new Set(keys).size, keys.length);
  assert.ok(q.options.every(o => POOL.some(w => w.py === o.key)), 'pinyin phải lấy từ dữ liệu, không tự ghép');
  assert.strictEqual(QE.build('hz2py', { hz: '无', py: '', vi: 'không', l: 1 }, ctx()), null);
  assert.strictEqual(q.quizType, 'hz2py'); assert.strictEqual(q.skill, 'pinyin');
});
test('cloze (câu ví dụ DB): khoét đúng 1 chỗ, nhiễu cùng độ dài, không chung chữ, không có trong câu', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const q = QE.build('cloze', W('学习'), ctx({}, seed));
    assert.ok(q, 'seed ' + seed);
    assert.ok(q.prompt.main.includes('＿＿＿') && !q.prompt.main.includes('学习'));
    for (const o of q.options) if (o.key !== '学习') { assert.strictEqual([...o.key].length, 2); assert.ok(!o.key.includes('学')); assert.ok(!'我每天学习汉语。'.includes(o.key)); }
    assert.strictEqual(q.sentence.zh, '我每天学习汉语。');
    assert.ok(q.explanation.some(l => l.includes('chưa có trong dữ liệu')), 'không bịa pinyin câu');
  }
});
test('cloze: câu chứa từ 2 lần bị loại; từ không có câu ví dụ → null (case 7)', () => {
  assert.strictEqual(QE.build('cloze', W('参加'), ctx()), null);
  assert.strictEqual(QE.build('cloze', W('认真'), ctx()), null);
  assert.strictEqual(QE.build('cloze', W('学习'), ctx({ examples: [] })), null);
});
test('cloze: dùng được câu từ SENTENCES qua trường hint', () => {
  const q = QE.build('cloze', W('汤'), ctx({ examples: [], pool: POOL.concat([{ hz: '米饭', py: 'mǐfàn', vi: 'cơm', l: 7 }, { hz: '面条', py: 'miàntiáo', vi: 'mì', l: 7 }, { hz: '鸡蛋', py: 'jīdàn', vi: 'trứng', l: 7 }]) }));
  // '汤' có 1 chữ → nhiễu phải 1 chữ: kho có đủ chữ đơn? nếu không dựng được thì phải là null (không tạo câu hỏng)
  if (q) { assert.ok(q.prompt.main.includes('＿＿＿')); assert.strictEqual(q.correctKey, '汤'); } else assert.strictEqual(q, null);
  const q2 = QE.build('cloze', W('包子'), ctx({ examples: [] }));
  assert.ok(q2); assert.ok(q2.prompt.main.includes('＿＿＿') && q2.sentence.source === 'sentence');
});
test('confusable: dùng nhóm có chú giải; chỉ luyện bổ sung (không FSRS)', () => {
  const q = QE.build('confusable', W('买'), ctx());
  assert.ok(q); assert.strictEqual(q.options.length, 2); assert.ok(q.tip.includes('卖'));
  assert.strictEqual(q.fsrsEligible, false); assert.strictEqual(q.exerciseFsrs, null);
  assert.strictEqual(QE.build('confusable', W('认真'), ctx()), null);
});
test('ghép cặp: ≥3 cặp, nhãn phải khác nhau hoàn toàn (không có 2 cặp cùng nghĩa/pinyin)', () => {
  const m = QE.buildMatch([W('学习'), W('学'), W('认真'), W('准备'), W('参加')], 'vi', ctx());
  assert.ok(m && m.pairs.length >= 3);
  assert.ok(!(m.pairs.some(p => p.hz === '学习') && m.pairs.some(p => p.hz === '学')), '学习 và 学 trùng nghĩa "học"');
  assert.strictEqual(new Set(m.rights.map(QE.normText)).size, m.rights.length);
  const m2 = QE.buildMatch([W('在'), W('再'), W('买')], 'py', ctx());
  assert.strictEqual(m2, null); // 在/再 cùng pinyin → chỉ còn 2 cặp không mơ hồ
  assert.strictEqual(QE.buildMatch([W('认真'), W('准备')], 'vi', ctx()), null);
});

console.log('\n[2] Tính chất chung (fuzz)');
test('FUZZ: mọi câu hỏi sinh ra qua QE.build đều qua QE.validate (không trùng/mơ hồ/lộ đáp án) [case 16]', () => {
  let built = 0;
  for (const typeId of Object.keys(QE.TYPES)) {
    for (const w of POOL) for (let seed = 1; seed <= 6; seed++) {
      const q = QE.build(typeId, w, ctx({}, seed * 131 + w.hz.charCodeAt(0)));
      if (!q) continue; built++;
      const v = QE.validate(q, { viOf, pyOf: hz => (W(hz) || {}).py });
      assert.ok(v.ok, typeId + ' ' + w.hz + ': ' + v.reason);
      if (QE.TYPES[typeId].typed) { // V110: câu tự nhập — không có lựa chọn; phải có đáp án chuẩn và kiểu chấm
        assert.strictEqual(q.options.length, 0); assert.ok(q.correctKey && q.typed, typeId + ' thiếu đáp án chuẩn/kiểu chấm');
        continue;
      }
      assert.strictEqual(q.options.filter((o, i) => i === q.correctIndex).length, 1);
      assert.strictEqual(q.options[q.correctIndex].key, q.correctKey);
    }
  }
  assert.ok(built > 300, 'quá ít câu được dựng: ' + built);
});
test('validate bắt đúng lỗi: trùng lựa chọn, nhiễu trùng nghĩa, nhiễu đồng âm, đề nghe lộ chữ, cloze lộ từ', () => {
  const good = QE.build('hz2vi', W('认真'), ctx());
  const dup = JSON.parse(JSON.stringify(good)); dup.options[(dup.correctIndex + 1) % 4].key = good.correctKey;
  assert.strictEqual(QE.validate(dup).ok, false);
  const syn = JSON.parse(JSON.stringify(good)); syn.options[(syn.correctIndex + 1) % 4].key = 'nghiêm túc, cẩn thận';
  assert.strictEqual(QE.validate(syn).reason, 'nhiễu trùng nghĩa');
  const l = QE.build('listen2hz', W('在'), ctx());
  const homo = JSON.parse(JSON.stringify(l)); homo.options[(homo.correctIndex + 1) % 4] = { key: '再', label: '再' };
  assert.strictEqual(QE.validate(homo, { pyOf: hz => (W(hz) || {}).py }).reason, 'nhiễu đồng âm');
  const leak = JSON.parse(JSON.stringify(l)); leak.prompt.ask = 'Nghe: 在';
  assert.strictEqual(QE.validate(leak).ok, false);
  const c = QE.build('cloze', W('学习'), ctx());
  const cl = JSON.parse(JSON.stringify(c)); cl.prompt.main = '我每天学习汉语。';
  assert.strictEqual(QE.validate(cl).ok, false);
  const few = JSON.parse(JSON.stringify(good)); few.options = few.options.slice(0, 2); few.correctIndex = Math.min(few.correctIndex, 1); few.correctKey = few.options[few.correctIndex].key;
  assert.strictEqual(QE.validate(few).reason, 'không đủ lựa chọn');
});
test('Vị trí đáp án đúng KHÔNG lặp liên tiếp cùng một chỗ', () => {
  const sess = QS.newSession(); let prev = -1, same = 0;
  for (let i = 0; i < 300; i++) {
    const w = POOL[i % POOL.length];
    const q = QS.choose(w, ctx({ rand: rng(i + 1) }), { session: sess, rand: rng(i + 9) });
    assert.ok(q);
    if (q.correctIndex === prev) same++;
    prev = q.correctIndex; QS.record(sess, q, true);
  }
  assert.strictEqual(same, 0);
});
test('Kho từ quá ít: 2 từ → câu 2 lựa chọn (hạ chuẩn); 1 từ → null, không ném lỗi, không lặp vô hạn [case 3, 18]', () => {
  const q2 = QS.choose(W('认真'), ctx({ pool: [W('认真'), W('准备')] }), { session: QS.newSession() });
  assert.ok(q2 && q2.options.length === 2);
  assert.strictEqual(QS.choose(W('认真'), ctx({ pool: [W('认真')] }), { session: QS.newSession() }), null);
  assert.strictEqual(QS.choose(W('认真'), ctx({ pool: [] }), { session: QS.newSession() }), null);
});

console.log('\n[3] Bộ chọn dạng câu hỏi');
const P = (o) => Object.assign({ recognition: { status: 'ok', score: 0.9, attempts: 6 }, recall: { status: 'ok', score: 0.9, attempts: 6 }, listening: { status: 'ok', score: 0.9, attempts: 6 }, pinyin: { status: 'ok', score: 0.9, attempts: 6 }, context: { status: 'ok', score: 0.9, attempts: 6 } }, o);
test('Người dùng mới (chưa có hồ sơ): vẫn chọn được câu hợp lệ [case 1]', () => {
  const q = QS.choose(W('认真'), ctx(), { session: QS.newSession(), profile: undefined });
  assert.ok(q);
});
test('Biết nghĩa nhưng yếu nghe → ưu tiên Nghe→Chữ Hán / Nghe→Nghĩa, không dồn hz→nghĩa', () => {
  const prof = P({ recognition: { status: 'ok', score: 0.95, attempts: 10 }, listening: { status: 'weak', score: 0.3, attempts: 5 } });
  const r = QS.rank(W('认真'), { profile: prof, session: QS.newSession(), rand: () => 0 });
  assert.ok(['listen2hz', 'listen2vi'].includes(r[0].typeId));
  assert.ok(['listen2hz', 'listen2vi'].includes(r[1].typeId));
  assert.ok(r.findIndex(x => x.typeId === 'hz2vi') > 1);
});
test('Nhận diện được nhưng yếu nhớ chủ động → tăng nghĩa→chữ Hán', () => {
  const prof = P({ recall: { status: 'weak', score: 0.25, attempts: 6 } });
  assert.strictEqual(QS.rank(W('认真'), { profile: prof, session: QS.newSession(), rand: () => 0 })[0].typeId, 'vi2hz');
});
test('Yếu Pinyin → hz2py; yếu ngữ cảnh → cloze (khi dựng được)', () => {
  assert.strictEqual(QS.rank(W('学习'), { profile: P({ pinyin: { status: 'weak', score: 0.3, attempts: 5 } }), session: QS.newSession(), rand: () => 0 })[0].typeId, 'hz2py');
  assert.strictEqual(QS.rank(W('学习'), { profile: P({ context: { status: 'weak', score: 0.3, attempts: 5 } }), session: QS.newSession(), rand: () => 0 })[0].typeId, 'cloze');
});
test('Dữ liệu chưa đủ → KHÔNG kết luận yếu; chỉ thu thập dữ liệu (điểm cộng nhỏ, giảm dần theo số lượt)', () => {
  const thin = { status: 'insufficient', score: null, attempts: 0 }, thin2 = { status: 'insufficient', score: null, attempts: 2 };
  const s0 = QS.scoreType('vi2hz', 'recall', { recall: thin }, QS.newSession(), W('认真'));
  const s2 = QS.scoreType('vi2hz', 'recall', { recall: thin2 }, QS.newSession(), W('认真'));
  const sw = QS.scoreType('vi2hz', 'recall', { recall: { status: 'weak', score: 0.3, attempts: 5 } }, QS.newSession(), W('认真'));
  assert.ok(s0 > s2 && sw > s0);
});
test('Không hỏi lặp cùng (từ, dạng): cặp đã hỏi bị trừ rất mạnh', () => {
  const sess = QS.newSession(); sess.asked['认真|vi2hz'] = 1;
  const prof = P({ recall: { status: 'weak', score: 0.2, attempts: 8 } });
  assert.notStrictEqual(QS.rank(W('认真'), { profile: prof, session: sess, rand: () => 0 })[0].typeId, 'vi2hz');
});
test('Không để cùng 1 dạng liên tiếp: trừ điểm khi trùng dạng ngay trước, trừ thêm khi 3 lần liên tiếp', () => {
  const sess = QS.newSession();
  const s1 = QS.scoreType('hz2vi', 'recognition', P(), sess, W('认真'));
  sess.history.push({ hz: 'a', typeId: 'hz2vi', correct: true });
  const s2 = QS.scoreType('hz2vi', 'recognition', P(), sess, W('认真'));
  sess.history.push({ hz: 'b', typeId: 'hz2vi', correct: true }, { hz: 'c', typeId: 'hz2vi', correct: true });
  const s3 = QS.scoreType('hz2vi', 'recognition', P(), sess, W('认真'));
  assert.ok(s1 > s2 && s2 > s3);
});
test('Người học đang gặp khó (3/4 câu gần nhất sai): giảm ép kỹ năng yếu, ưu tiên dạng dễ hz→nghĩa', () => {
  const sess = QS.newSession();
  for (const ok of [false, false, true, false]) sess.history.push({ hz: 'x', typeId: 'vi2hz', correct: ok });
  assert.strictEqual(QS.struggling(sess), true);
  const prof = P({ listening: { status: 'weak', score: 0.3, attempts: 6 } });
  assert.strictEqual(QS.rank(W('认真'), { profile: prof, session: sess, rand: () => 0 })[0].typeId, 'hz2vi');
});
test('Không có âm thanh → không bao giờ chọn dạng nghe; không có câu ví dụ → không chọn cloze [case 6, 7]', () => {
  const prof = P({ listening: { status: 'weak', score: 0.1, attempts: 9 }, context: { status: 'weak', score: 0.1, attempts: 9 } });
  for (let i = 0; i < 40; i++) {
    const q = QS.choose(W('认真'), ctx({ audioOk: false, examples: [], sentences: [], rand: rng(i + 1) }), { profile: prof, session: QS.newSession(), rand: rng(i + 3) });
    assert.ok(q && !['listen2hz', 'listen2vi', 'cloze'].includes(q.typeId), q && q.typeId);
  }
});
test('fsrsOnly loại dạng chỉ-luyện-bổ-sung; exclude loại dạng đã sai (luyện lại đổi dạng)', () => {
  assert.ok(!QS.rank(W('买'), { allowPracticeOnly: true, fsrsOnly: true }).some(r => r.typeId === 'confusable'));
  assert.ok(QS.rank(W('买'), { allowPracticeOnly: true }).some(r => r.typeId === 'confusable'));
  const q = QS.choose(W('认真'), ctx(), { exclude: ['hz2vi', 'vi2hz'], session: QS.newSession(), allowPracticeOnly: true });
  assert.ok(q && !['hz2vi', 'vi2hz'].includes(q.typeId));
});
test('Hạ chuẩn kho nhỏ KHÔNG được hỏi lại dạng đã bị loại / ngoài phạm vi only (luyện lại câu sai phải đổi dạng)', () => {
  assert.strictEqual(QS.choose(W('认真'), ctx(), { only: ['hz2vi'], exclude: ['hz2vi'], session: QS.newSession() }), null);
  assert.strictEqual(QS.choose(W('认真'), ctx({ pool: [W('认真'), W('准备')] }), { exclude: ['hz2vi'], only: ['vi2hz'], session: QS.newSession() }) === null
    || QS.choose(W('认真'), ctx({ pool: [W('认真'), W('准备')] }), { exclude: ['hz2vi'], only: ['vi2hz'], session: QS.newSession() }).typeId !== 'hz2vi', true);
});
test('Mọi câu từ bộ chọn mang đủ thông tin để ghi FSRS/luyện bổ sung (quizType + exercise) khớp bảng server', () => {
  const S = require(path.join(ROOT, 'lib', 'skills'));
  for (const t of Object.values(QE.TYPES)) {
    if (t.exerciseFsrs) { const e = S.resolveExercise(t.exerciseFsrs, t.quizType); assert.ok(e && e.fsrs && e.skill === t.skill, t.id); }
    const pe = S.resolveExercise(t.exercisePractice, t.quizType); assert.ok(pe && pe.fsrs === false && pe.skill === t.skill, t.id);
  }
});

runAll();
