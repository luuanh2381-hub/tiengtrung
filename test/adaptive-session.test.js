#!/usr/bin/env node
// test/adaptive-session.test.js — kiểm thử LUỒNG BUỔI HỌC thích ứng của tab "Hôm nay học" (V106).
// Chạy các hàm THẬT trích từ js/review.js trong `vm` (DOM/mạng/localStorage giả). Không cần DB/ts-fsrs/express.
// Phạm vi thật: logic hàng đợi, bộ chọn, chống lặp, tổng kết, nhật ký, ranh giới FSRS/luyện bổ sung.
// KHÔNG kiểm tra: giao diện trên trình duyệt/điện thoại thật, âm thanh thật, SQL thật, FSRS thật.
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
const review = read('js/review.js');
function grab(name) {
  let i = review.indexOf('async function ' + name + '(');
  if (i < 0) i = review.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'không thấy hàm ' + name);
  let depth = 0; const j = review.indexOf('{', i);
  for (let k = j; k < review.length; k++) {
    if (review[k] === '{') depth++; else if (review[k] === '}') { depth--; if (depth === 0) return review.slice(i, k + 1); }
  }
  throw new Error('không đóng được ' + name);
}
const constLine = (name) => { const m = review.match(new RegExp('^const ' + name + '\\b.*$', 'm')); assert.ok(m, name); return m[0]; };
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const POOL = [];
'认真 准备 参加 发现 学习 学校 学生 休息 苹果 桌子 天气 买 卖 汤 包子 电影 音乐 书 笔 纸 车 船 飞机 桥 路'.split(' ').forEach((hz, i) =>
  POOL.push({ hz, py: 'py' + i + (i % 2 ? 'ā' : 'è'), vi: 'nghĩa số ' + i, l: 1 + (i % 6) }));

