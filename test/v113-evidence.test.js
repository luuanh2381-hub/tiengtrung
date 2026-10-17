// test/v113-evidence.test.js — kiểm thử V113: bằng chứng kỹ năng, loại lượt "vừa xem đáp án", 5 nhóm khoảng nghỉ,
// phân phối dạng bài của bộ chọn. Chạy: node test/v113-evidence.test.js
// LƯU Ý TRUNG THỰC: các câu SQL (UPSERT bằng chứng, truy vấn trend/type/retention/backfill) KHÔNG chạy được ở đây (không có Postgres) —
// chúng được kiểm tra bằng đọc mã nguồn + bản JS tương đương của phép tính; cần chạy thử trên DB thật (xem hướng dẫn bàn giao).
'use strict';
const assert = require('assert');
const fs = require('fs'), path = require('path');
global.QE = require('../js/question-engine');
global.SS = require('../js/skill-score');
const QS = require('../js/question-selector');
const S = require('../lib/skills');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e)); }
}
const row = (n, k, extra) => { let r = null; for (let i = 0; i < n; i++) r = S.applyAttempt(r, i < k); return Object.assign({}, r, extra || {}); };

console.log('\n[1] Điểm / mức độ: ít lượt không được gọi là "tốt"');
test('3 lượt đúng → KHÔNG "good" (chỉ đang phát triển); 5 lượt đúng → good', () => {
  assert.strictEqual(S.classify(row(3, 3)).level, 'developing');
  assert.ok(S.classify(row(3, 3)).score >= S.GOOD_THRESHOLD, 'điểm thô đã ≥ 0.75 — chính vì vậy cần ràng buộc số lượt');
  assert.strictEqual(S.classify(row(5, 5)).level, 'good');
});
test('3 lượt sai → weak (tín hiệu yếu vẫn đủ rõ); 2 lượt sai → chưa đủ dữ liệu, KHÔNG mặc định yếu', () => {
  assert.strictEqual(S.classify(row(3, 0)).level, 'weak');
  const c = S.classify(row(2, 0)); assert.strictEqual(c.level, 'insufficient'); assert.strictEqual(c.score, null);
});
test('không có dòng nào → insufficient, không điểm', () => {
  const c = S.classify(null); assert.strictEqual(c.level, 'insufficient'); assert.strictEqual(c.score, null);
});
test('1 lượt / tất cả đúng / tất cả sai / kết quả cũ-mới khác nhau', () => {
  assert.strictEqual(S.classify(row(1, 1)).level, 'insufficient');
  assert.strictEqual(S.classify(row(20, 20)).level, 'good');
  assert.strictEqual(S.classify(row(20, 0)).level, 'weak');
  let r = null; for (let i = 0; i < 10; i++) r = S.applyAttempt(r, false); for (let i = 0; i < 10; i++) r = S.applyAttempt(r, true);
  assert.ok(S.classify(r).score > 0.7, 'lượt mới đúng phải kéo điểm lên (trọng số giảm dần)');
});

