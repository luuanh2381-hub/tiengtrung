#!/usr/bin/env node
// ════════════════════════════════════════════════════
// scripts/verify-optimizer-binding.js
//
// Chạy tự động qua "postinstall" (npm install) — nghĩa là chạy NGAY trong build container của
// Vercel, TRƯỚC khi function được đóng gói/deploy. Mục đích: biến 1 lỗi runtime ÂM THẦM ("Cannot
// find module '@open-spaced-repetition/binding'" chỉ lộ ra khi user bấm Run Optimizer trên
// production) thành 1 dòng CHẨN ĐOÁN RÕ RÀNG ngay trong Build Logs của Vercel — kể cả khi script
// này không chặn deploy (xem phần STRICT MODE bên dưới).
//
// MẶC ĐỊNH: KHÔNG BAO GIỜ làm fail build/deploy (exit code luôn 0), vì nếu optimizer chính thức
// không load được trên 1 nền tảng nào đó, đó CHỈ là 1 tính năng phụ (tự train weights cá nhân) —
// toàn bộ app học từ vựng chính (review/lesson/quiz...) không phụ thuộc vào nó, không có lý do gì
// để 1 dependency phụ làm sập cả app đang có người dùng thật. Server (lib/fsrs/optimizer.js) đã tự
// xử lý an toàn trường hợp thiếu binding (báo "OPTIMIZER_UNAVAILABLE" cho UI, không throw ra ngoài
// luồng review thật).
//
// STRICT MODE (tuỳ chọn): đặt biến môi trường FSRS_OPTIMIZER_STRICT_BUILD=1 trên Vercel (Project
// Settings → Environment Variables) nếu bạn muốn build THỰC SỰ FAIL khi optimizer không load được —
// hữu ích sau khi bạn đã xác nhận nó PHẢI chạy được và muốn deploy tự chặn nếu regressions.
// ════════════════════════════════════════════════════
'use strict';

const STRICT = process.env.FSRS_OPTIMIZER_STRICT_BUILD === '1';

function safeGlibcVersion() {
  try {
    const report = process.report && process.report.getReport && process.report.getReport();
    return (report && report.header && report.header.glibcVersionRuntime) || null;
  } catch {
    return null;
  }
}

function line(char = '─', n = 70) { return char.repeat(n); }

