#!/usr/bin/env node
// ════════════════════════════════════════════════════
// test/fsrs-optimizer-frontend.smoke.test.js — V88: smoke test THẬT (chạy code thật, không chỉ đọc)
// cho js/fsrs-optimizer.js. Đây là file BROWSER (dùng document/fetch toàn cục) — Node không có sẵn
// DOM nên dựng 1 `document` GIẢ TỐI GIẢN (chỉ đủ getElementById + các thuộc tính js/fsrs-optimizer.js
// thật sự dùng: innerHTML/textContent/style.display/disabled/classList) bằng Node `vm`, KHÔNG dùng
// jsdom (không có mạng để cài) — vẫn chạy ĐÚNG source thật của file, không phải bản chép/diễn giải lại.
//
// Bug gốc đang test: renderOptimizerBody() từng tham chiếu biến `bindingUnavailable` đã bị xoá khỏi
// kiến trúc V87 → ReferenceError → throw → body.innerHTML không được cập nhật → UI mắc mãi ở
// "⏳ Đang tải..." (HTML tĩnh ban đầu trong index.html không bao giờ bị ghi đè).
//
// Chạy: node test/fsrs-optimizer-frontend.smoke.test.js  (hoặc: npm run test:optimizer:frontend)
// ════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'fsrs-optimizer.js'), 'utf8');

// ── DOM giả tối giản — chỉ implement ĐÚNG những gì file thật dùng, không hơn ──
function makeFakeDocument() {
  const elements = new Map();
  function ensure(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id, innerHTML: '', textContent: '', disabled: false,
        style: { display: 'none' },
        classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } },
      });
    }
    return elements.get(id);
  }
  ensure('optimizer-modal').style.display = 'flex'; // mặc định coi như modal đang MỞ trong lúc test
  ensure('optimizer-body');
  ensure('optimizer-error');
  ensure('optimizer-run-btn');
  ensure('optimizer-diag-result');
  return { getElementById: ensure, _elements: elements };
}

// ── sandbox mới cho MỖI test — tránh state (poll timer, busy flag...) rò rỉ giữa các test ──
function makeSandbox({ fetchImpl, isAdmin = false, isLoggedInVal = true } = {}) {
  const fakeDoc = makeFakeDocument();
  const calls = { fetch: [] };
  const sandbox = {
    console,
    document: fakeDoc,
    setTimeout, clearTimeout, // dùng thật (Node có sẵn) — polling thật sẽ chạy, test tự clear khi xong
    fetch: (...args) => { calls.fetch.push(args); return (fetchImpl || (() => Promise.reject(new Error('fetch không được mock trong test này'))))(...args); },
    authHeaders: () => ({ Authorization: 'Bearer test-token' }),
    isAdminRole: () => isAdmin,
    isLoggedIn: () => isLoggedInVal,
    confirm: () => true,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'fsrs-optimizer.js' });
  sandbox.__doc = fakeDoc;
  sandbox.__calls = calls;
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
    console.log(`     ${e.stack || e.message}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.stack || e.message}`);
  }
}

console.log('════════════════════════════════════════════════════');
console.log('V88 FRONTEND SMOKE TEST — js/fsrs-optimizer.js (chạy code thật qua Node vm + DOM giả)');
console.log('════════════════════════════════════════════════════');

// ────────────────────────────────────────────────────
console.log('\n[renderOptimizerBody() — không được throw ReferenceError/TypeError ở BẤT KỲ state nào]');

// Các "hình dạng" status thật mà GET /status có thể trả (đúng shape lib/fsrs/optimizer.js:mapJobRow +
// getOptimizerStatus trả về — bindingAvailable:null/optimizerEngineState:'UNKNOWN' theo đúng kiến
// trúc V87, KHÔNG còn engineStatus).
const BASE_STATUS = {
  ok: true,
  report: { validReviews: 4372, totalReviews: 4400, uniqueCards: 794, dateRange: { days: 120 }, duplicates: 0, approximate: false },
  readiness: { status: 'OPTIMIZABLE', reason: 'Đủ dữ liệu để tối ưu.' },
  bindingAvailable: null, // V87 — KHÔNG còn true/false tự động, luôn null trừ khi admin tự probe
  bindingVersion: '0.5.0',
  optimizerEngineState: 'UNKNOWN', // V87 — mặc định luôn UNKNOWN
  job: null,
  personalWeightsEnabled: false,
  hasCandidate: false,
  canRollback: false,
  status: 'idle',
  lastError: null,
};