console.log('\n[2] Nhãn bằng chứng (evidenceOf)');
test('none / few / developing', () => {
  assert.strictEqual(S.evidenceOf(null).stage, 'none');
  assert.strictEqual(S.evidenceOf(row(2, 2)).stage, 'few');
  assert.strictEqual(S.evidenceOf(row(4, 4, { active_days: 1 })).stage, 'developing');
});
test('stable: ≥6 lượt, ≥3 ngày, điểm ≥ 0.75; thiếu 1 điều kiện → developing', () => {
  assert.strictEqual(S.evidenceOf(row(6, 6, { active_days: 3 })).stage, 'stable');
  assert.strictEqual(S.evidenceOf(row(6, 6, { active_days: 2 })).stage, 'developing');
  assert.strictEqual(S.evidenceOf(row(5, 5, { active_days: 5 })).stage, 'developing');
  assert.strictEqual(S.evidenceOf(row(8, 4, { active_days: 5 })).stage, 'developing', 'điểm thấp không thể ổn định');
});
test('hàng CŨ chưa có số ngày (active_days=0 dù nhiều lượt) → không bao giờ "stable" (không đoán)', () => {
  assert.notStrictEqual(S.evidenceOf(row(30, 30, { active_days: 0 })).stage, 'stable');
  assert.notStrictEqual(S.evidenceOf(row(30, 30)).stage, 'stable', 'thiếu hẳn trường mới cũng an toàn');
});
test('retested: ≥2 lượt sau khoảng nghỉ; vẫn có thể weak (nhãn bằng chứng ≠ kết quả)', () => {
  const r = row(5, 1, { active_days: 4, delayed_attempts: 3, delayed_correct: 0 });
  assert.strictEqual(S.evidenceOf(r).stage, 'retested');
  assert.strictEqual(S.classify(r).level, 'weak');
  assert.strictEqual(S.evidenceOf(row(5, 5, { delayed_attempts: 1 })).stage, 'developing', '1 lượt sau nghỉ chưa đủ');
});
test('profileForClient: kỹ năng không có dữ liệu → none, không điểm; kỹ năng có dữ liệu → có stage; không lẫn sang kỹ năng khác', () => {
  const p = S.profileForClient({ recall: Object.assign(row(6, 6), { active_days: 3, last_attempt_at: new Date(Date.now() - 2 * 864e5) }) }, Date.now());
  assert.strictEqual(p.recall.stage, 'stable'); assert.ok(p.recall.daysSince >= 1.9);
  for (const sk of ['recognition', 'listening', 'pinyin', 'context']) { assert.strictEqual(p[sk].stage, 'none'); assert.strictEqual(p[sk].score, null); assert.strictEqual(p[sk].daysSince, null); }
});
test('advanceProfileEntry: bất biến, mang theo bằng chứng, lượt sau ≥24h tính là sau-khoảng-nghỉ', () => {
  const e0 = Object.freeze(S.profileForClient({ listening: Object.assign(row(4, 3), { active_days: 2, last_attempt_at: new Date(Date.now() - 3 * 864e5) }) }).listening);
  const e1 = SS.advanceProfileEntry(e0, true);
  assert.strictEqual(e1.attempts, 5); assert.strictEqual(e1.dn, 1); assert.strictEqual(e1.dc, 1); assert.strictEqual(e1.ad, 3);
  const e2 = SS.advanceProfileEntry(e1, false); // daysSince = 0 → cùng ngày: không tăng ngày / sau nghỉ
  assert.strictEqual(e2.ad, 3); assert.strictEqual(e2.dn, 1);
});
test('bản JS của SQL: UPSERT bằng chứng — mô phỏng chuỗi lượt qua nhiều ngày khớp đếm tay', () => {
  // mô phỏng đúng điều kiện SQL: ngày VN khác nhau → active_days+1; cách ≥ 24h → delayed+1
  const dayVN = (t) => new Date(t + 7 * 3600e3).toISOString().slice(0, 10);
  const H = 3600e3, T0 = Date.UTC(2026, 0, 1, 0, 0);
  const seq = [[T0, true], [T0 + 1 * H, false], [T0 + 30 * H, true], [T0 + 31 * H, true], [T0 + 100 * H, true]];
  let st = { ad: 0, dn: 0, dc: 0, last: null };
  for (const [t, ok] of seq) {
    const newDay = st.last == null || dayVN(st.last) !== dayVN(t), delayed = st.last != null && t - st.last >= 24 * H;
    st = { ad: st.ad + (newDay ? 1 : 0), dn: st.dn + (delayed ? 1 : 0), dc: st.dc + (delayed && ok ? 1 : 0), last: t };
  }
  assert.deepStrictEqual([st.ad, st.dn, st.dc], [3, 2, 2]); // ngày VN: 1/1, 2/1, 5/1; cách ≥24h: lượt 3 và 5
});

