#!/usr/bin/env node
// test/drill-notes.test.js — kiểm thử V105: (1) câu "nhớ lại ngay" cho từ mới, (2) "Mẹo nhớ của bạn".
// Không cần Postgres/ts-fsrs. Phần pg là GIẢ LẬP (kiểm logic, không kiểm SQL thật); phần client chạy trong vm.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
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

// ── Trích hàm rvAdvanceQueue từ review.js và chạy với các biến toàn cục giả ─────────────────────
const reviewSrc = read('js/review.js');
function grabFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'không thấy ' + name);
  let depth = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++; else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('không đóng được ' + name);
}
function makeRv(items, lastAnswer) {
  const calls = { archived: 0, persisted: 0, purged: [] };
  const ctx = {
    currentTab: 'review', REPEAT_GAP: 3,
    RV_DRILL_ENABLED: true, RV_DRILL_GAP: 3, RV_DRILL_MAX_TRIES: 2,
    rvQueue: { items, answeredCount: 0, completedCards: [] },
    rvLastAnswer: lastAnswer, sessionKnownHz: new Set(), saveSessionKnownHz() {},
    sqPurgeHzFromAllQueues(hz) { calls.purged.push(hz); },
    rvStorageMode: () => 'k', ssArchiveSession() { calls.archived++; }, refreshServerMeta() {}, sqClearPersisted() {},
    sqPersist() { calls.persisted++; }, rvSummary: {}, rvPrepareCurrentCard() {}, render() {}, Date,
  };
  vm.createContext(ctx);
  vm.runInContext(grabFn(reviewSrc, 'rvAdvanceQueue') + ';globalThis.adv = rvAdvanceQueue;', ctx);
  return { ctx, calls, adv: () => ctx.adv() };
}
const W = (hz) => ({ hz, l: 1 });
const item = (type, hz, extra) => ({ type, word: W(hz), ...(extra || {}) });

