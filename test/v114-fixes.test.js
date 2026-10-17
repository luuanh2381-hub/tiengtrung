// test/v114-fixes.test.js — kiểm thử V114: (1) cờ introduced tách khỏi "lượt FSRS đầu sau giới thiệu", (2) getTodayProgress chỉ đếm lượt đo kỹ năng hợp lệ,
// (3) migrate-skill-evidence: mọi thay đổi cấu trúc nằm trong transaction. Chạy: node test/v114-fixes.test.js
//
// LƯU Ý TRUNG THỰC: không có PostgreSQL trong môi trường này.
//  • Nhóm [1] chạy NGUYÊN js/review.js + js/study-queue.js trong vm (DOM/mạng giả) — đây là chạy mã thật của trình duyệt, nhưng mạng/localStorage là giả.
//  • Nhóm [2] kiểm CHUỖI SQL thật mà getTodayProgress gửi đi (bắt bằng client giả) + một MÔ HÌNH THAM CHIẾU bằng JS của quy tắc. Mô hình JS KHÔNG phải
//    bằng chứng SQL đã chạy; câu SQL chưa được PostgreSQL thực thi ở đây (xem hướng dẫn bàn giao: chạy trên Neon staging).
//  • Nhóm [3] chạy script migration thật với driver `pg` GIẢ để kiểm thứ tự BEGIN/ensure/ROLLBACK/COMMIT — không chứng minh DDL thật hoàn tác được
//    (đó là hành vi của PostgreSQL; cần chạy thử trên staging).
'use strict';
const assert = require('assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0; const pending = [];
const test = (n, f) => pending.push({ n, f });
async function runAll() {
  for (const { n, f } of pending) {
    try { await f(); passed++; console.log('  ✅ ' + n); }
    catch (e) { failed++; console.log('  ❌ ' + n + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n     ') : e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
}
const tick = () => new Promise(r => setImmediate(r));

// ════════════════════════════════════════════════════════════════════════════
// [1] review.js — cờ introduced / introExposurePending
// ════════════════════════════════════════════════════════════════════════════
const POOL = [
  { hz: '认真', py: 'rènzhēn', vi: 'nghiêm túc', l: 5, hanviet: 'nhận chân' }, { hz: '准备', py: 'zhǔnbèi', vi: 'chuẩn bị', l: 5 },
  { hz: '参加', py: 'cānjiā', vi: 'tham gia', l: 5 }, { hz: '发现', py: 'fāxiàn', vi: 'phát hiện', l: 5 },
  { hz: '学习', py: 'xuéxí', vi: 'học tập', l: 1 }, { hz: '休息', py: 'xiūxi', vi: 'nghỉ ngơi', l: 1 },
  { hz: '苹果', py: 'píngguǒ', vi: 'quả táo', l: 2 }, { hz: '桌子', py: 'zhuōzi', vi: 'cái bàn', l: 2 }, { hz: '天气', py: 'tiānqì', vi: 'thời tiết', l: 2 },
];
// Môi trường giả cho review.js. fsrsCalls = mọi lần review.js gọi submitFsrsReviewAwaited (chính là payload sẽ vào outbox);
// persisted = bản chụp JSON của hàng đợi ở MỖI lần sqPersist (đúng thứ localStorage sẽ giữ).
function makeEnv(over) {
  const fsrsCalls = [], practiceCalls = [], persisted = [];
  const state = { nextCorrect: false };
  const doc = { createElement: () => ({ style: {}, appendChild() {}, set textContent(v) {} }), head: { appendChild() {} }, getElementById: () => null, querySelectorAll: () => [] };
  const ctx = Object.assign({
    console, Math, Date, JSON, Set, Map, Array, Object, String, Number, Promise, Error,
    // 450ms (khoảng nghỉ tối thiểu sau commit) chạy ngay; các hẹn giờ dài (tự sang câu sau 2s, đếm ngược) KHÔNG chạy — test tự điều khiển hàng đợi.
    setTimeout: (f, ms) => { if (ms <= 500) Promise.resolve().then(f); return 0; }, clearInterval() {}, setInterval: () => 0,
    document: doc, performance: { now: () => 0 }, WORDS: POOL, GUEST_MAX_LESSON: 99, isLoggedIn: () => true, isGuest: false, authToken: 't', authHeaders: () => ({}),
    SENTENCES: [], CONFUSE_GROUPS: [], showPinyin: true, showMeaning: true, isAdminRole: () => false, currentTab: 'review',
    escapeHtml: s => String(s == null ? '' : s), escapeJsAttr: s => String(s), renderHanziParts: () => '', wnBlockHtml: () => '', lessonsLabel: () => 'Bài 5',
    skillAudioAvailable: () => true, vtMarkStart() {}, vtHiddenMs: () => 0, render() {}, speak() {}, playDing() {}, playBuzz() {},
    sqCreate: () => ({ items: [], doneHz: new Set(), totalPlanned: 0, answeredCount: 0, sessionId: 'sess1234', startTime: null, endTime: null, completedCards: [], lessonFilter: null, dayKey: null }),
    sqSnapshotLessonFilter: () => ({}), sqReadPersisted: () => null,
    sqPersist(mode, sq, extra) { persisted.push({ mode, items: JSON.parse(JSON.stringify(sq.items)), extra: JSON.parse(JSON.stringify(extra || {})) }); },
    sqClearPersisted() {}, ssArchiveSession() {}, refreshServerMeta() {},
    sessionKnownHz: new Set(), saveSessionKnownHz() {}, sqPurgeHzFromAllQueues() {}, sqLessonFilterMatches: () => true, REPEAT_GAP: 3,
    genIdempotencyKey: () => 'k', todayKey: () => '2026-10-14', goTab() {},
    submitFsrsReviewAwaited: async (args) => { fsrsCalls.push(JSON.parse(JSON.stringify(args))); return { ok: true, answerCorrect: state.nextCorrect, card: {} }; },
    submitSkillPractice: async (args) => { practiceCalls.push(JSON.parse(JSON.stringify(args))); return { ok: true }; },
    SUBMIT_REVIEW_MAX_WAIT_MS: 1000, alert() {},
  }, over || {});
  vm.createContext(ctx);
  vm.runInContext(read('js/skill-score.js'), ctx);
  vm.runInContext(read('js/question-engine.js'), ctx);
  vm.runInContext(read('js/question-selector.js'), ctx);
  vm.runInContext(read('js/review.js'), ctx);
  // đếm số lần review.js cập nhật hồ sơ kỹ năng cục bộ (QS.learn) — phản ánh "lượt này được xử lý như lượt thường"
  vm.runInContext('var __learnCalls = 0; { const o = QS.learn; QS.learn = function () { __learnCalls++; return o.apply(QS, arguments); }; }', ctx);
  return { ctx, fsrsCalls, practiceCalls, persisted, state };
}
const R = (ctx, code) => vm.runInContext(code, ctx);

// Trả lời thẻ FSRS chính thức ở đầu hàng đợi: ghi nhận cục bộ (như rvPick) rồi chốt rating (như người học bấm nút) → rvCommitRating tự gọi rvAdvanceQueue.
async function answerOfficial(env, correct) {
  env.state.nextCorrect = correct;
  R(env.ctx, `(() => { const it = rvQueue.items[0]; rvRecordAnswer(it, rvQuestion, ${correct}, 1000, true);
    rvLastAnswer = { correct: ${correct}, card: null, autoRating: null }; rvPhase = 'answered';
    rvPendingReview = { selectedAnswer: 'x', responseTimeMs: 1000, answerChanges: 0 };
    rvRatingPhase = 'pending'; rvSystemRating = 'good'; })()`);
  await R(env.ctx, `rvCommitRating(rvAttemptId, '${correct ? 'good' : 'again'}')`);
  await tick();
}
const head = (ctx) => JSON.parse(R(ctx, 'JSON.stringify(rvQueue.items[0] || null)'));

// Đưa 1 từ mới qua: màn giới thiệu → câu kiểm tra (trả lời xong) → thẻ FSRS chính thức đứng ở đầu hàng đợi.
function introduceAndCheck(env, hz) {
  const { ctx } = env;
  R(ctx, `rvQueue.items = [{ type: 'new', word: WORDS.find(w => w.hz === '${hz}') }]; rvQueue.totalPlanned = 1; rvStage = 'run'; rvStartInfo = null; rvLog = []; rvPrepareCurrentCard();`);
  assert.strictEqual(R(ctx, 'rvPhase'), 'intro', 'bước 1: phải hiện màn giới thiệu');
  R(ctx, 'rvIntroDone()'); // bước 2: người học bấm "Đã xem — kiểm tra ngay"
  assert.strictEqual(head(ctx).type, 'check');
  R(ctx, `rvPickPractice({ _correct: true, dataset: { v: 'a' } })`); // trả lời câu kiểm tra (luyện bổ sung)
  R(ctx, 'rvAdvanceQueue()');
}

console.log('\n[1] Cờ introduced / introExposurePending (js/review.js)');

test('KỊCH BẢN 5 BƯỚC: giới thiệu → kiểm tra → FSRS đầu sai → thẻ quay lại → lượt sau; CHỈ lượt FSRS đầu mang exposure:intro', async () => {
  const env = makeEnv(); const { ctx } = env;
  introduceAndCheck(env, '认真');
  // sau câu kiểm tra: thẻ chính thức xuất hiện, KHÔNG hiện lại màn giới thiệu
  let it = head(ctx);
  assert.strictEqual(it.type, 'new'); assert.strictEqual(it.introduced, true); assert.strictEqual(it.introExposurePending, true);
  assert.strictEqual(R(ctx, 'rvPhase'), 'question', 'từ đã giới thiệu không được hiện lại màn giới thiệu');
  assert.strictEqual(env.practiceCalls.length, 1); assert.strictEqual(env.practiceCalls[0].source, 'check');
  assert.strictEqual(R(ctx, '__learnCalls'), 0, 'câu check KHÔNG cập nhật hồ sơ kỹ năng cục bộ');

  // bước 3: FSRS chính thức lần đầu, TRẢ LỜI SAI
  await answerOfficial(env, false);
  assert.strictEqual(env.fsrsCalls.length, 1);
  assert.strictEqual(env.fsrsCalls[0].exposure, 'intro', 'lượt FSRS đầu sau giới thiệu phải mang exposure:intro');
  assert.strictEqual(R(ctx, '__learnCalls'), 0, 'lượt đầu sau giới thiệu không cập nhật hồ sơ cục bộ');

  // bước 4: thẻ quay lại hàng đợi — vẫn "đã giới thiệu" nhưng KHÔNG còn là lượt đầu
  it = head(ctx);
  assert.ok(it && it.type === 'new' && it.word.hz === '认真', 'thẻ sai phải quay lại hàng đợi');
  assert.strictEqual(it.introduced, true, 'vẫn đã giới thiệu → không hiện lại màn giới thiệu');
  assert.strictEqual(it.introExposurePending, false, 'lượt đầu đã dùng — không được mang cờ nữa');
  assert.strictEqual(R(ctx, 'rvPhase'), 'question');

  // bước 5a: lần kế SAI nữa
  await answerOfficial(env, false);
  assert.strictEqual(env.fsrsCalls.length, 2);
  assert.strictEqual(env.fsrsCalls[1].exposure, undefined, 'lượt thứ hai (sai) phải xử lý bình thường');
  assert.strictEqual(R(ctx, '__learnCalls'), 1, 'lượt thứ hai cập nhật hồ sơ kỹ năng cục bộ như thường');
  assert.strictEqual(head(ctx).introExposurePending, false);

  // bước 5b: lần kế ĐÚNG
  await answerOfficial(env, true);
  assert.strictEqual(env.fsrsCalls.length, 3);
  assert.strictEqual(env.fsrsCalls[2].exposure, undefined, 'lượt thứ ba (đúng) phải xử lý bình thường');
  assert.strictEqual(R(ctx, '__learnCalls'), 2);
  assert.strictEqual(R(ctx, 'rvQueue.items.length'), 0, 'trả lời đúng → thẻ rời hàng đợi');
  assert.deepStrictEqual(env.fsrsCalls.map(c => c.exposure === 'intro'), [true, false, false], 'đúng MỘT lượt mang exposure:intro');
});

test('không đánh dấu mọi lượt của từ mới: từ mới trả lời ĐÚNG ngay lượt đầu cũng chỉ có 1 lượt exposure:intro', async () => {
  const env = makeEnv(); introduceAndCheck(env, '准备');
  await answerOfficial(env, true);
  assert.deepStrictEqual(env.fsrsCalls.map(c => c.exposure), ['intro']);
  assert.strictEqual(R(env.ctx, 'rvQueue.items.length'), 0);
});

test('thẻ ôn thường (review) và từ chưa giới thiệu không bao giờ mang exposure:intro', async () => {
  const env = makeEnv(); const { ctx } = env;
  R(ctx, `rvQueue.items = [{ type: 'review', word: WORDS[1] }]; rvQueue.totalPlanned = 1; rvStage = 'run'; rvStartInfo = null; rvLog = []; rvPrepareCurrentCard();`);
  await answerOfficial(env, false); await answerOfficial(env, true);
  assert.deepStrictEqual(env.fsrsCalls.map(c => c.exposure), [undefined, undefined]);
  assert.strictEqual(R(ctx, '__learnCalls'), 2);
});

test('tải lại trang giữa chừng: hàng đợi đã lưu SAU lượt đầu có cờ tắt → lượt kế sau khi khôi phục không mang exposure:intro', async () => {
  const env = makeEnv(); introduceAndCheck(env, '参加');
  // trước khi gửi: hàng đợi đang lưu (nếu tải lại lúc này, lượt đầu vẫn chưa gửi → vẫn là lượt đầu)
  const lastBefore = env.persisted[env.persisted.length - 1];
  const stillPending = lastBefore.items.find(i => i.type === 'new');
  assert.ok(!stillPending || stillPending.introExposurePending === true, 'trước khi gửi: cờ phải còn');
  await answerOfficial(env, false);
  const saved = env.persisted[env.persisted.length - 1];
  const card = saved.items.find(i => i.type === 'new' && i.word.hz === '参加');
  assert.ok(card, 'thẻ quay lại phải nằm trong hàng đợi đã lưu');
  assert.strictEqual(card.introduced, true); assert.strictEqual(card.introExposurePending, false);

  // "tải lại trang": môi trường MỚI, đọc đúng bản đã lưu
  const snap = { sessionId: 's1234567', items: saved.items, doneHz: [], totalPlanned: 1, answeredCount: 0, startTime: 1, completedCards: [], lessonFilter: {}, dayKey: '2026-10-14', savedAt: Date.now(), extra: saved.extra };
  const env2 = makeEnv({ sqReadPersisted: () => snap });
  await R(env2.ctx, 'startStudySession(false, false)');
  assert.strictEqual(R(env2.ctx, 'rvPhase'), 'question', 'không hiện lại màn giới thiệu sau khi tải lại');
  await answerOfficial(env2, true);
  assert.deepStrictEqual(env2.fsrsCalls.map(c => c.exposure), [undefined]);
});

test('tải lại trang NGAY SAU câu kiểm tra (chưa gửi lượt FSRS): thẻ chính thức vẫn là lượt đầu → vẫn mang exposure:intro', async () => {
  const env = makeEnv(); introduceAndCheck(env, '发现');
  const saved = env.persisted[env.persisted.length - 1];
  const snap = { sessionId: 's1234567', items: saved.items, doneHz: [], totalPlanned: 1, answeredCount: 0, startTime: 1, completedCards: [], lessonFilter: {}, dayKey: '2026-10-14', savedAt: Date.now(), extra: saved.extra };
  const env2 = makeEnv({ sqReadPersisted: () => snap });
  await R(env2.ctx, 'startStudySession(false, false)');
  await answerOfficial(env2, false);
  assert.strictEqual(env2.fsrsCalls[0].exposure, 'intro');
});

test('tương thích V113: hàng đợi cũ chỉ có `introduced` — chưa có lượt chính thức trong nhật ký → vẫn là lượt đầu; đã có → không phải lượt đầu', () => {
  const { ctx } = makeEnv();
  const w = (hz) => POOL.find(x => x.hz === hz);
  const items = [{ type: 'new', word: w('认真'), introduced: true }, { type: 'new', word: w('准备'), introduced: true },
    { type: 'new', word: w('参加'), introduced: true, introExposurePending: false }, { type: 'review', word: w('发现') }];
  const log = [{ hz: '准备', official: true, source: 'new' }, { hz: '认真', official: false, source: 'check' }];
  const out = vm.runInContext('(function(items, log){ return rvNormalizeIntroFlags(items, log); })', ctx)(items, log);
  assert.strictEqual(out[0].introExposurePending, true, 'chỉ có câu check (official:false) → vẫn chờ lượt đầu');
  assert.strictEqual(out[1].introExposurePending, false, 'đã có lượt chính thức trong nhật ký → đây là lần quay lại');
  assert.strictEqual(out[2].introExposurePending, false, 'giá trị đã có thì giữ nguyên');
  assert.strictEqual(out[3].introExposurePending, undefined, 'thẻ review không bị đụng');
});

test('check/redo vẫn không cập nhật hồ sơ kỹ năng cục bộ và vẫn là luyện bổ sung (không gửi FSRS)', () => {
  const env = makeEnv(); const { ctx } = env;
  R(ctx, `rvQueue.items = [{ type: 'redo', word: WORDS[0], targetSkill: 'recall' }]; rvQueue.totalPlanned = 0; rvStage = 'run'; rvStartInfo = null; rvLog = []; rvPrepareCurrentCard();`);
  R(ctx, `rvPickPractice({ _correct: true, dataset: { v: 'a' } })`);
  assert.strictEqual(R(ctx, '__learnCalls'), 0); assert.strictEqual(env.fsrsCalls.length, 0);
  assert.strictEqual(env.practiceCalls[0].source, 'redo');
});

test('outbox + idempotency: payload (kèm exposure) được ghi trước khi gửi, gửi lại dùng ĐÚNG payload/khoá cũ; lượt sau có khoá mới và không có exposure', async () => {
  const store = {}; let n = 0, online = false; const sent = [];
  const ctx = {
    console, Math, Date, JSON, Set, Map, Array, Object, String, Number, Promise, Error, setInterval: () => 0, setTimeout,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    window: { addEventListener() {}, crypto: { randomUUID: () => 'uuid-' + (++n) } }, crypto: { randomUUID: () => 'uuid-' + (++n) },
    document: { addEventListener() {}, visibilityState: 'visible' }, navigator: {},
    authUsername: 'u', isLoggedIn: () => true, authHeaders: () => ({}), bumpStudySessionCounters() {},
    fetch: async (url, opt) => { if (!online) throw new Error('offline'); sent.push(JSON.parse(opt.body)); return { status: 200, json: async () => ({ ok: true, answerCorrect: true }) }; },
  };
  vm.createContext(ctx); vm.runInContext(read('js/study-queue.js'), ctx);
  const w = { hz: '认真', l: 5 };
  const r1 = await vm.runInContext('submitFsrsReview', ctx)({ word: w, quizType: 'hz2vi', selectedAnswer: 'x', responseTimeMs: 900, rating: 'again', exerciseType: 'quiz-hz2vi', sessionId: 'sess1234', exposure: 'intro' });
  assert.strictEqual(r1.queued, true, 'mất mạng → vào outbox');
  const box = JSON.parse(store['reviewOutbox_u']); assert.strictEqual(box.length, 1);
  assert.strictEqual(box[0].payload.exposure, 'intro'); const key1 = box[0].payload.idempotencyKey;
  online = true;
  await vm.runInContext('flushReviewOutbox', ctx)();
  assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].idempotencyKey, key1, 'gửi lại phải cùng idempotencyKey');
  assert.strictEqual(sent[0].exposure, 'intro', 'gửi lại giữ nguyên exposure của lượt đó');
  assert.strictEqual(JSON.parse(store['reviewOutbox_u']).length, 0, 'gửi xong → gỡ khỏi outbox');
  // lượt kế (không exposure) có khoá mới và không mang exposure
  await vm.runInContext('submitFsrsReview', ctx)({ word: w, quizType: 'hz2vi', selectedAnswer: 'x', responseTimeMs: 900, rating: 'good', exerciseType: 'quiz-hz2vi', sessionId: 'sess1234' });
  assert.notStrictEqual(sent[1].idempotencyKey, key1); assert.strictEqual('exposure' in sent[1], false);
});

test('mã nguồn: gửi exposure theo introExposurePending, không còn theo `introduced`; tắt cờ SAU khi gọi submit (outbox write-ahead đã xong)', () => {
  const rv = read('js/review.js');
  assert.ok(rv.includes("exposure: rvIsIntroExposure(item) ? 'intro' : undefined"));
  assert.ok(!/exposure:\s*item\.introduced/.test(rv), 'không còn gắn exposure theo introduced');
  assert.ok(!/item\.type === 'redo' \|\| item\.introduced\)/.test(rv));
  const i = rv.indexOf('const reviewPromise = submitFsrsReviewAwaited'), j = rv.indexOf('item.introExposurePending = false;');
  assert.ok(i > 0 && j > i, 'tắt cờ phải nằm SAU lệnh gọi submit');
});

// ════════════════════════════════════════════════════════════════════════════
// [2] getTodayProgress — lượt đo kỹ năng hợp lệ
// ════════════════════════════════════════════════════════════════════════════
console.log('\n[2] getTodayProgress (lib/skill-store.js)');

// Mô hình THAM CHIẾU bằng JS của quy tắc (KHÔNG phải SQL). `now` cố định để kiểm ranh giới ngày Asia/Ho_Chi_Minh.
const VN = 7 * 3600e3, dayStartVN = (t) => Math.floor((t + VN) / 86400e3) * 86400e3 - VN;
function referenceProgress(history, practice, now, shown = ['check', 'redo']) {
  const t0 = dayStartVN(now);
  const h = history.filter(r => r.at >= t0), p = practice.filter(r => r.at >= t0);
  const valid = [
    ...h.filter(r => r.skill != null && r.word_id != null && r.exposure !== 'intro').map(r => r.ok),
    ...p.filter(r => r.skill != null && !shown.includes(r.source == null ? 'practice' : r.source)).map(r => r.ok),
  ];
  return { official: h.length, practice: p.length, measured: valid.length, measuredCorrect: valid.filter(Boolean).length };
}
const NOW = Date.UTC(2026, 9, 17, 5, 0); // 12:00 giờ VN ngày 17/10/2026
const todayAt = NOW - 3600e3;
const H = (o) => Object.assign({ at: todayAt, skill: 'recognition', word_id: 1, exposure: null, ok: true }, o);
const P = (o) => Object.assign({ at: todayAt, skill: 'recall', source: 'extra', ok: true }, o);

test('mô hình tham chiếu — 6 tình huống yêu cầu (đúng, sai, skill NULL, intro, check/redo, ngày không có lượt hợp lệ)', () => {
  // lượt hợp lệ đúng + lượt hợp lệ sai
  assert.deepStrictEqual(referenceProgress([H({ ok: true }), H({ ok: false })], [], NOW), { official: 2, practice: 0, measured: 2, measuredCorrect: 1 });
  // skill NULL: tính vào official nhưng KHÔNG vào measured/measured_correct
  assert.deepStrictEqual(referenceProgress([H({ skill: null, ok: true }), H({ ok: true })], [], NOW), { official: 2, practice: 0, measured: 1, measuredCorrect: 1 });
  // exposure = intro: tương tự
  assert.deepStrictEqual(referenceProgress([H({ exposure: 'intro', ok: true }), H({ ok: false })], [], NOW), { official: 2, practice: 0, measured: 1, measuredCorrect: 0 });
  // luyện bổ sung check/redo không đo; extra/match/practice/NULL source có đo
  const pr = [P({ source: 'check' }), P({ source: 'redo', ok: false }), P({ source: 'extra', ok: true }), P({ source: 'match', ok: false }), P({ source: null, ok: true })];
  assert.deepStrictEqual(referenceProgress([], pr, NOW), { official: 0, practice: 5, measured: 3, measuredCorrect: 2 });
  // không có lượt hợp lệ trong ngày → 0/0 (UI phải xử lý mẫu số 0)
  assert.deepStrictEqual(referenceProgress([H({ skill: null }), H({ exposure: 'intro' })], [P({ source: 'check' })], NOW), { official: 2, practice: 1, measured: 0, measuredCorrect: 0 });
});
test('mô hình tham chiếu — ranh giới ngày Asia/Ho_Chi_Minh: 23:59 hôm qua (VN) không tính, 00:01 hôm nay (VN) có tính; tử ≤ mẫu', () => {
  const t0 = dayStartVN(NOW); // 00:00 VN 17/10 = 17:00 UTC 16/10
  assert.strictEqual(new Date(t0).toISOString(), '2026-10-16T17:00:00.000Z');
  const r = referenceProgress([H({ at: t0 - 60e3, ok: true }), H({ at: t0 + 60e3, ok: true }), H({ at: t0 + 120e3, ok: false })], [], NOW);
  assert.deepStrictEqual(r, { official: 2, practice: 0, measured: 2, measuredCorrect: 1 });
  assert.ok(r.measuredCorrect <= r.measured);
});

// Gọi HÀM THẬT getTodayProgress với pool/client giả để bắt đúng câu SQL + tham số nó gửi đi.
async function captureTodayQuery() {
  const queries = [];
  const client = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [{ official: 7, practice: 4, measured: 5, measured_correct: 3, seconds: 90 }] }; }, release() {} };
  const dbPath = require.resolve('../lib/db'), ssPath = require.resolve('../lib/skill-store');
  const saveDb = require.cache[dbPath], saveSs = require.cache[ssPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getPool: () => ({ connect: async () => client }), ensureVocabTable: async () => {}, ensureFsrsTables: async () => {} } };
  delete require.cache[ssPath];
  try {
    const ss = require('../lib/skill-store');
    const out = await ss.getTodayProgress('user-1');
    const main = queries.filter(q => /AS measured_correct/.test(q.sql));
    return { out, main, all: queries };
  } finally {
    delete require.cache[ssPath]; if (saveSs) require.cache[ssPath] = saveSs;
    if (saveDb) require.cache[dbPath] = saveDb; else delete require.cache[dbPath];
  }
}
test('SQL thật: measured và measured_correct cùng đọc từ MỘT tập `valid`; tập này có skill IS NOT NULL + word_id IS NOT NULL + loại exposure intro + loại check/redo', async () => {
  const { out, main } = await captureTodayQuery();
  assert.strictEqual(main.length, 1, 'đúng 1 câu truy vấn tiến độ');
  const sql = main[0].sql.replace(/\s+/g, ' ');
  assert.ok(/valid AS \(/.test(sql));
  assert.ok(/SELECT COUNT\(\*\)::int FROM valid\) AS measured,/.test(sql) && /SELECT COUNT\(\*\)::int FROM valid WHERE ok\) AS measured_correct/.test(sql), 'tử và mẫu cùng lấy từ valid');
  const validBlock = sql.slice(sql.indexOf('valid AS ('), sql.indexOf(') SELECT'));
  const [hist, prac] = validBlock.split('UNION ALL');
  assert.ok(/FROM review_history/.test(hist) && /skill IS NOT NULL/.test(hist) && /word_id IS NOT NULL/.test(hist) && /exposure IS DISTINCT FROM 'intro'/.test(hist));
  assert.ok(/FROM skill_practice_log/.test(prac) && /skill IS NOT NULL/.test(prac) && /COALESCE\(source, 'practice'\) <> ALL\(\$3::text\[\]\)/.test(prac));
  // không còn 2 truy vấn measured/measured_correct tách rời (nguyên nhân lệch điều kiện giữa tử và mẫu)
  assert.strictEqual((sql.match(/AS measured\b/g) || []).length, 1); assert.strictEqual((sql.match(/AS measured_correct/g) || []).length, 1);
  assert.deepStrictEqual(out, { officialAnswers: 7, practiceAnswers: 4, durationSeconds: 90, measuredAnswers: 5, measuredCorrect: 3 }, 'ánh xạ kết quả trả về không đổi');
});
test('SQL thật: official/practice vẫn đếm mọi dòng trong ngày (không lọc kỹ năng/exposure/source); ranh giới ngày & tham số đúng', async () => {
  const { main } = await captureTodayQuery();
  const sql = main[0].sql.replace(/\s+/g, ' ');
  const off = sql.match(/\(SELECT COUNT\(\*\)::int FROM review_history, day_start WHERE ([^)]*)\) AS official/);
  const prc = sql.match(/\(SELECT COUNT\(\*\)::int FROM skill_practice_log, day_start WHERE ([^)]*)\) AS practice/);
  assert.ok(off && prc, 'official/practice còn nguyên');
  assert.ok(!/skill|exposure|source/.test(off[1]) && !/skill|exposure|source/.test(prc[1]), 'official/practice không bị thêm điều kiện lọc');
  assert.ok(sql.includes("date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2"), 'mốc 00:00 theo múi giờ $2');
  assert.deepStrictEqual(main[0].params, ['user-1', 'Asia/Ho_Chi_Minh', ['check', 'redo']]);
  assert.ok(/study_sessions[^)]*\(start_time AT TIME ZONE \$2\)::date = \(now\(\) AT TIME ZONE \$2\)::date/.test(sql), 'thời lượng học giữ nguyên');
});
test('điều kiện hợp lệ khớp phía GHI: db.js chỉ upsert kỹ năng khi skillReady + word_id + khác intro; recordPractice bỏ check/redo', () => {
  const db = read('lib/db.js'), ss = read('lib/skill-store.js');
  assert.ok(/if \(skillReady && effectiveWordId != null && skillRecord\.exposure !== 'intro'\)/.test(db));
  assert.ok(/const shown = SHOWN_ANSWER_SOURCES\.includes\(source\);\s*\n\s*if \(!shown\) await upsertSkillStatTx/.test(ss));
});