// Dựng 1 "trình duyệt giả" chạy các hàm thật của review.js.
function makeEnv(opts) {
  opts = opts || {};
  const log = { purged: [], persisted: [], archived: 0, fetches: [], practice: [], fsrs: [], alerts: [], redoItems: null };
  const ctx = {
    console, Math, Date, JSON, Set, Map, Array, Object, String, Number, Promise, Error,
    WORDS: opts.words || POOL, GUEST_MAX_LESSON: 99, isLoggedIn: () => true, isGuest: false, authToken: 't', authHeaders: () => ({}),
    SENTENCES: [], CONFUSE_GROUPS: [],
    skillAudioAvailable: () => opts.audio !== false,
    performance: { now: () => 0 }, vtMarkStart() {}, vtHiddenMs: () => 0, render() {},
    sessionKnownHz: new Set(), saveSessionKnownHz() {}, sqPurgeHzFromAllQueues: (hz) => log.purged.push(hz),
    REPEAT_GAP: 3, currentTab: 'review', ssArchiveSession() { log.archived++; }, refreshServerMeta() {}, sqClearPersisted() {},
    sqPersist: (k, q, extra) => log.persisted.push({ items: q.items.length, extra }), rvStorageMode: () => 'review',
    escapeHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    genIdempotencyKey: () => 'k-' + Math.random(), todayKey: () => '2026-10-14', sqSnapshotLessonFilter: () => ({}),
    sqCreate: () => ({ items: [], doneHz: new Set(), totalPlanned: 0, answeredCount: 0, sessionId: null, startTime: null, endTime: null, completedCards: [], lessonFilter: null, dayKey: null }),
    alert: (m) => log.alerts.push(m),
    submitSkillPractice: (a) => { log.practice.push(a); return Promise.resolve({ ok: true }); },
    submitFsrsReview: (a) => { log.fsrs.push(a); return Promise.resolve({ ok: true }); },
    fetch: opts.fetch || (async (url) => { log.fetches.push(url); return { json: async () => ({ ok: true, words: [] }) }; }),
    rvClearCountdown() {}, rvFindExample: () => null, lessonsLabel: () => 'Bài', playDing() {}, playBuzz() {}, speak() {},
  };
  vm.createContext(ctx);
  vm.runInContext(read('js/question-engine.js'), ctx);
  vm.runInContext(read('js/question-selector.js'), ctx);
  const consts = ['RV_NEW_GAP', 'RV_DRILL_GAP', 'RV_DRILL_MAX_TRIES', 'RV_EXTRA_MAX', 'RV_PRACTICE_TYPES'].map(constLine).join('\n');
  const fns = ['rvIsPractice', 'rvIsOfficial', 'rvQCtx', 'rvSkillTypes', 'rvBuildQuestionFor', 'rvStageLabel', 'rvRecordAnswer', 'rvRestoreQSession',
    'rvPrepareCurrentCard', 'rvIntroDone', 'rvAdvanceQueue', 'rvFetchWeakWords', 'rvWordOf', 'rvAddExtras', 'rvInsertMatch', 'rvBuildStartInfo',
    'rvSummaryHtml', 'rvBeginPracticeOnly', 'rvStartRedoWrong', 'rvStartWeakPractice', 'rvPickPractice', 'rvMatchPick', 'rvMatchFinish', 'rvMatchContinue', 'rvPracticeContinue'].map(grab).join('\n');
  const prelude = `
    let rvQueue = sqCreate(), rvQuestion = null, rvQSession = QS.newSession(), rvLog = [], rvStage = 'run', rvStartInfo = null, rvMatch = null,
        rvPhase = 'question', rvLastAnswer = null, rvAnswerChanges = 0, rvRatingPhase = null, rvSystemRating = null, rvUserRating = null,
        rvFinalRating = null, rvPendingReview = null, rvStartedAt = 0, rvExamplePool = [], rvSummary = { reviewCount: 0, newCount: 0 },
        rvWeakMode = false, rvBlockedByBacklog = false, rvTotalDue = 0, rvAttemptId = 0, rvSubmitting = false;
    ${consts}
    ${fns}
    globalThis.__env = { get q() { return rvQueue; }, set q(v) { rvQueue = v; }, get log() { return rvLog; }, set log(v) { rvLog = v; },
      get question() { return rvQuestion; }, get phase() { return rvPhase; }, set phase(v) { rvPhase = v; },
      get last() { return rvLastAnswer; }, set last(v) { rvLastAnswer = v; }, get qs() { return rvQSession; },
      get stage() { return rvStage; }, get match() { return rvMatch; }, set summary(v) { rvSummary = v; },
      f: { rvPrepareCurrentCard, rvIntroDone, rvAdvanceQueue, rvAddExtras, rvInsertMatch, rvBuildStartInfo, rvSummaryHtml, rvRecordAnswer,
           rvRestoreQSession, rvStartRedoWrong, rvStartWeakPractice, rvBuildQuestionFor, rvIsOfficial, rvIsPractice, rvMatchPick, rvMatchContinue, rvBeginPracticeOnly } };`;
  vm.runInContext(prelude, ctx);
  return { ctx, log, env: ctx.__env, f: ctx.__env.f };
}
const item = (type, hz, extra) => Object.assign({ type, word: POOL.find(w => w.hz === hz) }, extra || {});

// Mô phỏng 1 buổi học: người học trả lời theo `policy(item, q)` → true/false. Trả về thống kê.
function simulate(E, items, policy, maxSteps) {
  E.env.q = Object.assign(E.env.q, { items: items.slice(), totalPlanned: items.filter(E.f.rvIsOfficial).length });
  E.f.rvPrepareCurrentCard();
  let steps = 0, officialAnswers = 0, practiceAnswers = 0;
  const types = [];
  while (E.env.q.items.length && steps++ < (maxSteps || 400)) {
    const it = E.env.q.items[0];
    if (E.env.phase === 'intro') { E.f.rvIntroDone(); continue; }
    if (E.env.phase === 'match') {
      const m = E.env.match; for (const p of m.m.pairs) { m.solved.add(p.hz); m.solvedRights.add(p.right); } m.done = true;
      E.env.last = { correct: true }; E.f.rvAdvanceQueue(); practiceAnswers++; continue;
    }
    const q = E.env.question; assert.ok(q, 'phải có câu hỏi cho ' + it.type);
    const ok = policy(it, q, steps);
    types.push(q.typeId);
    E.f.rvRecordAnswer(it, q, ok, 1000, E.f.rvIsOfficial(it));
    E.env.last = { correct: ok };
    if (E.f.rvIsOfficial(it)) officialAnswers++; else practiceAnswers++;
    E.f.rvAdvanceQueue();
  }
  return { steps, officialAnswers, practiceAnswers, types, finished: E.env.q.items.length === 0 };
}