console.log('\n[1] Nhớ lại ngay cho từ mới');
test('Từ MỚI trả lời đúng → chèn 1 câu drill sau RV_DRILL_GAP thẻ; thẻ chính được tính, drill chưa tính', () => {
  const r = makeRv([item('new', 'A'), item('review', 'B'), item('review', 'C'), item('review', 'D'), item('review', 'E')], { correct: true });
  r.adv();
  const q = r.ctx.rvQueue;
  assert.strictEqual(q.answeredCount, 1);
  assert.strictEqual(q.completedCards.length, 1);
  assert.strictEqual(q.items[3].type, 'drill');
  assert.strictEqual(q.items[3].word.hz, 'A');
  assert.strictEqual(q.items.filter(i => i.type === 'drill').length, 1);
});
test('Từ mới trả lời SAI → không drill (thẻ vốn đã được chèn lại như cũ)', () => {
  const r = makeRv([item('new', 'A'), item('review', 'B'), item('review', 'C'), item('review', 'D')], { correct: false });
  r.adv();
  assert.strictEqual(r.ctx.rvQueue.items.filter(i => i.type === 'drill').length, 0);
  assert.ok(r.ctx.rvQueue.items.some(i => i.type === 'new' && i.word.hz === 'A'));
});
test('Thẻ ÔN TẬP trả lời đúng → không drill', () => {
  const r = makeRv([item('review', 'A'), item('review', 'B')], { correct: true });
  r.adv();
  assert.strictEqual(r.ctx.rvQueue.items.filter(i => i.type === 'drill').length, 0);
});
test('Hàng đợi chỉ còn từ mới đó: drill đứng ngay sau và phiên KHÔNG kết thúc sớm', () => {
  const r = makeRv([item('new', 'A')], { correct: true });
  r.adv();
  assert.strictEqual(r.ctx.rvQueue.items.length, 1);
  assert.strictEqual(r.ctx.rvQueue.items[0].type, 'drill');
  assert.strictEqual(r.calls.archived, 0);
});
test('Drill trả lời đúng → bị loại, KHÔNG tăng answeredCount/completedCards, KHÔNG đụng sessionKnownHz', () => {
  const r = makeRv([item('drill', 'A', { tries: 0 }), item('review', 'B')], { correct: true });
  r.adv();
  const q = r.ctx.rvQueue;
  assert.strictEqual(q.answeredCount, 0); assert.strictEqual(q.completedCards.length, 0);
  assert.strictEqual(r.ctx.sessionKnownHz.size, 0); assert.deepStrictEqual(r.calls.purged, []);
  assert.strictEqual(q.items.length, 1);
});
test('Drill sai lần 1 → hỏi lại 1 lần nữa; sai lần 2 → bỏ (không kẹt người học)', () => {
  const r1 = makeRv([item('drill', 'A', { tries: 0 }), item('review', 'B'), item('review', 'C'), item('review', 'D'), item('review', 'E')], { correct: false });
  r1.adv();
  const again = r1.ctx.rvQueue.items.find(i => i.type === 'drill');
  assert.ok(again && again.tries === 1);
  const r2 = makeRv([item('drill', 'A', { tries: 1 }), item('review', 'B')], { correct: false });
  r2.adv();
  assert.strictEqual(r2.ctx.rvQueue.items.filter(i => i.type === 'drill').length, 0);
});
test('Mỗi từ mới chỉ sinh đúng 1 drill ban đầu (không nhân bản khi drill sai rồi lặp)', () => {
  const r = makeRv([item('new', 'A'), item('review', 'B'), item('review', 'C'), item('review', 'D')], { correct: true });
  r.adv();
  assert.strictEqual(r.ctx.rvQueue.items.filter(i => i.type === 'drill').length, 1);
});
test('Drill luôn hỏi dạng nhớ chủ động (recall) và rvPickDrill KHÔNG gọi đường FSRS', () => {
  const choose = grabFn(reviewSrc, 'rvChooseExercise');
  const ctx = { skillAudioAvailable: () => true }; vm.createContext(ctx);
  vm.runInContext(choose + ';globalThis.f = rvChooseExercise;', ctx);
  assert.strictEqual(ctx.f({ type: 'drill', suggestedSkill: 'listening' }), 'recall');
  const pick = grabFn(reviewSrc, 'rvPickDrill');
  assert.ok(!/submitFsrsReview|rvFetchSystemRating|api\/study\/review/.test(pick), 'drill không được đi đường FSRS');
  assert.ok(/submitSkillPractice\(\{[^}]*practice-recall/.test(pick));
  assert.ok(/rvRatingPhase = null/.test(pick));
});
test('Khôi phục phiên và purge hàng đợi giữ nguyên câu drill', () => {
  assert.ok(/it\.type === 'drill' \|\| !sessionKnownHz\.has/.test(reviewSrc));
  assert.ok(/it\.type === 'drill' \|\| it\.word\.hz !== hz/.test(read('js/study-queue.js')));
});

// ── Mẹo nhớ: phía server ────────────────────────────────────────────────────────────────────────
console.log('\n[2] Mẹo nhớ — server');
const N = require(path.join(ROOT, 'lib', 'word-notes'));
test('sanitizeNote: bỏ ký tự điều khiển, gộp khoảng trắng; rỗng/null = xoá', () => {
  assert.strictEqual(N.sanitizeNote('  a\n\tb\u0000  c ').note, 'a b c');
  assert.strictEqual(N.sanitizeNote('   ').note, '');
  assert.strictEqual(N.sanitizeNote(null).note, '');
});
test('sanitizeNote: giới hạn 200 KÝ TỰ (đếm theo code point, emoji không bị tính đôi)', () => {
  assert.strictEqual(N.sanitizeNote('😀'.repeat(200)).ok, true);
  assert.strictEqual(N.sanitizeNote('😀'.repeat(201)).ok, false);
  assert.strictEqual(N.sanitizeNote('a'.repeat(201)).ok, false);
  assert.strictEqual(N.sanitizeNote(123).ok, false);
  assert.strictEqual(N.sanitizeNote({}).ok, false);
});
function fakeNotesPool() {
  const rows = new Map(); const vocab = new Map([['提高', 7]]);
  const client = {
    async query(sql, p) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/^INSERT INTO word_notes/.test(s)) { rows.set(p[0] + '|' + p[1], p[2]); return { rows: [] }; }
      if (/^DELETE FROM word_notes WHERE user_id = \$1 AND word_id/.test(s)) { rows.delete(p[0] + '|' + p[1]); return { rows: [] }; }
      if (/^SELECT v\.hz, n\.note/.test(s)) {
        const out = []; for (const [k, note] of rows) { const [u, id] = k.split('|'); if (u === p[0]) out.push({ hz: [...vocab].find(([, v]) => String(v) === id)[0], note }); } return { rows: out };
      }
      return { rows: [] };
    }, release() {},
  };
  const dbPath = require.resolve(path.join(ROOT, 'lib', 'db'), { paths: [ROOT] });
  const m = new Module(dbPath); m.filename = dbPath; m.loaded = true;
  m.exports = { getPool: () => ({ connect: async () => client }), resolveCanonicalWordId: async (_c, hz) => (vocab.has(hz) ? vocab.get(hz) : null), ensureVocabTable: async () => {}, ensureFsrsTables: async () => {} };
  require.cache[dbPath] = m;
  delete require.cache[require.resolve(path.join(ROOT, 'lib', 'word-notes'))];
  return { notes: require(path.join(ROOT, 'lib', 'word-notes')), rows };
}
test('setNote lưu / ghi đè / xoá khi rỗng; mỗi user một ghi chú riêng', async () => {
  const { notes, rows } = fakeNotesPool();
  assert.strictEqual((await notes.setNote('an', '提高', 'nâng cao = cao lên')).ok, true);
  await notes.setNote('binh', '提高', 'của bình');
  assert.strictEqual(rows.get('an|7'), 'nâng cao = cao lên'); assert.strictEqual(rows.get('binh|7'), 'của bình');
  const mine = await notes.listNotes('an');
  assert.deepStrictEqual(mine, [{ hz: '提高', note: 'nâng cao = cao lên' }]);   // không lẫn ghi chú của 'binh'
  await notes.setNote('an', '提高', '');
  assert.ok(!rows.has('an|7') && rows.has('binh|7'));
});
test('setNote: từ không tồn tại / hz sai → lỗi sạch, không ghi', async () => {
  const { notes, rows } = fakeNotesPool();
  assert.strictEqual((await notes.setNote('an', '不存在', 'x')).ok, false);
  assert.strictEqual((await notes.setNote('an', '', 'x')).ok, false);
  assert.strictEqual(rows.size, 0);
});
test('Route /api/notes bắt buộc đăng nhập, chỉ dùng authed.username', () => {
  const api = read('api/index.js');
  const rs = [...api.matchAll(/app\.(get|put)\('\/api\/notes',\s*async \(req, res\) => \{([\s\S]*?)\n\}\);/g)];
  assert.strictEqual(rs.length, 2);
  for (const [, , b] of rs) { assert.ok(/requireAuth\(req, res\)/.test(b) && /authed\.username/.test(b)); assert.ok(!/req\.(body|query)\.(userId|username)/.test(b)); }
});
test('Ghi chú chỉ bị xoá khi XOÁ TÀI KHOẢN (alsoDeleteAnalytics), KHÔNG bị xoá khi reset tiến độ', () => {
  const db = read('lib/db.js');
  const i = db.indexOf('wordNotes.deleteUserNotesTx(client, targetUserId)');
  assert.ok(i > 0);
  const before = db.slice(db.lastIndexOf('if (alsoDeleteAnalytics) {', i), i);
  assert.ok(before.length < 600 && !/\n    }\n/.test(before), 'lệnh xoá ghi chú phải nằm TRONG khối alsoDeleteAnalytics');
});
test('Migration V105 chỉ cộng thêm, kiểu user_id TEXT / word_id INT', () => {
  const sql = read('migrations/V105_word_notes.sql').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/\b(DROP|UPDATE|TRUNCATE)\b/i.test(sql) && /user_id TEXT/.test(sql) && /word_id INT/.test(sql) && !/BIGINT/i.test(sql));
});

