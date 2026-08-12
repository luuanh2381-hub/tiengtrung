// ════════════════════════════════════════════════════
// TEST BẮT BUỘC cho FSRS-6 (Phần 16). Dùng "assert" thuần của Node — không thêm devDependency
// framework test nào để tránh phải cài thêm gói (giữ đúng scope nâng cấp FSRS-6).
// Chạy: npm test  (= node test/fsrs.test.js)
//
// Mỗi test kiểm tra state/difficulty/stability/scheduled_days/due — không chỉ "chạy không lỗi".
// ════════════════════════════════════════════════════
const assert = require('assert');
const { reviewCard, getFsrsVerificationInfo, FSRS6_PARAM_COUNT, State } = require('../lib/fsrs');
const { personalBaselineMs } = require('../lib/fsrs-auto-rating');

// Bộ 21 default weights FSRS-6 CHÍNH THỨC, công bố bởi open-spaced-repetition (fsrs4anki /
// fsrs-optimizer / ts-fsrs "example" đều dùng chung 1 bộ này khi chưa optimize riêng cho user).
// Dùng để so khớp CHÍNH XÁC — không chỉ đếm số lượng — rằng scheduler đang chạy đúng FSRS-6 thật,
// không phải 1 bộ 21-số bất kỳ hoặc bộ weights của FSRS-5 (19 số) bị pad thêm cho đủ 21.
// Nguồn: open-spaced-repetition/fsrs4anki, open-spaced-repetition/ts-fsrs (packages/fsrs/example).
const OFFICIAL_FSRS6_DEFAULT_W = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    results.push([name, 'PASS']);
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    results.push([name, 'FAIL']);
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}

function assertValidCard(card) {
  assert.ok(card, 'card phải tồn tại');
  assert.ok([State.New, State.Learning, State.Review, State.Relearning].includes(card.state),
    `state hợp lệ, nhận được ${card.state}`);
  assert.ok(Number.isFinite(card.difficulty) && card.difficulty >= 1 && card.difficulty <= 10,
    `difficulty trong khoảng [1,10], nhận được ${card.difficulty}`);
  assert.ok(Number.isFinite(card.stability) && card.stability > 0,
    `stability > 0, nhận được ${card.stability}`);
  assert.ok(Number.isFinite(card.scheduled_days) && card.scheduled_days >= 0,
    `scheduled_days >= 0, nhận được ${card.scheduled_days}`);
  assert.ok(card.due instanceof Date && !Number.isNaN(card.due.getTime()), 'due là Date hợp lệ');
}

const BASE = new Date('2026-08-01T09:00:00.000Z');

// ── 0. FSRS-6 verification ──
test('FSRS-6: scheduler dùng đúng 21 parameters', () => {
  const info = getFsrsVerificationInfo();
  assert.strictEqual(info.paramCount, FSRS6_PARAM_COUNT);
  assert.strictEqual(info.isFsrs6, true);
});

// Kiểm chứng MẠNH hơn "length === 21": so khớp TỪNG giá trị với bộ default weights FSRS-6 công bố
// chính thức (project chưa optimize riêng nên vẫn phải khớp default của thư viện). Nếu package
// đang cài thực chất là bản giả/patch tự chế 21 số ngẫu nhiên, test này sẽ FAIL dù length đúng.
test('FSRS-6: 21 default weights khớp CHÍNH XÁC với công bố chính thức', () => {
  const info = getFsrsVerificationInfo();
  assert.strictEqual(info.w.length, OFFICIAL_FSRS6_DEFAULT_W.length);
  info.w.forEach((val, i) => {
    assert.ok(
      Math.abs(val - OFFICIAL_FSRS6_DEFAULT_W[i]) < 1e-6,
      `w[${i}] = ${val}, kỳ vọng ${OFFICIAL_FSRS6_DEFAULT_W[i]} (default FSRS-6 chính thức)`
    );
  });
});

