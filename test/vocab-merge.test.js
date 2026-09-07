#!/usr/bin/env node
// ════════════════════════════════════════════════════
// test/vocab-merge.test.js — Unit test THUẦN cho lib/vocab-merge.js (Phần "audit thống nhất từ
// vựng giữa các bài" — V93). KHÔNG cần DATABASE_URL/Postgres/pg/ts-fsrs — lib/vocab-merge.js
// không require bất kỳ dependency ngoài nào, nên file test này chạy được ngay cả TRƯỚC khi chạy
// `npm install` (khác test/fsrs.test.js vốn cần `ts-fsrs` đã cài qua lib/fsrs.js).
//
// Cover trực tiếp các case bắt buộc ở Phần 14 của yêu cầu audit mà KHÔNG cần Postgres:
//   Case 3  — thêm từ đã tồn tại + overwrite OFF -> giữ nguyên metadata cũ.
//   Case 4  — thêm từ đã tồn tại + overwrite ON  -> merge field theo quy tắc "đầy đủ hơn".
//   Case 6  — import Excel trùng với metadata đầy đủ hơn -> merge đúng, không mất dữ liệu.
//   Case 9  — 2 vocabulary trùng cùng có FSRS của 1 user -> chọn thẻ sống sót deterministic.
//   Case 11 — metadata mới có field rỗng -> KHÔNG được xoá dữ liệu cũ.
//   Case 12 — chạy lại lần 2 (idempotent) -> không đổi/tạo thêm gì khi input đã sạch.
//
// Chạy: node test/vocab-merge.test.js
// ════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');
const {
  mergeFuller, mergeSticky, mergeMeaning, mergeVocabRecords,
  pickCanonical, mergeManyVocabRecords, pickSurvivingFsrsCard, groupBy,
} = require(path.join(__dirname, '..', 'lib', 'vocab-merge'));

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
console.log('vocab-merge — unit tests (không cần Postgres/npm install)');
console.log('════════════════════════════════════════════════════');

console.log('\n[mergeFuller — Pinyin: ưu tiên chuỗi đầy đủ hơn, không rỗng-ghi-đè]');

test('mới đầy đủ hơn (dài hơn) -> chọn mới', () => {
  assert.strictEqual(mergeFuller('nihao', 'nǐ hǎo'), 'nǐ hǎo');
});
test('mới rỗng -> GIỮ NGUYÊN cũ (Case 11 — field rỗng không được xoá dữ liệu cũ)', () => {
  assert.strictEqual(mergeFuller('xuéxí', ''), 'xuéxí');
  assert.strictEqual(mergeFuller('xuéxí', null), 'xuéxí');
  assert.strictEqual(mergeFuller('xuéxí', undefined), 'xuéxí');
});
test('cũ rỗng, mới có giá trị -> nhận giá trị mới', () => {
  assert.strictEqual(mergeFuller('', 'xuéxí'), 'xuéxí');
});
test('độ dài bằng nhau -> ưu tiên giá trị mới (ý định cập nhật có chủ đích)', () => {
  assert.strictEqual(mergeFuller('abcde', 'xyzzz'), 'xyzzz');
});

console.log('\n[mergeSticky — tag: không tự động xoá tag cũ chỉ vì form mới không tick]');

test('mới có tag -> dùng tag mới', () => {
  assert.strictEqual(mergeSticky(null, 'ly_hop'), 'ly_hop');
});
test('mới KHÔNG có tag (rỗng/null) -> GIỮ nguyên tag cũ, không xoá (fix so với hành vi cũ)', () => {
  assert.strictEqual(mergeSticky('ly_hop', null), 'ly_hop');
  assert.strictEqual(mergeSticky('ly_hop', ''), 'ly_hop');
});

console.log('\n[mergeMeaning — hợp nhất nghĩa tiếng Việt, không mất cụm nghĩa nào]');

