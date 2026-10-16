#!/usr/bin/env node
// test/review-render.smoke.test.js — nạp NGUYÊN js/review.js vào vm (DOM/mạng giả) và vẽ mọi màn của "Hôm nay học":
// bắt lỗi tham chiếu (ReferenceError), và kiểm HTML không lộ đáp án trước khi trả lời. KHÔNG thay cho thử trên trình duyệt thật.
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
  { hz: '认真', py: 'rènzhēn', vi: 'nghiêm túc', l: 5, hanviet: 'nhận chân' }, { hz: '准备', py: 'zhǔnbèi', vi: 'chuẩn bị', l: 5 },
  { hz: '参加', py: 'cānjiā', vi: 'tham gia', l: 5 }, { hz: '发现', py: 'fāxiàn', vi: 'phát hiện', l: 5 },
  { hz: '学习', py: 'xuéxí', vi: 'học tập', l: 1 }, { hz: '休息', py: 'xiūxi', vi: 'nghỉ ngơi', l: 1 },
  { hz: '苹果', py: 'píngguǒ', vi: 'quả táo', l: 2 }, { hz: '桌子', py: 'zhuōzi', vi: 'cái bàn', l: 2 }, { hz: '天气', py: 'tiānqì', vi: 'thời tiết', l: 2 },
];
function makeEnv(over) {
  const doc = { createElement: () => ({ style: {}, appendChild() {}, set textContent(v) {} }), head: { appendChild() {} }, getElementById: () => null, querySelectorAll: () => [] };
  const ctx = Object.assign({
    console, Math, Date, JSON, Set, Map, Array, Object, String, Number, Promise, Error, setTimeout: () => 0, clearInterval() {}, setInterval: () => 0,
    document: doc, performance: { now: () => 0 }, WORDS: POOL, GUEST_MAX_LESSON: 99, isLoggedIn: () => true, isGuest: false, authToken: 't', authHeaders: () => ({}),
    SENTENCES: [], CONFUSE_GROUPS: [], showPinyin: true, showMeaning: true, isAdminRole: () => false, currentTab: 'review',
    escapeHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    escapeJsAttr: s => String(s).replace(/'/g, "\\'"), renderHanziParts: () => '', wnBlockHtml: () => '', lessonsLabel: () => 'Bài 5',
    skillAudioAvailable: () => true, vtMarkStart() {}, vtHiddenMs: () => 0, render() {}, speak() {}, playDing() {}, playBuzz() {},
    sqCreate: () => ({ items: [], doneHz: new Set(), totalPlanned: 0, answeredCount: 0, sessionId: null, startTime: null, endTime: null, completedCards: [], lessonFilter: null, dayKey: null }),
    sqSnapshotLessonFilter: () => ({}), sqReadPersisted: () => null, sqPersist() {}, sqClearPersisted() {}, ssArchiveSession() {}, refreshServerMeta() {},
    sessionKnownHz: new Set(), saveSessionKnownHz() {}, sqPurgeHzFromAllQueues() {}, sqLessonFilterMatches: () => true, REPEAT_GAP: 3,
    genIdempotencyKey: () => 'k', todayKey: () => '2026-10-14', goTab() {}, submitFsrsReviewAwaited: async () => ({ ok: true }), submitSkillPractice: async () => ({ ok: true }),
    SUBMIT_REVIEW_MAX_WAIT_MS: 1000, alert() {},
  }, over || {});
  vm.createContext(ctx);
  vm.runInContext(read('js/skill-score.js'), ctx);
  vm.runInContext(read('js/question-engine.js'), ctx);
  vm.runInContext(read('js/question-selector.js'), ctx);
  vm.runInContext(read('js/review.js'), ctx);   // nạp NGUYÊN file: lỗi cú pháp/khai báo trùng/tham chiếu mức file sẽ nổ ở đây
  return ctx;
}
const R = (ctx, code) => vm.runInContext(code, ctx);
const item = (type, hz) => ({ type, word: POOL.find(w => w.hz === hz) });
function show(ctx, items, setup) {
  R(ctx, `rvQueue.items = ${JSON.stringify(items)}; rvQueue.totalPlanned = ${items.length}; rvStage = 'run'; rvStartInfo = null; rvLog = [];`);
  if (setup) R(ctx, setup);
  R(ctx, 'rvPrepareCurrentCard()');
  return R(ctx, 'renderReview()');
}

test('Nạp nguyên review.js không lỗi; màn "Chưa có gì để học" khi rỗng', () => {
  const ctx = makeEnv();
  assert.ok(R(ctx, 'renderReview()').includes('Chưa có gì để học'));
});
test('Màn bắt đầu: hiện số liệu thật và nút Bắt đầu học; ẩn "Từ cần luyện thêm" khi = 0', () => {
  const ctx = makeEnv();
  R(ctx, `rvQueue.items = [{type:'new', word: WORDS[0]}, {type:'review', word: WORDS[1]}]; rvStage='start'; rvStartInfo = rvBuildStartInfo(rvQueue.items, 0);`);
  const h = R(ctx, 'renderReview()');
  assert.ok(h.includes('Bắt đầu học') && h.includes('Từ mới') && h.includes('Thẻ đến hạn ôn'));
  assert.ok(!h.includes('Từ cần luyện thêm') && !h.includes('Chỉ luyện từ hay sai'));
  R(ctx, `rvStartInfo = rvBuildStartInfo(rvQueue.items, 2);`);
  const h2 = R(ctx, 'renderReview()');
  assert.ok(h2.includes('Từ cần luyện thêm') && h2.includes('Chỉ luyện từ hay sai'));
});
test('Màn giới thiệu từ mới: có chữ, pinyin, nghĩa, nút nghe và "Đã xem — kiểm tra ngay"', () => {
  const ctx = makeEnv(); const h = show(ctx, [item('new', '认真')]);
  assert.ok(h.includes('认真') && h.includes('rènzhēn') && h.includes('nghiêm túc') && h.includes('Hán Việt') && h.includes('🔊') && h.includes('Đã xem — kiểm tra ngay'));
});
test('Màn giới thiệu: không có giọng đọc → KHÔNG có nút nghe giả', () => {
  const ctx = makeEnv({ skillAudioAvailable: () => false }); const h = show(ctx, [item('new', '认真')]);
  assert.ok(!h.includes('🔊'));
});
const typesToCheck = ['hz2vi', 'vi2hz', 'listen2hz', 'listen2vi', 'hz2py'];
for (const t of typesToCheck) {
  test('Câu hỏi ' + t + ': có 3-4 nút, không lộ đáp án trong phần đề', () => {
    const ctx = makeEnv();
    const h = show(ctx, [item('extra', '认真')], `rvQueue.items[0].targetSkill = ${JSON.stringify(vm.runInContext('QE', ctx).TYPES[t].skill)};`);
    // ép đúng dạng cần kiểm bằng cách dựng trực tiếp
    R(ctx, `rvQuestion = QE.build('${t}', rvQueue.items[0].word, rvQCtx()); rvPhase = 'question';`);
    const html = R(ctx, 'renderReview()');
    const nBtn = (html.match(/class="quiz-opt"/g) || []).length; assert.ok(nBtn >= 3 && nBtn <= 4, 'số nút: ' + nBtn);
    // chỉ xét phần người học NHÌN THẤY (văn bản), không xét thuộc tính onclick dùng để phát âm thanh
    const stemHtml = html.split('id="rv-opts"')[0];
    const stem = stemHtml.replace(/<[^>]*>/g, ' ') + (stemHtml.includes('🔊') ? ' 🔊' : '');
    if (t === 'listen2hz' || t === 'listen2vi') { assert.ok(stem.includes('🔊')); assert.ok(!stem.includes('认真') && !stem.includes('rènzhēn')); }
    if (t === 'vi2hz') { assert.ok(!stem.includes('认真') && !stem.includes('rènzhēn')); assert.ok(stem.includes('nghiêm túc')); }
    if (t === 'hz2py') { assert.ok(stem.includes('认真')); assert.ok(!stem.includes('rènzhēn'), 'hz2py không được hiện pinyin ở đề dù đang bật Hiện Pinyin'); }
    if (t === 'hz2vi') { assert.ok(!stem.includes('nghiêm túc')); }
  });
}
test('Cloze: đề có chỗ trống + bản dịch, không lộ từ; đáp án chỉ ở các nút', () => {
  const ctx = makeEnv({ SENTENCES: [] });
  R(ctx, `rvExamplePool = [{hz:'学习', zh:'我每天学习汉语。', vi:'Mỗi ngày tôi học tiếng Hán.'}];`);
  show(ctx, [item('review', '学习')]);
  R(ctx, `rvQuestion = QE.build('cloze', rvQueue.items[0].word, rvQCtx()); rvPhase = 'question';`);
  const html = R(ctx, 'renderReview()'); const stem = html.split('id="rv-opts"')[0];
  assert.ok(stem.includes('＿＿＿') && stem.includes('Mỗi ngày tôi học tiếng Hán.') && !stem.includes('学习'));
});
test('Đáp án FSRS chính thức: có thanh rating; đáp án luyện bổ sung: có nút Tiếp tục và KHÔNG có thanh rating', () => {
  const ctx = makeEnv();
  show(ctx, [item('review', '认真')]);
  R(ctx, `rvPhase = 'answered'; rvLastAnswer = {correct:true}; rvRatingPhase = null;`);
  assert.ok(!R(ctx, 'renderReview()').includes('rvPracticeContinue'));
  show(ctx, [item('extra', '认真')]);
  R(ctx, `rvPhase = 'answered'; rvLastAnswer = {correct:false};`);
  const h = R(ctx, 'renderReview()');
  assert.ok(h.includes('rvPracticeContinue') && !h.includes('rv-rating') && h.includes('không tính vào lịch ôn'));
});
test('Ghép cặp: vẽ 2 cột, nút chạm lớn, hướng dẫn tiếng Việt', () => {
  const ctx = makeEnv();
  const h = show(ctx, [{ type: 'match', hzs: ['认真', '准备', '参加', '发现'] }]);
  assert.ok(h.includes('Ghép chữ Hán với') && (h.match(/rv-match-btn/g) || []).length >= 6 && h.includes('Chạm 1 chữ Hán'));
});
test('Tổng kết vẽ được khi hàng đợi cạn và có nhật ký', () => {
  const ctx = makeEnv();
  R(ctx, `rvQueue.items = []; rvLog = [{hz:'认真',l:5,typeId:'hz2vi',skill:'recognition',correct:false,official:true,source:'review'}];`);
  const h = R(ctx, 'renderReview()');
  assert.ok(h.includes('Tổng kết buổi học') && h.includes('Luyện lại câu sai') && h.includes('认真'));
});
test('Tổng kết không bị nhầm thành "Chưa có gì để học" khi buổi chỉ gồm luyện bổ sung (summary 0/0 nhưng có nhật ký)', () => {
  const ctx = makeEnv();
  R(ctx, `rvQueue.items = []; rvSummary = {reviewCount:0,newCount:0}; rvLog = [{hz:'认真',l:5,typeId:'vi2hz',skill:'recall',correct:true,official:false,source:'extra'}];`);
  assert.ok(R(ctx, 'renderReview()').includes('Tổng kết buổi học'));
});
test('Mọi dạng: nhiều lần dựng ngẫu nhiên không bao giờ ném lỗi khi vẽ', () => {
  const ctx = makeEnv();
  R(ctx, `rvExamplePool = [{hz:'学习', zh:'我每天学习汉语。', vi:'Mỗi ngày tôi học tiếng Hán.'}];`);
  for (let i = 0; i < 60; i++) {
    const hz = POOL[i % POOL.length].hz; const type = ['review', 'new', 'extra', 'redo', 'check'][i % 5];
    const it = item(type === 'new' && i % 2 ? 'new' : type, hz); if (it.type === 'new') it.introduced = true;
    show(ctx, [it, item('review', POOL[(i + 1) % POOL.length].hz)]);
  }
});

runAll();
