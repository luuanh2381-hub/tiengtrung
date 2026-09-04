// test/fsrs-optimizer.browser-asset-resolution.test.js
//
// Regression test riêng cho computeBrowserOptimizerAssetUrls()/resolveBrowserOptimizerPkgRoot() trong
// api/index.js (audit lại lần 3-4 "AUDIT V91 – FIX FSRS OPTIMIZER DỨT ĐIỂM" — browser-side training).
//
// LÝ DO có file riêng: đây là lần THỨ HAI 1 lỗi thật ở đúng khu vực này chỉ lộ ra sau khi có log thật
// từ production, không bắt được bằng suy luận tĩnh hay bằng stub "dễ dãi" ở test/fsrs-optimizer.test.js
// (stub ở đó dùng package.json không có "exports" map, nên KHÔNG tái hiện được lỗi thật:
// ERR_PACKAGE_PATH_NOT_EXPORTED khi package thật có "exports" map chặt không khai "./package.json").
// File này dựng RIÊNG 1 bộ node_modules giả TRÊN ĐĨA (không phải chỉ trong bộ nhớ) mô phỏng ĐÚNG 2 khó
// khăn đã xác nhận từ log thật:
//   1. Package chính (@open-spaced-repetition/binding) có "exports" map không cho resolve
//      "./package.json" trực tiếp — dù package vẫn cài đặt/dùng bình thường (native vẫn chạy được).
//   2. Tên file .wasm/.mjs bên trong @open-spaced-repetition/binding-wasm32-wasi KHÔNG khớp ví dụ đã
//      đọc được trên mạng lúc viết code lần đầu (đặt tên tuỳ ý, thứ tự "browser"/"worker" đảo ngược).
// Nếu 1 lần sửa sau này vô tình quay lại cách resolve cũ (require.resolve('<pkg>/package.json')) hoặc
// giả định cứng tên file, test này sẽ FAIL ngay — không cần chờ tới khi có log thật từ production nữa.

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); failed++; }
}

