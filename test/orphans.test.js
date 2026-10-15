#!/usr/bin/env node
// test/orphans.test.js — dọn bản ghi ôn tập mồ côi (Loại A). pg GIẢ LẬP (kiểm luồng/transaction/xác nhận), kiểm tra TĨNH
// câu SQL và route. Điều kiện mồ côi đã được kiểm chứng riêng trên SQLite (không phải Postgres). Không chạy trên DB thật.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
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
function load(state) {
  const calls = [];
  const client = {
    async query(sql) {
      const s = sql.replace(/\s+/g, ' ').trim(); calls.push(s);
      if (/^DELETE FROM review_history/.test(s)) return { rowCount: state.history, rows: [] };
      if (/^DELETE FROM fsrs_cards/.test(s)) return { rowCount: state.cards, rows: [] };
      if (/COUNT\(\*\)::int AS total, COUNT\(\*\) FILTER/.test(s)) return { rows: [{ total: state.cards, due: state.due || 0 }] };
      if (/FROM review_history rh WHERE/.test(s) && /COUNT/.test(s)) return { rows: [{ total: state.history }] };
      return { rows: [] };
    }, release() {},
  };
  const dbPath = require.resolve(path.join(ROOT, 'lib', 'db'), { paths: [ROOT] });
  const m = new Module(dbPath); m.filename = dbPath; m.loaded = true;
  m.exports = { getPool: () => ({ connect: async () => client }), ensureFsrsTables: async () => {} };
  require.cache[dbPath] = m;
  delete require.cache[require.resolve(path.join(ROOT, 'lib', 'orphans'))];
  return { O: require(path.join(ROOT, 'lib', 'orphans')), calls };
}
const src = read('lib/orphans.js');

