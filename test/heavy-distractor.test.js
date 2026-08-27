#!/usr/bin/env node
// ════════════════════════════════════════════════════
// test/heavy-distractor.test.js — Unit test THUẦN cho js/distractor-engine.js (V86: HEAVY
// DISTRACTOR / MAXIMUM SIMILARITY). Chạy js/data.js + js/distractor-engine.js thật (không mock
// lại logic) trong 1 sandbox (Node `vm`) — 2 file này không đụng DOM/mạng nên chạy được thẳng
// ngoài trình duyệt. KHÔNG cần DATABASE_URL/Postgres, KHÔNG gọi mạng.
//
// File này CHỈ test bộ sinh distractor (QUESTION → OPTIONS). KHÔNG test/đụng tới FSRS —
// lib/fsrs*, api/study/review, reviewService... giữ nguyên 100%, xem test/fsrs*.test.js riêng.
//
// Chạy: node test/heavy-distractor.test.js  (hoặc: npm run test:distractor)
// ════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DATA_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');
const ENGINE_PATH = path.join(__dirname, '..', 'js', 'distractor-engine.js');
const ENGINE_SRC = fs.readFileSync(ENGINE_PATH, 'utf8');

// Sandbox mới cho MỖI lần gọi — tránh 1 test rò rỉ dbHanziParts/WORDS sang test khác.
// shuffle() dùng identity (không xáo trộn) để test tất định — các test dưới đây so sánh THEO TẬP
// HỢP/THỨ TỰ ĐIỂM SỐ (đúng thứ tự pickHeavyDistractors trả về), không phụ thuộc Math.random.
function loadEngine(dbHanziParts) {
  const sandbox = { console, dbHanziParts: dbHanziParts || {}, shuffle: (arr) => arr.slice() };
  vm.createContext(sandbox);
  vm.runInContext(DATA_SRC, sandbox, { filename: 'data.js' });
  vm.runInContext(ENGINE_SRC, sandbox, { filename: 'distractor-engine.js' });
  return sandbox;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
  }
}

console.log('════════════════════════════════════════════════════');
console.log('V86 HEAVY DISTRACTOR ENGINE — unit tests (không cần Postgres, không mạng)');
console.log('════════════════════════════════════════════════════');

