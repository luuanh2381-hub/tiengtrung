// test/study-time.test.js — V112: thời gian học THỰC (không tính khi chuyển tab / ẩn trình duyệt / bỏ không tương tác).
// Chạy: node test/study-time.test.js
// Dùng đồng hồ giả + DOM giả; nạp NGUYÊN js/timer.js, js/visibility-timer.js và lib/fsrs/analytics.js (pool giả) — không copy logic.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0; const pending = [];
const test = (n, f) => pending.push({ n, f });
async function runAll() {
  for (const { n, f } of pending) {
    try { await f(); pass++; console.log('  ✅ ' + n); }
    catch (e) { fail++; console.log('  ❌ ' + n + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
}

// ═══ [A] Quy tắc tính (thuần) ═══
const ST = require('../lib/fsrs/study-time');
console.log('\n[A] creditedSeconds — quy tắc cộng dồn có trần');
test('khoảng ngắn: cộng đúng khoảng thật', () => assert.strictEqual(ST.creditedSeconds(20000, undefined), 20));
test('vắng 10 phút mà client không báo gì → chỉ cộng tối đa TRẦN (60s), không phải 600s', () => assert.strictEqual(ST.creditedSeconds(600000, undefined), 60));
test('client báo 0 (vừa quay lại, đồng bộ mốc) → KHÔNG cộng gì dù vắng bao lâu', () => assert.strictEqual(ST.creditedSeconds(600000, 0), 0));
test('client báo ít hơn khoảng thật → tin số của client (nhỏ hơn)', () => assert.strictEqual(ST.creditedSeconds(40000, 15), 15));
test('client báo NHIỀU hơn thời gian thật / trần → bị chặn (không cộng lố)', () => {
  assert.strictEqual(ST.creditedSeconds(5000, 999), 5);
  assert.strictEqual(ST.creditedSeconds(600000, 9999), 60);
});
test('giá trị rác/âm/NaN → bỏ qua hoặc 0, không bao giờ làm tăng quá trần', () => {
  assert.strictEqual(ST.creditedSeconds(20000, 'abc'), 20);
  assert.strictEqual(ST.creditedSeconds(20000, -5), 0);
  assert.strictEqual(ST.creditedSeconds(-1000, 5), 0);
  assert.strictEqual(ST.creditedSeconds(NaN, 5), 0);
  assert.strictEqual(ST.creditedSeconds(0, 5), 0);
});
test('gửi trùng (retry mạng): lần 2 cách lần 1 ~0 giây → credit ≈ 0 (không nhân đôi)', () => assert.strictEqual(ST.creditedSeconds(300, 20), 0));

// ═══ [B] analytics.js với pool giả ═══
console.log('\n[B] analytics.js (pool giả) — server không còn cộng giờ treo tường');
function loadAnalytics(fake) {
  const dbPath = require.resolve('../lib/db'), schedPath = require.resolve('../lib/fsrs/scheduler');
  const saved = { db: require.cache[dbPath], sc: require.cache[schedPath] };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getPool: () => fake.pool } };
  require.cache[schedPath] = { id: schedPath, filename: schedPath, loaded: true, exports: { State: {} } };
  const ap = require.resolve('../lib/fsrs/analytics'); delete require.cache[ap];
  const mod = require('../lib/fsrs/analytics');
  return { mod, restore() { delete require.cache[ap]; if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath]; if (saved.sc) require.cache[schedPath] = saved.sc; else delete require.cache[schedPath]; } };
}
function fakePool(row) {
  const log = [];
  const client = {
    async query(sql, params) {
      const t = String(sql).trim();
      log.push({ sql: t, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(t)) return { rows: [] };
      if (/CREATE |ALTER /.test(t)) return { rows: [] };
      if (/FROM study_sessions WHERE user_id = \$1 ORDER BY end_time DESC/.test(t)) return { rows: row ? [row] : [] };
      if (/SELECT id, end_time, duration_seconds FROM study_sessions/.test(t)) return { rows: row ? [row] : [] };
      if (/^UPDATE study_sessions/.test(t)) return { rows: [Object.assign({}, row, { updated: params })] };
      if (/^INSERT INTO study_sessions/.test(t)) return { rows: [{ id: 99 }] };
      return { rows: [] };
    },
    release() {},
  };
  return { log, pool: { connect: async () => client } };
}
const T0 = Date.parse('2026-10-16T10:00:00Z');
const mkRow = (endOffsetMs, dur) => ({ id: 7, user_id: 'u', start_time: new Date(T0 - 3600e3), end_time: new Date(T0 + endOffsetMs), duration_seconds: dur, cards_reviewed: 5 });

test('recordStudyActivity: sau 10 phút vắng, lượt trả lời kế tiếp CHỈ cộng trần 60s (trước đây cộng cả ~70 phút từ start_time)', async () => {
  const fake = fakePool(mkRow(0, 100)); const { mod, restore } = loadAnalytics(fake);
  try {
    await mod.recordStudyActivity('u', { correct: true, now: new Date(T0 + 10 * 60e3) });
    const upd = fake.log.find(l => /^UPDATE study_sessions/.test(l.sql));
    assert.ok(upd, 'phải UPDATE (còn trong 15 phút)');
    assert.strictEqual(upd.params[1], 160, 'duration phải là 100 + 60, được ' + upd.params[1]);
  } finally { restore(); }
});
test('recordStudyActivity: lượt liên tiếp cách 8s → cộng 8s (đúng thực tế)', async () => {
  const fake = fakePool(mkRow(0, 100)); const { mod, restore } = loadAnalytics(fake);
  try {
    await mod.recordStudyActivity('u', { correct: false, now: new Date(T0 + 8e3) });
    assert.strictEqual(fake.log.find(l => /^UPDATE study_sessions/.test(l.sql)).params[1], 108);
  } finally { restore(); }
});
test('recordStudyActivity: cách > 15 phút → mở phiên MỚI (giữ nguyên hành vi gộp phiên)', async () => {
  const fake = fakePool(mkRow(0, 100)); const { mod, restore } = loadAnalytics(fake);
  try {
    await mod.recordStudyActivity('u', { correct: true, now: new Date(T0 + 16 * 60e3) });
    assert.ok(fake.log.some(l => /^INSERT INTO study_sessions/.test(l.sql)));
    assert.ok(!fake.log.some(l => /^UPDATE study_sessions/.test(l.sql)));
  } finally { restore(); }
});
test('heartbeat: client báo 18s học thực, khoảng thực 20s → cộng 18s', async () => {
  const fake = fakePool(mkRow(0, 100)); const { mod, restore } = loadAnalytics(fake);
  try {
    await mod.heartbeatExplicitSession('u', 7, new Date(T0 + 20e3), 18);
    const upd = fake.log.find(l => /^UPDATE study_sessions/.test(l.sql));
    assert.strictEqual(upd.params[1], 18);
  } finally { restore(); }
});
test('heartbeat sau khi VẮNG 30 phút, client báo 0 → cộng 0 nhưng vẫn dời mốc end_time (không cộng khoảng vắng)', async () => {
  const fake = fakePool(mkRow(0, 100)); const { mod, restore } = loadAnalytics(fake);
  try {
    await mod.heartbeatExplicitSession('u', 7, new Date(T0 + 30 * 60e3), 0);
    const upd = fake.log.find(l => /^UPDATE study_sessions/.test(l.sql));
    assert.strictEqual(upd.params[1], 0); assert.strictEqual(upd.params[0].getTime(), T0 + 30 * 60e3);
  } finally { restore(); }
});
test('heartbeat KHÔNG còn dùng công thức giờ treo tường (EXTRACT(EPOCH ... start_time)) và chạy trong giao dịch có khoá dòng', async () => {
  const src = read('lib/fsrs/analytics.js');
  const fn = src.slice(src.indexOf('async function heartbeatExplicitSession'), src.indexOf('// ── Dashboard'));
  assert.ok(!/start_time/.test(fn.replace(/\/\/.*$/gm, '')) || !/EXTRACT\(EPOCH FROM \(\$1 - start_time\)\)/.test(fn));
  assert.ok(/FOR UPDATE/.test(fn) && /BEGIN/.test(fn) && /COMMIT/.test(fn));
  const rec = src.slice(src.indexOf('async function recordStudyActivity'), src.indexOf('async function startExplicitSession'));
  assert.ok(!/ts\.getTime\(\) - new Date\(open\.start_time\)\.getTime\(\)\) \/ 1000\)\)/.test(rec.replace(/\([\s\S]*?end_time[\s\S]*?\)/, '')), 'recordStudyActivity còn tính theo start_time');
});
test('heartbeat với session không tồn tại / của user khác → null, ROLLBACK, không ghi', async () => {
  const fake = fakePool(null); const { mod, restore } = loadAnalytics(fake);
  try {
    const r = await mod.heartbeatExplicitSession('u', 7, new Date(T0), 5);
    assert.strictEqual(r, null);
    assert.ok(fake.log.some(l => /^ROLLBACK/.test(l.sql)) && !fake.log.some(l => /^UPDATE study_sessions/.test(l.sql)));
    assert.ok(fake.log.find(l => /SELECT id, end_time/.test(l.sql)).sql.includes('user_id = $2'), 'phải khoá theo user');
  } finally { restore(); }
});
test('API heartbeat nhận activeSeconds tuỳ chọn; thiếu → undefined (client cũ vẫn chạy)', () => {
  const api = read('api/index.js');
  const i = api.indexOf("app.post('/api/study/session/heartbeat'");
  const body = api.slice(i, i + 900);
  assert.ok(/activeSeconds/.test(body) && /heartbeatExplicitSession\(authed\.username, Number\(sessionId\), new Date\(\), active\)/.test(body));
});