test('Xoá khi số liệu khớp xem trước: BEGIN → 2 DELETE → COMMIT, trả đúng số dòng', async () => {
  const { O, calls } = load({ cards: 7, history: 12 });
  const r = await O.cleanupOrphans({ expectedCards: 7, expectedHistory: 12 });
  assert.deepStrictEqual({ ok: r.ok, c: r.removedCards, h: r.removedHistory }, { ok: true, c: 7, h: 12 });
  assert.deepStrictEqual(calls.filter(c => /^(BEGIN|COMMIT|ROLLBACK)/.test(c)), ['BEGIN', 'COMMIT']);
});
test('Số thực tế khác lúc xem trước → ROLLBACK, không xoá gì, báo lỗi tiếng Việt', async () => {
  const { O, calls } = load({ cards: 9, history: 12 });
  const r = await O.cleanupOrphans({ expectedCards: 7, expectedHistory: 12 });
  assert.strictEqual(r.ok, false); assert.ok(/đã thay đổi/.test(r.error));
  assert.ok(calls.includes('ROLLBACK') && !calls.includes('COMMIT'));
});
test('Thiếu/sai số liệu xem trước → từ chối TRƯỚC khi mở transaction', async () => {
  for (const bad of [{}, { expectedCards: -1, expectedHistory: 0 }, { expectedCards: '7', expectedHistory: 1 }, { expectedCards: 1.5, expectedHistory: 1 }]) {
    const { O, calls } = load({ cards: 1, history: 1 });
    const r = await O.cleanupOrphans(bad);
    assert.strictEqual(r.ok, false); assert.ok(!calls.some(c => /^(BEGIN|DELETE)/.test(c)));
  }
});
test('Xem trước chỉ đọc: không có câu lệnh ghi nào', async () => {
  const { O, calls } = load({ cards: 3, history: 4, due: 2 });
  const p = await O.previewOrphans();
  assert.strictEqual(p.cards, 3); assert.strictEqual(p.dueCards, 2); assert.strictEqual(p.history, 4);
  assert.ok(calls.every(c => /^SELECT/.test(c)), calls.find(c => !/^SELECT/.test(c)));
});
test('Chỉ DELETE trên fsrs_cards/review_history và luôn kèm điều kiện mồ côi (word_id IS NULL + không còn từ cùng hz)', () => {
  const dels = [...src.matchAll(/DELETE FROM (\w+) (\w+) WHERE \$\{(\w+)\}/g)];
  assert.strictEqual(dels.length, 2);
  assert.deepStrictEqual(dels.map(d => d[1]).sort(), ['fsrs_cards', 'review_history']);
  assert.ok(!/\bTRUNCATE\b|DELETE FROM (vocab_|word_|skill_|app_store|user_)/i.test(src));
  for (const c of ['CARDS_ORPHAN', 'HISTORY_ORPHAN']) {
    const m = src.match(new RegExp('const ' + c + ' = `([^`]*)`'));
    assert.ok(m && /word_id IS NULL AND NOT EXISTS \(SELECT 1 FROM vocab_words v WHERE v\.hz = /.test(m[1]), c);
  }
});
test('Điều kiện KHÔNG xét bài (l): từ chuyển bài/nhập lại không bị coi là mồ côi', () => {
  const O = load({ cards: 0, history: 0 }).O;
  assert.ok(!/\.l\b/.test(O.CARDS_ORPHAN) && !/\.l\b/.test(O.HISTORY_ORPHAN));
});
test('3 route admin: đăng nhập + requireAdmin; xoá cần confirm === "XOA"', () => {
  const api = read('api/index.js');
  for (const r of ["get('/api/admin/orphans'", "get('/api/admin/orphans/export'", "post('/api/admin/orphans/cleanup'"]) {
    const i = api.indexOf('app.' + r); assert.ok(i > 0, r);
    const body = api.slice(i, i + 400);
    assert.ok(/requireAuth\(req, res\)/.test(body) && /requireAdmin\(/.test(body), r);
  }
  const c = api.slice(api.indexOf("app.post('/api/admin/orphans/cleanup'"));
  assert.ok(/confirm !== 'XOA'/.test(c.slice(0, 900)));
});
test('Giao diện admin: bắt buộc tải sao lưu + gõ XOA mới gửi lệnh xoá; escape tên người dùng/chữ Hán', () => {
  const a = read('js/admin.js');
  assert.ok(/if \(!orphanState\.backedUp\)/.test(a) && /confirmText !== 'XOA'/.test(a));
  assert.ok(/escapeHtml\(u\.user_id\)/.test(a) && /escapeHtml\(h\.hz\)/.test(a));
  assert.ok(/expectedCards: orphanState\.cards, expectedHistory: orphanState\.history/.test(a));
});
test('dueBreakdown: chỉ SELECT, tham số hoá user_id, trả đủ 3 nhóm + theo bài', async () => {
  const calls = [];
  const client = { async query(sql, params) {
    const q = sql.replace(/\s+/g, ' ').trim(); calls.push({ q, params });
    if (/COUNT\(\*\)::int AS tong/.test(q)) return { rows: [{ tong: 10, khong_con_tu: 3, tu_khong_thuoc_bai: 4, tu_con_trong_bai: 3 }] };
    if (/GROUP BY vl\.lesson/.test(q)) return { rows: [{ lesson: 34, cards: 3 }] };
    return { rows: [] };
  }, release() {} };
  const dbPath = require.resolve(path.join(ROOT, 'lib', 'db'), { paths: [ROOT] });
  const m = new Module(dbPath); m.filename = dbPath; m.loaded = true;
  m.exports = { getPool: () => ({ connect: async () => client }), ensureFsrsTables: async () => {} };
  require.cache[dbPath] = m; delete require.cache[require.resolve(path.join(ROOT, 'lib', 'orphans'))];
  const O = require(path.join(ROOT, 'lib', 'orphans'));
  const r = await O.dueBreakdown('tuananh');
  assert.deepStrictEqual({ t: r.total, n: r.noWord, w: r.wordNoLesson, i: r.wordInLesson }, { t: 10, n: 3, w: 4, i: 3 });
  assert.strictEqual(r.byLesson[0].lesson, 34);
  assert.ok(calls.every(c => /^SELECT/.test(c.q) && c.params && c.params[0] === 'tuananh'));
  await assert.rejects(() => O.dueBreakdown(''));
  const api = read('api/index.js'); const i = api.indexOf("app.get('/api/admin/due-breakdown'");
  assert.ok(i > 0 && /requireAuth\(req, res\)/.test(api.slice(i, i + 300)) && /requireAdmin\(/.test(api.slice(i, i + 300)));
});
runAll();
