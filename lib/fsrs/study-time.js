// lib/fsrs/study-time.js — QUY TẮC TÍNH "THỜI GIAN HỌC THỰC" (V112). THUẦN: không DB, không mạng.
//
// TRƯỚC: duration_seconds = (thời điểm hiện tại − start_time) = GIỜ TREO TƯỜNG. Mọi hoạt động trong vòng 15 phút sau lần trước
// đều được cộng NGUYÊN khoảng trống → rời sang tab khác / app khác 10 phút rồi bấm 1 câu = 10 phút "học".
// SAU: duration_seconds = TỔNG các đoạn học thực, cộng dồn từng khoảng giữa 2 sự kiện (heartbeat hoặc lượt trả lời):
//        credit = min( khoảng cách thực giữa 2 sự kiện , TRẦN , số giây học thực do client báo — nếu có )
//   • TRẦN (ACTIVE_GAP_CAP_S): 1 khoảng không bao giờ được cộng quá chừng này, dù client báo bao nhiêu → client không thể
//     làm lố, và nếu client cũ không báo gì thì mỗi lần quay lại chỉ có thể "lố" tối đa bằng trần.
//   • Số client báo là mức TRẦN THÊM (không phải số được tin tuyệt đối): lúc quay lại sau khi vắng, client gửi 0 → server dời mốc
//     thời gian mà KHÔNG cộng gì, nên khoảng vắng mặt không bị tính ở lượt trả lời kế tiếp.
//   • Gửi trùng (retry mạng) vô hại: lần gửi thứ hai có khoảng cách thực ≈ 0 nên credit ≈ 0.
// Dòng study_sessions CŨ (đã lưu theo giờ treo tường) giữ nguyên, KHÔNG backfill; chỉ phiên mới ghi theo quy tắc này.

'use strict';

const ACTIVE_GAP_CAP_S = 60; // heartbeat 20s ⇒ gấp 3 nhịp; đủ cho 1 câu nghĩ lâu mà chưa kịp heartbeat

// gapMs: khoảng cách thực (ms) từ sự kiện trước đến sự kiện này. clientActiveSeconds: số giây học thực client đo được
// trong khoảng đó (undefined/null = client không báo → chỉ dùng trần). Trả về số giây NGUYÊN ≥ 0.
function creditedSeconds(gapMs, clientActiveSeconds) {
  const g = Number(gapMs);
  if (!Number.isFinite(g) || g <= 0) return 0;
  let c = Math.min(g / 1000, ACTIVE_GAP_CAP_S);
  if (clientActiveSeconds !== null && clientActiveSeconds !== undefined && clientActiveSeconds !== '') {
    const a = Number(clientActiveSeconds);
    c = Number.isFinite(a) ? Math.min(c, Math.max(0, a)) : c; // giá trị rác → bỏ qua, vẫn bị trần chặn
  }
  return Math.round(c);
}

module.exports = { ACTIVE_GAP_CAP_S, creditedSeconds };
