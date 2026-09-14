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
  // dynamic-wasi.mjs (bản ESM đúng) có bare import tới 1 package KHÁC — đúng lỗi thật production gặp
  // ("Failed to resolve module specifier '@napi-rs/wasm-runtime'"). QUAN TRỌNG (audit lỗi này — xem
  // AUDIT-REPORT-V95): đặt package NESTED bên trong node_modules CỦA CHÍNH package "binding" (mô
  // phỏng ĐÚNG cách npm/pnpm thường xử lý transitive dependency KHÔNG được hoist lên node_modules gốc
  // — vd do version khác ở nơi khác trong cây phụ thuộc), KHÔNG đặt sẵn ở node_modules gốc như trước
  // (bản test trước đặt ở gốc nên "quá dễ" — require.resolve() từ BẤT KỲ context nào cũng tìm thấy,
  // không bắt được đúng bug context-resolution mà production thực sự gặp phải).
  fs.writeFileSync(path.join(scopeDir, 'binding', 'dynamic-wasi.mjs'),
    "import { instantiate } from '@napi-rs/wasm-runtime';\nexport async function initOptimizer() { return { instantiate }; }\n");
  fs.writeFileSync(path.join(scopeDir, 'binding', 'dynamic-wasi.cjs'), 'const fakeDep = require("fs"); module.exports = { initOptimizer: async () => ({}) };'); // file CJS "bẫy" — nếu bị chọn nhầm, đây chính là nguồn require() gây lỗi thật trong trình duyệt

  // NESTED bên trong node_modules/@open-spaced-repetition/binding/node_modules/@napi-rs/wasm-runtime —
  // CỐ Ý không đặt ở node_modules gốc của tmpRoot (xem giải thích ở trên).
  const nestedScopeDir = path.join(scopeDir, 'binding', 'node_modules', '@napi-rs');
  fs.mkdirSync(path.join(nestedScopeDir, 'wasm-runtime'), { recursive: true });
  fs.writeFileSync(path.join(nestedScopeDir, 'wasm-runtime', 'package.json'), JSON.stringify({
    name: '@napi-rs/wasm-runtime', version: '0.2.0', main: './index.mjs',
  }));
  fs.writeFileSync(path.join(nestedScopeDir, 'wasm-runtime', 'index.mjs'), 'export function instantiate() { return {}; }\n');

  // Package WASM — tên file KHÔNG khớp ví dụ đã tra cứu (đúng khó khăn #2), không có "main"/"exports".
  fs.writeFileSync(path.join(scopeDir, 'binding-wasm32-wasi', 'package.json'), JSON.stringify({
    name: '@open-spaced-repetition/binding-wasm32-wasi', version: '0.5.0',
  }));
  fs.writeFileSync(path.join(scopeDir, 'binding-wasm32-wasi', 'weird-name.v9.wasm'), '');
  // "browser" TRƯỚC "worker" — cố tình đảo thứ tự (đúng khó khăn #2). QUAN TRỌNG (audit lỗi V96 —
  // "Optimizer lỗi trong trình duyệt: Failed to resolve module specifier '@napi-rs/wasm-runtime'" VẪN
  // xảy ra SAU KHI V95 đã fix import map đúng): đây chính là file được `new Worker(url, {type:'module'})`
  // tạo ra — theo đặc tả WHATWG, Worker có "module map" RIÊNG, KHÔNG kế thừa import map từ document
  // chính — nên NẾU file worker này (không phải dynamic-wasi entry) mới là nơi có bare import thật, thì
  // dù import map ở document đã đúng (V95), lỗi vẫn xảy ra Y HỆT — đúng bằng chứng thực tế đã thấy.
  fs.writeFileSync(path.join(scopeDir, 'binding-wasm32-wasi', 'browser-worker-thing.mjs'),
    "import { WASI } from '@napi-rs/wasm-runtime';\nself.onmessage = () => {};\n");
}

