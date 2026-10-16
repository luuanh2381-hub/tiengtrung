#!/usr/bin/env node
// test/v110-ui.smoke.test.js — nạp NGUYÊN các file giao diện V110 vào vm (DOM/mạng giả) và kiểm tra:
//   • câu tự nhập: vẽ đúng, không lộ đáp án, chấm/ghi nhận đúng đường (FSRS chính thức vs luyện bổ sung);
//   • bảng "Hôm nay học": số liệu, không cộng trùng, không biến mất chế độ khi hết thẻ;
//   • khối phân tích: chưa đủ dữ liệu / đủ dữ liệu / thoát HTML.
// KHÔNG thay cho thử trên trình duyệt thật (bàn phím điện thoại, bộ gõ tiếng Trung chưa kiểm thử được ở đây).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0, failed = 0; const pending = [];
const test = (n, f) => pending.push({ n, f });
async function runAll() {
  for (const { n, f } of pending) {
    try { await f(); passed++; console.log('  ✅ ' + n); }
    catch (e) { failed++; console.log('  ❌ ' + n + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
}
const POOL = [
  { hz: '准备', py: 'zhǔnbèi', vi: 'chuẩn bị', l: 5 }, { hz: '认真', py: 'rènzhēn', vi: 'nghiêm túc', l: 5 },
  { hz: '参加', py: 'cānjiā', vi: 'tham gia', l: 5 }, { hz: '发现', py: 'fāxiàn', vi: 'phát hiện', l: 5 },
  { hz: '学习', py: 'xuéxí', vi: 'học tập', l: 1 }, { hz: '休息', py: 'xiūxi', vi: 'nghỉ ngơi', l: 1 },
  { hz: '苹果', py: 'píngguǒ', vi: 'quả táo', l: 2 }, { hz: '桌子', py: 'zhuōzi', vi: 'cái bàn', l: 2 },
];
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function makeEnv(over) {
  const calls = { fetch: [], practice: [], fsrs: [] };
  const typedInput = { value: '', focus() {}, disabled: false };
  const ctx = Object.assign({
    console, Math, Date, JSON, Set, Map, Array, Object, String, Number, Promise, Error, setTimeout: () => 0, clearInterval() {}, setInterval: () => 0, clearTimeout() {},
    document: { createElement: () => ({ style: {}, appendChild() {}, set textContent(v) {} }), head: { appendChild() {} },
      getElementById: (id) => (id === 'rv-typed' ? typedInput : null), querySelectorAll: () => [] },
    localStorage: { _m: {}, getItem(k) { return k in this._m ? this._m[k] : null; }, setItem(k, v) { this._m[k] = String(v); } },
    performance: { now: () => 0 }, WORDS: POOL, GUEST_MAX_LESSON: 99, isLoggedIn: () => true, isGuest: false, authToken: 't', authHeaders: () => ({}),
    SENTENCES: [], CONFUSE_GROUPS: [], showPinyin: true, showMeaning: true, isAdminRole: () => false, currentTab: 'review',
    escapeHtml: esc, escapeJsAttr: s => String(s).replace(/'/g, "\\'"), renderHanziParts: () => '', wnBlockHtml: () => '', lessonsLabel: () => 'Bài 5',
    skillAudioAvailable: () => true, vtMarkStart() {}, vtHiddenMs: () => 0, render() {}, speak() {}, playDing() {}, playBuzz() {},
    sqCreate: () => ({ items: [], doneHz: new Set(), totalPlanned: 0, answeredCount: 0, sessionId: 'sess-1234567', startTime: null, endTime: null, completedCards: [], lessonFilter: null, dayKey: null }),
    sqSnapshotLessonFilter: () => ({}), sqReadPersisted: () => null, sqPersist() {}, sqClearPersisted() {}, ssArchiveSession() {}, refreshServerMeta() {},
    sessionKnownHz: new Set(), saveSessionKnownHz() {}, sqPurgeHzFromAllQueues() {}, sqLessonFilterMatches: () => true, REPEAT_GAP: 3,
    genIdempotencyKey: () => 'k-123456789', todayKey: () => '2026-10-16', goTab() {}, alert() {}, SUBMIT_REVIEW_MAX_WAIT_MS: 1000,
    submitFsrsReviewAwaited: async (a) => { calls.fsrs.push(a); return { ok: true }; },
    submitSkillPractice: async (a) => { calls.practice.push(a); return { ok: true }; },
    fetch: async (url, opts) => { calls.fetch.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null }); return { json: async () => ({ ok: true, systemRating: 'good' }) }; },
  }, over || {});
  vm.createContext(ctx);
  for (const f of ['js/answer-match.js', 'js/skill-score.js', 'js/question-engine.js', 'js/question-selector.js', 'js/review.js']) vm.runInContext(read(f), ctx);
  ctx.__calls = calls; ctx.__input = typedInput;
  return ctx;
}
const R = (ctx, code) => vm.runInContext(code, ctx);
// Hồ sơ "mọi kỹ năng đều tốt" → bộ chọn ưu tiên câu TỰ NHẬP (độ khó tăng dần).
const GOOD = { status: 'ok', level: 'good', score: 0.9, attempts: 8 };
const ALL_GOOD = { recognition: GOOD, recall: GOOD, listening: GOOD, pinyin: GOOD, context: GOOD };
function showTyped(ctx, type, hz, profile) {
  const w = POOL.find(x => x.hz === hz);
  R(ctx, `rvQueue.items = [${JSON.stringify({ type, word: w, skillProfile: profile || ALL_GOOD })}]; rvQueue.totalPlanned = 1; rvStage='run'; rvStartInfo=null; rvLog=[];`);
  R(ctx, 'rvPrepareCurrentCard()');
}

console.log('\n[A] Câu tự nhập trong "Hôm nay học"');
test('nạp nguyên review.js (kèm answer-match) không lỗi; cài đặt tự gõ mặc định BẬT, tắt được', () => {
  const ctx = makeEnv();
  assert.strictEqual(R(ctx, 'rvTypedEnabled()'), true);
  R(ctx, 'rvSetTypedEnabled(false)');
  assert.strictEqual(R(ctx, 'rvTypedEnabled()'), false);
});
test('hồ sơ tốt → có câu tự nhập; HTML có ô nhập, KHÔNG có nút lựa chọn, KHÔNG lộ đáp án, nêu quy tắc chấm', () => {
  let seen = new Set();
  for (let i = 0; i < 12; i++) {
    const ctx = makeEnv();
    showTyped(ctx, 'review', '准备');
    const q = R(ctx, 'rvQuestion');
    if (!q || !q.typed) continue;
    seen.add(q.typeId);
    const h = R(ctx, 'renderReview()');
    assert.ok(h.includes('id="rv-typed"') && h.includes('Quy tắc chấm'), 'thiếu ô nhập/quy tắc');
    assert.ok(!h.includes('quiz-opt'), 'câu tự nhập không được có nút lựa chọn');
    assert.ok(h.includes('autocapitalize="off"') && h.includes('spellcheck="false"'), 'ô nhập cần tắt tự sửa của bàn phím điện thoại');
    if (q.typeId === 'typeVi2hz') assert.ok(!h.includes('准备'), 'lộ chữ Hán đáp án trong đề');
    if (q.typeId === 'typeHz2py') assert.ok(!h.includes('zhǔnbèi'), 'lộ pinyin đáp án trong đề');
  }
  assert.ok(seen.size >= 1, 'bộ chọn không bao giờ chọn câu tự nhập dù mọi kỹ năng đều tốt');
});
test('tắt cài đặt → KHÔNG bao giờ ra câu tự nhập', () => {
  for (let i = 0; i < 12; i++) {
    const ctx = makeEnv(); R(ctx, 'rvSetTypedEnabled(false)');
    showTyped(ctx, 'review', '准备');
    assert.ok(!R(ctx, 'rvQuestion').typed);
  }
});
test('CỔNG CỨNG: tự động chọn KHÔNG ra câu tự gõ nếu kỹ năng chưa đủ lượt, kể cả khi mọi trắc nghiệm đều không dựng được (kho 1 từ)', () => {
  const ctx = makeEnv({ WORDS: [POOL[0]] });
  const w = POOL[0];
  const lowData = { recall: { status: 'ok', level: 'good', score: 0.95, attempts: 2 }, pinyin: { status: 'ok', level: 'good', score: 0.95, attempts: 2 } };
  const q = R(ctx, `QS.choose(${JSON.stringify(w)}, { pool: [${JSON.stringify(w)}], examples: [], sentences: [], confuseGroups: [], audioOk: true }, { allowTyped: true, profile: ${JSON.stringify(lowData)}, fsrsOnly: true })`);
  assert.ok(!q || !q.typed, 'ít lượt mà vẫn ra câu tự gõ');
  const forced = R(ctx, `QS.choose(${JSON.stringify(w)}, { pool: [${JSON.stringify(w)}] }, { allowTyped: true, forced: true, only: ['typeHz2py'] })`);
  assert.ok(forced && forced.typeId === 'typeHz2py', 'chế độ người học chọn tường minh phải ra được câu tự gõ');
});
test('hồ sơ yếu / chưa có dữ liệu → KHÔNG đưa câu tự nhập (không gõ khi chưa vững)', () => {
  for (const prof of [{}, { recall: { status: 'weak', level: 'weak', score: 0.3, attempts: 6 }, pinyin: { status: 'weak', level: 'weak', score: 0.3, attempts: 6 } }]) {
    for (let i = 0; i < 10; i++) {
      const ctx = makeEnv(); showTyped(ctx, 'review', '准备', prof);
      assert.ok(!R(ctx, 'rvQuestion').typed);
    }
  }
});
test('thẻ FSRS chính thức: tự nhập pinyin dùng số thanh → ĐÚNG; gọi preview kèm exerciseType; KHÔNG ghi luyện bổ sung', async () => {
  const ctx = makeEnv();
  showTyped(ctx, 'review', '准备');
  R(ctx, `rvQuestion = QE.build('typeHz2py', rvQueue.items[0].word, rvQCtx()); rvPhase='question';`);
  ctx.__input.value = ' Zhun3 bei4 ';
  await R(ctx, 'rvSubmitTyped(false)');
  assert.strictEqual(R(ctx, 'rvLastAnswer.correct'), true);
  assert.strictEqual(R(ctx, 'rvLastAnswer.typed.verdict'), 'exact');
  const pv = ctx.__calls.fetch.find(c => c.url === '/api/study/review/preview');
  assert.ok(pv, 'phải gọi preview để lấy gợi ý rating');
  assert.strictEqual(pv.body.exerciseType, 'review-hz2py-typed');
  assert.strictEqual(pv.body.selectedAnswer, 'Zhun3 bei4');
  assert.strictEqual(ctx.__calls.practice.length, 0);
});
test('pinyin KHÔNG dấu → SAI (đúng âm, thiếu thanh), và màn giải thích nói rõ lý do + đáp án chuẩn', async () => {
  const ctx = makeEnv();
  showTyped(ctx, 'review', '准备');
  R(ctx, `rvQuestion = QE.build('typeHz2py', rvQueue.items[0].word, rvQCtx()); rvPhase='question';`);
  ctx.__input.value = 'zhunbei';
  await R(ctx, 'rvSubmitTyped(false)');
  assert.strictEqual(R(ctx, 'rvLastAnswer.correct'), false);
  assert.strictEqual(R(ctx, 'rvLastAnswer.typed.verdict'), 'toneless');
  const html = R(ctx, 'rvExplainHtml()');
  assert.ok(html.includes('thiếu thanh điệu') && html.includes('Đáp án chuẩn: zhǔnbèi') && html.includes('zhunbei'));
});
test('chữ Hán: khoảng trắng thừa vẫn đúng; chữ khác thì sai', async () => {
  for (const [typed, expect] of [[' 准 备 ', true], ['准背', false]]) {
    const ctx = makeEnv(); showTyped(ctx, 'review', '准备');
    R(ctx, `rvQuestion = QE.build('typeVi2hz', rvQueue.items[0].word, rvQCtx()); rvPhase='question';`);
    ctx.__input.value = typed;
    await R(ctx, 'rvSubmitTyped(false)');
    assert.strictEqual(R(ctx, 'rvLastAnswer.correct'), expect, typed);
  }
});
test('bấm Kiểm tra khi ô trống → KHÔNG ghi nhận gì (có thể bấm nhầm); vẫn ở câu hỏi', async () => {
  const ctx = makeEnv(); showTyped(ctx, 'review', '准备');
  R(ctx, `rvQuestion = QE.build('typeHz2py', rvQueue.items[0].word, rvQCtx()); rvPhase='question';`);
  ctx.__input.value = '   ';
  await R(ctx, 'rvSubmitTyped(false)');
  assert.strictEqual(R(ctx, 'rvPhase'), 'question');
  assert.strictEqual(ctx.__calls.fetch.length + ctx.__calls.practice.length, 0);
  assert.strictEqual(R(ctx, 'rvLog.length'), 0);
});
test('"Bỏ qua" = chủ động không nhớ → tính SAI và gửi dấu hiệu bỏ trống (server không đưa vào hồ sơ kỹ năng)', async () => {
  const ctx = makeEnv(); showTyped(ctx, 'review', '准备');
  R(ctx, `rvQuestion = QE.build('typeHz2py', rvQueue.items[0].word, rvQCtx()); rvPhase='question';`);
  await R(ctx, 'rvSubmitTyped(true)');
  assert.strictEqual(R(ctx, 'rvLastAnswer.correct'), false);
  const pv = ctx.__calls.fetch.find(c => c.url === '/api/study/review/preview');
  assert.strictEqual(pv.body.selectedAnswer, '⨯ (bỏ trống) ⨯');
});
test('LUYỆN BỔ SUNG (extra): ghi qua submitSkillPractice với source+sessionId; KHÔNG gọi FSRS/preview', async () => {
  const ctx = makeEnv(); showTyped(ctx, 'extra', '准备');
  R(ctx, `rvQuestion = QE.build('typeHz2py', rvQueue.items[0].word, rvQCtx()); rvPhase='question';`);
  ctx.__input.value = 'zhǔnbèi';
  await R(ctx, 'rvSubmitTyped(false)');
  assert.strictEqual(ctx.__calls.practice.length, 1);
  const p = ctx.__calls.practice[0];
  assert.strictEqual(p.exerciseType, 'practice-pinyin-typed');
  assert.strictEqual(p.source, 'extra'); assert.strictEqual(p.sessionId, 'sess-1234567');
  assert.strictEqual(ctx.__calls.fetch.length, 0, 'luyện bổ sung không được gọi preview/FSRS');
  assert.strictEqual(ctx.__calls.fsrs.length, 0);
});
test('nguồn kết quả: check/redo/extra/match được ánh xạ đúng', () => {
  const ctx = makeEnv();
  for (const [t, s] of [['check', 'check'], ['redo', 'redo'], ['extra', 'extra'], ['drill', 'extra'], ['match', 'match']]) {
    assert.strictEqual(R(ctx, `rvPracticeSource({type:'${t}'})`), s);
  }
});
test('bấm đúp "Kiểm tra" không gửi 2 lần (rvPhase đổi ngay)', async () => {
  const ctx = makeEnv(); showTyped(ctx, 'extra', '准备');
  R(ctx, `rvQuestion = QE.build('typeHz2py', rvQueue.items[0].word, rvQCtx()); rvPhase='question';`);
  ctx.__input.value = 'zhǔnbèi';
  await Promise.all([R(ctx, 'rvSubmitTyped(false)'), R(ctx, 'rvSubmitTyped(false)')]);
  assert.strictEqual(ctx.__calls.practice.length, 1);
});

console.log('\n[E] V111 — thích ứng trong phiên học (review.js thật)');
const E_POOL = POOL.concat([{ hz: '准备好', py: 'zhǔnbèihǎo', vi: 'đã sẵn sàng', l: 5 }]);
const E_WEAK = { recognition: { status: 'ok', level: 'good', score: 0.9, attempts: 8, wa: 5.5, wc: 5.2, correct: 8 }, recall: { status: 'ok', level: 'good', score: 0.9, attempts: 8, wa: 5.5, wc: 5.2, correct: 8 },
  listening: { status: 'ok', level: 'good', score: 0.9, attempts: 8, wa: 5.5, wc: 5.2, correct: 8 }, pinyin: { status: 'ok', level: 'good', score: 0.9, attempts: 8, wa: 5.5, wc: 5.2, correct: 8 }, context: { status: 'ok', level: 'good', score: 0.9, attempts: 8, wa: 5.5, wc: 5.2, correct: 8 } };
test('rvRecordAnswer cập nhật hồ sơ NGAY — cho cả các thẻ khác của CÙNG từ trong hàng đợi, không đụng từ khác', () => {
  const ctx = makeEnv();
  const w = POOL[0], other = POOL[1];
  R(ctx, `rvQSession = QS.newSession(); rvQueue.items = [
    { type: 'review', word: ${JSON.stringify(w)}, skillProfile: ${JSON.stringify(E_WEAK)} },
    { type: 'redo', word: ${JSON.stringify(w)}, skillProfile: ${JSON.stringify(E_WEAK)} },
    { type: 'review', word: ${JSON.stringify(other)}, skillProfile: ${JSON.stringify(E_WEAK)} } ]; rvLog = [];`);
  R(ctx, `{ const q = QE.build('hz2vi', rvQueue.items[0].word, rvQCtx()); rvRecordAnswer(rvQueue.items[0], q, false, 2500, true); }`);
  assert.strictEqual(R(ctx, 'rvQueue.items[0].skillProfile.recognition.attempts'), 9);
  assert.ok(R(ctx, 'rvQueue.items[0].skillProfile.recognition.score') < 0.9, 'sai phải làm điểm giảm');
  assert.strictEqual(R(ctx, 'rvQueue.items[1].skillProfile.recognition.attempts'), 9, 'thẻ khác của CÙNG từ phải thấy kết quả');
  assert.strictEqual(R(ctx, 'rvQueue.items[2].skillProfile.recognition.attempts'), 8, 'từ khác không bị ảnh hưởng');
  assert.strictEqual(R(ctx, 'rvQueue.items[0].skillProfile.recall.attempts'), 8, 'kỹ năng khác không bị ảnh hưởng');
});
test('THAY ĐỔI LỰA CHỌN trong phiên: từ "đều tốt" → sai ở nhớ chủ động nhiều lần → câu kế là nghĩa→chữ Hán (không tự gõ)', () => {
  const ctx = makeEnv(); const w = POOL[0];
  R(ctx, `rvTypedEnabled = () => false; rvQSession = QS.newSession(); rvQueue.items = [{ type: 'review', word: ${JSON.stringify(w)}, skillProfile: ${JSON.stringify(E_WEAK)} }]; rvLog = [];`);
  for (let i = 0; i < 5; i++) R(ctx, `{ const it = rvQueue.items[0]; const q = QE.build('vi2hz', it.word, rvQCtx()); rvRecordAnswer(it, q, false, 3000, true); }`);
  assert.strictEqual(R(ctx, 'rvQueue.items[0].skillProfile.recall.level'), 'weak');
  R(ctx, 'rvQSession.asked = {}; rvQSession.history = [];'); // tách khỏi chống lặp để chỉ đo tác động của HỒ SƠ
  const q = R(ctx, 'rvBuildQuestionFor(rvQueue.items[0])');
  assert.strictEqual(q.typeId, 'vi2hz');
  assert.ok(q.why && q.why.includes('Nhớ chủ động') && q.why.includes('yếu'), q.why);
});
test('từ hay nhầm (server gửi item.confusions) → đáp án đó thật sự xuất hiện trong lựa chọn câu hỏi', () => {
  let hit = 0;
  for (let i = 0; i < 20; i++) {
    const ctx = makeEnv({ WORDS: E_POOL }); const w = POOL[0];
    R(ctx, `rvTypedEnabled = () => false; rvQSession = QS.newSession(); rvQueue.items = [{ type: 'review', word: ${JSON.stringify(w)}, skillProfile: {}, confusions: [{ text: '认真', n: 3 }] }]; rvLog = [];`);
    const q = R(ctx, `QE.build('vi2hz', rvQueue.items[0].word, Object.assign(rvQCtx(), { confusions: rvQueue.items[0].confusions }))`);
    if (q && q.options.some(o => o.key === '认真')) hit++;
  }
  assert.strictEqual(hit, 20, 'cặp này hợp lệ nên đáp án hay nhầm phải LUÔN xuất hiện, được ' + hit + '/20 (nếu chỉ tình cờ thì ~1/3)');
});
test('rvBuildQuestionFor truyền confusions và số thẻ chính thức còn lại cho bộ chọn', () => {
  const src = read('js/review.js');
  assert.ok(/confusions: item\.confusions/.test(src) && /remaining: rvQueue\.items\.filter\(rvIsOfficial\)\.length/.test(src));
});
test('lý do chọn dạng bài hiện trên màn hình (1 dòng, đã thoát HTML)', () => {
  const ctx = makeEnv();
  const w = POOL[0];
  const weak = Object.assign({}, E_WEAK, { listening: { status: 'weak', level: 'weak', score: 0.3, attempts: 6, wa: 3.7, wc: 0.7, correct: 1 } });
  R(ctx, `rvQSession = QS.newSession(); rvQueue.items = [${JSON.stringify({ type: 'review', word: w, skillProfile: weak })}]; rvQueue.totalPlanned = 1; rvStage='run'; rvStartInfo=null; rvLog=[]; rvPrepareCurrentCard();`);
  const h = R(ctx, 'renderReview()');
  assert.ok(h.includes('class="rv-why"') && h.includes('💡'), 'thiếu dòng lý do');
  R(ctx, `rvQuestion.why = '<img src=x onerror=1>'`);
  assert.ok(!R(ctx, 'renderReview()').includes('<img src=x'), 'lý do phải được thoát HTML');
});
test('câu bị ÉP (kiểm tra ngay sau khi xem từ mới) KHÔNG có dòng lý do', () => {
  const ctx = makeEnv(); const w = POOL[0];
  R(ctx, `rvQSession = QS.newSession(); rvQueue.items = [${JSON.stringify({ type: 'check', word: w, skillProfile: {} })}]; rvQueue.totalPlanned = 1; rvStage='run'; rvStartInfo=null; rvLog=[]; rvPrepareCurrentCard();`);
  assert.ok(!R(ctx, 'renderReview()').includes('class="rv-why"'));
});
test('tải lại trang: nhịp trả lời (rt) và lịch sử dựng lại từ nhật ký; vị trí đáp án cũ được xoá', () => {
  const ctx = makeEnv();
  R(ctx, `rvLog = [
    { hz: '准备', typeId: 'hz2vi', skill: 'recognition', correct: true, ms: 1000 },
    { hz: '认真', typeId: 'hz2vi', skill: 'recognition', correct: true, ms: 1200 },
    { hz: '参加', typeId: 'hz2vi', skill: 'recognition', correct: false, ms: 9000 } ]; rvRestoreQSession();`);
  assert.deepStrictEqual(JSON.parse(R(ctx, 'JSON.stringify(rvQSession.rt)')), { 'recognition:c': [1000, 1200] }, 'chỉ câu đúng làm chuẩn');
  assert.strictEqual(R(ctx, 'rvQSession.history.length'), 3);
  assert.strictEqual(R(ctx, 'rvQSession.recentCorrectPositions.length'), 0);
  assert.strictEqual(R(ctx, "rvQSession.asked['准备|hz2vi']"), 1);
});
test('câu tự gõ cũng cập nhật hồ sơ (cùng đường rvRecordAnswer) và dùng ngưỡng chậm riêng của câu gõ', async () => {
  const ctx = makeEnv(); const w = POOL[0];
  R(ctx, `rvQSession = QS.newSession(); rvQueue.items = [{ type: 'extra', word: ${JSON.stringify(w)}, skillProfile: ${JSON.stringify(E_WEAK)} }]; rvLog = [];
    rvQuestion = QE.build('typeHz2py', rvQueue.items[0].word, rvQCtx()); rvPhase = 'question';`);
  ctx.__input.value = 'zhǔnbèi';
  await R(ctx, 'rvSubmitTyped(false)');
  assert.strictEqual(R(ctx, 'rvQueue.items[0].skillProfile.pinyin.attempts'), 9);
});

console.log('\n[B] Bảng "Hôm nay học"');
function lessonEnv() {
  const ctx = makeEnv({ currentTab: 'today' });
  vm.runInContext(read('js/lesson.js'), ctx);
  return ctx;
}
const TODAY = (over) => Object.assign({
  ok: true, hasScope: true, dueCount: 12, dueInScope: 20, newInCurrentLesson: 5, currentLesson: 7, weakCount: 3, blockedByBacklog: false, totalDue: 20,
  breakdown: { knownWords: 100, due: 20, reinforce: 8, weakSkill: 15, delayed: 6, overlap: { weakAndDue: 4, reinforceAndDue: 2 }, uniqueWords: 40, delayedAfterDays: 7 },
  progress: { officialAnswers: 10, practiceAnswers: 6, durationSeconds: 780 },
  daily: { reviewLimit: 50, newLimit: 10, unlimited: false, reviewToday: 8, newToday: 2 },
}, over || {});
test('nạp nguyên lesson.js (kèm review.js) không lỗi', () => assert.strictEqual(typeof lessonEnv().renderTodayPanel, 'function'));
test('hiển thị đủ nhóm; nói rõ số hôm nay bị giới hạn ngày (12/20)', () => {
  const h = R(lessonEnv(), `renderTodayPanel(${JSON.stringify(TODAY())})`);
  for (const t of ['Thẻ đến hạn ôn', 'Từ mới dự kiến', 'Từ cần củng cố', 'Từ có kỹ năng yếu', 'Cần kiểm tra lại', 'Lượt câu hỏi hôm nay']) assert.ok(h.includes(t), 'thiếu: ' + t);
  assert.ok(h.includes('12/20'), 'phải nói rõ lấy 12/20 thẻ theo giới hạn ngày');
});
test('hiển thị thời gian học thực (13 phút = 780s) và nói rõ cách tính', () => {
  const h = R(lessonEnv(), `renderTodayPanel(${JSON.stringify(TODAY())})`);
  assert.ok(h.includes('13 phút') && h.includes('Thời gian học thực') && h.includes('không tính lúc chuyển tab'));
  const none = R(lessonEnv(), `renderTodayPanel(${JSON.stringify(TODAY({ progress: { officialAnswers: 0, practiceAnswers: 0, durationSeconds: 0 } }))})`);
  assert.ok(none.includes('0 phút'), 'chưa học → 0 phút, không số giả');
});
test('KHÔNG cộng trùng: "từ duy nhất" = từ đã học cần chú ý + từ mới (40 + 5 = 45), kèm giải thích giao nhau', () => {
  const h = R(lessonEnv(), `renderTodayPanel(${JSON.stringify(TODAY())})`);
  assert.ok(h.includes('45 từ duy nhất'));
  assert.ok(h.includes('4 từ vừa đến hạn vừa yếu kỹ năng') && h.includes('không cộng các ô trên với nhau'));
  assert.ok(h.includes('từ</i>') && h.includes('thẻ</i>') && h.includes('lượt</i>'));
});
test('tiến độ hôm nay = đã làm / (đã làm + còn lại): (8+2)/(10+12+5) = 37%', () => {
  const h = R(lessonEnv(), `renderTodayPanel(${JSON.stringify(TODAY())})`);
  assert.ok(h.includes('10/27 thẻ (37%)'), h.match(/\d+\/\d+ thẻ \(\d+%\)/) + '');
});
test('KHÔNG có thẻ đến hạn / từ mới: KHÔNG biến mất — vẫn có các chế độ luyện bổ sung (mở sẵn), không có nút "Bắt đầu học"', () => {
  const h = R(lessonEnv(), `renderTodayPanel(${JSON.stringify(TODAY({ dueCount: 0, dueInScope: 0, newInCurrentLesson: 0 }))})`);
  assert.ok(!h.includes('▶️ Bắt đầu học'));
  assert.ok(h.includes('<details open') && h.includes("skStartPractice('recall')") && h.includes("skStartPractice('delayed')"));
  assert.ok(h.includes('Bạn đã ôn hết thẻ đến hạn'));
});
test('8 chế độ có mặt; "Theo lịch FSRS"/"Từ mới" khoá khi trống; "Kiểm tra sau khoảng nghỉ" khoá khi 0 từ đủ điều kiện', () => {
  const h = R(lessonEnv(), `renderTodayPanel(${JSON.stringify(TODAY({ dueCount: 0, newInCurrentLesson: 0, breakdown: Object.assign({}, TODAY().breakdown, { delayed: 0 }) }))})`);
  for (const k of ["startStudyMode('due')", "startStudyMode('new')", "skStartPractice('recall')", "skStartPractice('listening')", "skStartPractice('pinyin')", "skStartPractice('context')", "skStartPractice('confusable')", "skStartPractice('delayed')"]) {
    // nút bị khoá thì không có onclick
    const present = h.includes(k);
    if (k === "startStudyMode('due')" || k === "startStudyMode('new')" || k === "skStartPractice('delayed')") assert.ok(!present, k + ' phải bị khoá');
    else assert.ok(present, 'thiếu chế độ ' + k);
  }
});
test('không có giọng đọc → chế độ nghe bị khoá và nói lý do', () => {
  const ctx = makeEnv({ currentTab: 'today', skillAudioAvailable: () => false }); vm.runInContext(read('js/lesson.js'), ctx);
  const h = R(ctx, `renderTodayPanel(${JSON.stringify(TODAY())})`);
  assert.ok(!h.includes("skStartPractice('listening')") && h.includes('không có giọng đọc'));
});
test('thiếu phần mở rộng (breakdown/progress null): vẫn vẽ số cũ + nêu "chưa đủ dữ liệu", không số giả', () => {
  const h = R(lessonEnv(), `renderTodayPanel(${JSON.stringify(TODAY({ breakdown: null, progress: null }))})`);
  assert.ok(h.includes('Thẻ đến hạn ôn') && h.includes('chưa đủ dữ liệu'));
  assert.ok(!h.includes('Từ cần củng cố') && !h.includes('từ duy nhất'));
});
test('currentLesson chứa HTML bị thoát (không XSS)', () => {
  const h = R(lessonEnv(), `renderTodayPanel(${JSON.stringify(TODAY({ dueCount: 0, newInCurrentLesson: 0, currentLesson: '<img src=x onerror=alert(1)>' }))})`);
  assert.ok(!h.includes('<img src=x'));
});

console.log('\n[C] Khối phân tích');
function skEnv() {
  const ctx = makeEnv({ currentTab: 'skills', skFetchJson: async () => ({ ok: true }) });
  for (const f of ['js/skills-ui.js', 'js/skills-analysis.js']) vm.runInContext(read(f), ctx);
  return ctx;
}
test('nạp skills-ui + skills-analysis không lỗi', () => assert.strictEqual(typeof skEnv().saRenderRecs, 'function'));
test('khuyến nghị: chưa tải → "Đang phân tích"; thiếu dữ liệu → nêu lý do, KHÔNG gợi ý', () => {
  const ctx = skEnv();
  assert.ok(R(ctx, 'saRenderRecs()').includes('Đang phân tích'));
  R(ctx, `saState.recs = ${JSON.stringify({ ok: true, status: 'insufficient', items: [], notes: ['Chưa có dữ liệu kiểm tra kỹ năng.'] })}`);
  const h = R(ctx, 'saRenderRecs()');
  assert.ok(h.includes('Chưa có dữ liệu kiểm tra kỹ năng') && !h.includes('Luyện ngay'));
});
test('khuyến nghị: có gợi ý → hiện lý do + nút luyện; nội dung từ server được thoát HTML', () => {
  const ctx = skEnv();
  R(ctx, `saState.recs = ${JSON.stringify({ ok: true, status: 'ok', notes: [], items: [{ id: 'x', title: '<b>XSS</b>', why: 'Điểm 40% (6 lượt)', action: { kind: 'practice', skill: 'recall', hint: 'Nghĩa → Chữ Hán' } }] })}`);
  const h = R(ctx, 'saRenderRecs()');
  assert.ok(h.includes('Điểm 40% (6 lượt)') && h.includes("skStartPractice('recall')") && !h.includes('<b>XSS</b>'));
});
test('trí nhớ dài hạn: chưa đủ mẫu → "Chưa đủ dữ liệu (n/10)", KHÔNG hiện %; đủ mẫu → hiện % kèm mẫu số', () => {
  const ctx = skEnv();
  const mk = (n, c) => ({ label: 'L', fsrs: { n, correct: c, rate: n >= 10 ? c / n : null }, practice: { n: 0, correct: 0, rate: null }, all: { n, correct: c, rate: n >= 10 ? c / n : null } });
  R(ctx, `saState.retention = ${JSON.stringify({ windowDays: 90, byType: [], buckets: { immediate: mk(20, 18), day: mk(3, 3), week: mk(12, 6), month: mk(0, 0) } })}`);
  const h = R(ctx, 'saRenderRetention()');
  assert.ok(h.includes('Chưa đủ dữ liệu (3/10 lượt)'), 'nhóm ít mẫu phải báo thiếu dữ liệu');
  assert.ok(h.includes('90% (18/20)') && h.includes('50% (6/12)'));
  assert.ok(h.includes('không</b> bị tính là quên'));
});
test('trí nhớ dài hạn: hoàn toàn chưa có dữ liệu → giải thích, không vẽ thanh', () => {
  const ctx = skEnv();
  const empty = { label: 'L', fsrs: { n: 0, correct: 0, rate: null }, practice: { n: 0, correct: 0, rate: null }, all: { n: 0, correct: 0, rate: null } };
  R(ctx, `saState.retention = ${JSON.stringify({ windowDays: 90, byType: [], buckets: { immediate: empty, day: empty, week: empty, month: empty } })}`);
  const h = R(ctx, 'saRenderRetention()');
  assert.ok(h.includes('Chưa có dữ liệu') && !h.includes('sa-bar-in'));
});
test('chi tiết từ: kỹ năng thiếu dữ liệu ghi "Chưa đủ dữ liệu" (không điểm); có dữ liệu ghi mức + %; thoát HTML', () => {
  const ctx = skEnv();
  const d = {
    ok: true, word: { hz: '准备', py: 'zhǔnbèi', vi: 'chuẩn bị <script>x</script>', hanviet: null, l: 5 },
    card: { state: 2, due: '2099-01-01T00:00:00Z', stability: 12.34, reps: 9, lapses: 1 },
    skills: { recognition: { level: 'good', score: 0.9, attempts: 8, correct: 8, lastAttemptAt: '2026-10-10T00:00:00Z' }, recall: { level: 'weak', score: 0.4, attempts: 6, correct: 2 },
      listening: { level: 'insufficient', attempts: 1 }, pinyin: { level: 'insufficient', attempts: 0 }, context: { level: 'insufficient', attempts: 0 } },
    history: [{ ts: '2026-10-10T08:00:00Z', skill: 'recall', exercise_type: 'review-vi2hz', ok: false, kind: 'fsrs', response_time_ms: 3400 }],
    typeStats: [], weakTypes: [{ exercise_type: 'review-vi2hz', n: 4, wrong: 3 }],
    recommendation: { status: 'ok', items: [{ id: 'recall-gap', title: 'Nhận diện tốt nhưng nhớ chủ động còn yếu', why: 'Nhận diện: 90%', action: { kind: 'practice', skill: 'recall', hint: 'Nghĩa → Chữ Hán' } }] },
  };
  R(ctx, `saState.word = ${JSON.stringify(d)}; saState.wordLoading = false;`);
  const h = R(ctx, 'saRenderWordDetail()');
  assert.ok(h.includes('Yếu') && h.includes('Tốt') && h.includes('Chưa đủ dữ liệu'));
  assert.ok(h.includes('1 lượt (cần ≥ 3)'), 'kỹ năng thiếu dữ liệu không được hiện điểm');
  assert.ok(h.includes('Đã học (ôn định kỳ)') && h.includes('Ôn FSRS'.slice(0, 3)));
  assert.ok(h.includes('Dạng bài hay sai') && h.includes('3/4 sai'));
  assert.ok(h.includes("skStartPracticeForWord('准备','recall')"));
  assert.ok(!h.includes('<script>'), 'dữ liệu phải được thoát HTML');
  assert.ok(!/tổng điểm|điểm tổng/i.test(h.replace('Không có điểm tổng hợp', '')), 'không được có điểm tổng hợp duy nhất');
});
test('chi tiết từ: từ chưa có thẻ FSRS và chưa có lịch sử → thông báo phù hợp, không lỗi', () => {
  const ctx = skEnv();
  R(ctx, `saState.word = ${JSON.stringify({ ok: true, word: { hz: '桌子', py: 'zhuōzi', vi: 'cái bàn' }, card: null, skills: {}, history: [], typeStats: [], weakTypes: [], recommendation: { status: 'insufficient', items: [], note: 'Chưa đủ dữ liệu: cần ít nhất 3 lượt.' } })}`);
  const h = R(ctx, 'saRenderWordDetail()');
  assert.ok(h.includes('chưa có thẻ FSRS') && h.includes('Chưa có lượt nào') && h.includes('Chưa đủ dữ liệu: cần ít nhất 3 lượt.'));
});
test('chi tiết từ: lỗi tải → hiện lỗi + nút thử lại + quay lại', () => {
  const ctx = skEnv();
  R(ctx, `saState.word = {hz:'准备'}; saState.wordError = 'Không tìm thấy từ vựng';`);
  const h = R(ctx, 'saRenderWordDetail()');
  assert.ok(h.includes('Không tìm thấy từ vựng') && h.includes('Thử lại') && h.includes('Quay lại'));
});
test('tab Phân tích: ghép đủ các khối; khi mở 1 từ thì chỉ hiện chi tiết', () => {
  const ctx = skEnv();
  R(ctx, `skState.loaded = true; skState.overview = {testedWords: 0, fsrsDueCount: 0, skills: {}}; skState.weak = []; skState.trend = {rows: []};`);
  const h = R(ctx, 'renderSkills()');
  for (const t of ['Gợi ý cho bạn', 'Tổng quan năng lực', 'Luyện theo kỹ năng', 'Xem chi tiết một từ', 'phân biệt từ dễ nhầm', 'Kiểm tra sau một khoảng nghỉ', 'tự gõ']) assert.ok(h.includes(t), 'thiếu khối: ' + t);
  R(ctx, `saState.word = {hz:'准备'}; saState.wordError = 'x';`);
  assert.ok(!R(ctx, 'renderSkills()').includes('Tổng quan năng lực'));
});

console.log('\n[D] Cấu hình');
test('index.html nạp answer-match TRƯỚC question-engine, và skills-analysis SAU skills-ui', () => {
  const h = read('index.html');
  assert.ok(h.indexOf('answer-match.js') > 0 && h.indexOf('answer-match.js') < h.indexOf('question-engine.js'));
  assert.ok(h.indexOf('skills-analysis.js') > h.indexOf('skills-ui.js'));
});
test('Migration V110 chỉ CỘNG THÊM (không DROP/UPDATE/DELETE ngoài phần hoàn tác đã comment)', () => {
  const sql = read('migrations/V110_retention_tracking.sql').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/\b(DROP|UPDATE|TRUNCATE|DELETE)\b/i.test(sql));
  assert.ok(/ADD COLUMN IF NOT EXISTS session_id/.test(sql) && /IF NOT EXISTS skill_practice_log_user_word_idx/.test(sql));
});
test('Server: /review, /preview, /practice đều chấm qua gradeAnswer; route phân tích mới có mặt và đều yêu cầu đăng nhập', () => {
  const api = read('api/index.js');
  assert.strictEqual((api.match(/gradeAnswer\(correctAnswer, selectedAnswer, /g) || []).length, 3);
  for (const r of ['/api/skills/retention', '/api/skills/recommendations', '/api/skills/word', '/api/skills/delayed-words']) {
    const i = api.indexOf(`app.get('${r}'`); assert.ok(i > 0, 'thiếu route ' + r);
    assert.ok(api.slice(i, i + 200).includes('requireAuth'), r + ' phải yêu cầu đăng nhập');
  }
});
test('Server: luyện bổ sung KHÔNG gọi reviewService (không đổi FSRS) — kể cả loại tự nhập', () => {
  const api = read('api/index.js');
  const i = api.indexOf("app.post('/api/skills/practice'"), j = api.indexOf("app.get('/api/skills/retention'");
  assert.ok(i > 0 && j > i);
  assert.ok(!/reviewService\./.test(api.slice(i, j)), 'route luyện bổ sung không được gọi reviewService');
});

runAll();