console.log('\n[1] Từ mới: giới thiệu → kiểm tra → ôn FSRS sau khoảng nghỉ');
test('Từ MỚI hiện màn giới thiệu trước, không bị hỏi khi chưa học [case 2]', () => {
  const E = makeEnv(); E.env.q.items = [item('new', '认真'), item('review', '准备')];
  E.f.rvPrepareCurrentCard();
  assert.strictEqual(E.env.phase, 'intro'); assert.strictEqual(E.env.question, null);
});
test('Xem xong → câu kiểm tra dễ (hz→nghĩa) loại "check", chưa tính FSRS', () => {
  const E = makeEnv(); E.env.q.items = [item('new', '认真'), item('review', '准备')];
  E.f.rvPrepareCurrentCard(); E.f.rvIntroDone();
  assert.strictEqual(E.env.q.items[0].type, 'check'); assert.strictEqual(E.env.question.typeId, 'hz2vi'); assert.strictEqual(E.env.phase, 'question');
});
test('Kiểm tra xong → thẻ FSRS chính thức của từ mới vào lại sau RV_NEW_GAP thẻ; không tăng answeredCount/không đánh dấu đã biết', () => {
  const E = makeEnv();
  E.env.q.items = [{ type: 'check', word: POOL[0], introduced: true }, item('review', 'b1'), item('review', '准备'), item('review', '参加'), item('review', '发现'), item('review', '学习')].map((x, i) => i === 1 ? item('review', '学校') : x);
  E.f.rvPrepareCurrentCard(); E.env.last = { correct: true }; E.f.rvAdvanceQueue();
  const qi = E.env.q.items;
  assert.strictEqual(qi[3].type, 'new'); assert.strictEqual(qi[3].introduced, true); assert.strictEqual(qi[3].word.hz, '认真');
  assert.strictEqual(E.env.q.answeredCount, 0); assert.strictEqual(E.env.q.completedCards.length, 0);
  assert.strictEqual(E.ctx.sessionKnownHz.size, 0); assert.deepStrictEqual(E.log.purged, []);
});
test('Ôn FSRS chính thức của từ mới (đã giới thiệu) KHÔNG hiện lại màn giới thiệu và chỉ dùng dạng server chấm được', () => {
  const E = makeEnv(); E.env.q.items = [{ type: 'new', word: POOL[0], introduced: true }];
  E.f.rvPrepareCurrentCard();
  assert.strictEqual(E.env.phase, 'question');
  assert.ok(E.env.question.exerciseFsrs && E.env.question.fsrsEligible);
});

