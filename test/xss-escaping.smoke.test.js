#!/usr/bin/env node
// ════════════════════════════════════════════════════
// test/xss-escaping.smoke.test.js — V88 (Phần 4 audit): test THẬT (chạy code thật qua Node vm) cho
// escapeHtml()/escapeJsAttr() (js/ui.js) + xác nhận TĨNH các điểm interpolation hz/py/vi/hanviet vào
// onclick/data-* đã DÙNG các hàm này (không phải chỉ đọc code bằng mắt).
//
// Chạy: node test/xss-escaping.smoke.test.js
// ════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadUiSandbox() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');
  const sandbox = { console, document: { addEventListener() {} } };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'ui.js' });
  return sandbox;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}`); console.log(`     ${e.message}`); }
}

console.log('════════════════════════════════════════════════════');
console.log('V88 XSS ESCAPING SMOKE TEST');
console.log('════════════════════════════════════════════════════');

console.log('\n[escapeHtml() — chạy thật]');
const sb = loadUiSandbox();

test('escapeHtml(): dữ liệu Hán tự/pinyin/tiếng Việt BÌNH THƯỜNG (không ký tự đặc biệt) → giữ NGUYÊN VẸN, không đổi nội dung (yêu cầu bắt buộc: KHÔNG được làm thay đổi nội dung tiếng Trung/Pinyin/Hán Việt)', () => {
  assert.strictEqual(sb.escapeHtml('清'), '清');
  assert.strictEqual(sb.escapeHtml('qīng'), 'qīng');
  assert.strictEqual(sb.escapeHtml('trong, sạch (nước)'), 'trong, sạch (nước)');
  assert.strictEqual(sb.escapeHtml('学习'), '学习');
});

test('escapeHtml(): encode đúng &<>"\' thành HTML entity', () => {
  assert.strictEqual(sb.escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.strictEqual(sb.escapeHtml(`a"b'c&d`), 'a&quot;b&#39;c&amp;d');
});

test('escapeHtml(): null/undefined → chuỗi rỗng, không throw', () => {
  assert.strictEqual(sb.escapeHtml(null), '');
  assert.strictEqual(sb.escapeHtml(undefined), '');
});

console.log('\n[escapeJsAttr() — chạy thật — dùng cho onclick="fn(\'...\')" (2 lớp: JS string + HTML attribute)]');

test('escapeJsAttr(): dữ liệu bình thường → giữ nguyên (không đổi hz/py/vi thật)', () => {
  assert.strictEqual(sb.escapeJsAttr('清'), '清');
  assert.strictEqual(sb.escapeJsAttr('học'), 'học');
});

test('escapeJsAttr(): dấu nháy đơn → escape thành \\\' (không phá literal chuỗi JS)', () => {
  assert.strictEqual(sb.escapeJsAttr(`it's`), `it\\'s`);
});

test('escapeJsAttr(): dấu nháy kép → encode &quot; (không phá thuộc tính HTML onclick="...")', () => {
  assert.strictEqual(sb.escapeJsAttr(`say "hi"`), 'say &quot;hi&quot;');
});

test('escapeJsAttr(): kết quả nhúng vào onclick="fn(\'X\')" không thể phá vỡ ra ngoài — mô phỏng cụ thể payload tấn công điển hình', () => {
  const malicious = `x'); alert(document.cookie); //`;
  const escaped = sb.escapeJsAttr(malicious);
  const onclickAttr = `fn('${escaped}')`; // đúng pattern thật đang dùng trong quiz.js/review.js/listen.js
  // Sau khi escape, chuỗi KHÔNG được còn dấu nháy đơn TRẦN nào (mọi ' phải đã thành \\' )
  const insideQuotes = onclickAttr.slice(onclickAttr.indexOf("('") + 2, onclickAttr.lastIndexOf("')"));
  assert.ok(!/(?<!\\)'/.test(insideQuotes), `vẫn còn dấu nháy đơn TRẦN (không escape) bên trong: ${insideQuotes}`);
});

console.log('\n[Xác nhận TĨNH — các điểm interpolation hz/py/vi/hanviet đã sửa THỰC SỰ dùng escapeHtml/escapeJsAttr]');

const FILES_TO_CHECK = {
  'js/quiz.js': [/data-v="\$\{escapeHtml\(o\.(vi|hz)\)\}"/, /onclick="qzPick\(this,'\$\{escapeJsAttr\(o\.hz\)\}'\)"/],
  'js/review.js': [/data-v="\$\{escapeHtml\(o\.vi\)\}"/, /onclick="rvPick\(this,'\$\{escapeJsAttr\(o\.hz\)\}'\)"/],
  'js/listen.js': [/onclick="lsPickWord\(this,'\$\{escapeJsAttr\(o\.hz\)\}','\$\{escapeJsAttr\(w\.hz\)\}'\)"/, /onclick="speak\('\$\{escapeJsAttr\(w\.hz\)\}'\)"/],
  'js/stats.js': [/onclick="speak\('\$\{escapeJsAttr\(w\.hz\)\}'\)"/],
  'js/translate.js': [/onclick="speak\('\$\{escapeJsAttr\(s\.hz\)\}'\)"/],
  'js/admin.js': [/onclick="adminResetUser\('\$\{escapeJsAttr\(u\.key\)\}','\$\{escapeJsAttr\(u\.username\)\}'\)"/, /onclick="adminDeleteUser\('\$\{escapeJsAttr\(u\.key\)\}','\$\{escapeJsAttr\(u\.username\)\}'\)"/],
};
for (const [file, patterns] of Object.entries(FILES_TO_CHECK)) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  patterns.forEach((re, i) => {
    test(`${file}: điểm interpolation #${i + 1} dùng escapeHtml/escapeJsAttr đúng như đã sửa`, () => {
      assert.ok(re.test(src), `không tìm thấy pattern mong đợi ${re} trong ${file}`);
    });
  });
}

test('js/compare.js: KHÔNG sửa (dữ liệu CONFUSE_GROUPS tĩnh trong data.js, không phải DB) — xác nhận vẫn dùng nguồn tĩnh, không phải WORDS', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'compare.js'), 'utf8');
  assert.ok(/cpTestQueue\s*=\s*shuffle\(CONFUSE_GROUPS/.test(src), 'compare.js phải vẫn lấy dữ liệu test từ CONFUSE_GROUPS tĩnh (không phải WORDS từ DB) — nếu dòng này đổi, cần audit lại compare.js có cần escape hay không');
});

console.log('\n════════════════════════════════════════════════════');
console.log(`Kết quả: ${passed} PASS, ${failed} FAIL`);
console.log('════════════════════════════════════════════════════');
if (failed > 0) process.exit(1);