// ── Mẹo nhớ: phía client (XSS) ──────────────────────────────────────────────────────────────────
console.log('\n[3] Mẹo nhớ — client');
function loadWn() {
  const els = {};
  const doc = { getElementById: id => els[id] || null, createElement: () => ({ style: {}, appendChild() {} }), head: { appendChild() {} }, body: { appendChild() {} } };
  const ctx = {
    document: doc, isLoggedIn: () => true, authHeaders: () => ({}), fetch: async () => ({ json: async () => ({ ok: true, notes: [] }) }),
    escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    escapeJsAttr: s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;'),
    currentTab: 'review', console, Promise, Object, JSON, Array, String,
  };
  vm.createContext(ctx);
  vm.runInContext(read('js/word-notes.js') + ';globalThis.api={wnInner,wnBlockHtml,setNote:(h,n)=>{wnNotes[h]=n;}};', ctx);
  return ctx.api;
}
test('Ghi chú chứa HTML/JS được escape khi hiển thị (không XSS)', () => {
  const api = loadWn();
  api.setNote('提高', '<img src=x onerror=alert(1)> "q" \'s\'');
  const html = api.wnInner('提高');
  assert.ok(!/<img/i.test(html), html);
  assert.ok(/&lt;img/.test(html));
});
test('hz chứa dấu nháy không phá thuộc tính onclick', () => {
  const api = loadWn();
  const html = api.wnInner("a'b\"c");
  assert.ok(!/onclick="wnOpenEditor\('a'b/.test(html));
});
test('Khối ghi chú có mặt ở Review (đáp án + drill) và Flashcard; khách không thấy', () => {
  assert.strictEqual((reviewSrc.match(/wnBlockHtml\(w\.hz\)/g) || []).length, 2);
  assert.ok(/wnBlockHtml\(w\.hz\)/.test(read('js/flashcard.js')));
  assert.ok(/js\/word-notes\.js/.test(read('index.html')));
});

runAll();
