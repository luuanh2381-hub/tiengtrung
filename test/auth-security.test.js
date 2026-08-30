#!/usr/bin/env node
// ════════════════════════════════════════════════════
// test/auth-security.test.js — V88 (Phần 6/7 audit "Authentication"/"Rate Limit"): test THẬT cho
// checkRateLimit() (trích trực tiếp từ api/index.js qua Node vm, không phải bản chép tay) + xác nhận
// TĨNH đã sửa username enumeration ở /api/login (2 thông điệp lỗi khác nhau → gộp thành 1).
//
// KHÔNG thể require() nguyên api/index.js trong sandbox này (cần express/bcryptjs/pg thật — không có
// mạng để cài) — trích ĐÚNG các hàm cần test bằng đếm độ sâu ngoặc { } từ chính source thật, giống kỹ
// thuật đã dùng ở test/fsrs-optimizer.test.js (extractFunctionBody).
//
// Chạy: node test/auth-security.test.js
// ════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const API_SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');

function extractFunctionBody(src, declarationRegex) {
  const m = declarationRegex.exec(src);
  assert.ok(m, `Không tìm thấy khai báo khớp ${declarationRegex}`);
  const parenStart = src.indexOf('(', m.index);
  let pdepth = 0, j = parenStart;
  for (; j < src.length; j++) {
    if (src[j] === '(') pdepth++;
    else if (src[j] === ')') { pdepth--; if (pdepth === 0) break; }
  }
  const startBrace = src.indexOf('{', j + 1);
  let depth = 0, i = startBrace;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(startBrace, i + 1);
  assert.ok(body.length > 30, `Thân hàm trích ra quá ngắn (${body.length} ký tự) — có thể trích sai vị trí`);
  return body;
}
function stripLineComments(code) {
  return code.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

// Trích ĐÚNG _rateLimitBuckets (const, khai báo ngay trước checkRateLimit) + checkRateLimit() thật từ
// api/index.js rồi chạy trong sandbox riêng — kiểm chứng ĐÚNG logic thật, không phải bản viết lại.
function loadRateLimiter() {
  const bucketDeclIdx = API_SRC.indexOf('const _rateLimitBuckets = new Map()');
  assert.ok(bucketDeclIdx !== -1, 'không tìm thấy khai báo _rateLimitBuckets trong api/index.js');
  const declIdx = API_SRC.indexOf('function checkRateLimit');
  const fnBody = extractFunctionBody(API_SRC, /function checkRateLimit\s*\(/);
  // Lấy NGUYÊN VĂN danh sách tham số thật (có destructuring { maxAttempts, windowMs }) — KHÔNG tự đặt
  // lại tên tham số, tránh đúng lỗi đã tự bắt được: đổi tên làm mất destructuring khiến biến bên trong
  // thân hàm (maxAttempts/windowMs) không còn được gán, throw "not defined" dù logic THẬT vẫn đúng.
  const parenStart = API_SRC.indexOf('(', declIdx);
  let pdepth = 0, j = parenStart;
  for (; j < API_SRC.length; j++) {
    if (API_SRC[j] === '(') pdepth++;
    else if (API_SRC[j] === ')') { pdepth--; if (pdepth === 0) break; }
  }
  const paramList = API_SRC.slice(parenStart, j + 1);
  const src = `const _rateLimitBuckets = new Map();\nfunction checkRateLimit${paramList} ${fnBody}\nmodule.exports = { checkRateLimit, _rateLimitBuckets };`;
  const sandbox = { module: { exports: {} }, console };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'checkRateLimit-extracted.js' });
  return sandbox.module.exports;
}
function fakeReq(ip) {
  return { headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: ip } };
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}`); console.log(`     ${e.message}`); }
}

console.log('════════════════════════════════════════════════════');
console.log('V88 AUTH SECURITY TEST — checkRateLimit() + username enumeration fix');
console.log('════════════════════════════════════════════════════');

console.log('\n[checkRateLimit() — chạy THẬT (trích trực tiếp từ api/index.js)]');

test('Dưới ngưỡng → luôn cho phép (true)', () => {
  const { checkRateLimit } = loadRateLimiter();
  const req = fakeReq('1.2.3.4');
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(checkRateLimit(req, 'login', { maxAttempts: 10, windowMs: 60000 }), true, `lần thử #${i + 1} phải được cho phép (chưa vượt 10)`);
  }
});

test('Vượt ngưỡng trong CÙNG cửa sổ thời gian → false (chặn)', () => {
  const { checkRateLimit } = loadRateLimiter();
  const req = fakeReq('5.6.7.8');
  let lastResult;
  for (let i = 0; i < 15; i++) lastResult = checkRateLimit(req, 'login', { maxAttempts: 10, windowMs: 60000 });
  assert.strictEqual(lastResult, false, 'lần thử thứ 15 (> 10) trong cùng cửa sổ 60s phải bị chặn');
});