function buildFakeNodeModules(root) {
  const scopeDir = path.join(root, 'node_modules', '@open-spaced-repetition');
  fs.mkdirSync(path.join(scopeDir, 'binding'), { recursive: true });
  fs.mkdirSync(path.join(scopeDir, 'binding-wasm32-wasi'), { recursive: true });

  // Package chính — "exports" map CHẶT, cố tình KHÔNG khai "./package.json" (đúng khó khăn #1 đã xác
  // nhận từ log thật) — nhưng "." và "./dynamic-wasi" vẫn resolve bình thường. Nhánh "./dynamic-wasi"
  // khai RIÊNG 2 file cho 2 điều kiện "import" (ESM thật, browser cần đúng file này) và "require" (CJS,
  // chứa require() thô — nếu code cũ phục vụ NHẦM file này, trình duyệt sẽ báo "require is not
  // defined", đúng lỗi thật đã gặp ở production — audit lại lần 6).
  fs.writeFileSync(path.join(scopeDir, 'binding', 'package.json'), JSON.stringify({
    name: '@open-spaced-repetition/binding', version: '0.5.0',
    exports: {
      '.': './index.js',
      './dynamic-wasi': { import: './dynamic-wasi.mjs', require: './dynamic-wasi.cjs' },
    },
  }));
  fs.writeFileSync(path.join(scopeDir, 'binding', 'index.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(scopeDir, 'binding', 'dynamic-wasi.mjs'), 'export async function initOptimizer() { return {}; }');
  fs.writeFileSync(path.join(scopeDir, 'binding', 'dynamic-wasi.cjs'), 'const fakeDep = require("fs"); module.exports = { initOptimizer: async () => ({}) };'); // file CJS "bẫy" — nếu bị chọn nhầm, đây chính là nguồn require() gây lỗi thật trong trình duyệt

  // Package WASM — tên file KHÔNG khớp ví dụ đã tra cứu (đúng khó khăn #2), không có "main"/"exports".
  fs.writeFileSync(path.join(scopeDir, 'binding-wasm32-wasi', 'package.json'), JSON.stringify({
    name: '@open-spaced-repetition/binding-wasm32-wasi', version: '0.5.0',
  }));
  fs.writeFileSync(path.join(scopeDir, 'binding-wasm32-wasi', 'weird-name.v9.wasm'), '');
  fs.writeFileSync(path.join(scopeDir, 'binding-wasm32-wasi', 'browser-worker-thing.mjs'), ''); // "browser" TRƯỚC "worker" — cố tình đảo thứ tự
}

function loadFunctionsFromRealSource() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
  const startIdx = src.indexOf('const BROWSER_OPTIMIZER_PACKAGES');
  const endIdx = src.indexOf('function serveBrowserOptimizerPackageFile');
  if (startIdx === -1 || endIdx === -1) {
    throw new Error('Không tìm thấy khối code browser-asset resolution trong api/index.js — cấu trúc file có thể đã đổi, cập nhật lại test này.');
  }
  const snippet = src.slice(startIdx, endIdx);
  const sandbox = { require, fs, path, console, module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(snippet + '\nmodule.exports = { computeBrowserOptimizerAssetUrlsDetailed };', sandbox, { filename: 'api/index.js (trích đoạn)' });
  return sandbox.module.exports;
}

console.log('[test/fsrs-optimizer.browser-asset-resolution.test.js]');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsrs-browser-asset-test-'));
try {
  buildFakeNodeModules(tmpRoot);
  // Chèn tmpRoot/node_modules vào ĐẦU danh sách tìm module của chính file test này, để require.resolve()
  // bên trong đoạn code trích ra tìm thấy bộ node_modules giả vừa dựng — KHÔNG đụng gì tới node_modules
  // thật của project (an toàn, chỉ ảnh hưởng resolution trong phạm vi tiến trình test này).
  module.paths.unshift(path.join(tmpRoot, 'node_modules'));
  require('module').Module._initPaths(); // đảm bảo global resolution cache nhận path mới ngay

  const { computeBrowserOptimizerAssetUrlsDetailed } = loadFunctionsFromRealSource();

  test('computeBrowserOptimizerAssetUrlsDetailed(): vẫn resolve ĐÚNG dù package chính có "exports" map chặn "./package.json" (lỗi thật đã gặp ở production — audit lại lần 4)', () => {
    const result = computeBrowserOptimizerAssetUrlsDetailed();
    assert.strictEqual(result.ok, true, `kỳ vọng ok:true, nhận: ${JSON.stringify(result)}`);
    assert.ok(result.urls.dynamicWasiEntryUrl.endsWith('/dynamic-wasi.mjs'));
  });

  test('computeBrowserOptimizerAssetUrlsDetailed(): PHẢI chọn nhánh "import" (ESM thật) của dynamic-wasi, KHÔNG được chọn nhánh "require" (CJS, chứa require() — lỗi thật "require is not defined" đã gặp ở production, audit lại lần 6)', () => {
    const result = computeBrowserOptimizerAssetUrlsDetailed();
    assert.strictEqual(result.ok, true);
    assert.ok(result.urls.dynamicWasiEntryUrl.endsWith('.mjs'), `phải chọn file .mjs (ESM), tuyệt đối không phải .cjs (CommonJS) — nhận: ${result.urls.dynamicWasiEntryUrl}`);
    assert.ok(!result.urls.dynamicWasiEntryUrl.includes('dynamic-wasi.cjs'), 'không được chọn nhầm file bẫy CommonJS');
  });

  test('computeBrowserOptimizerAssetUrlsDetailed(): tìm đúng file .wasm dù tên KHÔNG khớp ví dụ đã tra cứu lúc viết code', () => {
    const result = computeBrowserOptimizerAssetUrlsDetailed();
    assert.ok(result.ok && result.urls.wasmAssetUrl.endsWith('/weird-name.v9.wasm'), `kỳ vọng tìm thấy weird-name.v9.wasm, nhận: ${JSON.stringify(result)}`);
  });

  test('computeBrowserOptimizerAssetUrlsDetailed(): tìm đúng file worker dù thứ tự "browser"/"worker" trong tên bị đảo ngược so với ví dụ đã tra cứu', () => {
    const result = computeBrowserOptimizerAssetUrlsDetailed();
    assert.ok(result.ok && result.urls.workerScriptUrl.endsWith('/browser-worker-thing.mjs'), `kỳ vọng tìm thấy browser-worker-thing.mjs, nhận: ${JSON.stringify(result)}`);
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n════════════════════════════════════════════════════`);
console.log(`Kết quả: ${passed} PASS, ${failed} FAIL`);
console.log(`════════════════════════════════════════════════════`);
if (failed > 0) process.exitCode = 1;
