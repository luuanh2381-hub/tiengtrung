// ════════════════════════════════════════════════════
// V67 — AUTO FSRS RATING LAYER
// Hàm DUY NHẤT ở đây (getAutomaticFSRSRating) chỉ làm 1 việc: trả về 1 trong 4 chuỗi
// 'again' | 'hard' | 'good' | 'easy'. KHÔNG tự tính due/stability/difficulty/interval — việc đó
// vẫn 100% do ts-fsrs (lib/fsrs.js) đảm nhiệm (Phần 6/23/28 trong yêu cầu V67).
//
// Tín hiệu được dùng, theo đúng thứ tự ưu tiên yêu cầu (Phần 5):
//   1. answerCorrect         — quan trọng nhất, luôn quyết định trước
//   2. responseTimeMs        — so với BASELINE CÁ NHÂN của chính thẻ đó (Phần 15), không so
//                              với 1 con số cố định chung cho mọi user/mọi thẻ (Phần 5/29)
//   3-5. card.state/stability/difficulty hiện tại (Phần 9/10)
//   6-7. reviewHistory + answerChanges (Phần 16)
// ════════════════════════════════════════════════════
const { State } = require('ts-fsrs');

// Các ngưỡng dưới đây CHỈ là lưới an toàn cuối cùng khi chưa đủ dữ liệu để dựng baseline cá nhân
// (Phần 15/29) — không phải cơ chế ra quyết định chính, và không bao giờ tự ý gán Easy chỉ vì
// nhanh (Phần 9/14).
const FALLBACK_HARD_MS = 20000; // đúng nhưng >20s và chưa có baseline → nghiêng về Hard
const FALLBACK_EASY_MS = 1500; // rất nhanh — chỉ xét Easy khi kèm thêm bằng chứng thẻ đã "chín"
const MIN_HISTORY_FOR_BASELINE = 3; // cần tối thiểu 3 lượt ĐÚNG trước đó mới coi là đủ dữ liệu
const BASELINE_SAMPLE_SIZE = 10; // chỉ lấy tối đa 10 lượt gần nhất để baseline bám sát phong độ hiện tại
// "Review nhiễu khi thoát ra vào lại" — lớp phòng thủ THỨ 2 (độc lập với việc frontend đã tự trừ
// thời gian tab bị ẩn, xem js/visibility-timer.js): performance.now() phía client dù đã trừ đúng
// vẫn có thể sai số/không bắt hết mọi kiểu gián đoạn (vd browser/OS lạ không bắn visibilitychange
// đúng lúc, hoặc user chỉ đơn giản để màn hình mở nhưng không tương tác rất lâu). Bất kỳ
// responseTimeMs nào VƯỢT ngưỡng này đều bị coi là tín hiệu KHÔNG ĐÁNG TIN — không dùng để suy luận
// Hard/Easy nữa (rơi về các nhánh "chưa đủ dữ liệu" vốn đã có sẵn, mặc định an toàn = Good khi trả
// lời đúng) — nhưng KHÔNG đụng gì tới việc LƯU review (answerCorrect/FSRS state/due vẫn cập nhật
// bình thường, review_history vẫn lưu ĐÚNG giá trị thật đo được, không bị sửa/cap — chỉ riêng bước
// SUY LUẬN RATING bỏ qua tín hiệu này). 90s đủ dài để không loại nhầm người thật sự đang phân vân
// lâu cho 1 từ khó, đủ thấp để lọc được các trường hợp bị gián đoạn rõ ràng.
const MAX_TRUSTED_RESPONSE_MS = 90000;

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// reviewHistory: các lượt review TRƯỚC ĐÓ của CHÍNH thẻ này (word+user). KHÔNG phụ thuộc ngầm
// vào thứ tự caller truyền vào — hàm tự sort theo `reviewed_at` DESC (mới nhất trước) rồi mới lấy
// tối đa BASELINE_SAMPLE_SIZE phần tử có response_time_ms hợp lệ, để baseline luôn phản ánh đúng
// "N lượt gần nhất", kể cả nếu sau này có caller nào truyền vào không theo đúng thứ tự DB trả về.
// Baseline cá nhân theo Phần 15 — dùng median cho đỡ lệch bởi vài lượt bất thường (ví dụ user
// bị phân tâm giữa chừng khiến responseTime tăng đột biến 1 lần).
function personalBaselineMs(reviewHistory) {
  const sorted = [...(reviewHistory || [])].sort((a, b) => {
    const ta = a && a.reviewed_at ? new Date(a.reviewed_at).getTime() : 0;
    const tb = b && b.reviewed_at ? new Date(b.reviewed_at).getTime() : 0;
    return tb - ta; // DESC: mới nhất trước
  });
  const times = sorted
    .filter(r => r && r.answer_correct && Number.isFinite(Number(r.response_time_ms)) && Number(r.response_time_ms) > 0 && Number(r.response_time_ms) <= MAX_TRUSTED_RESPONSE_MS)
    .slice(0, BASELINE_SAMPLE_SIZE)
    .map(r => Number(r.response_time_ms));
  if (times.length < MIN_HISTORY_FOR_BASELINE) return null;
  return median(times);
}