// ────────────────────────────────────────────────────
console.log('\n[Không phụ thuộc mạng / dependency nặng]');
test('distractor-engine.js không gọi fetch/XHR/import mạng nào', () => {
  assert.ok(!/\bfetch\s*\(/.test(ENGINE_SRC), 'không được gọi fetch()');
  assert.ok(!/XMLHttpRequest/.test(ENGINE_SRC), 'không được dùng XMLHttpRequest');
  assert.ok(!/require\s*\(/.test(ENGINE_SRC), 'không thêm dependency ngoài (require)');
});

// ────────────────────────────────────────────────────
console.log('\n[ACCEPTANCE TEST — nhóm 清/情/晴/请/精/静/青, dữ liệu chiết tự mô phỏng]');

// Chiết tự mô phỏng đúng cấu tạo thật: 清=氵+青, 情=忄+青, 晴=日+青, 请=讠+青, 精=米+青, 静=青+争,
// 青 là chữ tượng hình gốc (không tách được thêm) — giống hệt phong cách dữ liệu HANZI_PARTS/
// dbHanziParts thật trong project (xem js/data.js, js/flashcard.js:loadHanziParts).
const qingFamilyParts = {
  '清': { type: 'parts', items: [{ c: '氵', m: 'nước' }, { c: '青', m: 'xanh (âm)' }] },
  '情': { type: 'parts', items: [{ c: '忄', m: 'tâm' }, { c: '青', m: 'xanh (âm)' }] },
  '晴': { type: 'parts', items: [{ c: '日', m: 'mặt trời' }, { c: '青', m: 'xanh (âm)' }] },
  '请': { type: 'parts', items: [{ c: '讠', m: 'lời nói' }, { c: '青', m: 'xanh (âm)' }] },
  '精': { type: 'parts', items: [{ c: '米', m: 'gạo' }, { c: '青', m: 'xanh (âm)' }] },
  '静': { type: 'parts', items: [{ c: '青', m: 'xanh (âm)' }, { c: '争', m: 'tranh giành' }] },
  '青': { type: 'note', text: 'Tượng hình, không tách được.' },
};
const target_qing = { hz: '清', py: 'qīng', vi: 'trong, sạch (nước)', l: 5, tag: 'tinhtu' };
const qingPool = [
  { hz: '情', py: 'qíng', vi: 'tình cảm', l: 5, tag: 'danhtu' },
  { hz: '晴', py: 'qíng', vi: 'trời nắng, quang đãng', l: 5, tag: 'tinhtu' },
  { hz: '请', py: 'qǐng', vi: 'mời, xin', l: 3, tag: 'dongtu' },
  { hz: '精', py: 'jīng', vi: 'tinh tuý, tinh vi', l: 8, tag: 'tinhtu' },
  { hz: '静', py: 'jìng', vi: 'yên tĩnh', l: 6, tag: 'tinhtu' },
  { hz: '青', py: 'qīng', vi: 'xanh (màu)', l: 4, tag: 'tinhtu' },
  // Từ KHÔNG liên quan — khác hẳn hình/âm/nghĩa, phải bị xếp SAU cả nhóm 青 ở trên
  { hz: '学', py: 'xué', vi: 'học', l: 1, tag: 'dongtu' },
  { hz: '水', py: 'shuǐ', vi: 'nước', l: 1, tag: 'danhtu' },
  { hz: '吃', py: 'chī', vi: 'ăn', l: 1, tag: 'dongtu' },
  { hz: '猫', py: 'māo', vi: 'con mèo', l: 2, tag: 'danhtu' },
];

test('target 清: top-3 distractor đều thuộc nhóm 青 (KHÔNG random, KHÔNG lẫn từ chẳng liên quan)', () => {
  const s = loadEngine(qingFamilyParts);
  const top3 = s.pickHeavyDistractors(target_qing, qingPool, 3, { mode: 'text', answerField: 'hz' }).map(x => x.hz);
  assert.strictEqual(top3.length, 3);
  const qingFamily = new Set(['情', '晴', '请', '精', '静', '青']);
  const unrelated = new Set(['学', '水', '吃', '猫']);
  top3.forEach(hz => {
    assert.ok(qingFamily.has(hz), `${hz} phải thuộc nhóm 青 dễ nhầm, không phải distractor yếu`);
    assert.ok(!unrelated.has(hz), `${hz} là từ không liên quan, không được lọt top-3`);
  });
});

test('scoreDistractor: 清 vs 情/晴/请/精/静/青 luôn cao hơn hẳn 清 vs 学/水/吃/猫', () => {
  const s = loadEngine(qingFamilyParts);
  const relatedMin = Math.min(...['情', '晴', '请', '精', '静', '青'].map(hz =>
    s.scoreDistractor(target_qing, qingPool.find(x => x.hz === hz), { mode: 'text' })));
  const unrelatedMax = Math.max(...['学', '水', '吃', '猫'].map(hz =>
    s.scoreDistractor(target_qing, qingPool.find(x => x.hz === hz), { mode: 'text' })));
  assert.ok(relatedMin > unrelatedMax, `điểm thấp nhất nhóm liên quan (${relatedMin}) phải > điểm cao nhất nhóm không liên quan (${unrelatedMax})`);
});

// ────────────────────────────────────────────────────
console.log('\n[ACCEPTANCE TEST — nhóm 木/本/未/末/休/林 ưu tiên hơn 明/学/水]');

const muFamilyParts = {
  '木': { type: 'note', text: 'Tượng hình: hình cây.' },
  '本': { type: 'parts', items: [{ c: '木', m: 'cây' }, { c: '一', m: 'gốc rễ' }] },
  '末': { type: 'parts', items: [{ c: '木', m: 'cây' }, { c: '一', m: 'ngọn' }] },
  '未': { type: 'parts', items: [{ c: '木', m: 'cây' }, { c: '一', m: 'nét ngang ngắn' }] },
  '休': { type: 'parts', items: [{ c: '亻', m: 'người' }, { c: '木', m: 'cây' }] },
  '林': { type: 'parts', items: [{ c: '木', m: 'cây' }] },
  '明': { type: 'parts', items: [{ c: '日', m: 'mặt trời' }, { c: '月', m: 'mặt trăng' }] },
};
const target_mu = { hz: '木', py: 'mù', vi: 'cây, gỗ', l: 2, tag: 'danhtu' };
const muPool = [
  { hz: '本', py: 'běn', vi: 'gốc, quyển (l.từ sách)', l: 1, tag: 'danhtu' },
  { hz: '未', py: 'wèi', vi: 'chưa', l: 3, tag: 'phutu' },
  { hz: '末', py: 'mò', vi: 'cuối, ngọn', l: 6, tag: 'danhtu' },
  { hz: '休', py: 'xiū', vi: 'nghỉ ngơi', l: 4, tag: 'dongtu' },
  { hz: '林', py: 'lín', vi: 'rừng', l: 5, tag: 'danhtu' },
  { hz: '明', py: 'míng', vi: 'sáng, rõ ràng', l: 2, tag: 'tinhtu' },
  { hz: '学', py: 'xué', vi: 'học', l: 1, tag: 'dongtu' },
  { hz: '水', py: 'shuǐ', vi: 'nước', l: 1, tag: 'danhtu' },
];

test('target 木: ưu tiên 本/未/末/休/林 hơn 明/学/水 — đúng ví dụ ACCEPTANCE TEST trong yêu cầu', () => {
  const s = loadEngine(muFamilyParts);
  const top3 = s.pickHeavyDistractors(target_mu, muPool, 3, { mode: 'text', answerField: 'hz' }).map(x => x.hz);
  const deprioritized = new Set(['明', '学', '水']);
  top3.forEach(hz => assert.ok(!deprioritized.has(hz), `${hz} phải bị xếp SAU 本/未/末/休/林, không được vào top-3`));
});

// ────────────────────────────────────────────────────
console.log('\n[Không duplicate / luôn loại target khỏi chính distractor của nó]');

test('pool có hz trùng lặp (cùng chữ ở nhiều bài khác nhau) → kết quả KHÔNG duplicate', () => {
  const s = loadEngine({});
  const target = { hz: 'A', py: 'a', vi: 'nghĩa A', l: 1 };
  const pool = [
    { hz: 'B', py: 'b', vi: 'nghĩa B', l: 1 },
    { hz: 'B', py: 'b', vi: 'nghĩa B (bài khác)', l: 7 }, // cùng hz B, khác bài — phải bị khử trùng
    { hz: 'C', py: 'c', vi: 'nghĩa C', l: 2 },
    { hz: 'D', py: 'd', vi: 'nghĩa D', l: 3 },
  ];
  const picked = s.pickHeavyDistractors(target, pool, 3, {});
  const hzList = picked.map(x => x.hz);
  assert.strictEqual(new Set(hzList).size, hzList.length, 'không được có 2 option cùng hz');
  assert.strictEqual(hzList.length, 3, 'đủ 3 vì pool có đủ 3 hz khác nhau (B/C/D)');
});

test('target không bao giờ xuất hiện trong chính danh sách distractor của nó', () => {
  const s = loadEngine({});
  const target = { hz: 'A', py: 'a', vi: 'nghĩa A', l: 1 };
  const pool = [target, { hz: 'B', py: 'b', vi: 'nghĩa B', l: 1 }, { hz: 'C', py: 'c', vi: 'nghĩa C', l: 1 }];
  const picked = s.pickHeavyDistractors(target, pool, 3, {});
  assert.ok(!picked.some(x => x.hz === target.hz));
});

// ────────────────────────────────────────────────────
console.log('\n[FALLBACK — pool ít hơn số lượng cần, KHÔNG bịa/duplicate, không crash]');

test('pool chỉ có 1 ứng viên hợp lệ, cần 3 → trả về đúng 1, không lỗi, không bịa thêm', () => {
  const s = loadEngine({});
  const target = { hz: 'A', py: 'a', vi: 'nghĩa A', l: 1 };
  const pool = [{ hz: 'B', py: 'b', vi: 'nghĩa B', l: 1 }];
  const picked = s.pickHeavyDistractors(target, pool, 3, {});
  assert.strictEqual(picked.length, 1);
  assert.strictEqual(picked[0].hz, 'B');
});

test('pool rỗng → trả về mảng rỗng, không throw', () => {
  const s = loadEngine({});
  const target = { hz: 'A', py: 'a', vi: 'nghĩa A', l: 1 };
  assert.deepStrictEqual(s.pickHeavyDistractors(target, [], 3, {}), []);
});

// ────────────────────────────────────────────────────
console.log('\n[HARD ≠ AMBIGUOUS — chặn đồng nghĩa hoàn toàn khi field chấm đáp án là nghĩa (vi)]');

test("answerField:'vi' → loại thẳng ứng viên có nghĩa TRÙNG HỆT target (không chỉ hạ điểm)", () => {
  const s = loadEngine({});
  const target = { hz: '高兴', py: 'gāoxìng', vi: 'vui, vui vẻ', l: 1 };
  const pool = [
    { hz: '快乐', py: 'kuàilè', vi: 'vui, vui vẻ', l: 3 }, // trùng hệt nghĩa — PHẢI bị loại khi chấm theo vi
    { hz: '难过', py: 'nánguò', vi: 'buồn', l: 4 },
    { hz: '生气', py: 'shēngqì', vi: 'tức giận', l: 4 },
  ];
  const picked = s.pickHeavyDistractors(target, pool, 3, { answerField: 'vi' });
  assert.ok(!picked.some(x => x.hz === '快乐'), '快乐 đồng nghĩa hoàn toàn với target, phải bị loại khi answerField=vi');
  assert.strictEqual(picked.length, 2);
});

test("answerField:'hz' → KHÔNG loại từ đồng nghĩa (đáp án đang chấm là mặt chữ Hán, không mơ hồ)", () => {
  const s = loadEngine({});
  const target = { hz: '高兴', py: 'gāoxìng', vi: 'vui, vui vẻ', l: 1 };
  const pool = [
    { hz: '快乐', py: 'kuàilè', vi: 'vui, vui vẻ', l: 3 },
    { hz: '难过', py: 'nánguò', vi: 'buồn', l: 4 },
  ];
  const picked = s.pickHeavyDistractors(target, pool, 2, { answerField: 'hz' });
  assert.strictEqual(picked.length, 2, '快乐 KHÔNG bị loại vì đáp án đang chấm là hz, không phải vi');
});

// ────────────────────────────────────────────────────
console.log('\n[LISTENING ĐẶC BIỆT — ưu tiên pinyin/thanh điệu hơn hẳn hình chữ khi mode=listening]');

// Dùng 3 chữ Hán CÓ THẬT nhưng KHÔNG nằm trong CONFUSE_GROUPS/SEMANTIC_GROUPS thật của project
// (甲/乙/丙 — để tránh cộng dồn điểm "đã kiểm chứng thủ công" làm nhiễu phép so sánh thuần
// hình-vs-âm), và gán component/pinyin GIẢ LẬP tách bạch tuyệt đối 2 tín hiệu:
//   乙 chỉ chung COMPONENT với 甲 (gần HÌNH), âm đọc hoàn toàn khác.
//   丙 chỉ chung ÂM (cùng base pinyin, khác thanh) với 甲, KHÔNG chung component/chữ nào.
const shapeVsSoundParts = {
  '甲': { type: 'parts', items: [{ c: 'comp-A', m: '' }, { c: 'comp-B', m: '' }] },
  '乙': { type: 'parts', items: [{ c: 'comp-A', m: '' }, { c: 'comp-C', m: '' }] }, // chung comp-A → GẦN HÌNH
  '丙': { type: 'parts', items: [{ c: 'comp-X', m: '' }] }, // không chung component nào
};
const target_jia = { hz: '甲', py: 'jiā', vi: 'giáp, số 1', l: 9 };
const shapeOnly = { hz: '乙', py: 'wō', vi: 'nghĩa khác hẳn', l: 9 };  // gần HÌNH, âm 'wō' rất khác 'jiā'
const soundOnly = { hz: '丙', py: 'jiá', vi: 'nghĩa khác hẳn nữa', l: 9 }; // gần ÂM (cùng base "jia"), khác thanh, không chung hình

test("mode:'listening' xếp ứng viên gần ÂM ĐỌC lên trên ứng viên CHỈ gần HÌNH CHỮ", () => {
  const s = loadEngine(shapeVsSoundParts);
  const scoreShape = s.scoreDistractor(target_jia, shapeOnly, { mode: 'listening' });
  const scoreSound = s.scoreDistractor(target_jia, soundOnly, { mode: 'listening' });
  assert.ok(scoreSound > scoreShape, `Nghe phải ưu tiên gần ÂM (${scoreSound}) hơn gần HÌNH thuần tuý (${scoreShape})`);
});

test("mode:'text' (không phải Nghe) thì gần HÌNH vẫn cạnh tranh được với gần ÂM (không bị bỏ qua)", () => {
  const s = loadEngine(shapeVsSoundParts);
  const scoreShape = s.scoreDistractor(target_jia, shapeOnly, { mode: 'text' });
  const scoreSound = s.scoreDistractor(target_jia, soundOnly, { mode: 'text' });
  assert.ok(scoreShape > 0, 'vẫn phải nhận điểm dương nhờ component dù âm đọc khác nhau');
  // Ở mode 'text' (Chọn đáp án/Trắc nghiệm hz→vi, Việt→hz), tín hiệu hình/component (component
  // cấu tạo chữ) không bị pinyin lấn át hoàn toàn như ở mode 'listening'.
  assert.ok(scoreShape >= scoreSound * 0.5, 'trọng số hình ở mode text không được yếu hơn hẳn âm như ở mode listening');
});

// ────────────────────────────────────────────────────
console.log('\n[Curated CONFUSE_GROUPS thật trong data.js — 未/末 đã có sẵn trong project]');

test('CONFUSE_GROUPS thật (data.js) đẩy 未 vs 末 lên rất cao so với từ ngẫu nhiên khác', () => {
  const s = loadEngine({});
  const target = { hz: '未', py: 'wèi', vi: 'chưa', l: 3 };
  const curated = { hz: '末', py: 'mò', vi: 'cuối, ngọn', l: 6 };
  const random = { hz: '爱好', py: 'àihào', vi: 'sở thích', l: 9 };
  const sCurated = s.scoreDistractor(target, curated, { mode: 'text' });
  const sRandom = s.scoreDistractor(target, random, { mode: 'text' });
  assert.ok(sCurated > sRandom, 'cặp đã kiểm chứng thủ công (未/末) phải luôn thắng từ không liên quan');
});

// ────────────────────────────────────────────────────
console.log('\n[Sắp xếp GIẢM DẦN, không phải random — 100% ưu tiên heaviest]');

test('pickHeavyDistractors trả về ĐÚNG top-N theo điểm giảm dần (không random)', () => {
  const s = loadEngine(qingFamilyParts);
  const scored = qingPool.map(x => ({ hz: x.hz, sc: s.scoreDistractor(target_qing, x, { mode: 'text' }) }));
  scored.sort((a, b) => b.sc - a.sc);
  const expectedTop3 = scored.slice(0, 3).map(x => x.hz);
  const actualTop3 = s.pickHeavyDistractors(target_qing, qingPool, 3, { mode: 'text' }).map(x => x.hz);
  assert.deepStrictEqual(actualTop3, expectedTop3);
});

// ────────────────────────────────────────────────────
console.log('\n[makeQuizOpts — luôn đủ số lượng, luôn có đáp án đúng, dùng đúng pool truyền vào]');

test('makeQuizOpts trả về đúng 4 phần tử (1 đúng + 3 distractor), có mặt target', () => {
  const s = loadEngine(qingFamilyParts);
  const opts = s.makeQuizOpts(target_qing, qingPool, { mode: 'text', answerField: 'hz' });
  assert.strictEqual(opts.length, 4);
  assert.ok(opts.some(o => o.hz === target_qing.hz));
  const hzSet = new Set(opts.map(o => o.hz));
  assert.strictEqual(hzSet.size, 4, 'không được có 2 option trùng hz trong 4 lựa chọn cuối cùng');
});

// ────────────────────────────────────────────────────
console.log('\n[KHÔNG ảnh hưởng FSRS — chỉ khẳng định KHÔNG có tham chiếu nào tới lớp FSRS trong engine]');

test('distractor-engine.js không tham chiếu reviewService/FSRS/rating/scheduler trong CODE THẬT (bỏ qua comment giải thích)', () => {
  // Bỏ dòng comment // trước khi kiểm tra — file này CÓ nhắc tới "FSRS"/"reviewService" trong lời
  // giải thích ở đầu file (nói rõ KHÔNG đụng vào), điều đó không phải là vi phạm; vi phạm thật là
  // nếu CODE (ngoài comment) gọi/import/tham chiếu tới các khái niệm đó.
  const codeOnly = ENGINE_SRC.split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n');
  const forbidden = /reviewService|fsrs|scheduler|Rating\.|\bstability\b|\bdifficulty\b|retrievability|optimizer/i;
  assert.ok(!forbidden.test(codeOnly), 'engine phải HOÀN TOÀN tách biệt khỏi lớp FSRS — chỉ quyết định OPTIONS (chỉ được nhắc trong comment giải thích, không trong code)');
});

// ────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════');
console.log(`KẾT QUẢ: ${passed} passed, ${failed} failed`);
console.log('════════════════════════════════════════════════════');
if (failed > 0) process.exit(1);