test('2 IP KHÁC NHAU có bucket ĐỘC LẬP — IP A bị chặn không ảnh hưởng IP B', () => {
  const { checkRateLimit } = loadRateLimiter();
  const reqA = fakeReq('9.9.9.9'), reqB = fakeReq('1.1.1.1');
  for (let i = 0; i < 15; i++) checkRateLimit(reqA, 'login', { maxAttempts: 10, windowMs: 60000 });
  assert.strictEqual(checkRateLimit(reqB, 'login', { maxAttempts: 10, windowMs: 60000 }), true, 'IP B chưa từng gọi trước đó, phải KHÔNG bị ảnh hưởng bởi việc IP A bị chặn');
});

test('2 route KHÁC NHAU (vd login vs register) trên CÙNG 1 IP có bucket ĐỘC LẬP', () => {
  const { checkRateLimit } = loadRateLimiter();
  const req = fakeReq('2.2.2.2');
  for (let i = 0; i < 15; i++) checkRateLimit(req, 'login', { maxAttempts: 10, windowMs: 60000 });
  assert.strictEqual(checkRateLimit(req, 'register', { maxAttempts: 5, windowMs: 60000 }), true, 'route "register" phải có bucket riêng, không bị ảnh hưởng bởi việc "login" của CÙNG IP đã bị chặn');
});

test('Cửa sổ thời gian đã hết hạn (windowMs trôi qua) → reset, cho phép lại', () => {
  const { checkRateLimit } = loadRateLimiter();
  const req = fakeReq('3.3.3.3');
  for (let i = 0; i < 15; i++) checkRateLimit(req, 'login', { maxAttempts: 10, windowMs: 1 }); // windowMs=1ms — hết hạn gần như ngay
  // đợi 1 chút để chắc chắn đã qua windowMs=1ms
  const start = Date.now();
  while (Date.now() - start < 5) { /* busy-wait ngắn, đủ vượt windowMs=1ms */ }
  assert.strictEqual(checkRateLimit(req, 'login', { maxAttempts: 10, windowMs: 1 }), true, 'sau khi windowMs trôi qua, phải bắt đầu cửa sổ MỚI và cho phép lại');
});

console.log('\n[Username enumeration — /api/login — xác nhận TĨNH đã gộp thông điệp lỗi]');

test('/api/login: "tài khoản không tồn tại" và "sai mật khẩu" giờ trả CÙNG 1 thông điệp cho client (Phần 6 — chống username enumeration)', () => {
  const loginRouteIdx = API_SRC.indexOf("app.post('/api/login'");
  const nextRouteIdx = API_SRC.indexOf("app.post(", loginRouteIdx + 10);
  const loginSrc = stripLineComments(API_SRC.slice(loginRouteIdx, nextRouteIdx));
  assert.ok(/GENERIC_LOGIN_ERROR/.test(loginSrc), 'phải dùng 1 biến thông điệp CHUNG cho cả 2 nhánh lỗi');
  const clientFacingErrors = loginSrc.match(/error:\s*GENERIC_LOGIN_ERROR/g) || [];
  assert.strictEqual(clientFacingErrors.length, 2, `phải có ĐÚNG 2 chỗ dùng GENERIC_LOGIN_ERROR cho client (nhánh "không tồn tại" + nhánh "sai mật khẩu") — thấy ${clientFacingErrors.length}`);
  // Server LOG vẫn phải giữ chi tiết thật (không ẩn khỏi chính hệ thống, chỉ ẩn khỏi response)
  assert.ok(/tài khoản không tồn tại/.test(loginSrc) && /sai mật khẩu/.test(loginSrc), 'log nội bộ (logActivity) vẫn phải ghi rõ lý do thật để phục vụ điều tra — chỉ ẩn khỏi client, không ẩn khỏi log');
});

test('/api/login, /api/register, /api/change-password đều gọi checkRateLimit()', () => {
  ['login', 'register', 'change-password'].forEach((route) => {
    const routeIdx = API_SRC.indexOf(`app.post('/api/${route}'`);
    assert.ok(routeIdx !== -1, `route /api/${route} phải tồn tại`);
    const nextRouteIdx = API_SRC.indexOf('app.post(', routeIdx + 10);
    const routeSrc = API_SRC.slice(routeIdx, nextRouteIdx > routeIdx ? nextRouteIdx : routeIdx + 1500);
    assert.ok(new RegExp(`checkRateLimit\\(req,\\s*'${route}'`).test(routeSrc), `route /api/${route} phải gọi checkRateLimit(req, '${route}', ...)`);
    assert.ok(/429/.test(routeSrc), `route /api/${route} phải trả HTTP 429 khi vượt rate limit`);
  });
});

console.log('\n════════════════════════════════════════════════════');
console.log(`Kết quả: ${passed} PASS, ${failed} FAIL`);
console.log('════════════════════════════════════════════════════');
if (failed > 0) process.exit(1);
