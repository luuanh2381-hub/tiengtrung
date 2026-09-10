#!/usr/bin/env node
// ════════════════════════════════════════════════════
// test/visibility-timer.test.js — "review nhiễu khi thoát ra vào lại"
//
// js/visibility-timer.js là file FRONTEND thuần (chạy bằng thẻ <script> thường trên trình duyệt,
// không phải Node module — không có require/module.exports). Để test được trong Node (không cần
// trình duyệt/jsdom), dùng module `vm` built-in của Node chạy file trong 1 sandbox context riêng có
// mock tối giản cho `document`/`performance` — mô phỏng ĐÚNG hành vi thật: `performance.now()` là
// đồng hồ tăng dần độc lập, `document.hidden`/visibilitychange mô phỏng lúc tab bị ẩn/hiện lại.
//
// Chạy: node test/visibility-timer.test.js
// ════════════════════════════════════════════════════
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

// Tạo 1 sandbox MỚI cho mỗi test (đồng hồ giả `now` + trạng thái `hidden` riêng, không rò rỉ giữa
// các test) — nạp lại file thật từ js/visibility-timer.js, không copy/diễn giải lại logic ở đây.
function makeSandbox() {
  let now = 0;
  let hidden = false;
  const listeners = [];
  const sandbox = {
    document: {
      get hidden() { return hidden; },
      addEventListener: (evt, fn) => { if (evt === 'visibilitychange') listeners.push(fn); },
    },
    performance: { now: () => now },
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'visibility-timer.js'), 'utf8');
  vm.runInContext(code, sandbox);
  return {
    vtMarkStart: () => sandbox.vtMarkStart(),
    vtHiddenMs: () => sandbox.vtHiddenMs(),
    advanceTime: (ms) => { now += ms; },
    setHidden: (v) => { hidden = v; listeners.forEach(fn => fn()); }, // mô phỏng browser bắn 'visibilitychange'
  };
}

console.log('════════════════════════════════════════════════════');
console.log('visibility-timer — test (giả lập document/performance bằng vm, không cần trình duyệt)');
console.log('════════════════════════════════════════════════════');

test('Không ẩn lần nào trong lúc chờ trả lời -> vtHiddenMs() = 0 (không ảnh hưởng gì tới case bình thường)', () => {
  const t = makeSandbox();
  t.vtMarkStart();
  t.advanceTime(5000);
  assert.strictEqual(t.vtHiddenMs(), 0);
});

test('Thoát ra 1 lần rồi vào lại -> vtHiddenMs() phản ánh ĐÚNG khoảng thời gian đã vắng mặt', () => {
  const t = makeSandbox();
  t.vtMarkStart();
  t.advanceTime(1000);      // suy nghĩ 1s
  t.setHidden(true);        // chuyển sang app khác
  t.advanceTime(600000);    // rời đi 10 phút
  t.setHidden(false);       // quay lại
  t.advanceTime(500);       // suy nghĩ thêm rồi bấm chọn
  assert.strictEqual(t.vtHiddenMs(), 600000, 'phải trừ ĐÚNG đủ 10 phút đã vắng mặt, không thiếu không thừa');
});

test('Ẩn/hiện NHIỀU LẦN trong CÙNG 1 câu hỏi (vd bật app nhắn tin vài lần) -> cộng dồn đúng từng đoạn', () => {
  const t = makeSandbox();
  t.vtMarkStart();
  t.advanceTime(500);
  t.setHidden(true); t.advanceTime(10000); t.setHidden(false); // ẩn 10s
  t.advanceTime(200);
  t.setHidden(true); t.advanceTime(30000); t.setHidden(false); // ẩn thêm 30s
  t.advanceTime(100);
  assert.strictEqual(t.vtHiddenMs(), 40000);
});

test('vtMarkStart() cho câu hỏi MỚI phải reset về 0 — không mang theo thời gian ẩn của câu TRƯỚC', () => {
  const t = makeSandbox();
  t.vtMarkStart();
  t.setHidden(true); t.advanceTime(50000); t.setHidden(false); // câu 1: bị ẩn 50s
  assert.strictEqual(t.vtHiddenMs(), 50000);
  t.vtMarkStart(); // sang câu hỏi MỚI
  t.advanceTime(1000);
  assert.strictEqual(t.vtHiddenMs(), 0, 'không được rò rỉ 50000ms của câu hỏi trước sang câu này');
});

test('Edge case: vtMarkStart() được gọi ĐÚNG lúc tab đang ẩn -> vẫn tính đúng từ thời điểm đó trở đi', () => {
  const t = makeSandbox();
  t.setHidden(true); // đã ẩn từ trước khi câu hỏi này kịp chuẩn bị xong
  t.vtMarkStart();
  t.advanceTime(5000);
  t.setHidden(false);
  assert.strictEqual(t.vtHiddenMs(), 5000);
});

test('Đang ẩn NGAY LÚC gọi vtHiddenMs() (chưa quay lại) -> vẫn cộng đúng phần đang ẩn dở, không đợi visibilitychange mới tính', () => {
  const t = makeSandbox();
  t.vtMarkStart();
  t.advanceTime(1000);
  t.setHidden(true);
  t.advanceTime(3000); // vẫn đang ẩn tại thời điểm gọi
  assert.strictEqual(t.vtHiddenMs(), 3000);
});

test('Mô phỏng luồng sử dụng thật: responseTimeMs sau khi trừ phải xấp xỉ đúng "thời gian suy nghĩ thật", không lẫn thời gian vắng mặt', () => {
  const t = makeSandbox();
  const START = 0;
  t.vtMarkStart(); // rvStartedAt = performance.now() (=0 ở sandbox này)
  t.advanceTime(2000);      // suy nghĩ 2s
  t.setHidden(true);
  t.advanceTime(600000);    // rời đi 10 phút — ĐÂY LÀ "review nhiễu" nếu không xử lý
  t.setHidden(false);
  t.advanceTime(1000);      // suy nghĩ thêm 1s rồi bấm chọn
  const rawElapsed = 2000 + 600000 + 1000; // 603000 — nếu KHÔNG trừ thời gian ẩn (bug cũ)
  const responseTimeMs = Math.max(0, rawElapsed - t.vtHiddenMs()); // đúng công thức dùng ở review.js/flashcard.js/...
  assert.strictEqual(responseTimeMs, 3000, `phải ra đúng 3000ms (2s+1s suy nghĩ thật), không phải ${rawElapsed}ms`);
});

console.log('\n════════════════════════════════════════════════════');
console.log(`Kết quả: ${passed} PASS, ${failed} FAIL`);
console.log('════════════════════════════════════════════════════');
if (failed > 0) process.exitCode = 1;