// ═══ [C] Trình duyệt: timer.js + visibility-timer.js với đồng hồ giả ═══
console.log('\n[C] timer.js — chuyển tab / ẩn trình duyệt / không tương tác');
function makeBrowser() {
  let nowMs = 1_000_000;
  const listeners = {}; const winListeners = {};
  const timers = []; let nextId = 1;
  const chip = { style: {}, textContent: '' };
  const fetches = [];
  const doc = { hidden: false, getElementById: (id) => (id === 'study-timer-chip' ? chip : null), addEventListener: (ev, f) => (listeners[ev] = listeners[ev] || []).push(f) };
  const ctx = {
    console, Math, JSON, Promise, Object, Number, String, Array, Set, Map,
    Date: { now: () => nowMs }, performance: { now: () => nowMs },
    document: doc, window: { addEventListener: (ev, f) => (winListeners[ev] = winListeners[ev] || []).push(f) },
    localStorage: { _m: {}, getItem(k) { return k in this._m ? this._m[k] : null; }, setItem(k, v) { this._m[k] = String(v); } },
    authUsername: 'u', isLoggedIn: () => true, authHeaders: () => ({}), currentTab: 'review',
    setInterval: (f, ms) => { const id = nextId++; timers.push({ id, f, ms, next: nowMs + ms }); return id; },
    clearInterval: (id) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    fetch: async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null; fetches.push({ url, body });
      if (url === '/api/study/session/start') return { json: async () => ({ ok: true, sessionId: 5 }) };
      return { json: async () => ({ ok: true, durationSeconds: 0 }) };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read('js/timer.js'), ctx);
  vm.runInContext(read('js/visibility-timer.js'), ctx);
  // document.addEventListener của visibility-timer đã gắn vào `listeners`
  const api = {
    ctx, chip, fetches, doc,
    set tab(v) { ctx.currentTab = v; },
    advance(ms) { // chạy đồng hồ giả theo từng giây (đúng như setInterval thật), kích hoạt các timer đến hạn
      let left = ms;
      while (left > 0) {
        const step = Math.min(1000, left); nowMs += step; left -= step;
        for (const t of timers.slice()) if (nowMs >= t.next) { t.next += t.ms; t.f(); }
      }
    },
    jump(ms) { nowMs += ms; }, // thời gian trôi qua KHÔNG có tick nào (tab bị đóng băng / máy ngủ)
    now: () => nowMs,
    hide() { doc.hidden = true; (listeners.visibilitychange || []).forEach(f => f()); },
    show() { doc.hidden = false; (listeners.visibilitychange || []).forEach(f => f()); },
    touch() { (winListeners.pointerdown || []).forEach(f => f()); },
    run: (code) => vm.runInContext(code, ctx),
    get active() { return Math.round(vm.runInContext('studySession.activeMs', ctx) / 1000); },
  };
  return api;
}
const flush = () => new Promise(r => setImmediate(r)); // chờ hết chuỗi bất đồng bộ fetch → res.json() → finally
async function openSession(b) { await b.run('ensureStudySession()'); await flush(); }