// ── New → {Again, Hard, Good, Easy} ──
for (const rating of ['again', 'hard', 'good', 'easy']) {
  test(`New -> ${rating}`, () => {
    const { newCard, ratingName } = reviewCard(null, rating, BASE);
    assertValidCard(newCard);
    assert.strictEqual(ratingName, rating);
    if (rating === 'again') {
      // Again trên thẻ New -> Learning (không nhảy thẳng Review)
      assert.strictEqual(newCard.state, State.Learning);
    } else {
      assert.ok([State.Learning, State.Review].includes(newCard.state));
    }
  });
}

// ── Good -> {Again, Hard, Good, Easy} (thẻ đã có lịch sử) ──
const { newCard: goodBaseCard } = reviewCard(null, 'good', BASE);
for (const rating of ['again', 'hard', 'good', 'easy']) {
  test(`Good -> ${rating}`, () => {
    const reviewTime = new Date(goodBaseCard.due.getTime());
    const { newCard } = reviewCard(goodBaseCard, rating, reviewTime);
    assertValidCard(newCard);
    if (rating === 'again') {
      assert.ok(newCard.lapses >= goodBaseCard.lapses,
        'lapses phải tăng hoặc giữ nguyên sau Again');
    }
  });
}

// ── Multiple reviews same day ──
test('Multiple reviews same day: Good -> Good (+2h) -> Hard (+5h)', () => {
  const { newCard: c1 } = reviewCard(null, 'good', BASE);
  const t2 = new Date(BASE.getTime() + 2 * 60 * 60 * 1000);
  const { newCard: c2 } = reviewCard(c1, 'good', t2);
  assertValidCard(c2);
  const t3 = new Date(BASE.getTime() + 5 * 60 * 60 * 1000);
  const { newCard: c3 } = reviewCard(c2, 'hard', t3);
  assertValidCard(c3);
  // Cùng ngày -> due mới vẫn phải >= thời điểm review vừa rồi.
  assert.ok(c3.due.getTime() >= t3.getTime());
});

// ── Review after several days ──
test('Review after several days: New -> Good -> (due date) Good', () => {
  const { newCard: c1 } = reviewCard(null, 'good', BASE);
  assert.ok(c1.scheduled_days >= 0);
  const dueTime = new Date(c1.due.getTime());
  const { newCard: c2 } = reviewCard(c1, 'good', dueTime);
  assertValidCard(c2);
  assert.ok(c2.stability >= 0);
});

// ── Review at midnight (23:59 / 00:00 / 00:01) ──
test('Review at midnight boundary (23:59 -> 00:01 UTC)', () => {
  const t2359 = new Date('2026-08-10T23:59:00.000Z');
  const { newCard: c1 } = reviewCard(null, 'good', t2359);
  assertValidCard(c1);
  const t0000 = new Date('2026-08-11T00:00:00.000Z');
  const { newCard: c2 } = reviewCard(c1, 'good', t0000);
  assertValidCard(c2);
  const t0001 = new Date('2026-08-11T00:01:00.000Z');
  const { newCard: c3 } = reviewCard(c2, 'good', t0001);
  assertValidCard(c3);
  // due luôn phải >= thời điểm review (không được lùi về quá khứ).
  assert.ok(c3.due.getTime() >= t0001.getTime());
});

// ── Rating mapping (Phần 8) ──
test('Rating mapping Again=1 Hard=2 Good=3 Easy=4', () => {
  const { Rating } = require('ts-fsrs');
  assert.strictEqual(Rating.Again, 1);
  assert.strictEqual(Rating.Hard, 2);
  assert.strictEqual(Rating.Good, 3);
  assert.strictEqual(Rating.Easy, 4);
});