// card: object có tối thiểu { state, stability, difficulty, reps, last_review } — null/undefined
// nếu đây là từ HOÀN TOÀN MỚI (chưa từng có fsrs_card).
function getAutomaticFSRSRating({ answerCorrect, responseTimeMs, card, reviewHistory, answerChanges }) {
  const changes = Number.isFinite(answerChanges) ? answerChanges : 0;
  // "Review nhiễu khi thoát ra vào lại" — lớp phòng thủ thứ 2: responseTimeMs vượt ngưỡng tin cậy bị
  // coi như KHÔNG CÓ (rt=null), rơi về các nhánh "chưa đủ dữ liệu" vốn đã xử lý an toàn bên dưới.
  const rawRt = Number.isFinite(responseTimeMs) && responseTimeMs >= 0 ? responseTimeMs : null;
  const rt = (rawRt !== null && rawRt <= MAX_TRUSTED_RESPONSE_MS) ? rawRt : null;

  // ── Phần 7/11: SAI đáp án → luôn Again. responseTime KHÔNG được dùng để lật ngược quyết định
  //     này (Phần 11: "đúng nhưng suy nghĩ 12 giây" không phải Again — nhưng SAI thì luôn Again,
  //     bất kể trả lời nhanh hay chậm). Việc chuyển trạng thái Learning/Relearning cụ thể do chính
  //     ts-fsrs.repeat() xử lý — ở layer này không tự viết state transition (Phần 7). ──
  if (!answerCorrect) return 'again';

  const isNewCard = !card || card.state === State.New || (Number(card.reps) === 0 && !card.last_review);

  // ── Phần 9: NEW card chưa có lịch sử FSRS — TUYỆT ĐỐI không suy ra Easy chỉ vì responseTime
  //     ngắn (một từ mới trả lời đúng rất nhanh nhiều khả năng là may mắn/đoán, không phải đã nhớ
  //     chắc). Chỉ phân biệt Good/Hard dựa trên dấu hiệu lúng túng rõ ràng (quá chậm hoặc đổi đáp
  //     án nhiều lần). Mặc định an toàn: Good (Phần 13/29). ──
  if (isNewCard) {
    if (changes >= 3 || (rt !== null && rt > FALLBACK_HARD_MS)) return 'hard';
    return 'good';
  }

  // ── Phần 10/15: card đã có lịch sử (Review/Learning/Relearning) — ưu tiên baseline CÁ NHÂN của
  //     CHÍNH thẻ này, không so với 1 số cố định áp cho mọi user/mọi thẻ. ──
  const baseline = personalBaselineMs(reviewHistory);
  const difficulty = Number.isFinite(Number(card.difficulty)) ? Number(card.difficulty) : 5;
  const stability = Number.isFinite(Number(card.stability)) ? Number(card.stability) : 0;

  if (baseline !== null && rt !== null) {
    const ratio = rt / baseline;
    // Đúng + rất nhanh so với chính lịch sử của thẻ này + thẻ đang "dễ" (difficulty thấp,
    // stability đã ổn định) + không đổi đáp án lần nào → đủ bằng chứng cho Easy (Phần 14).
    if (ratio <= 0.6 && changes === 0 && difficulty <= 4 && stability >= 1) return 'easy';
    // Đúng nhưng chậm hơn hẳn so với chính thẻ này, hoặc đổi đáp án nhiều lần, hoặc thẻ đang khó
    // (difficulty cao) mà vẫn chậm → Hard, tức "nhớ được nhưng khó" (Phần 12).
    if (ratio >= 1.8 || changes >= 2 || (difficulty >= 7 && ratio >= 1.2)) return 'hard';
    return 'good';
  }

  // ── Chưa đủ dữ liệu để dựng baseline cá nhân (Phần 15/29) — lưới an toàn bảo thủ, Good là
  //     fallback mặc định, chỉ lệch sang Hard/Easy khi tín hiệu thật sự rõ ràng. Không được đoán
  //     bừa Easy (Phần 14/29). ──
  if (rt !== null) {
    if (changes >= 3 || rt > FALLBACK_HARD_MS) return 'hard';
    // Chỉ cân nhắc Easy khi thẻ đã "chín" (đã ở state Review, ôn lại ≥2 lần, difficulty thấp) —
    // tránh lặp lại đúng cái lỗi mà Phần 9 cảnh báo (nhanh không đồng nghĩa với nhớ chắc).
    if (
      rt < FALLBACK_EASY_MS && changes === 0 &&
      card.state === State.Review && Number(card.reps) >= 2 && difficulty <= 3
    ) return 'easy';
  }
  if (changes >= 3) return 'hard';
  return 'good';
}

module.exports = { getAutomaticFSRSRating, personalBaselineMs };