test('đang học (hiển thị, ở tab học, có chạm) → đồng hồ chạy đúng thời gian', async () => {
  const b = makeBrowser(); await openSession(b);
  b.touch(); b.advance(30000);
  assert.strictEqual(b.active, 30); assert.ok(b.chip.textContent.includes('00:30'), b.chip.textContent);
});
test('ẨN TRÌNH DUYỆT (chuyển tab trình duyệt/app khác): thời gian đứng yên, quay lại KHÔNG nhảy cóc', async () => {
  const b = makeBrowser(); await openSession(b);
  b.touch(); b.advance(20000);
  b.hide(); b.advance(600000); // 10 phút ở chỗ khác (timer vẫn tick như desktop làm chậm)
  b.show(); b.touch(); b.advance(5000);
  assert.strictEqual(b.active, 25, 'phải là 20 + 5, không phải 625: ' + b.active);
});
test('SANG TAB KHÁC TRONG APP (Thống kê) rồi quay lại: không cộng thời gian ở tab kia', async () => {
  const b = makeBrowser(); await openSession(b);
  b.touch(); b.advance(15000);
  b.tab = 'stats'; b.run('leaveStudyContext()');
  b.advance(300000); // 5 phút xem thống kê
  b.tab = 'review'; await openSession(b); b.touch(); b.advance(10000);
  assert.strictEqual(b.active, 25, 'phải là 15 + 10: ' + b.active);
});
test('tab Hôm nay (dashboard) không phải màn học → không cộng; tab Phân tích chỉ cộng khi ĐANG làm bài luyện', async () => {
  const b = makeBrowser(); await openSession(b);
  b.touch(); b.tab = 'today'; assert.strictEqual(b.run('isStudyContext()'), false);
  b.tab = 'skills'; b.run('var skState = { practice: null }'); assert.strictEqual(b.run('isStudyContext()'), false);
  b.run('skState.practice = { q: {} }'); assert.strictEqual(b.run('isStudyContext()'), true, 'buổi luyện bổ sung (V110) phải được tính là học');
});
test('KHÔNG TƯƠNG TÁC quá 90s → ngừng cộng; chạm lại thì cộng tiếp', async () => {
  const b = makeBrowser(); await openSession(b);
  b.touch(); b.advance(200000); // 200s không chạm gì
  assert.ok(b.active >= 89 && b.active <= 91, 'chỉ được cộng tối đa ~90s, được ' + b.active);
  const before = b.active; b.touch(); b.advance(10000);
  assert.strictEqual(b.active, before + 10);
});
test('máy ngủ / tab bị đóng băng (đồng hồ nhảy 1 giờ không có tick) → KHÔNG cộng cục lớn', async () => {
  const b = makeBrowser(); await openSession(b);
  b.touch(); b.advance(10000);
  b.jump(3600000); b.touch(); b.advance(1000);
  assert.ok(b.active <= 10 + 2 + 1, 'cộng bù quá nhiều: ' + b.active);
});
test('đồng hồ hiển thị mờ đi khi đang tạm dừng, sáng lại khi học tiếp', async () => {
  const b = makeBrowser(); await openSession(b);
  b.touch(); b.advance(2000); b.hide(); b.advance(2000);
  assert.strictEqual(b.chip.style.opacity, '.55');
  b.show(); b.touch(); b.advance(1000); assert.strictEqual(b.chip.style.opacity, '');
});
test('render() gọi ensureStudySession liên tục KHÔNG tạo lại interval (heartbeat 20s vẫn chạy được)', async () => {
  const b = makeBrowser(); await openSession(b);
  const n0 = b.run('_studyTimerHandle'), h0 = b.run('_studyHeartbeatHandle');
  for (let i = 0; i < 5; i++) { b.touch(); b.advance(4000); await b.run('ensureStudySession()'); } // vẽ lại mỗi 4s
  assert.strictEqual(b.run('_studyTimerHandle'), n0); assert.strictEqual(b.run('_studyHeartbeatHandle'), h0);
  assert.ok(b.fetches.some(f => f.url === '/api/study/session/heartbeat'), 'heartbeat phải chạy dù liên tục vẽ lại');
});