console.log('\n[2] Ranh giới FSRS ↔ luyện bổ sung');
test('Thẻ FSRS đúng → loại khỏi phiên, tính tiến độ, đánh dấu đã biết; không sinh thêm câu phụ nào', () => {
  const E = makeEnv(); E.env.q.items = [item('review', '认真'), item('review', '准备')];
  E.f.rvPrepareCurrentCard(); E.env.last = { correct: true }; E.f.rvAdvanceQueue();
  assert.strictEqual(E.env.q.items.length, 1); assert.strictEqual(E.env.q.answeredCount, 1);
  assert.ok(E.ctx.sessionKnownHz.has('认真')); assert.deepStrictEqual(E.log.purged, ['认真']);
});
test('Thẻ FSRS sai → quay lại sau REPEAT_GAP thẻ (không bị bỏ qua) và lần sau hỏi DẠNG KHÁC (chống lặp)', () => {
  const E = makeEnv(); const w = '认真';
  E.env.q.items = [item('review', w), item('review', '准备'), item('review', '参加'), item('review', '发现'), item('review', '学习')];
  E.f.rvPrepareCurrentCard(); const first = E.env.question.typeId;
  E.f.rvRecordAnswer(E.env.q.items[0], E.env.question, false, 1, true);
  E.env.last = { correct: false }; E.f.rvAdvanceQueue();
  const idx = E.env.q.items.findIndex(i => i.word.hz === w); assert.strictEqual(idx, 3);
  // đến lượt: chuẩn bị lại thẻ này
  while (E.env.q.items[0].word.hz !== w) { E.env.last = { correct: true }; E.f.rvAdvanceQueue(); }
  assert.notStrictEqual(E.env.question.typeId, first);
  assert.ok(!E.ctx.sessionKnownHz.has(w));
});
test('Câu luyện bổ sung (extra/redo): KHÔNG đi đường FSRS — rvPickPractice không gọi submitFsrsReview/preview, chỉ ghi kỹ năng', () => {
  const src = grab('rvPickPractice');
  assert.ok(!/submitFsrsReview|rvFetchSystemRating|api\/study\/review/.test(src));
  assert.ok(/submitSkillPractice\(\{ word: w, exerciseType: q\.exercisePractice/.test(src));
  const E = makeEnv(); E.env.q.items = [item('extra', '认真', { targetSkill: 'recall' })];
  E.f.rvPrepareCurrentCard();
  const btn = { dataset: { v: E.env.question.correctKey }, _correct: true, classList: { add() {} }, disabled: false };
  E.ctx.document = { querySelectorAll: () => [], getElementById: () => null };
  E.ctx.setTimeout = () => 0;
  vm.runInContext('rvPickPractice', E.ctx)(btn);
  assert.strictEqual(E.log.fsrs.length, 0); assert.strictEqual(E.log.practice.length, 1);
  assert.ok(E.log.practice[0].exerciseType.startsWith('practice-'));
});
test('Luyện bổ sung sai → hỏi lại tối đa RV_DRILL_MAX_TRIES lần, mỗi lần đổi dạng; hết lượt thì bỏ (không kẹt) [case 9]', () => {
  const E = makeEnv(); E.env.q.items = [item('extra', '认真', { targetSkill: 'recall' }), item('review', '准备'), item('review', '参加'), item('review', '发现')];
  E.f.rvPrepareCurrentCard(); const t1 = E.env.question.typeId;
  E.env.last = { correct: false }; E.f.rvAdvanceQueue();
  const again = E.env.q.items.find(i => i.type === 'extra');
  assert.ok(again && again.tries === 1 && again.failedTypes.includes(t1));
  while (E.env.q.items[0].type !== 'extra') { E.env.last = { correct: true }; E.f.rvAdvanceQueue(); }
  E.env.last = { correct: false }; E.f.rvAdvanceQueue();
  assert.ok(!E.env.q.items.some(i => i.type === 'extra'));
  assert.strictEqual(E.env.q.answeredCount, 3); // 3 thẻ FSRS đã trả lời đúng khi đưa 'extra' lên đầu; câu luyện bổ sung không cộng thêm
});
test('Luyện bổ sung đúng → loại, không đổi tiến độ phiên', () => {
  const E = makeEnv(); E.env.q.items = [item('extra', '认真', { targetSkill: 'recall' }), item('review', '准备')];
  E.f.rvPrepareCurrentCard(); E.env.last = { correct: true }; E.f.rvAdvanceQueue();
  assert.strictEqual(E.env.q.items.length, 1); assert.strictEqual(E.env.q.answeredCount, 0); assert.strictEqual(E.ctx.sessionKnownHz.size, 0);
});

console.log('\n[3] Trộn nguồn: từ mới + đến hạn + hay sai');
const weakRows = (hzs) => hzs.map(hz => { const w = POOL.find(x => x.hz === hz); return { hz, l: w.l, skill: 'recall' }; });
test('rvAddExtras: ≤25% buổi (≥1 khi ≥4 thẻ), không trùng từ đã có, thẻ FSRS giữ nguyên thứ tự [case 4, 5]', async () => {
  const urls = [];
  const E = makeEnv({ fetch: async (u) => { urls.push(u); return { json: async () => ({ ok: true, words: weakRows(['汤', '包子', '电影', '音乐', '书', '笔']) }) }; } });
  const official = ['认真', '准备', '参加', '发现', '学习', '学校', '学生', '休息'].map(h => item(h === '认真' ? 'new' : 'review', h));
  const out = await E.f.rvAddExtras(official);
  assert.strictEqual(out.extraCount, 2);
  assert.deepStrictEqual(Array.from(out.items.filter(i => E.f.rvIsOfficial(i)).map(i => i.word.hz)), official.map(i => i.word.hz));
  assert.ok(out.items.filter(i => i.type === 'extra').every(i => !official.some(o => o.word.hz === i.word.hz)));
  assert.ok(/weakOnly=1/.test(urls[0]));
  assert.ok(out.items[0].type !== 'extra', 'extra không được chen lên trước thẻ FSRS đầu tiên');
});
test('rvAddExtras: buổi <4 thẻ → không chèn; buổi rỗng → tối đa RV_EXTRA_MAX; từ đã trong hàng đợi bị loại', async () => {
  const E = makeEnv({ fetch: async () => ({ json: async () => ({ ok: true, words: weakRows(['认真', '汤', '包子', '电影', '音乐', '书', '笔', '纸']) }) }) });
  const few = [item('review', '认真'), item('review', '准备'), item('review', '参加')];
  assert.strictEqual((await E.f.rvAddExtras(few)).extraCount, 0);
  const empty = await E.f.rvAddExtras([]);
  assert.strictEqual(empty.extraCount, 6); assert.ok(empty.items.every(i => i.type === 'extra'));
  const withDup = await E.f.rvAddExtras([item('review', '认真'), item('review', '准备'), item('review', '参加'), item('review', '发现')]);
  assert.ok(!withDup.items.some(i => i.type === 'extra' && i.word.hz === '认真'));
});
test('rvAddExtras: lỗi mạng/ok:false/khách → giữ nguyên danh sách, không ném lỗi [case 12]', async () => {
  const items = [item('review', '认真'), item('review', '准备'), item('review', '参加'), item('review', '发现')];
  const E1 = makeEnv({ fetch: async () => { throw new Error('offline'); } });
  assert.strictEqual((await E1.f.rvAddExtras(items)).extraCount, 0);
  const E2 = makeEnv({ fetch: async () => ({ json: async () => ({ ok: false }) }) });
  assert.strictEqual((await E2.f.rvAddExtras(items)).items.length, 4);
  const E3 = makeEnv(); E3.ctx.isGuest = true; assert.strictEqual((await E3.f.rvAddExtras(items)).extraCount, 0);
});
test('rvInsertMatch: cần ≥4 từ khác nhau; chèn đúng 1 bài, giữ thứ tự thẻ FSRS', () => {
  const E = makeEnv();
  const three = [item('review', '认真'), item('review', '准备'), item('review', '参加')];
  assert.strictEqual(E.f.rvInsertMatch(three).length, 3);
  const six = ['认真', '准备', '参加', '发现', '学习', '学校'].map(h => item('review', h));
  const out = E.f.rvInsertMatch(six);
  assert.strictEqual(out.filter(i => i.type === 'match').length, 1);
  assert.deepStrictEqual(Array.from(out.filter(E.f.rvIsOfficial).map(i => i.word.hz)), six.map(i => i.word.hz));
  assert.strictEqual(new Set(out.find(i => i.type === 'match').hzs).size, 4);
});
test('Màn bắt đầu: số liệu THẬT (từ mới, đến hạn, từ hay sai, số câu dự kiến), không số giả [case IX]', () => {
  const E = makeEnv();
  const items = [item('new', '认真'), item('new', '准备'), item('review', '参加'), item('extra', '汤', { targetSkill: 'recall' }), item('match', '', { hzs: [] })];
  items[3].word = POOL.find(w => w.hz === '汤');
  const info = E.f.rvBuildStartInfo(items, 1);
  assert.strictEqual(info.newCount, 2); assert.strictEqual(info.reviewCount, 1); assert.strictEqual(info.extraCount, 1);
  assert.strictEqual(info.estimated, 1 + 2 * 2 + 1 + 1);
  assert.deepStrictEqual(Array.from(info.lessons), [...new Set([POOL[0].l, POOL[1].l, POOL[2].l])].sort((a, b) => a - b));
});

console.log('\n[4] Mô phỏng cả buổi (kết thúc hữu hạn, chống lặp)');
test('Buổi nhiều từ mới + đến hạn, trả lời đúng hết: kết thúc, mỗi thẻ FSRS đúng 1 lượt chính thức, mỗi từ mới đúng 1 câu kiểm tra [case 2, 8]', () => {
  const E = makeEnv();
  const items = ['认真', '准备', '参加', '发现', '学习', '学校'].map(h => item('new', h)).concat(['学生', '休息', '苹果', '桌子', '天气', '汤'].map(h => item('review', h)));
  const r = simulate(E, items, () => true);
  assert.ok(r.finished);
  assert.strictEqual(r.officialAnswers, 12);
  const checks = E.env.log.filter(e => e.source === 'check').length; assert.strictEqual(checks, 6);
  assert.strictEqual(E.env.log.filter(e => e.official).length, 12);
});
test('Mọi câu sai ở lần đầu rồi đúng: vẫn kết thúc hữu hạn; không lặp cùng (từ, dạng) quá mức [case 9, 18]', () => {
  const E = makeEnv(); const seen = {};
  const items = ['认真', '准备', '参加', '发现'].map(h => item('review', h));
  const r = simulate(E, items, (it, q) => { const k = q.hz + '|' + q.typeId; seen[k] = (seen[k] || 0) + 1; return seen[k] > 0 && (E.env.log.filter(e => e.hz === q.hz && e.official).length >= 1); }, 200);
  assert.ok(r.finished); assert.ok(r.officialAnswers >= 8);
  const pairCounts = Object.values(E.env.qs.asked); assert.ok(Math.max(...pairCounts) <= 2, 'cặp (từ, dạng) bị hỏi lặp quá nhiều: ' + Math.max(...pairCounts));
});
test('Kho từ chỉ 2 từ: buổi vẫn chạy được (câu 2 lựa chọn) và kết thúc; kho 1 từ: bỏ thẻ thay vì kẹt [case 3, 18]', () => {
  const E2 = makeEnv({ words: POOL.slice(0, 2) });
  const r2 = simulate(E2, [item('review', POOL[0].hz), item('review', POOL[1].hz)], () => true);
  assert.ok(r2.finished && r2.officialAnswers === 2);
  const E1 = makeEnv({ words: POOL.slice(0, 1) });
  const r1 = simulate(E1, [item('review', POOL[0].hz)], () => true);
  assert.ok(r1.finished); assert.strictEqual(r1.officialAnswers, 0);
});
test('Không có âm thanh → cả buổi không có câu nghe; không có câu ví dụ → không có cloze [case 6, 7]', () => {
  const E = makeEnv({ audio: false });
  const items = POOL.slice(0, 12).map(w => item('review', w.hz));
  for (const it of items) it.skillProfile = { listening: { status: 'weak', score: 0.1, attempts: 9 }, context: { status: 'weak', score: 0.1, attempts: 9 } };
  const r = simulate(E, items, () => true);
  assert.ok(r.finished); assert.ok(!r.types.some(t => t === 'listen2hz' || t === 'listen2vi' || t === 'cloze'));
});
test('Từ yếu nghe (có âm thanh) → buổi có câu nghe cho đúng từ đó; từ khác không bị ép [case 5]', () => {
  const E = makeEnv();
  const a = item('review', '认真'); a.skillProfile = { recognition: { status: 'ok', score: 0.95, attempts: 10 }, recall: { status: 'ok', score: 0.9, attempts: 6 }, listening: { status: 'weak', score: 0.2, attempts: 6 }, pinyin: { status: 'ok', score: 0.9, attempts: 6 }, context: { status: 'ok', score: 0.9, attempts: 6 } };
  E.env.q.items = [a]; E.f.rvPrepareCurrentCard();
  assert.ok(['listen2hz', 'listen2vi'].includes(E.env.question.typeId));
});
test('Bài ghép cặp: hoàn tất ghi từng cặp (luyện bổ sung), không đổi tiến độ FSRS', () => {
  const E = makeEnv();
  E.env.q.items = [{ type: 'match', hzs: ['认真', '准备', '参加', '发现'] }, item('review', '学习')];
  E.f.rvPrepareCurrentCard();
  assert.strictEqual(E.env.phase, 'match');
  const m = E.env.match;
  for (const p of m.m.pairs) { E.ctx.__sel = p; }
  // chạm đúng từng cặp
  for (const p of m.m.pairs) { E.f.rvMatchPick('L', m.m.lefts.indexOf(p.hz)); E.f.rvMatchPick('R', m.m.rights.indexOf(p.right)); }
  assert.strictEqual(m.done, true);
  assert.strictEqual(E.log.practice.length, m.m.pairs.length);
  assert.ok(E.log.practice.every(a => /^practice-match-/.test(a.exerciseType)));
  assert.strictEqual(E.log.fsrs.length, 0);
  E.f.rvMatchContinue();
  assert.strictEqual(E.env.q.answeredCount, 0); assert.strictEqual(E.env.q.items[0].word.hz, '学习');
});
test('Ghép cặp: chọn sai ghi nhận là sai (lần chọn đầu), đáp án vẫn ghép được rồi hoàn tất', () => {
  const E = makeEnv();
  E.env.q.items = [{ type: 'match', hzs: ['认真', '准备', '参加', '发现'] }];
  E.f.rvPrepareCurrentCard(); const m = E.env.match; const p0 = m.m.pairs[0]; const wrongRight = m.m.pairs[1].right;
  E.f.rvMatchPick('L', m.m.lefts.indexOf(p0.hz)); E.f.rvMatchPick('R', m.m.rights.indexOf(wrongRight));
  assert.ok(m.wrong.has(p0.hz) && !m.solved.has(p0.hz));
  for (const p of m.m.pairs) { E.f.rvMatchPick('L', m.m.lefts.indexOf(p.hz)); E.f.rvMatchPick('R', m.m.rights.indexOf(p.right)); }
  assert.strictEqual(m.done, true);
  const sent = E.log.practice.find(a => a.word.hz === p0.hz);
  assert.strictEqual(sent.selectedAnswer, wrongRight, 'phải gửi lần chọn đầu tiên');
});

console.log('\n[5] Nhật ký, tổng kết, luyện lại, khôi phục');
test('Tổng kết: tổng/đúng/sai/tỉ lệ, theo dạng bài, kỹ năng "Chưa đủ dữ liệu" khi <3 câu, nhắc phân biệt trí nhớ dài hạn [case IV-D]', () => {
  const E = makeEnv(); E.env.summary = { reviewCount: 3, newCount: 1 };
  const L = [['认真', 'hz2vi', true], ['认真', 'vi2hz', false], ['准备', 'hz2vi', true], ['参加', 'hz2vi', true], ['发现', 'listen2hz', false]];
  E.env.log = L.map(([hz, typeId, correct]) => ({ hz, l: 1, typeId, skill: typeId === 'hz2vi' ? 'recognition' : (typeId === 'vi2hz' ? 'recall' : 'listening'), correct, ms: 1000, official: true, source: 'review' }));
  E.env.q.startTime = Date.now() - 5 * 60000; E.env.q.endTime = Date.now();
  const html = E.f.rvSummaryHtml();
  assert.ok(html.includes('Tổng kết buổi học') && html.includes('60%') && html.includes('3 / 2'));
  assert.ok(html.includes('Chưa đủ dữ liệu')); assert.ok(html.includes('chưa phải mức độ ghi nhớ lâu dài'));
  assert.ok(html.includes('Luyện lại câu sai') && html.includes('Kết thúc buổi học'));
});
test('Tổng kết: từ sai rồi đúng lại (lần cuối đúng) KHÔNG nằm trong "cần ôn lại"; không có sai → không có nút luyện lại', () => {
  const E = makeEnv();
  E.env.log = [{ hz: '认真', l: 1, typeId: 'hz2vi', skill: 'recognition', correct: false, official: true, source: 'review' }, { hz: '认真', l: 1, typeId: 'vi2hz', skill: 'recall', correct: true, official: true, source: 'review' }];
  const html = E.f.rvSummaryHtml();
  assert.ok(!html.includes('Luyện lại câu sai')); assert.ok(html.includes('Không có từ nào sai ở lần trả lời cuối'));
});
test('Tổng kết: đủ ≥3 câu của 1 kỹ năng và <70% → liệt kê là cần cải thiện', () => {
  const E = makeEnv();
  E.env.log = [false, false, true].map((c, i) => ({ hz: POOL[i].hz, l: POOL[i].l, typeId: 'vi2hz', skill: 'recall', correct: c, official: true, source: 'review' }));
  assert.ok(E.f.rvSummaryHtml().includes('Nhớ chủ động'));
});
test('Luyện lại câu sai (dạng 10): chỉ từ có lần cuối SAI, kèm các dạng đã sai để ĐỔI dạng; không FSRS, không lưu phiên', () => {
  const E = makeEnv();
  E.env.log = [
    { hz: '认真', l: 1, typeId: 'hz2vi', skill: 'recognition', correct: false, official: true, source: 'review' },
    { hz: '准备', l: 2, typeId: 'vi2hz', skill: 'recall', correct: true, official: true, source: 'review' },
    { hz: '参加', l: 3, typeId: 'hz2py', skill: 'pinyin', correct: false, official: true, source: 'review' },
  ];
  E.f.rvStartRedoWrong();
  const items = E.env.q.items;
  assert.ok(E.env.q.practiceOnly); assert.deepStrictEqual(Array.from(items.map(i => i.word.hz)).sort(), ['参加', '认真'].sort());
  assert.ok(items.every(i => i.type === 'redo'));
  assert.deepStrictEqual(Array.from(items.find(i => i.word.hz === '认真').failedTypes), ['hz2vi']);
  // đổi dạng thật: câu của 认真 không được là hz2vi
  const q = E.f.rvBuildQuestionFor(items.find(i => i.word.hz === '认真'));
  assert.notStrictEqual(q.typeId, 'hz2vi');
  E.env.last = { correct: true }; E.f.rvAdvanceQueue(); E.env.last = { correct: true }; E.f.rvAdvanceQueue();
  assert.strictEqual(E.env.q.items.length, 0); assert.strictEqual(E.log.persisted.length, 0); assert.strictEqual(E.log.archived, 0);
});
test('Không có câu sai → báo, không tạo buổi rỗng', () => {
  const E = makeEnv(); E.env.log = [{ hz: '认真', l: 1, typeId: 'hz2vi', skill: 'recognition', correct: true, official: true, source: 'review' }];
  E.f.rvStartRedoWrong(); assert.strictEqual(E.log.alerts.length, 1); assert.strictEqual(E.env.q.items.length, 0);
});
test('Nhật ký + khôi phục sau tải lại trang: chống lặp dựng lại từ nhật ký; nhật ký được lưu cùng phiên [case 10, 11]', () => {
  const E = makeEnv(); E.env.q.items = [item('review', '认真'), item('review', '准备'), item('review', '参加')];
  E.f.rvPrepareCurrentCard(); const q = E.env.question; E.env.last = { correct: true };
  E.f.rvRecordAnswer(E.env.q.items[0], q, true, 800, true); E.f.rvAdvanceQueue();
  assert.ok(E.log.persisted.length >= 1 && Array.isArray(E.log.persisted[0].extra.log) && E.log.persisted[0].extra.log.length === 1);
  const saved = JSON.parse(JSON.stringify(E.log.persisted[0].extra.log));
  const E2 = makeEnv(); E2.env.log = saved; E2.f.rvRestoreQSession();
  assert.strictEqual(E2.env.qs.asked['认真|' + q.typeId], 1); assert.strictEqual(E2.env.qs.history.length, 1);
  assert.ok(/log: rvLog/.test(review) && /saved\.extra\.log/.test(review));
  assert.ok(/\(it\.type !== 'review' && it\.type !== 'new'\) \|\| !sessionKnownHz\.has/.test(review), 'khôi phục không được lọc nhầm câu luyện bổ sung');
});
test('Từ mới trong phiên đã lưu (chưa giới thiệu) khi khôi phục vẫn có màn giới thiệu; thẻ introduced không lặp giới thiệu', () => {
  const E = makeEnv(); E.env.q.items = [{ type: 'new', word: POOL[0], introduced: true }, item('new', '准备')];
  E.f.rvPrepareCurrentCard(); assert.strictEqual(E.env.phase, 'question');
  E.env.last = { correct: true }; E.f.rvAdvanceQueue(); assert.strictEqual(E.env.phase, 'intro');
});

console.log('\n[6] Tĩnh: giao diện/tương thích');
test('Giao diện tiếng Việt: các nhãn chính có mặt; mục tiêu chạm ≥44px cho ghép cặp (điện thoại)', () => {
  for (const t of ['Bắt đầu học', 'Tổng kết buổi học', 'Luyện lại câu sai', 'Kết thúc buổi học', 'Đã xem — kiểm tra ngay', 'Ghép chữ Hán với']) assert.ok(review.includes(t), t);
  const m = review.match(/\.rv-match-btn\{min-height:(\d+)px/); assert.ok(m && +m[1] >= 44);
  assert.ok(/grid-template-columns:1fr 1fr/.test(review));
});
test('Các dạng đã nối vào index.html trước review.js; engine không phụ thuộc DOM', () => {
  const h = read('index.html');
  assert.ok(h.indexOf('question-engine.js') < h.indexOf('review.js') && h.indexOf('question-selector.js') < h.indexOf('review.js'));
  for (const f of ['js/question-engine.js', 'js/question-selector.js']) assert.ok(!/\bdocument\b|\bwindow\b|\bfetch\(/.test(read(f).replace(/\/\/.*$/gm, '')), f);
});
test('Chỉ lượt FSRS chính thức truyền exerciseType FSRS; xác nhận gọi server giữ nguyên preview → commit', () => {
  assert.ok(/exerciseType: rvQuestion\.exerciseFsrs/.test(review));
  assert.ok(/api\/study\/review\/preview/.test(review));
  assert.strictEqual((review.match(/submitFsrsReviewAwaited\(/g) || []).length, 1, 'chỉ 1 chỗ gửi FSRS chính thức trong Review');
});

runAll();