function main() {
  const runtime = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    glibc: safeGlibcVersion(),
  };

  console.log('\n' + line('═'));
  console.log('FSRS OPTIMIZER — build-time binding check (scripts/verify-optimizer-binding.js)');
  console.log(line('═'));
  console.log(`Môi trường build: node=${runtime.node} platform=${runtime.platform} arch=${runtime.arch}` +
    (runtime.glibc ? ` glibc=${runtime.glibc}` : ' glibc=(không đọc được — có thể là musl/Alpine, hoặc process.report không khả dụng)'));

  // Bước 1: gói base có require() được không? Đây CHÍNH XÁC là dòng đang fail trên production
  // ("Cannot find module '@open-spaced-repetition/binding'") — nếu nó CŨNG fail ngay ở đây, TRONG
  // build container của Vercel, thì kết luận CHẮC CHẮN: đây là lỗi CÀI ĐẶT (npm install không cài
  // được / registry chặn / thiếu optionalDependency phù hợp), KHÔNG PHẢI lỗi đóng gói function
  // (Node File Trace / includeFiles) — 2 loại lỗi này cần sửa khác nhau hoàn toàn.
  let binding = null;
  let requireError = null;
  try {
    binding = require('@open-spaced-repetition/binding');
  } catch (e) {
    requireError = e;
  }

  if (!binding) {
    console.error(`❌ require('@open-spaced-repetition/binding') FAIL NGAY TRONG BUILD: ${requireError.message}`);
    console.error('   → Kết luận: đây là lỗi CÀI ĐẶT (npm install trong build container không có gói này),');
    console.error('     KHÔNG PHẢI lỗi đóng gói Vercel Function (includeFiles/Node File Trace).');
    console.error('   → Kiểm tra: (1) package.json có đúng "@open-spaced-repetition/binding" trong');
    console.error('     "dependencies" không, (2) registry mặc định (không có scope registry lạ trong .npmrc),');
    console.error('     (3) log "npm install" phía trên dòng này có báo lỗi/warning gì về gói này không.');
    reportAndExit({ available: false, engine: null, ...runtime, error: requireError.message, stage: 'require-base-package' });
    return;
  }

  const { computeParameters, FSRSBindingItem, FSRSBindingReview } = binding;
  if (typeof computeParameters !== 'function' || typeof FSRSBindingItem !== 'function' || typeof FSRSBindingReview !== 'function') {
    console.error('❌ Gói ĐÃ load nhưng KHÔNG export đúng computeParameters/FSRSBindingItem/FSRSBindingReview.');
    console.error('   → Package đang ở public beta, API có thể đã đổi — mở');
    console.error('     node_modules/@open-spaced-repetition/binding/README.md thật rồi cập nhật');
    console.error('     lib/fsrs/optimizer.js:trainWithOfficialOptimizer() cho khớp.');
    reportAndExit({ available: false, engine: null, ...runtime, error: 'API export không khớp tài liệu công khai', stage: 'validate-api' });
    return;
  }

  // Bước 2: engine nào đang chạy? Best-effort — package không expose cờ này qua public API, suy
  // luận gián tiếp bằng cách thử require() gói native platform tương ứng runtime hiện tại.
  let expectedNative = null;
  if (runtime.platform === 'darwin') expectedNative = `@open-spaced-repetition/binding-darwin-${runtime.arch === 'arm64' ? 'arm64' : 'x64'}`;
  else if (runtime.platform === 'win32') expectedNative = '@open-spaced-repetition/binding-win32-x64-msvc';
  else if (runtime.platform === 'linux') expectedNative = `@open-spaced-repetition/binding-linux-${runtime.arch}-gnu`; // giả định glibc — Vercel Node Functions chạy Amazon Linux, không phải musl

  let engine = 'unknown';
  if (expectedNative) {
    try { require(expectedNative); engine = 'native'; } catch { engine = 'wasi-or-other'; }
  }
  let wasmAssetPresent = false;
  try { require.resolve('@open-spaced-repetition/binding-wasm32-wasi/package.json'); wasmAssetPresent = true; } catch {}

  console.log(`✅ require('@open-spaced-repetition/binding') OK trong build container — version ${getVersion()}.`);
  console.log(`   Engine suy luận (best-effort): ${engine}${expectedNative ? ` (đã thử: ${expectedNative})` : ''}`);
  console.log(`   Gói WASI fallback (@open-spaced-repetition/binding-wasm32-wasi) có mặt: ${wasmAssetPresent ? 'CÓ' : 'KHÔNG'}`);
  console.log('   ⚠️  LƯU Ý QUAN TRỌNG: kết quả PASS ở đây chỉ chứng minh gói cài được trong BUILD');
  console.log('   container — KHÔNG chứng minh nó còn trong function ĐÃ ĐÓNG GÓI trên production');
  console.log('   (Vercel dùng Node File Trace để chỉ đóng gói phần cần thiết — vercel.json:includeFiles');
  console.log('   đã được khai báo để ép đưa toàn bộ node_modules/@open-spaced-repetition/** vào, nhưng');
  console.log('   CHỈ khi Framework Preset thực sự là "Other" — nếu Vercel dùng builder khác, includeFiles');
  console.log('   có thể bị BỎ QUA ÂM THẦM, chỉ có 1 dòng cảnh báo trong build log, không phải lỗi to).');
  console.log('   → Sau khi deploy, GỌI GET /api/fsrs-optimizer/status trên chính URL production để xác');
  console.log('     nhận lần cuối — đó là bằng chứng DUY NHẤT đáng tin, không phải kết quả script này.');
  console.log(line('═') + '\n');

  reportAndExit({ available: true, engine, packageVersion: getVersion(), ...runtime, nativeBinary: expectedNative, wasmAssetPresent, error: null, stage: 'ok' });
}

function getVersion() {
  try { return require('@open-spaced-repetition/binding/package.json').version; } catch { return null; }
}

function reportAndExit(result) {
  if (!result.available) {
    console.error(line('═'));
    if (STRICT) {
      console.error('FSRS_OPTIMIZER_STRICT_BUILD=1 đang bật → LÀM FAIL BUILD (exit 1).');
      console.error(line('═') + '\n');
      process.exitCode = 1;
      return;
    }
    console.error('Build vẫn tiếp tục bình thường (mặc định KHÔNG chặn deploy vì optimizer chỉ là');
    console.error('tính năng phụ) — nhưng tính năng "🧠 FSRS Optimizer" sẽ báo OPTIMIZER_UNAVAILABLE');
    console.error('cho tới khi vấn đề trên được sửa. Đặt FSRS_OPTIMIZER_STRICT_BUILD=1 nếu muốn build');
    console.error('tự chặn deploy trong trường hợp này.');
    console.error(line('═') + '\n');
  }
  process.exitCode = 0;
}

main();