test('ví dụ mẫu trong yêu cầu: cũ "học", mới "học; học tập; học hỏi" -> chọn nguyên mới (đã bao hàm cũ)', () => {
  assert.strictEqual(mergeMeaning('học', 'học; học tập; học hỏi'), 'học; học tập; học hỏi');
});
test('2 nghĩa khác nhau, không cái nào chứa cái kia -> merge có kiểm soát, giữ cả 2 (Phần 5)', () => {
  assert.strictEqual(mergeMeaning('học tập', 'học hỏi'), 'học tập; học hỏi');
});
test('mới rỗng -> giữ nguyên nghĩa cũ, KHÔNG được xoá (Case 11)', () => {
  assert.strictEqual(mergeMeaning('học tập; học hỏi', ''), 'học tập; học hỏi');
});
test('trùng lặp cụm nghĩa (khác hoa/thường, khoảng trắng thừa) -> không nhân đôi', () => {
  assert.strictEqual(mergeMeaning('Học tập', ' học tập ; học hỏi'), 'Học tập; học hỏi');
});
test('cũ rỗng -> dùng nguyên mới', () => {
  assert.strictEqual(mergeMeaning('', 'học tập'), 'học tập');
});

console.log('\n[mergeVocabRecords — Case 3/4: overwrite OFF giữ nguyên, ON merge có kiểm soát]');

test('Case 3 — overwrite OFF: giữ NGUYÊN 100% metadata cũ dù dữ liệu mới khác', () => {
  const existing = { hz: '学习', py: 'xuéxí', vi: 'học', tag: null, hanviet: 'Học tập' };
  const incoming = { hz: '学习', py: 'xué xí (mới)', vi: 'học tập; nghiên cứu', tag: 'ly_hop' };
  const r = mergeVocabRecords(existing, incoming, false);
  assert.strictEqual(r.py, 'xuéxí');
  assert.strictEqual(r.vi, 'học');
  assert.strictEqual(r.tag, null);
  assert.strictEqual(r.hanviet, 'Học tập');
  assert.strictEqual(r.changed, false);
});

test('Case 4 — overwrite ON: merge field theo quy tắc "đầy đủ hơn", không đánh mất dữ liệu cũ hợp lệ', () => {
  const existing = { hz: '学习', py: 'xuexi', vi: 'học', tag: null, hanviet: 'Học tập' };
  const incoming = { hz: '学习', py: 'xuéxí', vi: 'học tập; học hỏi; nghiên cứu', tag: 'ly_hop' };
  const r = mergeVocabRecords(existing, incoming, true);
  assert.strictEqual(r.py, 'xuéxí'); // đầy đủ hơn (có dấu thanh điệu)
  assert.strictEqual(r.vi, 'học; học tập; học hỏi; nghiên cứu'); // hợp nhất, giữ "học" cũ
  assert.strictEqual(r.tag, 'ly_hop');
  assert.strictEqual(r.hanviet, 'Học tập'); // hanviet không đổi vì hz không đổi
  assert.strictEqual(r.changed, true);
});

test('Case 11 — overwrite ON nhưng field mới rỗng -> KHÔNG được xoá dữ liệu cũ ở field đó', () => {
  const existing = { hz: '电脑', py: 'diànnǎo', vi: 'máy tính', tag: 'ly_hop', hanviet: null };
  const incoming = { hz: '电脑', py: '', vi: '', tag: '' };
  const r = mergeVocabRecords(existing, incoming, true);
  assert.strictEqual(r.py, 'diànnǎo');
  assert.strictEqual(r.vi, 'máy tính');
  assert.strictEqual(r.tag, 'ly_hop');
});

console.log('\n[pickCanonical — Phần 3/4: giữ canonical ID = id nhỏ nhất, idempotent]');

test('chọn đúng id nhỏ nhất làm canonical, bất kể thứ tự truyền vào', () => {
  const { canonical, losers } = pickCanonical([{ id: 389 }, { id: 101 }, { id: 245 }]);
  assert.strictEqual(canonical.id, 101);
  assert.deepStrictEqual(losers.map(x => x.id), [245, 389]);
});

test('Case 12 — chỉ còn 1 bản ghi (đã dedupe từ lần chạy trước) -> canonical giữ nguyên, losers rỗng (idempotent)', () => {
  const { canonical, losers } = pickCanonical([{ id: 101 }]);
  assert.strictEqual(canonical.id, 101);
  assert.strictEqual(losers.length, 0);
});

test('mảng rỗng -> không throw, trả canonical null', () => {
  const { canonical, losers } = pickCanonical([]);
  assert.strictEqual(canonical, null);
  assert.strictEqual(losers.length, 0);
});

console.log('\n[mergeManyVocabRecords — đúng ví dụ minh hoạ trong yêu cầu audit, Phần 4]');