console.log('\n[D] Heartbeat báo activeSeconds đúng');
const hbs = (b) => b.fetches.filter(f => f.url === '/api/study/session/heartbeat').map(f => f.body);
test('heartbeat báo số giây học THỰC (không phải giờ treo tường) và không báo trùng phần đã gửi', async () => {
  const b = makeBrowser(); await openSession(b);
  b.touch(); b.advance(20000); await flush();
  b.touch(); b.advance(20000); await flush();
  const h = hbs(b);
  assert.strictEqual(h.length, 2);
  assert.ok(h[0].activeSeconds >= 19 && h[0].activeSeconds <= 20, JSON.stringify(h[0]));
  assert.ok(h[1].activeSeconds >= 19 && h[1].activeSeconds <= 21, 'không được cộng dồn lại phần đã gửi: ' + JSON.stringify(h[1]));
});
test('đang ẩn trình duyệt: báo nốt phần dư ĐÚNG MỘT LẦN rồi im lặng (không đẩy end_time đi tiếp theo giờ treo tường)', async () => {
  const b = makeBrowser(); await openSession(b);
  b.touch(); b.advance(5000); b.hide(); await flush();
  b.advance(25000); await flush(); // nhịp heartbeat đầu tiên sau khi ẩn: gửi nốt phần dư chưa báo
  const n = hbs(b).length;
  assert.ok(n <= 1, 'chỉ được báo nốt 1 lần, được ' + n);
  if (n === 1) assert.ok(hbs(b)[0].activeSeconds >= 4 && hbs(b)[0].activeSeconds <= 6, JSON.stringify(hbs(b)[0]));
  b.advance(600000); await flush();
  assert.strictEqual(hbs(b).length, n, 'sau khi báo nốt, không được gửi thêm khi vẫn đang ẩn');
});
test('ẩn trình duyệt → báo NỐT giây học thực chưa gửi (keepalive) rồi dừng', async () => {
  const b = makeBrowser(); await openSession(b);
  b.touch(); b.advance(12000);
  b.run('leaveStudyContext(true)'); await flush();
  const h = hbs(b); assert.ok(h.length >= 1 && h[h.length - 1].activeSeconds >= 11 && h[h.length - 1].activeSeconds <= 12, JSON.stringify(h));
});
test('quay lại sau khi vắng: heartbeat đồng bộ có activeSeconds ≈ 0 (server dời mốc, không cộng khoảng vắng)', async () => {
  const b = makeBrowser(); await openSession(b);
  b.touch(); b.advance(20000); await flush();
  b.hide(); b.run('leaveStudyContext(true)'); await flush();
  b.advance(900000); b.show(); await openSession(b); await b.run('sendStudyHeartbeat({ force: true })'); await flush();
  const h = hbs(b); assert.strictEqual(h[h.length - 1].activeSeconds, 0, JSON.stringify(h[h.length - 1]));
});
test('vắng > 15 phút: phiên trong bộ nhớ hết hạn → mở phiên MỚI, đồng hồ về 0 (khớp quy tắc gộp phiên của server)', async () => {
  const b = makeBrowser(); await openSession(b);
  b.touch(); b.advance(30000); await flush();
  b.run('leaveStudyContext()'); b.jump(20 * 60e3); await openSession(b);
  assert.strictEqual(b.fetches.filter(f => f.url === '/api/study/session/start').length, 2);
  assert.strictEqual(b.active, 0);
});
test('mạng lỗi khi heartbeat: phần chưa gửi KHÔNG mất, gửi bù ở nhịp sau', async () => {
  const b = makeBrowser(); await openSession(b);
  const realFetch = b.ctx.fetch; let calls = 0;
  b.ctx.fetch = async (url, opts) => { if (url.includes('heartbeat') && calls++ === 0) throw new Error('offline'); return realFetch(url, opts); };
  b.touch(); b.advance(20000); await flush();
  b.touch(); b.advance(20000); await flush();
  const sent = hbs(b).reduce((s, x) => s + x.activeSeconds, 0);
  assert.ok(sent >= 38 && sent <= 41, 'tổng đã báo phải ≈ 40s, được ' + sent);
});
test('không gửi 2 heartbeat chồng nhau', async () => {
  const b = makeBrowser(); await openSession(b);
  let started = 0, finish; const realFetch = b.ctx.fetch;
  b.ctx.fetch = (url, opts) => url.includes('heartbeat') ? (started++, new Promise(r => { finish = () => r({ json: async () => ({ ok: true }) }); })) : realFetch(url, opts);
  b.touch(); b.advance(5000);
  b.run('sendStudyHeartbeat({ force: true })'); b.run('sendStudyHeartbeat({ force: true })'); b.run('sendStudyHeartbeat({ force: true })');
  assert.strictEqual(started, 1, 'chỉ 1 request được phép bay cùng lúc, được ' + started);
  finish(); await flush();
  assert.strictEqual(b.run('_studyHeartbeatInFlight'), false);
  assert.strictEqual(b.run('studyUnsentSeconds()'), 0, 'sau khi gửi thành công, phần đã báo phải được trừ đi');
});