// ════════════════════════════════════════════════════════════════════════════
// [3] migrate-skill-evidence.js — DRY_RUN và transaction
// ════════════════════════════════════════════════════════════════════════════
console.log('\n[3] scripts/migrate-skill-evidence.js');

// `pg` không được cài trong môi trường này (không có node_modules) → chèn module giả vào Module._load, không phụ thuộc gói thật.
const Module = require('module');
async function runMigrationScript({ dry, vocabRows = 100, ensureFails = false, sqlFails = false }) {
  const log = []; let ended = false;
  const client = {
    query: async (sql, params) => {
      const s = String(sql).trim(); const first = s.split('\n')[0].slice(0, 70); log.push(first);
      if (/^SELECT to_regclass/.test(s)) return { rows: [{ t: (params[0] === 'vocab_words' && vocabRows === null) ? null : params[0] }] };
      if (/FROM vocab_words$/.test(s)) return { rows: [{ n: vocabRows }] };
      if (/information_schema/.test(s)) return { rows: log.includes('<ensureSkillTables>') ? [{ kind: 'cột', name: 'word_skill_stats.active_days' }] : [] };
      if (sqlFails && /V113/.test(s)) throw new Error('SQL V113 lỗi giả');
      return { rows: [{ n: 0 }] };
    },
    release() { log.push('<release>'); },
  };
  const fakePg = { Pool: function () { this.connect = async () => client; this.end = async () => { ended = true; }; } };
  const fakeSkillStore = { ensureSkillTables: async (c) => { log.push('<ensureSkillTables>'); if (ensureFails) throw new Error('DDL lỗi giả'); } };
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'pg') return fakePg;
    if (request === '../lib/skill-store') return fakeSkillStore;
    return origLoad.apply(this, arguments);
  };
  const out = [], origLog = console.log, origErr = console.error;
  console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => out.push('ERR ' + a.join(' '));
  const saved = { url: process.env.DATABASE_URL, dry: process.env.DRY_RUN, code: process.exitCode };
  process.env.DATABASE_URL = 'postgres://fake'; if (dry) process.env.DRY_RUN = '1'; else delete process.env.DRY_RUN;
  process.exitCode = 0;
  const sp = require.resolve('../scripts/migrate-skill-evidence.js'); delete require.cache[sp];
  try {
    require('../scripts/migrate-skill-evidence.js');
    for (let i = 0; i < 200 && !ended; i++) await tick();
  } finally {
    Module._load = origLoad; console.log = origLog; console.error = origErr; delete require.cache[sp];
    const code = process.exitCode; process.exitCode = saved.code;
    if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url;
    if (saved.dry === undefined) delete process.env.DRY_RUN; else process.env.DRY_RUN = saved.dry;
    return { log, out, code, ended };
  }
}
const idx = (log, re) => log.findIndex(x => typeof x === 'string' && re.test(x));