test('3 bản ghi trùng (101 Lesson1/245 Lesson5/389 Lesson8) -> gộp về canonical=101, đủ 3 lesson, không mất nghĩa nào', () => {
  const rows = [
    { id: 101, hz: '学习', py: 'xuéxí', vi: 'học', tag: null, hanviet: null, l: 1 },
    { id: 245, hz: '学习', py: 'xuéxí', vi: 'học tập', tag: null, hanviet: null, l: 5 },
    { id: 389, hz: '学习', py: 'xuéxí', vi: 'học hỏi', tag: null, hanviet: null, l: 8 },
  ];
  const result = mergeManyVocabRecords(rows);
  assert.strictEqual(result.canonicalId, 101, 'phải GIỮ canonical ID = 101 (id nhỏ nhất)');
  assert.deepStrictEqual(result.lessons, [1, 5, 8], 'phải gộp đủ cả 3 lesson, không thiếu bài nào');
  assert.deepStrictEqual(result.loserIds, [245, 389]);
  // Không được đánh rơi bất kỳ cụm nghĩa nào trong 3 bản ghi gốc — ưu tiên AN TOÀN (không mất dữ
  // liệu) hơn là khớp đúng văn bản ví dụ rút gọn của yêu cầu.
  ['học', 'học tập', 'học hỏi'].forEach(part => {
    assert.ok(result.merged.vi.includes(part), `nghĩa hợp nhất phải còn chứa "${part}": ${result.merged.vi}`);
  });
});

test('nhóm chỉ có 1 bản ghi (không trùng) -> canonical = chính nó, lessons = đúng 1 bài, không đổi gì', () => {
  const rows = [{ id: 500, hz: '电脑', py: 'diànnǎo', vi: 'máy tính', tag: null, hanviet: null, l: 10 }];
  const result = mergeManyVocabRecords(rows);
  assert.strictEqual(result.canonicalId, 500);
  assert.deepStrictEqual(result.lessons, [10]);
  assert.deepStrictEqual(result.loserIds, []);
  assert.strictEqual(result.merged.vi, 'máy tính');
});

console.log('\n[pickSurvivingFsrsCard — Case 9: 2 duplicate vocab cùng có FSRS của 1 user]');

test('reps cao hơn thắng (tiến độ học thật nhiều hơn)', () => {
  const { winner, losers } = pickSurvivingFsrsCard([
    { id: 1, reps: 3, last_review: '2026-01-01' },
    { id: 2, reps: 10, last_review: '2025-12-01' },
  ]);
  assert.strictEqual(winner.id, 2);
  assert.deepStrictEqual(losers.map(x => x.id), [1]);
});

test('bằng reps -> last_review gần đây hơn thắng', () => {
  const { winner } = pickSurvivingFsrsCard([
    { id: 1, reps: 5, last_review: '2026-01-01' },
    { id: 2, reps: 5, last_review: '2026-03-01' },
  ]);
  assert.strictEqual(winner.id, 2);
});

test('bằng reps, cùng chưa từng review (last_review null) -> id nhỏ nhất thắng (ổn định/idempotent)', () => {
  const { winner } = pickSurvivingFsrsCard([
    { id: 55, reps: 0, last_review: null },
    { id: 12, reps: 0, last_review: null },
  ]);
  assert.strictEqual(winner.id, 12);
});

test('chỉ 1 thẻ (không trùng) -> thẻ đó thắng, losers rỗng (Case 12 — idempotent)', () => {
  const { winner, losers } = pickSurvivingFsrsCard([{ id: 7, reps: 2, last_review: null }]);
  assert.strictEqual(winner.id, 7);
  assert.strictEqual(losers.length, 0);
});

console.log('\n[groupBy — helper gom nhóm theo hz]');

test('gom đúng nhóm theo hz, giữ nguyên thứ tự phần tử trong từng nhóm', () => {
  const map = groupBy([{ hz: 'A', id: 1 }, { hz: 'B', id: 2 }, { hz: 'A', id: 3 }], r => r.hz);
  assert.deepStrictEqual(map.get('A').map(x => x.id), [1, 3]);
  assert.deepStrictEqual(map.get('B').map(x => x.id), [2]);
});

console.log('\n════════════════════════════════════════════════════');
console.log(`Kết quả: ${passed} PASS, ${failed} FAIL`);
console.log('════════════════════════════════════════════════════');
if (failed > 0) process.exitCode = 1;