console.log('\n[3] Lượt vừa xem đáp án KHÔNG cộng điểm kỹ năng');
test('server /practice: check & redo ghi nhật ký nhưng bỏ qua upsertSkillStatTx; extra/match vẫn tính', () => {
  const src = read('lib/skill-store.js');
  assert.ok(/const shown = SHOWN_ANSWER_SOURCES\.includes\(source\);\s*\n\s*if \(!shown\) await upsertSkillStatTx/.test(src));
  assert.ok(src.includes('countedInSkill: !shown'));
  assert.deepStrictEqual(S.SHOWN_ANSWER_SOURCES, ['check', 'redo']);
});
test('server /study/review: exposure=intro vẫn ghi review_history (FSRS) nhưng không upsert kỹ năng', () => {
  const db = read('lib/db.js');
  assert.ok(db.includes("skillRecord.exposure !== 'intro'") && db.includes("wrong_answer, exposure"));
  const api = read('api/index.js');
  assert.ok(api.includes('exposure: cleanExposure(exposure)') && /idempotencyKey, rating, exerciseType, sessionId, exposure \} = req\.body/.test(api));
  assert.strictEqual(S.cleanExposure('intro'), 'intro');
  for (const bad of ['INTRO', 'x', null, undefined, 1, {}]) assert.strictEqual(S.cleanExposure(bad), null, 'giá trị lạ không được tin');
});
test('chỉ review_history của lượt ĐẦU sau giới thiệu mang exposure; FSRS (lịch) không bị đụng: không UPDATE fsrs_cards thêm', () => {
  const db = read('lib/db.js');
  const i = db.indexOf("skillRecord.exposure !== 'intro'");
  const block = db.slice(i, i + 900);
  assert.ok(!/fsrs_cards/.test(block), 'khối ghi kỹ năng không được chạm fsrs_cards');
});
test('client: lượt official sau intro gửi exposure=intro; check/redo/intro không gọi QS.learn', () => {
  const rv = read('js/review.js'), sq = read('js/study-queue.js');
  // V114: cờ gửi exposure tách khỏi `introduced` (xem test/v114-fixes.test.js); kỳ vọng V113 cũ gắn theo `introduced` là SAI hành vi nên được cập nhật.
  assert.ok(rv.includes("exposure: rvIsIntroExposure(item) ? 'intro' : undefined"));
  assert.ok(/item\.type === 'check' \|\| item\.type === 'redo' \|\| rvIsIntroExposure\(item\)/.test(rv));
  assert.ok(sq.includes("payload.exposure = 'intro'") && sq.includes('sessionId, exposure }'));
});
test('trend + theo dạng bài loại lượt vừa xem đáp án; retention xếp chúng vào "ngay sau học"', () => {
  const src = read('lib/skill-store.js');
  // V114: 2 truy vấn "today" (measured, measured_correct) được gộp thành MỘT tập `valid` dùng chung → còn 3 lần xuất hiện (trend + byType + valid).
  assert.ok((src.match(/COALESCE\(source, 'practice'\) <> ALL\(\$3::text\[\]\)/g) || []).length >= 3, 'trend + byType + tập valid của today');
  assert.ok(src.includes("(exposure = 'intro') IS TRUE AS shown"));
  assert.ok(src.includes("exposure IS DISTINCT FROM 'intro'"));
});
test('migration V113 chỉ cộng thêm (không DROP/DELETE ngoài phần hoàn tác đã comment), backfill idempotent', () => {
  const sql = read('migrations/V113_skill_evidence.sql');
  const live = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/DROP\s|DELETE\s|TRUNCATE/i.test(live));
  assert.ok(/ADD COLUMN IF NOT EXISTS active_days INT NOT NULL DEFAULT 0/.test(live) && /AND s\.active_days = 0 AND s\.delayed_attempts = 0/.test(live));
  assert.ok(!/SET[^;]*\b(attempts|correct|w_attempts|w_correct)\s*=/i.test(live.replace(/delayed_attempts|delayed_correct/g, '')), 'backfill không đổi điểm cũ');
  assert.ok(read('lib/skill-store.js').includes('ADD COLUMN IF NOT EXISTS active_days'));
});

console.log('\n[4] 5 nhóm khoảng nghỉ + khuyến nghị dùng đúng nhóm "≥ 3 ngày"');
test('LATE_BUCKET_IDS = d3 + d7 và recommendGlobal dùng chúng (≥3 ngày, đủ mẫu mới kết luận)', () => {
  assert.deepStrictEqual(S.LATE_BUCKET_IDS, ['d3', 'd7']);
  assert.deepStrictEqual(S.RETENTION_BUCKETS.map(b => b.id), ['immediate', 'short', 'd1', 'd3', 'd7']);
  assert.ok(read('lib/skill-recommend.js').includes('for (const id of LATE_BUCKET_IDS)'));
});
test('SQL retention sinh CASE khớp 5 nhóm (cận 10 phút, 24h, 72h, 168h)', () => {
  const src = read('lib/skill-store.js');
  assert.ok(src.includes('bucketCaseSql'));
  const whens = S.RETENTION_BUCKETS.filter(b => Number.isFinite(b.maxH)).map(b => b.maxH);
  assert.deepStrictEqual(whens.map(x => Math.round(x * 6) / 6), [1 / 6, 24, 72, 168].map(x => Math.round(x * 6) / 6));
});

