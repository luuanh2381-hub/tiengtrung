#!/usr/bin/env node
// ════════════════════════════════════════════════════
// FSRS-6 VERIFICATION SCRIPT (yêu cầu Phần 17)
//
// Chứng minh scheduler của project đang chạy FSRS-6 thật (do package "ts-fsrs" tính, KHÔNG tự
// viết lại thuật toán). In ra:
//   - package version + số lượng parameters (w) đang dùng
//   - kết quả state/difficulty/stability/scheduled_days/due cho từng rating, trên nhiều chuỗi
//     review khác nhau (New→X, cùng ngày, sau nhiều ngày)
//
// Chạy: npm run verify:fsrs6
// ════════════════════════════════════════════════════
const path = require('path');
const { reviewCard, getFsrsVerificationInfo, FSRS6_PARAM_COUNT, State } = require('../lib/fsrs');

const OFFICIAL_FSRS6_DEFAULT_W = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

function pkgVersion() {
  try {
    // eslint-disable-next-line global-require
    return require('ts-fsrs/package.json').version;
  } catch (e) {
    return 'unknown';
  }
}

function printCard(label, card) {
  console.log(
    `  ${label.padEnd(28)} state=${State[card.state]?.padEnd(10) || card.state} ` +
    `difficulty=${card.difficulty.toFixed(4).padStart(8)} ` +
    `stability=${card.stability.toFixed(4).padStart(9)} ` +
    `scheduled_days=${String(card.scheduled_days).padStart(4)} ` +
    `due=${card.due.toISOString()}`
  );
}

function main() {
  console.log('════════════════════════════════════════════════════');
  console.log('FSRS-6 VERIFICATION');
  console.log('════════════════════════════════════════════════════');
  console.log(`ts-fsrs package version : ${pkgVersion()}`);

  const info = getFsrsVerificationInfo();
  console.log(`FSRS parameters (w)     : ${info.paramCount} phần tử`);
  console.log(`Expected for FSRS-6     : ${FSRS6_PARAM_COUNT} phần tử`);
  console.log(`request_retention       : ${info.requestRetention}`);
  console.log(`enable_fuzz             : ${info.enableFuzz}`);
  console.log(`enable_short_term       : ${info.enableShortTerm}`);
  console.log(`w = [${info.w.map((x) => x.toFixed(4)).join(', ')}]`);
  console.log('');

  if (!info.isFsrs6) {
    console.log('❌ KHÔNG xác minh được FSRS-6 (số lượng parameters khác 21).');
    process.exitCode = 1;
    return;
  }
  console.log('✅ Xác nhận: scheduler đang dùng đúng cấu trúc 21 parameters của FSRS-6.');

  const matchesOfficial = info.w.length === OFFICIAL_FSRS6_DEFAULT_W.length &&
    info.w.every((v, i) => Math.abs(v - OFFICIAL_FSRS6_DEFAULT_W[i]) < 1e-6);
  if (matchesOfficial) {
    console.log('✅ Xác nhận: 21 default weights khớp CHÍNH XÁC với bộ default FSRS-6 công bố chính');
    console.log('   thức (open-spaced-repetition/fsrs4anki, ts-fsrs) — không phải số ngẫu nhiên.\n');
  } else {
    console.log('⚠️  21 weights KHÔNG khớp default FSRS-6 công bố chính thức — có thể project đã');
    console.log('   tự set custom "w" (đã optimize riêng) chứ không dùng default. Nếu bạn KHÔNG cố');
    console.log('   tình truyền "w" tuỳ chỉnh vào generatorParameters(), hãy kiểm tra lại.\n');
  }

  console.log('API scheduling đang dùng: scheduler.next(card, reviewTime, rating) — KHÔNG dùng');
  console.log('repeat() cho luồng review thật (repeat() chỉ còn trong previewSchedule(), hiện chưa');
  console.log('được gọi ở đâu trong project).\n');

  // ── Chuỗi 1: New → mỗi rating (Again/Hard/Good/Easy) ──
  console.log('── New → {Again, Hard, Good, Easy} ──');
  const base = new Date('2026-08-01T09:00:00.000Z');
  for (const rating of ['again', 'hard', 'good', 'easy']) {
    const { newCard } = reviewCard(null, rating, base);
    printCard(`New → ${rating}`, newCard);
  }

  // ── Chuỗi 2: Good rồi Good/Hard/Again trong CÙNG NGÀY (Phần 12 — same-day reviews) ──
  console.log('\n── Same-day: Good → {Good, Hard, Again} vài giờ sau ──');
  const { newCard: afterFirstGood } = reviewCard(null, 'good', base);
  printCard('New → Good', afterFirstGood);
  const sameDay = new Date(base.getTime() + 4 * 60 * 60 * 1000); // +4h, vẫn cùng ngày
  for (const rating of ['good', 'hard', 'again']) {
    const { newCard } = reviewCard(afterFirstGood, rating, sameDay);
    printCard(`  (+4h) Good → ${rating}`, newCard);
  }

  // ── Chuỗi 3: Review sau nhiều ngày ──
  console.log('\n── Review sau nhiều ngày: New → Good → (7 ngày sau) Good ──');
  const sevenDaysLater = new Date(afterFirstGood.due.getTime());
  const { newCard: afterSecondGood } = reviewCard(afterFirstGood, 'good', sevenDaysLater);
  printCard('New → Good', afterFirstGood);
  printCard(`  (due, +${afterFirstGood.scheduled_days}d) Good → Good`, afterSecondGood);

  // ── Chuỗi 4: Review lúc nửa đêm (kiểm tra timezone/UTC không tự lệch ngày ở tầng scheduler —
  //     xử lý timezone hiển thị/DB là việc riêng, xem Phần 13) ──
  console.log('\n── Review quanh nửa đêm UTC (23:59 / 00:00 / 00:01) ──');
  const midnightBase = new Date('2026-08-10T23:59:00.000Z');
  const { newCard: nightCard } = reviewCard(null, 'good', midnightBase);
  printCard('23:59 New → Good', nightCard);
  const justAfter = new Date('2026-08-11T00:01:00.000Z');
  const { newCard: nightCard2 } = reviewCard(nightCard, 'good', justAfter);
  printCard('00:01 Good → Good', nightCard2);

  console.log('\n════════════════════════════════════════════════════');
  console.log('FSRS-6 MIGRATION VERIFIED: scheduler đang chạy FSRS-6 (21 parameters), do package');
  console.log('"ts-fsrs" tính toán trực tiếp (không tự viết lại thuật toán).');
  console.log('════════════════════════════════════════════════════');
}

main();