const STATE_FIXTURES = {
  'idle (chưa từng Run)': { ...BASE_STATUS, status: 'idle' },
  'queued': { ...BASE_STATUS, status: 'queued', job: { id: 1, status: 'queued', stage: 'queued', attempt: 1, maxAttempts: 3, progress: null } },
  'running (có tiến độ)': { ...BASE_STATUS, status: 'running', job: { id: 1, status: 'running', stage: 'training', attempt: 1, maxAttempts: 3, progress: { current: 400, total: 794 } } },
  'running (đang tự thử lại, attempt>1)': { ...BASE_STATUS, status: 'running', job: { id: 1, status: 'running', stage: 'prepared', attempt: 2, maxAttempts: 3, progress: null } },
  'failed': { ...BASE_STATUS, status: 'failed', lastError: 'Optimizer thất bại. Vui lòng thử lại.' },
  'completed (có candidate + kết quả lần chạy gần nhất)': {
    ...BASE_STATUS, status: 'completed', hasCandidate: true,
    candidateMeta: { defaultScore: 0.42, personalScore: 0.35, improvement: 0.166, recommend: true, trainCards: 635, validationCards: 159, optimizerVersion: '0.5.0' },
  },
  'personal weights đang active': { ...BASE_STATUS, status: 'completed', personalWeightsEnabled: true, appliedAt: new Date().toISOString(), canRollback: true },
  'NOT_READY (chưa đủ dữ liệu)': { ...BASE_STATUS, status: 'idle', readiness: { status: 'NOT_READY', reason: 'Chưa đủ review hợp lệ.' } },
};

for (const [label, fixture] of Object.entries(STATE_FIXTURES)) {
  test(`renderOptimizerBody() — state "${label}" — không throw`, () => {
    const sb = makeSandbox({ isAdmin: false });
    assert.doesNotThrow(() => sb.renderOptimizerBody(fixture), `renderOptimizerBody() throw ở state "${label}"`);
    assert.ok(sb.__doc.getElementById('optimizer-body').innerHTML.length > 0, 'phải render ra HTML thật, không để trống');
  });
}

test('renderOptimizerBody(): admin thấy nút "Kiểm tra engine", user thường KHÔNG thấy', () => {
  const sbAdmin = makeSandbox({ isAdmin: true });
  sbAdmin.renderOptimizerBody(BASE_STATUS);
  assert.ok(sbAdmin.__doc.getElementById('optimizer-body').innerHTML.includes('checkOptimizerEngineDiagnostics'), 'admin phải thấy nút kiểm tra engine thủ công');

  const sbUser = makeSandbox({ isAdmin: false });
  sbUser.renderOptimizerBody(BASE_STATUS);
  assert.ok(!sbUser.__doc.getElementById('optimizer-body').innerHTML.includes('checkOptimizerEngineDiagnostics'), 'user thường KHÔNG được thấy nút này (Phần IV — chỉ admin, có rủi ro native)');
});

// ────────────────────────────────────────────────────
console.log('\n[TÁI HIỆN ĐÚNG BUG GỐC — bindingUnavailable — và xác nhận đã sửa]');