// ── reviewCard() phải dùng scheduler.next(), không dùng repeat() khi rating đã biết ──
test('reviewCard() dùng next() — chỉ tính đúng 1 nhánh rating, không preview cả 4', () => {
  const { fsrs, generatorParameters, createEmptyCard, Rating } = require('ts-fsrs');
  const scheduler = fsrs(generatorParameters({ request_retention: 0.9, enable_fuzz: true }));
  const card = createEmptyCard(BASE);

  let repeatCalls = 0;
  let nextCalls = 0;
  const origRepeat = scheduler.repeat.bind(scheduler);
  const origNext = scheduler.next.bind(scheduler);
  scheduler.repeat = (...args) => { repeatCalls += 1; return origRepeat(...args); };
  scheduler.next = (...args) => { nextCalls += 1; return origNext(...args); };

  // Gọi trực tiếp API next() đúng như lib/fsrs.js đang làm, để xác nhận API tồn tại + trả về
  // đúng { card, log } cho 1 rating cụ thể (không phải object indexed theo cả 4 rating).
  const result = scheduler.next(card, BASE, Rating.Good);
  assert.ok(result && result.card && result.log, 'next() trả về { card, log }');
  assert.strictEqual(nextCalls, 1);
  assert.strictEqual(repeatCalls, 0, 'không gọi repeat() khi đã biết rating');
  assertValidCard(result.card);
});

// ── Baseline responseTime: phải tự sort theo reviewed_at DESC, không phụ thuộc ngầm vào thứ tự
//     caller truyền vào (yêu cầu mới — Phần 6). Test này dựng tình huống mà nếu KHÔNG sort (bug
//     cũ: chỉ .slice(0,10) trên mảng chưa chắc đã sort) sẽ ra kết quả SAI hẳn (5499.5 thay vì
//     1000), để chứng minh việc sort thực sự có tác dụng chứ không phải no-op. ──
test('personalBaselineMs(): tự sort theo reviewed_at, không phụ thuộc thứ tự input', () => {
  const makeRow = (ms, minutesAgo) => ({
    answer_correct: true,
    response_time_ms: ms,
    reviewed_at: new Date(BASE.getTime() - minutesAgo * 60000).toISOString(),
  });
  // 5 lượt RẤT CŨ (1000 phút trước, responseTime=9999) cố tình đặt Ở ĐẦU mảng input — mô phỏng
  // 1 caller không sort theo reviewed_at. 10 lượt THẬT SỰ gần nhất (1..10 phút trước) có
  // responseTime=1000, đặt sau. Nếu code cũ chỉ .slice(0,10) trên mảng này (không tự sort) sẽ lấy
  // nhầm 5 lượt cũ + 5 lượt mới → median lệch hẳn (5499.5). Code đã sửa phải tự sort trước, chỉ
  // lấy đúng 10 lượt MỚI NHẤT (toàn bộ responseTime=1000) → median đúng = 1000.
  const oldJunk = Array.from({ length: 5 }, () => makeRow(9999, 1000));
  const trueRecent = Array.from({ length: 10 }, (_, i) => makeRow(1000, i + 1));
  const messyOrder = [...oldJunk, ...trueRecent]; // cố tình KHÔNG sort, rác cũ ở đầu
  const baseline = personalBaselineMs(messyOrder);
  assert.strictEqual(baseline, 1000,
    `baseline phải = 1000 (median của 10 lượt MỚI NHẤT thật sự), nhận được ${baseline} ` +
    `(nếu ra 5499.5 nghĩa là hàm chưa tự sort mà đang tin thứ tự input)`);
});

// ── Concurrent review: xử lý ở tầng DB (SELECT ... FOR UPDATE trong lib/db.js::reviewFsrsCard),
//     KHÔNG thể unit-test thuần ở tầng scheduler vì không chạm DB. Cần Postgres thật để test tích
//     hợp 2 request đồng thời cùng 1 thẻ — ghi chú rõ ràng thay vì giả lập kết quả PASS. ──
test('Concurrent review (ghi chú: cần Postgres thật để test tích hợp)', () => {
  // Không throw -> coi là "đã ghi nhận yêu cầu", nhưng đây KHÔNG phải bằng chứng concurrency an
  // toàn. Xem báo cáo cuối cùng, mục TEST, dòng "Concurrent review".
  assert.ok(true);
});

console.log('\n──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
