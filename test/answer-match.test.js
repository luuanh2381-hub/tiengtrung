// test/answer-match.test.js — kiểm thử bộ chấm đáp án tự nhập (js/answer-match.js). Chạy: node test/answer-match.test.js
'use strict';
const assert = require('assert');
const AM = require('../js/answer-match');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + '\n     ' + (e && e.message)); }
}
const py = (i, e, o) => AM.matchPinyin(i, e, o);
const hz = (i, e) => AM.matchHanzi(i, e);

console.log('\n[1] Chữ Hán');
test('đúng chính xác', () => assert.strictEqual(hz('准备', '准备').correct, true));
test('khoảng trắng thừa (đầu/cuối/giữa, cả toàn chiều)', () => {
  assert.strictEqual(hz('  准 备  ', '准备').correct, true);
  assert.strictEqual(hz('准\u3000备', '准备').correct, true);
});
test('dấu câu cuối do bộ gõ thêm vào', () => assert.strictEqual(hz('准备。', '准备').correct, true));
test('ký tự vô hình (zero-width) không làm sai', () => assert.strictEqual(hz('准\u200B备', '准备').correct, true));
test('Unicode tương đương: chữ Hán tương thích U+F900 ≡ U+8C48', () => {
  assert.strictEqual('\uF900'.normalize('NFKC'), '\u8C48'); // tiền đề: NFKC gộp chúng
  assert.strictEqual(hz('\uF900', '\u8C48').correct, true);
});
test('dạng toàn chiều ≡ bán chiều (chữ số / chữ cái)', () => assert.strictEqual(hz('ＡＢ', 'AB').correct, true));
test('KHÁC chữ = sai (không chấp nhận gần giống)', () => {
  assert.strictEqual(hz('准背', '准备').correct, false);
  assert.strictEqual(hz('准', '准备').correct, false);
});
test('KHÔNG đổi giản thể ↔ phồn thể', () => assert.strictEqual(hz('準備', '准备').correct, false));
test('đáp án trống / chỉ khoảng trắng → empty (không phải sai)', () => {
  assert.strictEqual(hz('', '准备').verdict, 'empty');
  assert.strictEqual(hz('   ', '准备').verdict, 'empty');
});
test('nhiều phương án trong đáp án chuẩn', () => {
  assert.strictEqual(hz('跟', '和/跟').correct, true);
  assert.strictEqual(hz('和', '和/跟').correct, true);
  assert.strictEqual(hz('与', '和/跟').correct, false);
});
test('đáp án chuẩn có ngoặc tuỳ chọn "(一)点儿"', () => {
  assert.strictEqual(hz('点儿', '(一)点儿').correct, true);
  assert.strictEqual(hz('一点儿', '(一)点儿').correct, true);
});
test('đáp án chuẩn có dấu chỗ trống "把…" → gõ "把" vẫn đúng', () => assert.strictEqual(hz('把', '把…').correct, true));

console.log('\n[2] Pinyin — dấu thanh');
test('có dấu: zhǔnbèi', () => assert.strictEqual(py('zhǔnbèi', 'zhǔnbèi').verdict, 'exact'));
test('có khoảng trắng giữa âm tiết', () => assert.strictEqual(py('zhǔn bèi', 'zhǔnbèi').correct, true));
test('đáp án chuẩn có khoảng trắng, người học gõ liền', () => assert.strictEqual(py('zhǔnbèi', 'zhǔn bèi').correct, true));
test('chữ hoa / chữ thường', () => {
  assert.strictEqual(py('ZHǓNBÈI', 'zhǔnbèi').correct, true);
  assert.strictEqual(py('Zhǔnbèi', 'zhǔnbèi').correct, true);
});
test('dấu thanh dạng tổ hợp (combining) ≡ dạng dựng sẵn', () => {
  const combining = 'zhu\u030Cnbe\u0300i'; // u + caron, e + grave
  assert.strictEqual(py(combining, 'zhǔnbèi').correct, true);
});
test('dấu nháy phân âm tiết: xī\'ān', () => assert.strictEqual(py("xī'ān", 'xīān').correct, true));
test('ü: lǜ', () => {
  assert.strictEqual(py('lǜ', 'lǜ').correct, true);
  assert.strictEqual(py('lv4', 'lǜ').correct, true);
  assert.strictEqual(py('lu:4', 'lǜ').correct, true);
  assert.strictEqual(py('lü4', 'lǜ').correct, true);
});
test('g một tầng (ɡ) ≡ g', () => assert.strictEqual(py('ɡǒu', 'gǒu').correct, true));