test('Bug gốc: renderOptimizerBody() với status thật kiểu V87 (bindingAvailable:null) — job failed → nút PHẢI là "🔁 Thử lại", KHÔNG throw ReferenceError bindingUnavailable', () => {
  const sb = makeSandbox({ isAdmin: false });
  const failedStatus = { ...BASE_STATUS, status: 'failed', lastError: 'Optimizer thất bại. Vui lòng thử lại.' };
  assert.doesNotThrow(() => sb.renderOptimizerBody(failedStatus));
  const html = sb.__doc.getElementById('optimizer-body').innerHTML;
  assert.ok(html.includes('🔁 Thử lại'), 'job failed phải hiện nút "Thử lại"');
  assert.ok(!html.includes('Optimizer chưa sẵn sàng'), 'KHÔNG còn hiện nhãn "chưa sẵn sàng" cũ (dựa vào bindingUnavailable đã xoá)');
  assert.ok(!/optimizer-run-btn"[^>]*disabled/.test(html), 'job failed (không active) → nút Run KHÔNG được disabled (khác lúc trước khi sửa: (isActive||bindingUnavailable) luôn để disabled oan nếu bindingUnavailable bị coi truthy do lỗi)');
});

test('Source code: KHÔNG còn bất kỳ tham chiếu nào tới biến bindingUnavailable (Phần 13 — search toàn diện, không chỉ sửa 1 dòng)', () => {
  assert.ok(!/bindingUnavailable/.test(SRC), 'phải xoá HẲN, không còn sót ở bất kỳ đâu trong file');
});

// ────────────────────────────────────────────────────
console.log('\n[loadOptimizerStatus() — round-trip THẬT qua fetch giả — UI không bao giờ mắc "Đang tải..."]');

async function run() {
  await testAsync('fetch thành công + status hợp lệ → render xong, KHÔNG còn "Đang tải..." tĩnh ban đầu', async () => {
    const sb = makeSandbox({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ...BASE_STATUS, status: 'completed' }) }),
    });
    sb.__doc.getElementById('optimizer-body').innerHTML = '⏳ Đang tải...'; // mô phỏng đúng HTML tĩnh ban đầu trong index.html
    await sb.loadOptimizerStatus();
    const html = sb.__doc.getElementById('optimizer-body').innerHTML;
    assert.notStrictEqual(html, '⏳ Đang tải...', 'PHẢI được ghi đè — đây chính là bug gốc: throw giữa chừng khiến innerHTML giữ nguyên "Đang tải..." mãi mãi');
    assert.ok(html.length > 20);
  });

  await testAsync('fetch() tự throw (network error thật) → hiện thông báo mất kết nối, KHÔNG throw ra ngoài, KHÔNG còn "Đang tải..."', async () => {
    const sb = makeSandbox({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    sb.__doc.getElementById('optimizer-body').innerHTML = '⏳ Đang tải...';
    await assert.doesNotReject(() => sb.loadOptimizerStatus());
    const html = sb.__doc.getElementById('optimizer-body').innerHTML;
    assert.notStrictEqual(html, '⏳ Đang tải...');
    assert.ok(html.includes('Không kết nối được máy chủ'));
    sb.stopOptimizerPolling(); // dọn timer tự-thử-lại đã được hẹn, tránh treo tiến trình test
  });

  await testAsync('HTTP 401 → hiện phiên hết hạn, dừng polling, KHÔNG throw', async () => {
    const sb = makeSandbox({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: 'unauthorized' }) }) });
    await assert.doesNotReject(() => sb.loadOptimizerStatus());
    const html = sb.__doc.getElementById('optimizer-body').innerHTML;
    assert.ok(html.includes('Phiên đăng nhập'));
  });

  await testAsync('Response KHÔNG PHẢI JSON hợp lệ (vd HTML lỗi 500 của platform) → không crash, có fallback rõ ràng', async () => {
    const sb = makeSandbox({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => { throw new SyntaxError('Unexpected token <'); } }) });
    await assert.doesNotReject(() => sb.loadOptimizerStatus());
    const html = sb.__doc.getElementById('optimizer-body').innerHTML;
    assert.ok(html.includes('Lỗi server'));
    sb.stopOptimizerPolling();
  });

  await testAsync('renderOptimizerBody() throw (mô phỏng lỗi lập trình tương lai, vd data=null) → loadOptimizerStatus() PHẢI bắt lại, hiện lỗi + nút Thử lại, KHÔNG để "Đang tải..." mãi mãi', async () => {
    const sb = makeSandbox({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => null }) });
    sb.__doc.getElementById('optimizer-body').innerHTML = '⏳ Đang tải...';
    await assert.doesNotReject(() => sb.loadOptimizerStatus());
    const html = sb.__doc.getElementById('optimizer-body').innerHTML;
    assert.notStrictEqual(html, '⏳ Đang tải...', 'ĐÂY LÀ TEST QUAN TRỌNG NHẤT — đúng lớp bug đã xảy ra: render throw giữa chừng không được để lại "Đang tải..." vĩnh viễn');
    assert.ok(html.includes('Lỗi giao diện Optimizer') || html.includes('Lỗi server'), 'phải có thông báo lỗi rõ ràng kèm cách thử lại');
  });

  await testAsync('Cap chống tự-thử-lại vô hạn: gọi loadOptimizerStatus({isAutoPoll:true}) liên tiếp vượt ngưỡng → dừng tự động, không dội fetch vô hạn', async () => {
    let fetchCount = 0;
    const sb = makeSandbox({ fetchImpl: async () => { fetchCount++; throw new TypeError('Failed to fetch'); } });
    for (let i = 0; i < 10; i++) {
      sb.stopOptimizerPolling();
      await sb.loadOptimizerStatus({ isAutoPoll: true }); // giả lập NHIỀU lượt tự động liên tiếp đều lỗi
    }
    assert.ok(fetchCount < 10, `phải dừng tự động thử lại sau ngưỡng cố định — fetch đã gọi ${fetchCount} lần cho 10 lượt yêu cầu (phải nhỏ hơn 10 vì có cap)`);
    const html = sb.__doc.getElementById('optimizer-body').innerHTML;
    assert.ok(html.includes('nhiều lần thử'));
  });

  await testAsync('Lượt gọi THỦ CÔNG (isAutoPoll mặc định false) reset được bộ đếm lỗi — bấm "Thử lại" sau khi đã cap vẫn thử lại được, không bị kẹt cap vĩnh viễn', async () => {
    let shouldFail = true;
    const sb = makeSandbox({
      fetchImpl: async () => {
        if (shouldFail) throw new TypeError('Failed to fetch');
        return { ok: true, status: 200, json: async () => ({ ok: true, ...BASE_STATUS, status: 'completed' }) };
      },
    });
    for (let i = 0; i < 6; i++) { sb.stopOptimizerPolling(); await sb.loadOptimizerStatus({ isAutoPoll: true }); }
    assert.ok(sb.__doc.getElementById('optimizer-body').innerHTML.includes('nhiều lần thử'), 'phải đã bị cap sau 6 lượt tự động lỗi liên tiếp');
    shouldFail = false;
    await sb.loadOptimizerStatus(); // gọi THỦ CÔNG (như bấm nút "Thử lại") — không truyền isAutoPoll
    const html = sb.__doc.getElementById('optimizer-body').innerHTML;
    assert.ok(!html.includes('nhiều lần thử'), 'lượt gọi thủ công phải thoát khỏi trạng thái cap, thử tải lại thật');
  });

  console.log('\n════════════════════════════════════════════════════');
  console.log(`Kết quả: ${passed} PASS, ${failed} FAIL`);
  console.log('════════════════════════════════════════════════════');
  if (failed > 0) process.exit(1);
}

run();