function loadFunctionsFromRealSource() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
  const startIdx = src.indexOf('const BROWSER_OPTIMIZER_PACKAGES');
  // Trước đây dừng ở ĐẦU serveBrowserOptimizerPackageFile (loại trừ luôn hàm đó) — giờ cần export cả
  // hàm này để test riêng kịch bản "file worker tự import bare specifier" (V96), nên dời điểm cắt tới
  // NGAY TRƯỚC dòng app.get() đầu tiên (bao gồm trọn hàm, nhưng KHÔNG kéo theo lời gọi app.get() —
  // `app` là Express instance thật, không tồn tại trong sandbox test này, gọi vào sẽ throw).
  const endIdx = src.indexOf("app.get('/api/fsrs-optimizer/browser/pkg/binding/*'");
  if (startIdx === -1 || endIdx === -1) {
    throw new Error('Không tìm thấy khối code browser-asset resolution trong api/index.js — cấu trúc file có thể đã đổi, cập nhật lại test này.');
  }
  const snippet = src.slice(startIdx, endIdx);
  const sandbox = { require, fs, path, console, module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(snippet + '\nmodule.exports = { computeBrowserOptimizerAssetUrlsDetailed, buildImportMapForFile, serveDynamicPkgFile, serveBrowserOptimizerPackageFile, _dynamicPkgRootByUrlKey, rewriteBareSpecifiersInSource, extractBareSpecifiers };', sandbox, { filename: 'api/index.js (trích đoạn)' });
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

  const { computeBrowserOptimizerAssetUrlsDetailed, buildImportMapForFile, serveDynamicPkgFile, serveBrowserOptimizerPackageFile, _dynamicPkgRootByUrlKey, rewriteBareSpecifiersInSource, extractBareSpecifiers } = loadFunctionsFromRealSource();

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

  test('computeBrowserOptimizerAssetUrlsDetailed(): importMap PHẢI có mục cho "@napi-rs/wasm-runtime" (bare specifier mà dynamic-wasi.mjs import — lỗi thật "Failed to resolve module specifier" đã gặp ở production, audit lại lần 7)', () => {
    const result = computeBrowserOptimizerAssetUrlsDetailed();
    assert.strictEqual(result.ok, true);
    assert.ok(result.importMap['@napi-rs/wasm-runtime'], `importMap phải có mục cho @napi-rs/wasm-runtime — nhận: ${JSON.stringify(result.importMap)}`);
    assert.ok(result.importMap['@napi-rs/wasm-runtime'].startsWith('/api/fsrs-optimizer/browser/pkg-dyn/napi-rs__wasm-runtime/'));
  });

  test('buildImportMapForFile(): quét đúng bare specifier từ nội dung file thật, không cần biết tên trước (tổng quát, không hardcode "@napi-rs/wasm-runtime")', () => {
    const dynamicWasiPath = path.join(tmpRoot, 'node_modules', '@open-spaced-repetition', 'binding', 'dynamic-wasi.mjs');
    const map = buildImportMapForFile(dynamicWasiPath, 2);
    assert.deepStrictEqual(Object.keys(map), ['@napi-rs/wasm-runtime']);
  });

  test('cache _dynamicPkgRootByUrlKey PHẢI trỏ đúng vào thư mục NESTED (bug thứ 2, cùng gốc với bug trên): route serveDynamicPkgFile() — nơi trình duyệt THỰC SỰ tải file @napi-rs/wasm-runtime về — phải dùng LẠI đúng root đã xác định lúc build import map, KHÔNG được tự tính lại bằng require.resolve() không-context (nếu tính lại sẽ vẫn ra null/404 dù import map đã đúng, vì cùng 1 lý do gốc: package bị nested, không hoist)', () => {
    computeBrowserOptimizerAssetUrlsDetailed(); // đảm bảo cache đã populate (an toàn gọi lại nhiều lần)
    const cachedRoot = _dynamicPkgRootByUrlKey['napi-rs__wasm-runtime'];
    const expectedNestedRoot = path.join(tmpRoot, 'node_modules', '@open-spaced-repetition', 'binding', 'node_modules', '@napi-rs', 'wasm-runtime');
    assert.strictEqual(cachedRoot, expectedNestedRoot, `phải dùng đúng root NESTED đã cache, nhận: ${cachedRoot}`);
  });

  test('serveDynamicPkgFile(): PHẢI serve được file thật (không rơi vào nhánh lỗi 404 "Không rõ package") cho đúng urlKey của @napi-rs/wasm-runtime', () => {
    computeBrowserOptimizerAssetUrlsDetailed();
    const res = {
      _json: null, _status: null, _body: null,
      status(code) { this._status = code; return this; },
      json(obj) { this._json = obj; return this; }, // nếu code lỗi sẽ gọi tới đây (đồng bộ) — vượt qua được nghĩa là fix đúng
      send(body) { this._body = body; return this; }, // file .mjs -> code MỚI đọc hết + rewrite rồi send() (không còn pipe())
      setHeader() {},
      write() { return true; }, end() {}, on() {}, once() {}, emit() {}, // no-op đủ để .pipe() (nhánh file khác .mjs) không throw
    };
    serveDynamicPkgFile({ params: { urlKey: 'napi-rs__wasm-runtime', 0: 'index.mjs' } }, res);
    assert.strictEqual(res._json, null, `không được rơi vào nhánh lỗi — nhận lỗi: ${JSON.stringify(res._json)}`);
    assert.notStrictEqual(res._status, 404);
    assert.ok(res._body && res._body.includes('export function instantiate'), 'phải trả về đúng nội dung file thật');
  });

  test('computeBrowserOptimizerAssetUrlsDetailed(): tìm đúng file .wasm dù tên KHÔNG khớp ví dụ đã tra cứu lúc viết code', () => {
    const result = computeBrowserOptimizerAssetUrlsDetailed();
    assert.ok(result.ok && result.urls.wasmAssetUrl.endsWith('/weird-name.v9.wasm'), `kỳ vọng tìm thấy weird-name.v9.wasm, nhận: ${JSON.stringify(result)}`);
  });

  test('computeBrowserOptimizerAssetUrlsDetailed(): tìm đúng file worker dù thứ tự "browser"/"worker" trong tên bị đảo ngược so với ví dụ đã tra cứu', () => {
    const result = computeBrowserOptimizerAssetUrlsDetailed();
    assert.ok(result.ok && result.urls.workerScriptUrl.endsWith('/browser-worker-thing.mjs'), `kỳ vọng tìm thấy browser-worker-thing.mjs, nhận: ${JSON.stringify(result)}`);
  });

  console.log('\n[V96 — rewriteBareSpecifiersInSource(): viết lại bare specifier NGAY TRONG nội dung file, không cần trình duyệt tự áp dụng import map]');

  // Dùng CHUNG 1 filePath CÓ THẬT trên đĩa (nằm trong tmpRoot đã dựng, cùng thư mục với package
  // "binding") cho các test case dưới đây — createRequire(fromFilePath) cần fromFilePath THẬT SỰ nằm
  // đúng vị trí trong cây node_modules giả lập thì mới resolve được @napi-rs/wasm-runtime (nested bên
  // trong); dùng 1 đường dẫn "giả" tuỳ ý (không tồn tại, không nằm trong tmpRoot) sẽ khiến
  // createRequire tìm node_modules từ vị trí KHÔNG LIÊN QUAN, luôn resolve thất bại — đó là lỗi Ở TEST
  // (dùng sai input), không phải lỗi code thật.
  const dynamicWasiPathForRewriteTests = path.join(tmpRoot, 'node_modules', '@open-spaced-repetition', 'binding', 'dynamic-wasi.mjs');

  test('rewrite "import {X} from \'pkg\'" (static) -> thay đúng bằng URL tuyệt đối, không còn bare specifier nào sau khi quét lại', () => {
    computeBrowserOptimizerAssetUrlsDetailed();
    const dynamicWasiPath = dynamicWasiPathForRewriteTests;
    const src = fs.readFileSync(dynamicWasiPath, 'utf8');
    const out = rewriteBareSpecifiersInSource(src, dynamicWasiPath);
    // LƯU Ý: extractBareSpecifiers() chạy TRONG vm sandbox (realm riêng) -> mảng nó trả về KHÔNG
    // strictEqual/deepStrictEqual được với literal [] của file test (khác prototype/realm) dù rỗng y
    // hệt — so sánh qua .length (primitive number, không có vấn đề cross-realm) thay vì so mảng trực tiếp.
    assert.strictEqual(extractBareSpecifiers(out).length, 0, `sau rewrite KHÔNG được còn bare specifier nào: ${out}`);
    assert.ok(out.includes("from '/api/fsrs-optimizer/browser/pkg-dyn/napi-rs__wasm-runtime/index.mjs'"), `phải chứa đúng URL tuyệt đối: ${out}`);
    assert.ok(out.includes('export async function initOptimizer'), 'phần code KHÁC ngoài specifier phải giữ nguyên y hệt');
  });

  test('rewrite dynamic import("pkg") -> thay đúng specifier bên trong, giữ nguyên cú pháp import(...)', () => {
    const out = rewriteBareSpecifiersInSource("const m = await import('@napi-rs/wasm-runtime');", dynamicWasiPathForRewriteTests);
    assert.ok(out.includes("import('/api/fsrs-optimizer/browser/pkg-dyn/napi-rs__wasm-runtime/index.mjs')"), out);
  });

  test('rewrite side-effect-only import \'pkg\' (không "from") -> thay đúng', () => {
    const out = rewriteBareSpecifiersInSource("import '@napi-rs/wasm-runtime';\nconsole.log(1);", dynamicWasiPathForRewriteTests);
    assert.ok(out.includes("import '/api/fsrs-optimizer/browser/pkg-dyn/napi-rs__wasm-runtime/index.mjs'"), out);
  });

  test('specifier KHÔNG resolve được (package không tồn tại) -> GIỮ NGUYÊN, không throw, không phá nội dung khác', () => {
    const out = rewriteBareSpecifiersInSource("import { z } from 'khong-ton-tai-abc-xyz';\nexport const ok = 1;", dynamicWasiPathForRewriteTests);
    assert.ok(out.includes("from 'khong-ton-tai-abc-xyz'"), 'phải giữ nguyên nếu không resolve được, không thay bằng rác');
    assert.ok(out.includes('export const ok = 1;'));
  });

  test('đường dẫn tương đối ("./foo.js") và tuyệt đối ("/x") -> KHÔNG bị đụng vào (chỉ rewrite bare specifier)', () => {
    const src = "import a from './foo.js';\nimport b from '/already/absolute.js';\nimport c from '@napi-rs/wasm-runtime';";
    const out = rewriteBareSpecifiersInSource(src, dynamicWasiPathForRewriteTests);
    assert.ok(out.includes("from './foo.js'"));
    assert.ok(out.includes("from '/already/absolute.js'"));
    assert.ok(!out.includes("from '@napi-rs/wasm-runtime'"), 'CHỈ specifier bare mới bị thay, 2 dòng kia phải nguyên vẹn');
  });

  test('KỊCH BẢN THỰC TẾ ĐÃ GẶP: file WORKER SCRIPT (không phải dynamic-wasi entry) tự import bare specifier — serve qua route THẬT (binding-wasm32-wasi) phải trả về nội dung ĐÃ rewrite, giải quyết đúng vấn đề "import map không áp dụng cho Worker"', () => {
    const handler = serveBrowserOptimizerPackageFile('binding-wasm32-wasi');
    const res = {
      _json: null, _status: null, _body: null,
      status(code) { this._status = code; return this; },
      json(obj) { this._json = obj; return this; },
      send(body) { this._body = body; return this; },
      setHeader() {},
    };
    handler({ params: { 0: 'browser-worker-thing.mjs' } }, res);
    assert.strictEqual(res._json, null, `không được lỗi: ${JSON.stringify(res._json)}`);
    assert.ok(res._body, 'phải trả về nội dung file');
    assert.strictEqual(extractBareSpecifiers(res._body).length, 0, `nội dung file WORKER trả về cho trình duyệt KHÔNG được còn bare specifier nào (đây chính là file mà import map không áp dụng được): ${res._body}`);
    assert.ok(res._body.includes('/api/fsrs-optimizer/browser/pkg-dyn/napi-rs__wasm-runtime/'), res._body);
  });
} finally {
  // Trì hoãn việc xoá tmpRoot — test serveDynamicPkgFile() ở trên gọi fs.createReadStream(...).pipe()
  // (BẤT ĐỒNG BỘ, không đợi) để verify KHÔNG rơi vào nhánh lỗi 404 (đủ cho assertion, không cần đợi đọc
  // xong nội dung) — nhưng nếu xoá tmpRoot NGAY LẬP TỨC ở đây, luồng đọc file đó (đang chạy dở, rớt lại)
  // sẽ gặp ENOENT khi thư mục đã biến mất → "Unhandled 'error' event" làm crash tiến trình DÙ mọi
  // assertion đã PASS. setTimeout giữ event loop sống thêm 1 chút, đủ để thao tác đọc file nhỏ trong
  // tmpfs (luôn rất nhanh) hoàn thành trước khi dọn dẹp — không ảnh hưởng gì tới các dòng in kết quả/
  // process.exitCode bên dưới (chạy đồng bộ, độc lập, không đợi setTimeout này).
  setTimeout(() => fs.rmSync(tmpRoot, { recursive: true, force: true }), 200);
}

console.log(`\n════════════════════════════════════════════════════`);
console.log(`Kết quả: ${passed} PASS, ${failed} FAIL`);
console.log(`════════════════════════════════════════════════════`);
if (failed > 0) process.exitCode = 1;
