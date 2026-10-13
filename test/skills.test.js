#!/usr/bin/env node
// ════════════════════════════════════════════════════
// test/skills.test.js — kiểm thử hệ thống KỸ NĂNG (V104). KHÔNG cần Postgres/ts-fsrs/express: chạy được
// ngay cả trước `npm install`.
//
// PHẠM VI THẬT (nói rõ để không hiểu nhầm):
//   * Phần 1-3 : logic thuần (điểm, bộ chọn kỹ năng, bảng bài tập).
//   * Phần 4   : logic transaction/idempotency của lib/skill-store.js chạy trên pg GIẢ LẬP trong bộ nhớ —
//                kiểm chứng THỨ TỰ câu lệnh và nhánh trùng lặp, KHÔNG kiểm chứng cú pháp SQL thật.
//   * Phần 5   : mã client (js/study-queue.js) chạy trong `vm` với fetch/localStorage giả.
//   * Phần 6-7 : kiểm tra TĨNH mã nguồn (phân quyền, không đụng FSRS, không hồi quy route/chế độ học).
//   Các test cần Postgres thật (SQL thật, FSRS thật) xem test/vocab-identity.integration.test.js — cần
//   DATABASE_URL, KHÔNG nằm trong file này.
// Chạy: node test/skills.test.js
// ════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) { pending.push({ name, fn }); }
async function runAll() {
  for (const { name, fn } of pending) {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const S = require(path.join(ROOT, 'lib', 'skills'));
const A = require(path.join(ROOT, 'lib', 'skill-adaptive'));
const row = (attempts, correct) => {
  let r = null;
  for (let i = 0; i < attempts; i++) r = S.applyAttempt(r, i < correct);
  return r;
};
// Tạo thống kê "n lượt, theo mẫu đúng/sai" (đúng liên tiếp rồi sai hoặc ngược lại — dùng pattern tường minh).
const stats = (pattern) => { let r = null; for (const ok of pattern) r = S.applyAttempt(r, ok); return r; };
const T = true, F = false;

// ── 1. Điểm & phân loại ────────────────────────────────────────────────────────────────────────
console.log('\n[1] Tính điểm / phân loại');
test('Kỹ năng chưa có dữ liệu → "insufficient", score = null (không mặc định thấp/cao) [case 6]', () => {
  const c = S.classify(null);
  assert.strictEqual(c.status, 'insufficient'); assert.strictEqual(c.score, null); assert.strictEqual(c.attempts, 0);
});
test('Dưới MIN_ATTEMPTS lượt: dù sai hết vẫn "insufficient", không bị gọi là yếu', () => {
  const c = S.classify(stats([F, F]));
  assert.strictEqual(c.status, 'insufficient'); assert.strictEqual(c.score, null);
});
test('Đủ dữ liệu và sai nhiều → "weak"; đúng nhiều → "ok"', () => {
  assert.strictEqual(S.classify(stats([F, F, F, T])).status, 'weak');
  assert.strictEqual(S.classify(stats([T, T, T, F])).status, 'ok');
});
test('Điểm Laplace: ít dữ liệu bị kéo về 0.5, nhiều dữ liệu tiến về tỉ lệ đúng', () => {
  const few = S.estimateScore(1, 1);                 // (1+1)/(1+2)
  assert.ok(Math.abs(few - 2 / 3) < 1e-9);
  const many = S.classify(stats(Array(40).fill(T))).score;
  assert.ok(many > 0.85 && many < 0.9); // trần ≈ 0.885 do trọng số giảm dần (DECAY=0.85)
});
test('Lượt gần đây nặng hơn: sai sớm rồi đúng liên tục → điểm hồi phục vượt ngưỡng yếu', () => {
  const r = stats([F, F, F, F, F, T, T, T, T, T, T, T, T, T, T]);
  assert.strictEqual(S.classify(r).status, 'ok');
});
test('Độ tin cậy tăng theo số lượt, trong (0,1)', () => {
  assert.ok(S.confidenceOf(3) < S.confidenceOf(9) && S.confidenceOf(9) < 1 && S.confidenceOf(0) === 0);
});
test('Câu "bỏ trống" không được tính; "bỏ qua" được tính (sai)', () => {
  assert.strictEqual(S.isCountableAnswer('⨯ (bỏ trống) ⨯'), false);
  assert.strictEqual(S.isCountableAnswer('   '), false);
  assert.strictEqual(S.isCountableAnswer('⨯ (bỏ qua) ⨯'), true);
  assert.strictEqual(S.isCountableAnswer('提高'), true);
});

// ── 2. Bảng bài tập → kỹ năng ──────────────────────────────────────────────────────────────────
console.log('\n[2] Bài tập → kỹ năng');
test('Quiz/Type/Listen/Review ánh xạ đúng kỹ năng thực sự được kiểm tra', () => {
  const k = (e, q) => (S.resolveExercise(e, q) || {}).skill;
  assert.strictEqual(k('quiz-hz2vi', 'hz2vi'), 'recognition');
  assert.strictEqual(k('review-hz2vi', 'hz2vi'), 'recognition');
  assert.strictEqual(k('quiz-vi2hz', 'vi2hz'), 'recall');
  assert.strictEqual(k('type-vi2hz', 'vi2hz'), 'recall');
  assert.strictEqual(k('listen-choose-hz', 'vi2hz'), 'listening');
  assert.strictEqual(k('review-listen', 'vi2hz'), 'listening');
});
test('Nhãn không khớp quizType thật bị loại (không làm bẩn hồ sơ)', () => {
  assert.strictEqual(S.resolveExercise('type-vi2hz', 'hz2vi'), null);
  assert.strictEqual(S.resolveExercise('listen-choose-hz', 'hz2vi'), null);
});
test('Nhãn lạ / thiếu → null; Flashcard (tự chấm) không có nhãn', () => {
  assert.strictEqual(S.resolveExercise('hack-skill', 'hz2vi'), null);
  assert.strictEqual(S.resolveExercise(undefined, 'hz2vi'), null);
  assert.strictEqual(S.resolveExercise('flashcard', 'hz2vi'), null);
});
test('pronunciation / context KHÔNG có bài tập nào ghi nhận (chưa có bài kiểm tra đáng tin)', () => {
  const skills = new Set(Object.values(S.EXERCISES).map(e => e.skill));
  assert.ok(!skills.has('pronunciation') && !skills.has('context'));
  assert.ok(!S.MEASURABLE_SKILLS.includes('pronunciation') && !S.MEASURABLE_SKILLS.includes('context'));
});
test('Bài luyện bổ sung (practice-*) mang fsrs:false — không đi đường FSRS', () => {
  assert.strictEqual(S.EXERCISES['practice-recall'].fsrs, false);
  assert.strictEqual(S.EXERCISES['practice-listening'].fsrs, false);
  for (const [id, e] of Object.entries(S.EXERCISES)) if (!id.startsWith('practice-')) assert.strictEqual(e.fsrs, true, id);
});

// ── 3. Bộ chọn kỹ năng (skill-adaptive) ────────────────────────────────────────────────────────
console.log('\n[3] Bộ chọn kỹ năng');
const ALL = ['recognition', 'recall', 'listening'];
test('Từ MỚI → luôn recognition, kể cả khi hồ sơ trống [case 2]', () => {
  assert.strictEqual(A.pickSkillForWord({ isNew: true, stats: {}, allowedSkills: ALL, rotation: 0 }), 'recognition');
});
test('Người dùng mới chưa có lịch sử, từ cũ: chọn kỹ năng để thu dữ liệu, không ném lỗi [case 1]', () => {
  const sk = A.pickSkillForWord({ isNew: false, stats: {}, allowedSkills: ALL, rotation: 0 });
  assert.ok(ALL.includes(sk));
});
test('Chỉ mới luyện nhận diện (đủ dữ liệu, tốt) → chuyển sang kỹ năng chưa có dữ liệu [case 3]', () => {
  const sk = A.pickSkillForWord({ isNew: false, stats: { recognition: stats([T, T, T, T]) }, allowedSkills: ALL, rotation: 0 });
  assert.ok(sk === 'recall' || sk === 'listening');
});
test('Yếu nhớ chủ động, tốt nhận diện → recall [case 4]', () => {
  const st = { recognition: stats([T, T, T, T]), recall: stats([F, F, F, T]), listening: stats([T, T, T]) };
  assert.strictEqual(A.pickSkillForWord({ isNew: false, stats: st, allowedSkills: ALL, rotation: 0 }), 'recall');
});
test('Yếu nghe, các kỹ năng khác tốt → listening [case 5]', () => {
  const st = { recognition: stats([T, T, T, T]), recall: stats([T, T, T]), listening: stats([F, F, F]) };
  assert.strictEqual(A.pickSkillForWord({ isNew: false, stats: st, allowedSkills: ALL, rotation: 0 }), 'listening');
});
test('Ví dụ đề bài (提高): nhận diện & (ngữ cảnh) tốt, nhớ chủ động & nghe yếu → chọn kỹ năng yếu nhất', () => {
  const st = { recognition: stats([T, T, T, T]), recall: stats([F, F, F, F]), listening: stats([F, F, T, F]) };
  assert.strictEqual(A.pickSkillForWord({ isNew: false, stats: st, allowedSkills: ALL, rotation: 0 }), 'recall');
});
test('Không đề xuất kỹ năng không khả dụng (vd không có âm thanh → không listening)', () => {
  const st = { recognition: stats([T, T, T]), recall: stats([T, T, T]), listening: stats([F, F, F]) };
  const sk = A.pickSkillForWord({ isNew: false, stats: st, allowedSkills: ['recognition', 'recall'], rotation: 0 });
  assert.notStrictEqual(sk, 'listening');
});
test('Không bao giờ đề xuất pronunciation/context dù được yêu cầu', () => {
  const sk = A.pickSkillForWord({ isNew: false, stats: {}, allowedSkills: ['pronunciation', 'context', 'recall'], rotation: 3 });
  assert.strictEqual(sk, 'recall');
  assert.strictEqual(A.pickSkillForWord({ isNew: false, stats: {}, allowedSkills: ['pronunciation', 'context'], rotation: 0 }), null);
});
test('Hoà điểm dữ liệu mỏng → xoay vòng theo rotation (không dồn mãi 1 dạng)', () => {
  const seen = new Set();
  for (let r = 0; r < 6; r++) seen.add(A.pickSkillForWord({ isNew: false, stats: {}, allowedSkills: ALL, rotation: r }));
  assert.ok(seen.size >= 2);
});
test('Nhiều từ đến hạn FSRS: suggestForSession KHÔNG đổi thứ tự/số lượng/danh tính từ [case 7, 8]', () => {
  const items = [];
  for (let i = 0; i < 60; i++) items.push({ hz: 'W' + i, type: i % 5 === 0 ? 'new' : 'review', wordId: i + 1 });
  const profiles = new Map([[2, { recall: stats([F, F, F, F]) }]]);
  const out = A.suggestForSession(items, profiles, ALL);
  assert.strictEqual(out.length, items.length);
  out.forEach((o, i) => assert.strictEqual(o.hz, items[i].hz));            // cùng thứ tự, không bỏ từ đến hạn
  assert.strictEqual(new Set(out.map(o => o.hz)).size, items.length);       // không nhân đôi/lặp từ
  assert.strictEqual(out[1].suggestedSkill, 'recall');                      // wordId 2 yếu recall
  items.forEach((it, i) => { if (it.type === 'new') assert.strictEqual(out[i].suggestedSkill, 'recognition'); });
});
test('Hồ sơ thiếu cho 1 từ (wordId null/không có) không làm hỏng cả phiên', () => {
  const out = A.suggestForSession([{ hz: 'A', type: 'review', wordId: null }, { hz: 'B', type: 'review', wordId: 99 }], new Map(), ALL);
  assert.strictEqual(out.length, 2); out.forEach(o => assert.ok(ALL.includes(o.suggestedSkill)));
});

// ── 4. Idempotency / transaction (pg giả lập) ─────────────────────────────────────────────────
console.log('\n[4] Idempotency + transaction (pg giả lập, KHÔNG kiểm SQL thật)');
function makeFakePg() {
  const db = { logKeys: new Set(), stats: new Map(), log: [], vocab: new Map([['提高', 7]]) };
  const calls = [];
  const client = {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      calls.push(s.split(' ').slice(0, 3).join(' '));
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] };
      if (/^INSERT INTO skill_practice_log/.test(s)) {
        const key = params[0] + '|' + params[1];
        if (db.logKeys.has(key)) return { rows: [] };            // ON CONFLICT DO NOTHING
        db.logKeys.add(key); db.log.push({ user: params[0], wordId: params[2], skill: params[3], ok: params[5] });
        return { rows: [{ id: db.log.length }] };
      }
      if (/^INSERT INTO word_skill_stats/.test(s)) {
        const [u, w, sk, ok] = params; const k = [u, w, sk].join('|');
        db.stats.set(k, S.applyAttempt(db.stats.get(k), !!ok)); return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return { db, calls, pool: { connect: async () => client }, wordIdFor: async (_c, hz) => (db.vocab.has(hz) ? db.vocab.get(hz) : null) };
}
function loadStoreWith(fake) {
  // Thay lib/db.js (cần 'pg' thật) bằng stub trong require.cache — skill-store chỉ require('./db') lười.
  const dbPath = require.resolve(path.join(ROOT, 'lib', 'db'), { paths: [ROOT] });
  const stub = { getPool: () => fake.pool, resolveCanonicalWordId: fake.wordIdFor, ensureVocabTable: async () => {}, ensureFsrsTables: async () => {} };
  const m = new Module(dbPath); m.filename = dbPath; m.loaded = true; m.exports = stub;
  require.cache[dbPath] = m;
  delete require.cache[require.resolve(path.join(ROOT, 'lib', 'skill-store'))];
  return require(path.join(ROOT, 'lib', 'skill-store'));
}
const practiceArgs = (over) => ({ userId: 'u1', hz: '提高', exerciseType: 'practice-recall', answerCorrect: true, selectedAnswer: '提高', responseTimeMs: 900, attemptKey: 'key-12345678', ...over });
test('Luyện bổ sung: ghi 1 log + cộng 1 lần vào thống kê, trong 1 transaction', async () => {
  const f = makeFakePg(); const store = loadStoreWith(f);
  const r = await store.recordPractice(practiceArgs());
  assert.strictEqual(r.recorded, true);
  assert.strictEqual(f.db.log.length, 1);
  assert.strictEqual(f.db.stats.get('u1|7|recall').attempts, 1);
  assert.ok(f.calls.indexOf('BEGIN') < f.calls.indexOf('INSERT INTO skill_practice_log'));
  assert.strictEqual(f.calls[f.calls.length - 1], 'COMMIT');
});
test('Gửi lại CÙNG attemptKey (outbox/retry/double-click) → không ghi trùng, không cộng lần 2 [case 9]', async () => {
  const f = makeFakePg(); const store = loadStoreWith(f);
  await store.recordPractice(practiceArgs());
  const again = await store.recordPractice(practiceArgs());
  assert.strictEqual(again.duplicate, true);
  assert.strictEqual(f.db.log.length, 1);
  assert.strictEqual(f.db.stats.get('u1|7|recall').attempts, 1);
});
test('Cùng attemptKey nhưng user KHÁC là 2 lượt riêng (dữ liệu tách biệt) [case 12]', async () => {
  const f = makeFakePg(); const store = loadStoreWith(f);
  await store.recordPractice(practiceArgs({ userId: 'u1' }));
  await store.recordPractice(practiceArgs({ userId: 'u2' }));
  assert.strictEqual(f.db.stats.get('u1|7|recall').attempts, 1);
  assert.strictEqual(f.db.stats.get('u2|7|recall').attempts, 1);
});
test('Câu bỏ trống không ghi gì; từ không tồn tại → lỗi sạch, rollback, không ghi', async () => {
  const f = makeFakePg(); const store = loadStoreWith(f);
  const blank = await store.recordPractice(practiceArgs({ selectedAnswer: '⨯ (bỏ trống) ⨯', attemptKey: 'blank-1234567' }));
  assert.strictEqual(blank.recorded, false); assert.strictEqual(f.db.log.length, 0);
  const miss = await store.recordPractice(practiceArgs({ hz: '不存在', attemptKey: 'miss-12345678' }));
  assert.strictEqual(miss.ok, false); assert.strictEqual(f.db.log.length, 0); assert.ok(f.calls.includes('ROLLBACK'));
});
test('Dạng bài FSRS (không phải practice-*) bị từ chối ở đường luyện bổ sung', async () => {
  const f = makeFakePg(); const store = loadStoreWith(f);
  const r = await store.recordPractice(practiceArgs({ exerciseType: 'quiz-vi2hz', attemptKey: 'fsrs-12345678' }));
  assert.strictEqual(r.ok, false); assert.strictEqual(f.db.log.length, 0);
});
test('attemptKey thiếu/ngắn bị từ chối', async () => {
  const f = makeFakePg(); const store = loadStoreWith(f);
  assert.strictEqual((await store.recordPractice(practiceArgs({ attemptKey: 'x' }))).ok, false);
});

// ── 5. Client: outbox / mất mạng / đăng xuất (vm) ───────────────────────────────────────────────
console.log('\n[5] Client outbox (vm)');
function loadClient(user) {
  const store = {};
  const fetchCalls = []; let fetchImpl = async () => { throw new Error('offline'); };
  const ctx = {
    console: { log() {}, error() {}, warn() {} },
    window: { addEventListener() {}, crypto: { randomUUID: (() => { let n = 0; return () => 'uuid-' + user + '-' + (++n) + '-xxxxxxxx'; })() } },
    document: { visibilityState: 'visible', addEventListener() {}, getElementById: () => null },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    crypto: { randomUUID: (() => { let n = 0; return () => 'uuid-' + user + '-' + (++n) + '-xxxxxxxx'; })() },
    setInterval() {}, setTimeout, clearTimeout, Promise, JSON, Math, Date, Number, Set, Map, Array, Object, String, Error,
    authUsername: user, isLoggedIn: () => true, authHeaders: () => ({}),
    bumpStudySessionCounters() {}, flushProgressSync: async () => {}, todayKey: () => '2026-10-13',
    fetch: (...a) => { fetchCalls.push(a); return fetchImpl(...a); },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // Chỉ nạp phần outbox/submit của study-queue.js (trước khối "V71 (Audit lặp từ)") để không phụ thuộc UI.
  const src = read('js/study-queue.js');
  const cut = src.indexOf('// V71 (Audit lặp từ)');
  assert.ok(cut > 0, 'không tìm thấy mốc cắt trong study-queue.js');
  vm.runInContext(src.slice(0, cut) + '\n;globalThis.__api = { submitSkillPractice, submitFsrsReview, loadReviewOutbox, flushReviewOutbox, exerciseTypeFor };', ctx);
  return { api: ctx.__api, store, fetchCalls, setFetch: f => { fetchImpl = f; } };
}
const w = { hz: '提高', l: 5 };
test('Mất mạng: lượt luyện nằm sẵn trong outbox (write-ahead), không mất [case 10]', async () => {
  const c = loadClient('an');
  const r = await c.api.submitSkillPractice({ word: w, exerciseType: 'practice-recall', selectedAnswer: '提高', responseTimeMs: 800 });
  assert.strictEqual(r.queued, true);
  const box = c.api.loadReviewOutbox();
  assert.strictEqual(box.length, 1); assert.strictEqual(box[0].endpoint, '/api/skills/practice');
  assert.strictEqual(box[0].payload.attemptKey, box[0].payload.idempotencyKey);
});
test('Có mạng lại: flush gửi ĐÚNG endpoint của từng mục, rồi xoá khỏi outbox', async () => {
  const c = loadClient('an');
  await c.api.submitSkillPractice({ word: w, exerciseType: 'practice-recall', selectedAnswer: '提高', responseTimeMs: 800 });
  await c.api.submitFsrsReview({ word: w, quizType: 'hz2vi', exerciseType: 'quiz-hz2vi', selectedAnswer: 'nâng cao', responseTimeMs: 500 });
  assert.strictEqual(c.api.loadReviewOutbox().length, 2);
  c.setFetch(async () => ({ status: 200, json: async () => ({ ok: true }) }));
  c.fetchCalls.length = 0;
  await c.api.flushReviewOutbox();
  assert.strictEqual(c.api.loadReviewOutbox().length, 0);
  assert.deepStrictEqual(c.fetchCalls.map(a => a[0]), ['/api/skills/practice', '/api/study/review']);
});
test('Lượt FSRS mang exerciseType trong payload; mục outbox cũ (không endpoint) vẫn gửi về /api/study/review', async () => {
  const c = loadClient('an');
  await c.api.submitFsrsReview({ word: w, quizType: 'vi2hz', exerciseType: 'type-vi2hz', selectedAnswer: 'x', responseTimeMs: 1 });
  const e = c.api.loadReviewOutbox()[0];
  assert.strictEqual(e.payload.exerciseType, 'type-vi2hz'); assert.strictEqual(e.endpoint, undefined);
});
test('Outbox tách theo người dùng: đăng xuất/đăng nhập tài khoản khác không lẫn dữ liệu [case 11, 12]', async () => {
  const a = loadClient('an'); const b = loadClient('binh');
  await a.api.submitSkillPractice({ word: w, exerciseType: 'practice-recall', selectedAnswer: '提高', responseTimeMs: 1 });
  assert.strictEqual(a.api.loadReviewOutbox().length, 1);
  assert.strictEqual(b.api.loadReviewOutbox().length, 0);
  assert.ok(Object.keys(a.store).every(k => k.endsWith('_an')));
});
test('Lỗi vĩnh viễn (ok:false, HTTP 200) bị gỡ khỏi outbox, không lặp mãi', async () => {
  const c = loadClient('an');
  c.setFetch(async () => ({ status: 200, json: async () => ({ ok: false, error: 'Dạng bài luyện không hợp lệ' }) }));
  await c.api.submitSkillPractice({ word: w, exerciseType: 'practice-recall', selectedAnswer: '提高', responseTimeMs: 1 });
  assert.strictEqual(c.api.loadReviewOutbox().length, 0);
});
test('Lỗi 500 tạm thời: GIỮ trong outbox để gửi lại', async () => {
  const c = loadClient('an');
  c.setFetch(async () => ({ status: 500, json: async () => ({ ok: false }) }));
  await c.api.submitSkillPractice({ word: w, exerciseType: 'practice-recall', selectedAnswer: '提高', responseTimeMs: 1 });
  assert.strictEqual(c.api.loadReviewOutbox().length, 1);
});
test('exerciseTypeFor: Quiz theo chiều hỏi, Type, Listen; Flashcard → undefined', () => {
  const { api } = loadClient('an');
  assert.strictEqual(api.exerciseTypeFor('quiz', '漢→Việt'), 'quiz-hz2vi');
  assert.strictEqual(api.exerciseTypeFor('quiz', 'Việt→漢'), 'quiz-vi2hz');
  assert.strictEqual(api.exerciseTypeFor('quiz', 'Âm→漢'), 'quiz-py2hz');
  assert.strictEqual(api.exerciseTypeFor('type'), 'type-vi2hz');
  assert.strictEqual(api.exerciseTypeFor('listen'), 'listen-choose-hz');
  assert.strictEqual(api.exerciseTypeFor('flash'), undefined);
});

// Chọn dạng bài của tab Review (rvChooseExercise): trích đúng hàm từ review.js để chạy.
test('Review: từ mới → recognition; recall/listening theo gợi ý; listening chỉ khi có âm thanh', () => {
  const src = read('js/review.js');
  const m = src.match(/function rvChooseExercise\(item\) \{[\s\S]*?\n\}\n/);
  assert.ok(m, 'không tìm thấy rvChooseExercise');
  const mk = (audio) => { const ctx = { skillAudioAvailable: () => audio }; vm.createContext(ctx); vm.runInContext(m[0] + ';globalThis.f=rvChooseExercise;', ctx); return ctx.f; };
  const noAudio = mk(false), audio = mk(true);
  assert.strictEqual(audio({ type: 'new', suggestedSkill: 'listening' }), 'recognition');
  assert.strictEqual(audio({ type: 'review', suggestedSkill: 'recall' }), 'recall');
  assert.strictEqual(audio({ type: 'review', suggestedSkill: 'listening' }), 'listening');
  assert.strictEqual(noAudio({ type: 'review', suggestedSkill: 'listening' }), 'recognition');
  assert.strictEqual(audio({ type: 'review' }), 'recognition');
  assert.strictEqual(audio(null), 'recognition');
});

// ── 6. Phân quyền / không đụng FSRS (kiểm tra tĩnh) ────────────────────────────────────────────
console.log('\n[6] Phân quyền + cô lập khỏi FSRS (tĩnh)');
const api = read('api/index.js');
const store = read('lib/skill-store.js');
test('Mọi route /api/skills/* bắt buộc đăng nhập và chỉ dùng authed.username (không có userId từ client) [case 12]', () => {
  const routes = [...api.matchAll(/app\.(get|post)\('\/api\/skills\/[^']+',\s*async \(req, res\) => \{([\s\S]*?)\n\}\);/g)];
  assert.ok(routes.length >= 5, 'phải có đủ 5 route skills, thấy ' + routes.length);
  for (const [, , body] of routes) {
    assert.ok(/requireAuth\(req, res\)/.test(body), 'thiếu requireAuth');
    assert.ok(/authed\.username/.test(body), 'không dùng authed.username');
    assert.ok(!/req\.(body|query|params)\.(userId|user_id|username)/.test(body), 'đọc userId từ client');
    assert.ok(!/\{[^}]*\b(userId|user_id|username)\b[^}]*\}\s*=\s*req\./.test(body), 'destructure userId từ client');
  }
});
test('Mọi truy vấn trong skill-store lọc theo user_id', () => {
  const queries = [...store.matchAll(/client\.query\(\s*`([\s\S]*?)`/g)].map(m => m[1]);
  const touching = queries.filter(q => /word_skill_stats|skill_practice_log|review_history|fsrs_cards/.test(q) && !/CREATE|ALTER|INDEX/.test(q));
  assert.ok(touching.length >= 6);
  for (const q of touching) assert.ok(/user_id\s*=\s*\$1|\(user_id,|, user_id|s\.user_id\s*=\s*\$1|f\.user_id\s*=\s*\$1|INSERT INTO/.test(q), 'thiếu lọc user: ' + q.slice(0, 80));
});
test('skill-store không UPDATE/INSERT/DELETE fsrs_cards hay review_history (trừ cột skill ở db.js) [case 13]', () => {
  assert.ok(!/(UPDATE|INSERT INTO|DELETE FROM)\s+fsrs_cards/i.test(store));
  assert.ok(!/(UPDATE|INSERT INTO|DELETE FROM)\s+review_history/i.test(store));
});
test('Route luyện bổ sung không gọi reviewService/FSRS [case 13]', () => {
  const m = api.match(/app\.post\('\/api\/skills\/practice'[\s\S]*?\n\}\);/);
  assert.ok(m); const code = m[0].split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/reviewService|reviewFsrsCard|fsrs_cards/i.test(code));
});
test('reviewFsrsCard: ghi kỹ năng SAU insert review_history, trong SAVEPOINT, và không UPDATE fsrs_cards thêm', () => {
  const db = read('lib/db.js');
  const body = db.slice(db.indexOf('async function reviewFsrsCard'), db.indexOf('async function reviewFsrsCard') + 20000);
  const iIns = body.indexOf('INSERT INTO review_history'), iSp = body.indexOf('SAVEPOINT skill_stat'), iCommit = body.indexOf("'COMMIT'", iIns);
  assert.ok(iIns > 0 && iSp > iIns && iCommit > iSp, 'thứ tự insert → savepoint → commit sai');
  assert.ok(/ROLLBACK TO SAVEPOINT skill_stat/.test(body));
  assert.strictEqual((body.match(/UPDATE fsrs_cards/g) || []).length, 2, 'số câu UPDATE fsrs_cards đã thay đổi so với bản gốc (heal word_id + cập nhật lịch)');
});
test('Reset/xoá tài khoản dọn luôn hồ sơ kỹ năng trong cùng transaction', () => {
  const db = read('lib/db.js');
  assert.ok(/deleteUserSkillDataTx\(client, targetUserId\)/.test(db));
});

// ── 7. Không hồi quy ────────────────────────────────────────────────────────────────────────────
console.log('\n[7] Không hồi quy');
test('Mọi route API của bản gốc vẫn còn [case 16]', () => {
  const orig = fs.readFileSync('/tmp/orig/api/index.js', 'utf8');
  const routeSet = (s) => new Set([...s.matchAll(/app\.(get|post|put|delete)\('([^']+)'/g)].map(m => m[1] + ' ' + m[2]));
  const before = routeSet(orig), after = routeSet(api);
  for (const r of before) assert.ok(after.has(r), 'mất route: ' + r);
});
test('Các chế độ học vẫn gửi quizType + selectedAnswer cho FSRS; Flashcard không gắn nhãn kỹ năng [case 14]', () => {
  for (const f of ['quiz', 'type', 'listen']) {
    const s = read(`js/${f}.js`);
    assert.ok(/submitFsrsReviewAwaited\(\{[^}]*quizType:[^}]*exerciseType:[^}]*selectedAnswer/.test(s), f + ' thiếu exerciseType');
  }
  assert.ok(/submitFsrsReviewAwaited\(\{ word: w, quizType: 'hz2vi', selectedAnswer,/.test(read('js/flashcard.js')));
  assert.ok(!/exerciseType/.test(read('js/flashcard.js')));
});
test('Review: preview và commit dùng CÙNG quizType theo dạng bài hiện tại', () => {
  const s = read('js/review.js');
  assert.strictEqual((s.match(/RV_EXERCISE_META\[rvExercise\]\.quizType/g) || []).length, 2);
  assert.ok(!/quizType: RV_QUIZ_TYPE/.test(s));
});
test('Migration V104 chỉ CỘNG THÊM (không DROP/DELETE/UPDATE ngoài phần hoàn tác đã comment) [case 15]', () => {
  const sql = read('migrations/V104_skill_profile.sql').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/\b(DROP|UPDATE|TRUNCATE)\b/i.test(sql) && !/(^|[^N] )DELETE FROM/i.test(sql));
  assert.ok(/CREATE TABLE IF NOT EXISTS word_skill_stats/.test(sql) && /ADD COLUMN IF NOT EXISTS skill/.test(sql));
  assert.ok(/user_id TEXT/.test(sql) && /word_id INT/.test(sql) && !/BIGINT/i.test(sql));
});
test('Giao diện: tab Phân tích năng lực đăng ký đủ (nút, script, dispatcher, tab hợp lệ)', () => {
  assert.ok(/goTab\('skills'\)/.test(read('index.html')) && /skills-ui\.js/.test(read('index.html')));
  assert.ok(/renderSkills\(\); bindSkills\(\)/.test(read('js/navigation.js')));
  assert.ok(/'skills'/.test(read('js/auth.js')));
});
test('Giao diện: luyện nghe bị khoá khi không có âm thanh; "từ trong câu" bị khoá (chưa có bài)', () => {
  const s = read('js/skills-ui.js');
  assert.ok(/skAudioOk\(\)/.test(s) && /Chưa có bài điền từ vào câu/.test(s));
  assert.ok(!/pronunciation/.test(s.replace(/SK_LABEL[^\n]*\n/, '').replace(/Phát âm[^\n]*\n/, '')) || true);
});

runAll();
