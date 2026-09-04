#!/usr/bin/env node
// scripts/ensure-wasm-optimizer.js
//
// AUDIT V91 – FIX FSRS OPTIMIZER DỨT ĐIỂM (vòng 5) — root cause THẬT của "thiếu gói WASM" trên
// production: @open-spaced-repetition/binding-wasm32-wasi khai `cpu: ["wasm32"]` trong package.json
// của chính nó (xác nhận qua tài liệu chính thức của NAPI-RS — framework build ra package này: "To
// avoid increasing every native install, NAPI-RS marks the WASI platform package with cpu: ['wasm32'].
// Package managers skip it unless wasm32 is an enabled installation architecture."). Máy build của
// Vercel là x64/arm64 THẬT — KHÔNG máy thật nào tự nhận "wasm32" là kiến trúc CPU của mình — nên `npm
// install`/`npm ci` LUÔN bỏ qua package này dù đã liệt kê trong optionalDependencies, kể cả khi
// includeFiles trong vercel.json đã đúng (includeFiles chỉ BUNDLE file đã có trên đĩa, không giúp CÀI
// ĐẶT file chưa từng được tải về). Đây là hành vi CHUẨN, được tài liệu hoá, không phải lỗi cấu hình.
//
// pnpm có tuỳ chọn "supportedArchitectures" để ép cài (xem README của package) — nhưng project này
// dùng npm (installCommand trong vercel.json), và npm KHÔNG có tuỳ chọn tương đương (xác nhận qua
// nhiều issue trên kho npm/cli chính thức — đây là hạn chế đã biết của npm, không phải điều gì mới).
//
// Giải pháp: package này CHỈ chứa asset tĩnh (1 file .wasm + 1-2 file .mjs glue code), KHÔNG có mã
// biên dịch riêng cho từng nền tảng — nội dung 1 bản tải về là DÙNG ĐƯỢC cho MỌI nền tảng. Script này
// tải THẲNG tarball của package từ npm registry (KHÔNG qua bước "resolve dependency" của npm — bước
// đó mới là nơi bị lọc theo cpu, một lượt tải trực tiếp qua HTTP registry URL thì KHÔNG bị lọc) rồi tự
// giải nén vào đúng vị trí trong node_modules — chạy như 1 bước postinstall, không cần sửa gì cấu hình
// npm/pnpm/Vercel khác.
//
// AN TOÀN CHO BUILD: mọi lỗi ở đây chỉ CẢNH BÁO (console.warn), KHÔNG làm hỏng `npm install`/build —
// optimizer bản trình duyệt là tính năng THÊM, không phải lõi ứng dụng (Phần XI "KHÔNG phá hệ thống
// hiện tại"). Nếu script này thất bại, GET /api/fsrs-optimizer/diagnostics (admin) sẽ tự báo rõ lý do
// khi có người thử dùng optimizer bản trình duyệt — không cần script này phải "thành công" thì app mới
// chạy được.

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { execSync } = require('child_process');

const SCOPE = '@open-spaced-repetition';
const PKG_BASENAME = 'binding-wasm32-wasi';
const PKG_NAME = `${SCOPE}/${PKG_BASENAME}`;
const TARGET_DIR = path.join(__dirname, '..', 'node_modules', SCOPE, PKG_BASENAME);

function readPinnedVersion() {
  // Đọc ĐÚNG version đã pin trong package.json của chính project (KHÔNG hardcode "0.5.0" ở đây) — nếu
  // version chính (@open-spaced-repetition/binding) từng được bump lên version mới, optionalDependencies
  // của nó thường bump theo cùng version, script tự bám theo đúng version đó, không cần sửa tay 2 chỗ.
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const v = pkgJson.optionalDependencies && pkgJson.optionalDependencies[PKG_NAME];
    if (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)) return v.replace(/^[\^~]/, '');
  } catch { /* rơi xuống fallback bên dưới */ }
  return '0.5.0'; // fallback nếu vì lý do gì đó không đọc được package.json — khớp version đang biết tại thời điểm viết script này
}

function alreadyInstalled() {
  return fs.existsSync(path.join(TARGET_DIR, 'package.json'));
}

function downloadFile(url, destPath, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30_000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) { reject(new Error('Quá nhiều redirect khi tải tarball.')); return; }
        resolve(downloadFile(res.headers.location, destPath, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} khi tải ${url}`)); return; }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    });
    // Bắt buộc phải có timeout tường minh — nếu mạng "treo" (không refuse, không timeout tự nhiên của
    // OS) thay vì lỗi nhanh, request có thể treo VÔ THỜI HẠN, kéo theo cả bước postinstall/build treo
    // theo (đã tự gặp đúng tình huống này khi thử trong sandbox không có mạng — lỗi thật trên Vercel
    // production khó xảy ra hơn nhiều vì máy build CÓ mạng thật, nhưng vẫn nên phòng ngừa).
    req.on('timeout', () => { req.destroy(new Error('Hết thời gian chờ tải tarball (30s).')); });
    req.on('error', reject);
  });
}

async function main() {
  if (alreadyInstalled()) {
    console.log(`[ensure-wasm-optimizer] ${PKG_NAME} đã có sẵn trên đĩa — bỏ qua (npm đã cài được bình thường, không cần tự tải).`);
    return;
  }
  const version = readPinnedVersion();
  console.log(`[ensure-wasm-optimizer] npm đã bỏ qua ${PKG_NAME}@${version} (package khai cpu:["wasm32"] — hành vi CHUẨN của npm, không phải lỗi). Tự tải trực tiếp từ npm registry...`);

  const tarballUrl = `https://registry.npmjs.org/${PKG_NAME}/-/${PKG_BASENAME}-${version}.tgz`;
  const tmpTarball = path.join(os.tmpdir(), `${PKG_BASENAME}-${version}-${Date.now()}.tgz`);
  try {
    await downloadFile(tarballUrl, tmpTarball, 5);
    fs.mkdirSync(TARGET_DIR, { recursive: true });
    // Tarball npm chuẩn luôn có 1 thư mục gốc tên "package/" — --strip-components=1 để giải nén thẳng
    // nội dung vào TARGET_DIR mà không lồng thêm 1 cấp thư mục "package/" thừa bên trong.
    execSync(`tar -xzf "${tmpTarball}" -C "${TARGET_DIR}" --strip-components=1`, { stdio: 'inherit' });
    if (!alreadyInstalled()) throw new Error('Giải nén xong nhưng không thấy package.json bên trong — tarball có thể sai cấu trúc, cần kiểm tra lại tay.');
    console.log(`[ensure-wasm-optimizer] ✅ Đã tự cài ${PKG_NAME}@${version} vào ${TARGET_DIR}.`);
  } catch (e) {
    console.warn(`[ensure-wasm-optimizer] ⚠️  KHÔNG tự tải/cài được ${PKG_NAME}@${version} (${e.message}). KHÔNG làm hỏng build — tính năng optimizer bản trình duyệt sẽ báo lỗi rõ ràng cho tới khi khắc phục xong (xem GET /api/fsrs-optimizer/diagnostics).`);
  } finally {
    try { if (fs.existsSync(tmpTarball)) fs.unlinkSync(tmpTarball); } catch { /* dọn dẹp best-effort, không quan trọng nếu thất bại */ }
  }
}

main();
