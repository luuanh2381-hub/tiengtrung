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

// (Phần "nhớ lại ngay" kiểu V105 được thay bằng luồng giới thiệu → kiểm tra → ôn FSRS sau khoảng nghỉ của V106;
//  xem test/adaptive-session.test.js.)

// ── Mẹo nhớ: phía server ────────────────────────────────────────────────────────────────────────
console.log('\n[1] Mẹo nhớ — server');
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
console.log('\n[2] Mẹo nhớ — client');
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
  assert.strictEqual((reviewSrc.match(/wnBlockHtml\(w\.hz\)/g) || []).length, 3); // màn giới thiệu + đáp án luyện bổ sung + đáp án FSRS
  assert.ok(/wnBlockHtml\(w\.hz\)/.test(read('js/flashcard.js')));
  assert.ok(/js\/word-notes\.js/.test(read('index.html')));
});

runAll();