test('DRY_RUN: BEGIN xảy ra TRƯỚC ensureSkillTables; kết thúc bằng ROLLBACK, không COMMIT; thông báo không hứa "không ghi gì"', async () => {
  const r = await runMigrationScript({ dry: true });
  assert.ok(idx(r.log, /^BEGIN$/) >= 0 && idx(r.log, /^<ensureSkillTables>$/) > idx(r.log, /^BEGIN$/), 'BEGIN phải đứng trước ensureSkillTables');
  assert.ok(idx(r.log, /^ROLLBACK$/) > idx(r.log, /^<ensureSkillTables>$/)); assert.strictEqual(idx(r.log, /^COMMIT$/), -1);
  const text = r.out.join('\n');
  assert.ok(/ROLLBACK/.test(text) && /KHÔNG để lại thay đổi nào/.test(text) && /Sequence/.test(text));
  assert.ok(!/không ghi gì\./i.test(text.replace(/KHÔNG để lại thay đổi nào/g, '')), 'không còn câu "không ghi gì" tuyệt đối');
  assert.strictEqual(r.code, 0); assert.ok(r.ended);
});
test('chạy thật: ensureSkillTables + SQL V113 cùng nằm giữa BEGIN và COMMIT (một transaction duy nhất)', async () => {
  const r = await runMigrationScript({ dry: false });
  const b = idx(r.log, /^BEGIN$/), e = idx(r.log, /^<ensureSkillTables>$/), c = idx(r.log, /^COMMIT$/);
  assert.ok(b >= 0 && e > b && c > e, JSON.stringify(r.log)); assert.strictEqual(idx(r.log, /^ROLLBACK$/), -1);
  assert.strictEqual(r.log.filter(x => x === 'BEGIN').length, 1, 'chỉ 1 transaction');
  assert.strictEqual(r.code, 0);
});
test('ensureSkillTables lỗi giữa chừng → ROLLBACK toàn bộ, không COMMIT, mã thoát 1', async () => {
  const r = await runMigrationScript({ dry: false, ensureFails: true });
  assert.ok(idx(r.log, /^ROLLBACK$/) > idx(r.log, /^<ensureSkillTables>$/)); assert.strictEqual(idx(r.log, /^COMMIT$/), -1);
  assert.strictEqual(r.code, 1); assert.ok(r.out.some(x => /đã ROLLBACK toàn bộ/.test(x)));
});
test('SQL V113 lỗi → ROLLBACK (cả phần ensure trước đó cũng được hoàn tác vì cùng transaction), không COMMIT', async () => {
  const r = await runMigrationScript({ dry: false, sqlFails: true });
  assert.ok(idx(r.log, /^ROLLBACK$/) > idx(r.log, /^<ensureSkillTables>$/)); assert.strictEqual(idx(r.log, /^COMMIT$/), -1); assert.strictEqual(r.code, 1);
});
test('vocab_words trống/chưa có → từ chối TRƯỚC khi gọi ensureSkillTables (không đổi gì), ROLLBACK, mã thoát 1', async () => {
  for (const rows of [0, null]) {
    const r = await runMigrationScript({ dry: true, vocabRows: rows });
    assert.strictEqual(idx(r.log, /^<ensureSkillTables>$/), -1, 'chưa được gọi ensure');
    assert.ok(idx(r.log, /^ROLLBACK$/) >= 0); assert.strictEqual(idx(r.log, /^COMMIT$/), -1); assert.strictEqual(r.code, 1);
  }
});
test('mã nguồn script: không còn ensureSkillTables trước BEGIN; có lock_timeout; không DROP/DELETE/TRUNCATE trên dữ liệu lịch sử', () => {
  const src = read('scripts/migrate-skill-evidence.js');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(code.indexOf("'BEGIN'") >= 0 && code.indexOf('ensureSkillTables') > code.indexOf("'BEGIN'"));
  assert.ok(/SET LOCAL lock_timeout/.test(code));
  assert.ok(!/DELETE\s+FROM|TRUNCATE|DROP\s+TABLE/i.test(code));
});

runAll();