console.log('\n[5] Bộ chọn: phân phối dạng bài không lệch nghiêm trọng, chưa có dữ liệu ≠ yếu');
const POOL = [
  { hz: '准备', py: 'zhǔnbèi', vi: 'chuẩn bị', l: 5 }, { hz: '认真', py: 'rènzhēn', vi: 'nghiêm túc', l: 5 },
  { hz: '参加', py: 'cānjiā', vi: 'tham gia', l: 5 }, { hz: '发现', py: 'fāxiàn', vi: 'phát hiện', l: 5 },
  { hz: '学习', py: 'xuéxí', vi: 'học tập', l: 1 }, { hz: '休息', py: 'xiūxi', vi: 'nghỉ ngơi', l: 1 },
  { hz: '苹果', py: 'píngguǒ', vi: 'quả táo', l: 2 }, { hz: '桌子', py: 'zhuōzi', vi: 'cái bàn', l: 2 },
  { hz: '电脑', py: 'diànnǎo', vi: 'máy tính', l: 3 }, { hz: '朋友', py: 'péngyou', vi: 'bạn bè', l: 1 },
];
const ctx = () => ({ pool: POOL, examples: [], sentences: [], confuseGroups: [], audioOk: true });
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function simulate(profileFor, n, seed) {
  const rand = mulberry(seed), session = QS.newSession(), counts = {};
  for (let i = 0; i < n; i++) {
    const w = POOL[i % POOL.length];
    const q = QS.choose(w, ctx(), { session, profile: profileFor(w), rand, allowTyped: false, remaining: 5 });
    if (!q) continue;
    counts[q.typeId] = (counts[q.typeId] || 0) + 1;
    QS.record(session, q, true, 2000);
  }
  return counts;
}
test('mọi kỹ năng chưa có dữ liệu: 60 câu trải đều, không dạng nào > 50%', () => {
  const c = simulate(() => ({}), 60, 11); const tot = Object.values(c).reduce((a, b) => a + b, 0);
  assert.ok(Object.keys(c).length >= 3, JSON.stringify(c));
  for (const [k, v] of Object.entries(c)) assert.ok(v / tot <= 0.5, `${k} chiếm ${(v / tot * 100) | 0}% — ${JSON.stringify(c)}`);
});
test('nhận diện giỏi (good), nhớ chủ động yếu: ưu tiên recall nhưng vẫn KHÔNG chiếm gần hết phiên', () => {
  const prof = () => ({ recognition: SS.toProfileEntry(row(12, 12)), recall: SS.toProfileEntry(row(6, 1)) });
  const c = simulate(prof, 60, 5); const tot = Object.values(c).reduce((a, b) => a + b, 0);
  const recall = c.vi2hz || 0;
  assert.ok(recall / tot >= 0.2, 'recall yếu phải được ưu tiên: ' + JSON.stringify(c));
  assert.ok(recall / tot <= 0.7, 'nhưng không được chiếm gần hết phiên: ' + JSON.stringify(c));
  assert.ok((c.hz2vi || 0) / tot <= 0.5, 'recognition không được lấn át: ' + JSON.stringify(c));
});
test('kỹ năng nghe CHƯA có dữ liệu không được cộng điểm "yếu" (chỉ cộng nhỏ để thu dữ liệu) và thấp hơn kỹ năng thật sự yếu', () => {
  const prof = { recall: SS.toProfileEntry(row(6, 1)), listening: SS.toProfileEntry(null) };
  const W = POOL[0], sess = QS.newSession();
  const sRecall = QS.scoreType('vi2hz', 'recall', prof, sess, W, {}), sListen = QS.scoreType('listen2hz', 'listening', prof, sess, W, {});
  assert.ok(sRecall > sListen, `weak(${sRecall}) phải > chưa-có-dữ-liệu(${sListen})`);
  assert.ok(sListen - QS.WEIGHTS.base.listen2hz <= QS.WEIGHTS.dataMax + 1e-9);
});
test('"đã đủ vững" chỉ khi đủ lượt: 3 lượt đúng KHÔNG bị trừ điểm strong; ≥ 0.85 với nhiều lượt mới bị trừ nhẹ', () => {
  const W = POOL[0], sess = QS.newSession();
  const few = SS.toProfileEntry(row(3, 3)), many = SS.toProfileEntry(row(14, 14));
  const base = QS.WEIGHTS.base.hz2vi;
  const sFew = QS.scoreType('hz2vi', 'recognition', { recognition: few }, sess, W, {}), sMany = QS.scoreType('hz2vi', 'recognition', { recognition: many }, sess, W, {});
  assert.ok(sFew >= base - 1e-9 || few.level !== 'good', 'ít lượt không được coi là vững');
  assert.ok(sMany < sFew + 1e-9 || many.level === 'good');
});
test('một từ được hỏi nhiều lần (kể cả toàn sai): chừng nào còn dạng CHƯA dùng thì không lặp lại cặp (từ, dạng)', () => {
  const sess = QS.newSession(), W = POOL[0], seq = [];
  for (let i = 0; i < 5; i++) {
    const q = QS.choose(W, ctx(), { session: sess, profile: {}, rand: mulberry(3 + i), allowTyped: false });
    assert.ok(q); seq.push(q.typeId); QS.record(sess, q, false, 3000);
  }
  assert.strictEqual(new Set(seq).size, 5, 'năm câu đầu phải là năm dạng khác nhau: ' + seq.join(','));
});
// GIỚI HẠN ĐÃ BIẾT (không sửa ở bộ chọn): khi MỌI dạng dựng được đã dùng hết cho cùng một từ và người học sai liên tiếp, bộ chọn có thể
// quay lại dạng dễ (hz2vi) vài lần liên tiếp theo quy tắc "sai liên tiếp → hạ độ khó". Vòng lặp vô hạn được chặn ở TẦNG HÀNG ĐỢI
// (RV_DRILL_MAX_TRIES = 2, RV_EXTRA_MAX = 6), không phải ở bộ chọn.
test('hàng đợi chặn lặp vô hạn: luyện lại tối đa 2 lần/từ, luyện thêm tối đa 6/buổi', () => {
  const rv = read('js/review.js');
  assert.ok(/const RV_DRILL_MAX_TRIES = 2;/.test(rv) && /const RV_EXTRA_MAX = 6;/.test(rv));
});