console.log('\n[3] Pinyin — số thanh');
test('zhun3bei4 ≡ zhǔnbèi', () => {
  assert.strictEqual(py('zhun3bei4', 'zhǔnbèi').correct, true);
  assert.strictEqual(py('zhun3 bei4', 'zhǔnbèi').correct, true);
});
test('đặt dấu đúng quy tắc: hao3 → hǎo; liu2 → liú (dấu ở u); gui4 → guì (dấu ở i); dou1 → dōu (dấu ở o)', () => {
  assert.strictEqual(py('hao3', 'hǎo').correct, true);
  assert.strictEqual(py('liu2', 'liú').correct, true);
  assert.strictEqual(py('gui4', 'guì').correct, true);
  assert.strictEqual(py('dou1', 'dōu').correct, true);
});
test('thanh nhẹ: xǐhuan ≡ xi3huan hoặc xi3huan5', () => {
  assert.strictEqual(py('xi3huan', 'xǐhuan').correct, true);
  assert.strictEqual(py('xi3huan5', 'xǐhuan').correct, true);
});
test('số thanh sai → tone_mismatch (sai)', () => {
  const r = py('zhun3bei1', 'zhǔnbèi');
  assert.strictEqual(r.verdict, 'tone_mismatch'); assert.strictEqual(r.correct, false);
});

console.log('\n[4] Pinyin — không dấu / sai');
test('không dấu: KHÔNG đúng theo mặc định, verdict riêng "toneless"', () => {
  const r = py('zhunbei', 'zhǔnbèi');
  assert.strictEqual(r.verdict, 'toneless'); assert.strictEqual(r.correct, false);
});
test('không dấu: đúng khi chế độ cho phép rõ ràng (allowToneless)', () => {
  const r = py('zhunbei', 'zhǔnbèi', { allowToneless: true });
  assert.strictEqual(r.verdict, 'toneless'); assert.strictEqual(r.correct, true);
});
test('allowToneless KHÔNG nới cho trường hợp sai thanh', () => {
  assert.strictEqual(py('zhūnbèi', 'zhǔnbèi', { allowToneless: true }).correct, false);
});
test('sai thanh: zhǔnbēi', () => assert.strictEqual(py('zhǔnbēi', 'zhǔnbèi').verdict, 'tone_mismatch'));
test('thiếu thanh MỘT phần (chỉ đánh dấu 1 âm tiết) → không được tính toneless/đúng', () => {
  const r = py('zhǔnbei', 'zhǔnbèi');
  assert.strictEqual(r.correct, false); assert.strictEqual(r.verdict, 'tone_mismatch');
});
test('khác âm → wrong', () => assert.strictEqual(py('zhǔnpèi', 'zhǔnbèi').verdict, 'wrong'));
test('gõ chữ Hán vào ô pinyin → wrong (không phải pinyin)', () => assert.strictEqual(py('准备', 'zhǔnbèi').verdict, 'wrong'));
test('trống → empty', () => { assert.strictEqual(py('', 'zhǔnbèi').verdict, 'empty'); assert.strictEqual(py('  ', 'zhǔnbèi').verdict, 'empty'); });
test('nhiều cách đọc "cháng / zhǎng": chấp nhận từng cách', () => {
  assert.strictEqual(py('cháng', 'cháng / zhǎng').correct, true);
  assert.strictEqual(py('zhang3', 'cháng / zhǎng').correct, true);
  assert.strictEqual(py('chāng', 'cháng / zhǎng').correct, false);
});

console.log('\n[5] grade() thống nhất');
test('grade chọn đúng kiểu theo kind', () => {
  assert.strictEqual(AM.grade('hz', '准备', '准备').correct, true);
  assert.strictEqual(AM.grade('py', 'zhun3bei4', 'zhǔnbèi').correct, true);
});
test('đáp án chuẩn rỗng/thiếu → không bao giờ "đúng" (câu lỗi không được tính đúng)', () => {
  assert.strictEqual(AM.grade('py', 'abc', '').correct, false);
  assert.strictEqual(AM.grade('hz', 'abc', '').correct, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
