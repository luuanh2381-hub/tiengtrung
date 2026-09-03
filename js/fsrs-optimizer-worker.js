// js/fsrs-optimizer-worker.js — Web Worker chạy FSRS Optimizer CHÍNH THỨC (native binding qua
// WASM/WASI) TRONG TRÌNH DUYỆT — audit lại "AUDIT V91 – FIX FSRS OPTIMIZER DỨT ĐIỂM", Phần I/II/V.
//
// LÝ DO tồn tại file này: computeParameters() chạy trong Vercel Function LUÔN bị chặn trên bởi giới
// hạn thời lượng thật của platform (60s Hobby / tới 300s Pro) — dù heartbeat/retry/abort có đúng tới
// đâu (xem lib/fsrs/optimizer.js — trainWithOfficialOptimizer, V90/V91), 1 lần abort chỉ giúp DỪNG
// SẠCH, KHÔNG tạo thêm thời gian thật để train xong. Chạy trong 1 Worker của trình duyệt thì KHÔNG có
// giới hạn thời lượng nhân tạo tương tự — đây là cách giải quyết TẬN GỐC, không phải vá thêm.
//
// KHÔNG tự viết optimizer/gradient descent nào ở đây — vẫn gọi ĐÚNG computeParameters() của package
// @open-spaced-repetition/binding chính thức, chỉ đổi MÔI TRƯỜNG chạy (Phần II).
//
// Giao thức message (đơn giản, 1 chiều mỗi lượt):
//   Nhận:  { type: 'start', jobId, assetUrls: {dynamicWasiEntryUrl, wasmAssetUrl, workerScriptUrl},
//            trainItems: [{ reviews: [{ rating, deltaT }, ...] }, ...], enableShortTerm }
//   Gửi:   { type: 'progress', jobId, current, total }
//          { type: 'done', jobId, weights: [21 số hữu hạn] }
//          { type: 'error', jobId, message }
//
// KHÔNG có cơ chế "abort vì hết ngân sách thời gian" ở đây (khác hẳn bản server) — trình duyệt không
// có giới hạn nhân tạo nào cần né. Hủy thật sự (user bấm Hủy/đóng modal) được xử lý bằng cách
// terminate() CHÍNH Worker này từ luồng chính (js/fsrs-optimizer.js) — không cần Worker tự biết.

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type !== 'start') return;
  const { jobId, assetUrls, trainItems, enableShortTerm } = msg;

  try {
    if (!assetUrls || !assetUrls.dynamicWasiEntryUrl || !assetUrls.wasmAssetUrl || !assetUrls.workerScriptUrl) {
      throw new Error('Thiếu asset URL từ server — optimizer chưa sẵn sàng trên server (kiểm tra @open-spaced-repetition/binding-wasm32-wasi đã cài trên server chưa).');
    }
    if (!Array.isArray(trainItems) || trainItems.length === 0) {
      throw new Error('Thiếu dữ liệu train (trainItems rỗng).');
    }

    // dynamic-wasi entry là module ESM bình thường (không cần bundler xử lý riêng) — import() động
    // trực tiếp bằng URL do SERVER tính (qua require.resolve() thật trên server đó, xem
    // api/index.js:computeBrowserOptimizerAssetUrls) — KHÔNG đoán tên file ở đây.
    const { initOptimizer } = await import(/* webpackIgnore: true */ assetUrls.dynamicWasiEntryUrl);
    if (typeof initOptimizer !== 'function') {
      throw new Error('Module dynamic-wasi không export initOptimizer như tài liệu mô tả — có thể package đã đổi API (đây là package đang ở giai đoạn beta, "API may change").');
    }

    const binding = await initOptimizer({
      wasm: assetUrls.wasmAssetUrl,
      worker: () => new Worker(assetUrls.workerScriptUrl, { type: 'module' }),
    });
    if (!binding || typeof binding.computeParameters !== 'function' || typeof binding.FSRSBindingItem !== 'function' || typeof binding.FSRSBindingReview !== 'function') {
      throw new Error('initOptimizer() không trả về đúng hình dạng binding mong đợi (thiếu computeParameters/FSRSBindingItem/FSRSBindingReview).');
    }

    const bindingItems = trainItems.map((item) =>
      new binding.FSRSBindingItem((item.reviews || []).map((r) => new binding.FSRSBindingReview(r.rating, r.deltaT)))
    );

    let lastPosted = 0;
    const result = await binding.computeParameters(bindingItems, {
      enableShortTerm: enableShortTerm !== false,
      progress: (current, total) => {
        const now = Date.now();
        if (now - lastPosted >= 250 || current === total) {
          lastPosted = now;
          self.postMessage({ type: 'progress', jobId, current, total });
        }
        // KHÔNG trả false ở đây — không có ngân sách thời gian nhân tạo nào cần chủ động né trong
        // trình duyệt (khác hẳn bản server, xem trainWithOfficialOptimizer). Hủy thật được xử lý bằng
        // terminate() Worker này từ bên ngoài, không qua đường progress callback.
        return true;
      },
    });

    const weights = Array.isArray(result) ? result
      : (result && Array.isArray(result.parameters)) ? result.parameters
      : (result && Array.isArray(result.w)) ? result.w
      : null;
    const FSRS6_PARAM_COUNT = 21;
    if (!Array.isArray(weights) || weights.length !== FSRS6_PARAM_COUNT || !weights.every((n) => Number.isFinite(Number(n)))) {
      throw new Error(`Optimizer trả về weights không hợp lệ (cần đúng ${FSRS6_PARAM_COUNT} số hữu hạn).`);
    }
    self.postMessage({ type: 'done', jobId, weights: weights.map(Number) });
  } catch (e) {
    self.postMessage({ type: 'error', jobId, message: (e && e.message) ? e.message : String(e) });
  }
};