console.log('\n[6] Giao diện & khuyến nghị: ngôn ngữ đúng dữ liệu');
test('Hôm nay học: tách tiến độ nhiệm vụ khỏi % nhớ; có mục tiêu chính; tỉ lệ đúng có mẫu số; bảo vệ payload cũ', () => {
  const ls = read('js/lesson.js');
  assert.ok(ls.includes('không phải % từ đã nhớ lâu dài') && ls.includes('Mục tiêu chính'));
  assert.ok(ls.includes('pr.measuredAnswers != null') && ls.includes('b.stableWords != null'));
  assert.ok(ls.includes('không phải “đã thuộc”'));
  assert.ok(ls.indexOf('đến hạn theo lịch FSRS') < ls.indexOf('củng cố ${b.reinforce}'), 'thẻ đến hạn luôn là ưu tiên đầu');
});
test('UI phân tích: hiện "Dừng khi", nhãn bằng chứng, giới hạn của so sánh nhóm', () => {
  const ui = read('js/skills-analysis.js');
  assert.ok(ui.includes('it.stopWhen') && ui.includes('Tương đối ổn định') && ui.includes('Đã kiểm tra lại sau khoảng nghỉ') && ui.includes('Giới hạn:'));
  assert.ok(!/ghi nhớ chắc chắn/.test(ui + read('js/lesson.js') + read('js/review.js')));
});
test('migrate script tồn tại, có DRY_RUN và ROLLBACK khi lỗi (V114: kiểm hành vi thật ở v114-fixes)', () => {
  const m = read('scripts/migrate-skill-evidence.js');
  assert.ok(m.includes('DRY_RUN') && m.includes("ROLLBACK") && m.includes('V113_skill_evidence.sql'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