// ═══ [E] Thời gian trả lời từng câu (đầu vào của code thích ứng) ═══
console.log('\n[E] visibility-timer — thời gian trả lời trừ cả lúc ở tab khác trong app');
function vtEnv() { const b = makeBrowser(); return b; }
const rt = (b, startedAt) => Math.max(0, b.now() - startedAt - b.run('vtHiddenMs()'));
test('đổi sang tab khác trong app 5 phút rồi quay lại: responseTimeMs chỉ gồm thời gian thật nhìn câu hỏi', () => {
  const b = vtEnv(); b.tab = 'review';
  b.advance(2000); const startedAt = b.now(); b.run('vtMarkStart()'); // câu hỏi hiện ra ở tab review
  b.advance(3000);
  b.tab = 'stats'; b.run('vtSync()'); b.advance(300000);
  b.tab = 'review'; b.run('vtSync()'); b.advance(2000);
  assert.strictEqual(rt(b, startedAt), 5000, 'phải là 3s + 2s = 5s, được ' + rt(b, startedAt));
});
test('ẩn trình duyệt VẪN được trừ như cũ', () => {
  const b = vtEnv(); b.tab = 'review'; const startedAt = b.now(); b.run('vtMarkStart()');
  b.advance(1000); b.hide(); b.advance(60000); b.show(); b.advance(1000);
  assert.strictEqual(rt(b, startedAt), 2000);
});
test('đổi tab trong app RỒI ẩn trình duyệt chồng nhau: không trừ 2 lần', () => {
  const b = vtEnv(); b.tab = 'review'; const startedAt = b.now(); b.run('vtMarkStart()');
  b.advance(1000); b.tab = 'stats'; b.run('vtSync()'); b.advance(10000); b.hide(); b.advance(10000); b.show(); b.advance(10000);
  b.tab = 'review'; b.run('vtSync()'); b.advance(1000);
  assert.strictEqual(rt(b, startedAt), 2000, 'được ' + rt(b, startedAt));
});
test('RÀNG BUỘC: mốc bắt đầu vắng là lúc vtSync() chạy — mọi lần đổi tab trong app đều đi qua render() (đã gọi vtSync)', () => {
  const b = vtEnv(); b.tab = 'review'; const startedAt = b.now(); b.run('vtMarkStart()');
  b.advance(2000); b.tab = 'stats'; b.run('vtSync()'); b.advance(8000); // render() của tab mới gọi vtSync đúng lúc đổi
  assert.strictEqual(b.run('vtHiddenMs()'), 8000);
  assert.strictEqual(rt(b, startedAt), 2000);
  const nav = read('js/navigation.js');
  const fn = nav.slice(nav.indexOf('function render() {'), nav.indexOf("if (currentTab === 'home')"));
  assert.ok(/vtSync\(\);/.test(fn), 'render() phải gọi vtSync() TRƯỚC khi vẽ tab mới');
});
test('câu hỏi chuẩn bị NGAY TRƯỚC khi chuyển tab hiển thị (vd bấm chế độ luyện ở Hôm nay) → nhận tab mới, không bị coi là vắng', () => {
  const b = vtEnv(); b.tab = 'today'; const startedAt = b.now(); b.run('vtMarkStart()');
  b.tab = 'skills'; b.advance(100); b.run('vtSync()'); // đổi tab trong 500ms đầu
  b.advance(4000);
  assert.strictEqual(rt(b, startedAt), 4100, 'được ' + rt(b, startedAt));
});
test('đổi tab SAU 500ms thì mới tính là vắng', () => {
  const b = vtEnv(); b.tab = 'review'; const startedAt = b.now(); b.run('vtMarkStart()');
  b.advance(2000); b.tab = 'stats'; b.run('vtSync()'); b.advance(5000);
  assert.strictEqual(rt(b, startedAt), 2000);
});
test('vtMarkStart mới (câu kế) đặt lại bộ đếm vắng và chủ sở hữu tab', () => {
  const b = vtEnv(); b.tab = 'review'; b.run('vtMarkStart()'); b.tab = 'stats'; b.advance(9999); b.run('vtSync()');
  b.tab = 'quiz'; b.advance(1000); const s2 = b.now(); b.run('vtMarkStart()'); b.advance(3000);
  assert.strictEqual(rt(b, s2), 3000);
});

// ═══ [F] Cấu hình ═══
console.log('\n[F] Tích hợp');
test('render() đồng bộ vtSync + dùng isStudyContext/leaveStudyContext; handler visibility/pagehide dùng giờ học thực', () => {
  const nav = read('js/navigation.js'), sq = read('js/study-queue.js');
  assert.ok(/vtSync\(\);/.test(nav) && /isStudyContext\(\)/.test(nav) && /leaveStudyContext\(\)/.test(nav) && !/STUDY_TABS\.has\(currentTab\)/.test(nav));
  assert.ok(!/STUDY_TABS\.has\(currentTab\)/.test(sq), 'study-queue.js còn dùng STUDY_TABS (bỏ sót tab luyện bổ sung)');
  assert.ok(/activeSeconds: studyUnsentSeconds\(\)/.test(sq) && /leaveStudyContext\(true\)/.test(sq));
});
test('đồng hồ hiển thị KHÔNG còn tính (Date.now() − startedAt)', () => {
  const src = read('js/timer.js').replace(/\/\/.*$/gm, '');
  assert.ok(!/Date\.now\(\) - studySession\.startedAt/.test(src));
});

runAll();
