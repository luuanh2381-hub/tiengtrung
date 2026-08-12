// ════════════════════════════════════════════════════
// SERVER — App học từ vựng tiếng Trung (bản deploy Vercel)
// Đăng ký / đăng nhập / lưu tiến độ theo tài khoản.
// Dữ liệu lưu trong Postgres (xem lib/db.js) thay vì file JSON,
// vì Vercel không giữ file lâu dài giữa các lần chạy.
// ════════════════════════════════════════════════════
const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { readDB, updateDB, getVocabByLessons, getVocabCounts, importVocab, clearVocab, deleteVocabLesson,
  getAllVocabWords, updateVocabHanviet, getWordExampleCounts, insertWordExamples, getWordExamplesForLessons,
  getAllHanziParts, getHanziPartsKeys, insertHanziParts,
  insertActivityLog, getActivityLogs, reserveGeminiSlot, bumpGeminiRateLimit } = require('../lib/db');

const app = express();

process.on('uncaughtException', (err) => {
  console.error('⚠️  [uncaughtException]:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('⚠️  [unhandledRejection]:', err && err.message);
});

function emptyProgress() {
  return { srs: {}, streak: 0, lastDate: null, ui: { lastTab: 'home', selectedBookIds: [1], selectedLessons: [], lessonsAllMode: true } };
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function countKnown(progress) {
  const srs = (progress && progress.srs) || {};
  let n = 0;
  for (const hz in srs) { if (srs[hz] && srs[hz].step >= 3) n++; }
  return n;
}

const RANKS = [
  { min: 0,   name: 'Tân binh',      icon: '🌱' },
  { min: 20,  name: 'Mới nhập môn',  icon: '🐣' },
  { min: 60,  name: 'Chăm chỉ',      icon: '📖' },
  { min: 120, name: 'Vững vàng',     icon: '🎯' },
  { min: 250, name: 'Cao thủ',       icon: '🔥' },
  { min: 400, name: 'Đại cao thủ',   icon: '💎' },
  { min: 600, name: 'Đại tông sư',   icon: '👑' },
];
function getRank(known) {
  let cur = RANKS[0];
  for (const r of RANKS) { if (known >= r.min) cur = r; }
  const idx = RANKS.indexOf(cur);
  const next = RANKS[idx + 1] || null;
  return {
    name: cur.name, icon: cur.icon,
    next: next ? { name: next.name, icon: next.icon, remain: next.min - known } : null,
  };
}

// Luôn tính "ngày hôm nay" theo GIỜ VIỆT NAM (UTC+7), không phụ thuộc múi giờ của server đang chạy
// (server Vercel mặc định chạy UTC — nếu không quy đổi, mốc "sang ngày mới" sẽ lệch 7 tiếng,
// ảnh hưởng tới lượt truy cập theo ngày, nhật ký hoạt động, v.v.)
const VN_TIMEZONE = 'Asia/Ho_Chi_Minh';
function vnDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: VN_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date || new Date());
}
function vnTimeKey(date) {
  return new Intl.DateTimeFormat('vi-VN', { timeZone: VN_TIMEZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date || new Date());
}
function todayKey() {
  return vnDateKey();
}

function fail(res, e, fallbackMsg) {
  console.error('⚠️  Lỗi:', e && e.message);
  res.status(500).json({ ok: false, error: fallbackMsg || ('Lỗi server: ' + (e && e.message)) });
}

// ── Ghi nhật ký hoạt động (không chờ, không để lỗi ghi log làm hỏng luồng chính) ──
function logActivity(username, role, action, detail) {
  insertActivityLog({ username, role, action, detail }).catch((e) => {
    console.error('⚠️  Không ghi được nhật ký:', e && e.message);
  });
}

// Nén gzip/brotli các response JSON (đặc biệt danh sách từ vựng, ví dụ, chiết tự — có thể khá
// lớn) — giảm dung lượng truyền qua mạng, giúp tải nhanh hơn nhất là mạng chậm/di động.
app.use(compression());
app.use(express.json({ limit: '20mb' }));

// ── Xác thực: kiểm tra token, KHÔNG khoá dữ liệu (chỉ đọc) ──
async function requireAuth(req, res) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { res.status(401).json({ ok: false, error: 'Chưa đăng nhập' }); return null; }
  const db = await readDB();
  const username = db.tokens[token];
  if (!username || !db.users[username]) {
    res.status(401).json({ ok: false, error: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại' });
    return null;
  }
  return { username, token, db };
}

function requireAdmin(user, res) {
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
    res.status(403).json({ ok: false, error: 'Chỉ quản trị viên mới dùng được chức năng này' });
    return false;
  }
  return true;
}
function requireSuperAdmin(user, res) {
  if (!user || user.role !== 'superadmin') {
    res.status(403).json({ ok: false, error: 'Chỉ quản trị cao nhất mới dùng được chức năng này' });
    return false;
  }
  return true;
}

// ── Ghi nhận 1 lượt truy cập ──
app.post('/api/visit', async (req, res) => {
  try {
    await updateDB((db) => {
      const key = todayKey();
      db.visits.total = (db.visits.total || 0) + 1;
      db.visits.byDate[key] = (db.visits.byDate[key] || 0) + 1;
    });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── Đăng ký ──
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, error: 'Thiếu tên đăng nhập hoặc mật khẩu' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.json({ ok: false, error: 'Tên đăng nhập 3-20 ký tự, chỉ gồm chữ/số/gạch dưới' });
  }
  if (String(password).length < 4) return res.json({ ok: false, error: 'Mật khẩu cần tối thiểu 4 ký tự' });
  try {
    const key = username.toLowerCase();
    const passwordHash = await bcrypt.hash(String(password), 10);
    const token = makeToken();
    const result = await updateDB((db) => {
      if (db.users[key]) return { ok: false, error: 'Tên đăng nhập đã tồn tại' };
      const isFirstUser = Object.keys(db.users).length === 0;
      db.users[key] = {
        username, passwordHash,
        role: isFirstUser ? 'superadmin' : 'user',
        progress: emptyProgress(),
        createdAt: Date.now(),
      };
      db.tokens[token] = key;
      const known = countKnown(db.users[key].progress);
      return { ok: true, token, username, role: db.users[key].role, progress: db.users[key].progress, rank: getRank(known) };
    });
    if (result.ok) logActivity(result.username, result.role, 'auth', 'Đăng ký tài khoản mới');
    res.json(result);
  } catch (e) { fail(res, e); }
});

// ── Đăng nhập ──
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, error: 'Thiếu tên đăng nhập hoặc mật khẩu' });
  try {
    const key = String(username).toLowerCase();
    const db = await readDB();
    const user = db.users[key];
    if (!user) {
      logActivity(username, null, 'auth', 'Đăng nhập thất bại (tài khoản không tồn tại)');
      return res.json({ ok: false, error: 'Tài khoản không tồn tại' });
    }
    const match = await bcrypt.compare(String(password), user.passwordHash);
    if (!match) {
      logActivity(user.username, user.role, 'auth', 'Đăng nhập thất bại (sai mật khẩu)');
      return res.json({ ok: false, error: 'Sai mật khẩu' });
    }
    const token = makeToken();
    const result = await updateDB((db2) => {
      const u = db2.users[key];
      if (!u.role) u.role = 'user';
      db2.tokens[token] = key;
      const progress = u.progress || emptyProgress();
      const known = countKnown(progress);
      return { ok: true, token, username: u.username, role: u.role, progress, rank: getRank(known) };
    });
    if (result.ok) logActivity(result.username, result.role, 'auth', 'Đăng nhập');
    res.json(result);
  } catch (e) { fail(res, e); }
});

// ── Đăng xuất ──
app.post('/api/logout', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  try {
    await updateDB((db) => { delete db.tokens[authed.token]; });
    logActivity(authed.username, authed.db.users[authed.username].role || 'user', 'auth', 'Đăng xuất');
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── Lấy tiến độ ──
app.get('/api/progress', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  const user = authed.db.users[authed.username];
  const progress = user.progress || emptyProgress();
  const known = countKnown(progress);
  res.json({ ok: true, username: user.username, role: user.role || 'user', progress, rank: getRank(known) });
});

// ── Lưu tiến độ ──
app.post('/api/progress', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  const { srs, streak, lastDate, ui } = req.body || {};
  try {
    const rank = await updateDB((db) => {
      const safeUi = (ui && typeof ui === 'object') ? {
        lastTab: typeof ui.lastTab === 'string' ? ui.lastTab : 'home',
        selectedBookIds: Array.isArray(ui.selectedBookIds)
          ? ui.selectedBookIds.filter(n => Number.isFinite(n)) : [1],
        selectedLessons: Array.isArray(ui.selectedLessons)
          ? ui.selectedLessons.filter(n => Number.isFinite(n)) : [],
        lessonsAllMode: typeof ui.lessonsAllMode === 'boolean' ? ui.lessonsAllMode : true,
        // Các cài đặt hiển thị (Ẩn/Hiện Pinyin, nghĩa, Hán Việt, giao diện tối/sáng, tốc độ đọc,
        // chế độ + số câu Trắc nghiệm mặc định) — lưu để mở lại app khỏi phải chọn lại từ đầu.
        showPinyin: typeof ui.showPinyin === 'boolean' ? ui.showPinyin : true,
        showMeaning: typeof ui.showMeaning === 'boolean' ? ui.showMeaning : true,
        showHanViet: typeof ui.showHanViet === 'boolean' ? ui.showHanViet : true,
        theme: (ui.theme === 'dark' || ui.theme === 'light') ? ui.theme : 'light',
        ttsRate: (typeof ui.ttsRate === 'number' && ui.ttsRate >= 0.3 && ui.ttsRate <= 1.0) ? ui.ttsRate : 0.65,
        qzType: ['漢→Việt', 'Việt→漢', 'Âm→漢'].includes(ui.qzType) ? ui.qzType : '漢→Việt',
        qzQuestionCount: Number.isFinite(ui.qzQuestionCount) ? ui.qzQuestionCount : 30,
        questionCount: Number.isFinite(ui.questionCount) ? ui.questionCount : 10,
      } : { lastTab: 'home', selectedBookIds: [1], selectedLessons: [], lessonsAllMode: true,
        showPinyin: true, showMeaning: true, showHanViet: true, theme: 'light', ttsRate: 0.65,
        qzType: '漢→Việt', qzQuestionCount: 30, questionCount: 10 };
      db.users[authed.username].progress = {
        srs: (srs && typeof srs === 'object') ? srs : {},
        streak: typeof streak === 'number' ? streak : 0,
        lastDate: lastDate || null,
        ui: safeUi,
      };
      return getRank(countKnown(db.users[authed.username].progress));
    });
    res.json({ ok: true, rank });
  } catch (e) { fail(res, e); }
});

// ── Bảng xếp hạng ──
app.get('/api/leaderboard', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  const db = authed.db;
  const list = Object.values(db.users).map(u => {
    const known = countKnown(u.progress || emptyProgress());
    return {
      username: u.username,
      known,
      streak: (u.progress && u.progress.streak) || 0,
      rank: getRank(known).name,
      isMe: u.username.toLowerCase() === authed.username,
    };
  }).sort((a, b) => b.known - a.known || b.streak - a.streak);
  res.json({ ok: true, leaderboard: list.slice(0, 100) });
});

// ── [ADMIN] Thống kê lượt truy cập ──
app.get('/api/admin/visits', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  const db = authed.db;
  if (!requireAdmin(db.users[authed.username], res)) return;
  const visits = db.visits || { total: 0, byDate: {} };
  const today = todayKey();
  const last14 = [];
  for (let i = 13; i >= 0; i--) {
    const d = vnDateKey(new Date(Date.now() - i * 86400000));
    last14.push({ date: d, count: visits.byDate[d] || 0 });
  }
  res.json({
    ok: true,
    total: visits.total || 0,
    today: visits.byDate[today] || 0,
    totalUsers: Object.keys(db.users).length,
    last14,
  });
});

// ── [ADMIN] Nhật ký hoạt động — tối đa 10 ngày gần nhất, gộp theo ngày (mới nhất trước) ──
app.get('/api/admin/logs', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireAdmin(authed.db.users[authed.username], res)) return;
  try {
    const rows = await getActivityLogs();
    const byDay = new Map();
    for (const row of rows) {
      if (!byDay.has(row.day)) byDay.set(row.day, []);
      byDay.get(row.day).push({
        time: row.time, username: row.username, role: row.role,
        action: row.action, detail: row.detail,
      });
    }
    const days = [...byDay.entries()].map(([date, logs]) => ({ date, count: logs.length, logs }));
    res.json({ ok: true, days });
  } catch (e) { fail(res, e); }
});

// ── [ADMIN] Danh sách toàn bộ user ──
app.get('/api/admin/users', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  const db = authed.db;
  if (!requireAdmin(db.users[authed.username], res)) return;
  const list = Object.entries(db.users).map(([key, u]) => {
    const known = countKnown(u.progress || emptyProgress());
    return {
      key,
      username: u.username,
      role: u.role || 'user',
      known,
      streak: (u.progress && u.progress.streak) || 0,
      createdAt: u.createdAt,
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
  res.json({ ok: true, users: list });
});

// ── [ADMIN] Xoá tài khoản ──
app.post('/api/admin/users/:key/delete', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireAdmin(authed.db.users[authed.username], res)) return;
  const targetKey = req.params.key.toLowerCase();
  try {
    const result = await updateDB((db) => {
      if (targetKey === authed.username) return { ok: false, error: 'Không thể tự xoá chính mình' };
      if (!db.users[targetKey]) return { ok: false, error: 'Không tìm thấy tài khoản' };
      if (db.users[targetKey].role === 'superadmin') return { ok: false, error: 'Không thể xoá tài khoản quản trị cao nhất' };
      delete db.users[targetKey];
      for (const t in db.tokens) { if (db.tokens[t] === targetKey) delete db.tokens[t]; }
      return { ok: true };
    });
    if (result.ok) {
      const actingUser = authed.db.users[authed.username];
      logActivity(authed.username, actingUser.role, 'admin', `Xoá tài khoản "${targetKey}"`);
    }
    res.json(result);
  } catch (e) { fail(res, e); }
});

// ── [ADMIN] Reset tiến độ của 1 tài khoản ──
app.post('/api/admin/users/:key/reset', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireAdmin(authed.db.users[authed.username], res)) return;
  const targetKey = req.params.key.toLowerCase();
  try {
    const result = await updateDB((db) => {
      if (!db.users[targetKey]) return { ok: false, error: 'Không tìm thấy tài khoản' };
      const actingUser = db.users[authed.username];
      if (db.users[targetKey].role === 'superadmin' && actingUser.role !== 'superadmin') {
        return { ok: false, error: 'Chỉ quản trị cao nhất mới được reset tài khoản này' };
      }
      db.users[targetKey].progress = emptyProgress();
      return { ok: true };
    });
    if (result.ok) {
      const actingUser = authed.db.users[authed.username];
      logActivity(authed.username, actingUser.role, 'admin', `Reset tiến độ tài khoản "${targetKey}"`);
    }
    res.json(result);
  } catch (e) { fail(res, e); }
});

// ── [SUPERADMIN] Thăng/giáng quyền admin ──
app.post('/api/admin/users/:key/role', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireSuperAdmin(authed.db.users[authed.username], res)) return;
  const { role } = req.body || {};
  if (role !== 'admin' && role !== 'user') return res.json({ ok: false, error: 'Role không hợp lệ' });
  const targetKey = req.params.key.toLowerCase();
  try {
    const result = await updateDB((db) => {
      if (!db.users[targetKey]) return { ok: false, error: 'Không tìm thấy tài khoản' };
      if (db.users[targetKey].role === 'superadmin') return { ok: false, error: 'Không thể đổi quyền của tài khoản quản trị cao nhất' };
      if (targetKey === authed.username && role === 'user') return { ok: false, error: 'Không thể tự hạ quyền chính mình' };
      db.users[targetKey].role = role;
      return { ok: true };
    });
    if (result.ok) {
      const actingUser = authed.db.users[authed.username];
      logActivity(authed.username, actingUser.role, 'admin', `Đổi quyền tài khoản "${targetKey}" thành "${role}"`);
    }
    res.json(result);
  } catch (e) { fail(res, e); }
});

// ── Lấy từ vựng THEO ĐÚNG các bài được yêu cầu (?lessons=32,33,34) — không tải cả kho ──
app.get('/api/vocab', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  try {
    const raw = String(req.query.lessons || '').trim();
    if (!raw) return res.json({ ok: true, vocab: [] });
    const lessons = raw.split(',').map(s => parseInt(s, 10)).filter(Number.isFinite);
    const vocab = await getVocabByLessons(lessons);
    // Từ vựng hiếm khi đổi (chỉ đổi khi admin nhập/xoá bài) — cho phép trình duyệt lưu tạm
    // (private vì có gắn token) để mở lại app trong ít phút không phải tải lại qua mạng.
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ ok: true, vocab });
  } catch (e) { fail(res, e); }
});

// ── Lấy từ vựng cho KHÁCH (chưa đăng nhập) — không cần token, nhưng chỉ cho phép tối đa
//     Bài 1-5 (giới hạn dùng thử của khách), server tự chặn dù client gửi số bài nào khác ──
const GUEST_MAX_LESSON_SERVER = 5;
app.get('/api/vocab/public', async (req, res) => {
  try {
    const raw = String(req.query.lessons || '').trim();
    if (!raw) return res.json({ ok: true, vocab: [] });
    const lessons = raw.split(',').map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n >= 1 && n <= GUEST_MAX_LESSON_SERVER);
    if (lessons.length === 0) return res.json({ ok: true, vocab: [] });
    const vocab = await getVocabByLessons(lessons);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ ok: true, vocab });
  } catch (e) { fail(res, e); }
});

// ── Đếm nhanh số từ theo từng bài (payload rất nhỏ, không chứa dữ liệu nhạy cảm) — để hiện số từ
//     ở màn chọn Quyển/level mà không cần tải cả nội dung. Công khai, không cần đăng nhập. ──
app.get('/api/vocab/counts', async (req, res) => {
  try {
    const counts = await getVocabCounts();
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ ok: true, counts });
  } catch (e) { fail(res, e); }
});

// ── [ADMIN] Nhập từ vựng hàng loạt (từ file Excel đã được parse ở trình duyệt, hoặc nhập thủ công 1 từ) ──
app.post('/api/admin/vocab/import', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireAdmin(authed.db.users[authed.username], res)) return;
  const { words, overwrite } = req.body || {};
  if (!Array.isArray(words) || words.length === 0) {
    return res.json({ ok: false, error: 'Không có dữ liệu từ vựng để nhập' });
  }
  try {
    const result = await importVocab(words, !!overwrite);
    const actingUser = authed.db.users[authed.username];
    logActivity(authed.username, actingUser.role, 'vocab',
      `Nhập từ vựng: thêm ${result.added}, cập nhật ${result.updated}, bỏ qua ${result.skipped} (tổng ${result.total} từ)`);
    res.json({ ok: true, ...result });
  } catch (e) { fail(res, e); }
});

// ── [ADMIN] Xoá toàn bộ từ vựng của MỘT bài cụ thể (không đụng các bài khác) ──
app.post('/api/admin/vocab/delete-lesson', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireAdmin(authed.db.users[authed.username], res)) return;
  const l = parseInt((req.body || {}).l, 10);
  if (!Number.isFinite(l) || l < 1) {
    return res.json({ ok: false, error: 'Số bài không hợp lệ' });
  }
  try {
    const removed = await deleteVocabLesson(l);
    const actingUser = authed.db.users[authed.username];
    logActivity(authed.username, actingUser.role, 'vocab', `Xoá bài số ${l} (${removed} từ)`);
    res.json({ ok: true, removed });
  } catch (e) { fail(res, e); }
});

// ── [ADMIN] Xoá toàn bộ từ vựng đã thêm qua Excel/thủ công (không đụng tới 781 từ có sẵn của app) ──
app.post('/api/admin/vocab/clear', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireAdmin(authed.db.users[authed.username], res)) return;
  try {
    const removed = await clearVocab();
    const actingUser = authed.db.users[authed.username];
    logActivity(authed.username, actingUser.role, 'vocab', `Xoá toàn bộ từ vựng đã thêm (${removed} từ)`);
    res.json({ ok: true, removed });
  } catch (e) { fail(res, e); }
});

// ── Đổi mật khẩu ──
app.post('/api/change-password', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.json({ ok: false, error: 'Thiếu dữ liệu' });
  if (String(newPassword).length < 4) return res.json({ ok: false, error: 'Mật khẩu mới cần tối thiểu 4 ký tự' });
  try {
    const user = authed.db.users[authed.username];
    const match = await bcrypt.compare(String(oldPassword), user.passwordHash);
    if (!match) return res.json({ ok: false, error: 'Mật khẩu hiện tại không đúng' });
    const newHash = await bcrypt.hash(String(newPassword), 10);
    await updateDB((db) => { db.users[authed.username].passwordHash = newHash; });
    logActivity(authed.username, user.role || 'user', 'auth', 'Đổi mật khẩu');
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════
// AI DỊCH — Sinh câu luyện dịch & chấm bài bằng Google Gemini (free tier)
// Cần đặt biến môi trường GEMINI_API_KEY (lấy tại https://aistudio.google.com/apikey)
// ════════════════════════════════════════════════════
const https = require('https');
// QUAN TRỌNG: Tài liệu chính thức của Google (ai.google.dev/gemini-api/docs/models) nói rõ
// "gemini-flash-latest" CỐ TÌNH trỏ tới model thử nghiệm (experimental) — không dành cho production,
// và có quota free tier rất hẹp (từng đo được chỉ 5 request/phút). Đó là lý do dù giãn cách bao lâu
// vẫn bị "quota exceeded" liên tục. Model ổn định "gemini-3.5-flash" ĐƯỢC CHỌN làm mặc định, nhưng
// quota free tier THỰC TẾ đo được của model này qua lỗi Google trả về cũng chỉ là 5 request/phút
// (không phải 15-20 request/phút như tài liệu công khai gợi ý cho các model Flash khác — quota free
// tier có thể khác nhau tuỳ từng Google Cloud project). Có thể ghi đè bằng biến môi trường
// GEMINI_MODEL trên Vercel nếu sau này muốn thử model khác (vd "gemini-3.1-flash-lite" thường có
// quota free tier cao hơn) mà không cần sửa code.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Luôn đảm bảo khoảng cách tối thiểu giữa 2 lần gọi Gemini để không vượt quota free tier —
// dùng hàng đợi CHUNG lưu trong Postgres (reserveGeminiSlot ở lib/db.js) thay vì chỉ đếm trong RAM,
// vì RAM của mỗi tiến trình là riêng biệt, không ngăn được việc nhiều tiến trình (vd nhiều lượt cron
// GitHub Actions chồng nhau) cùng vượt quota chung.
// Quota THỰC TẾ Google báo qua lỗi 429 là "limit: 5" (5 request/phút) — dùng 13s/lần (~4.6 request/
// phút) để có biên độ an toàn, tránh sát ngưỡng gây lỗi liên tục. Có thể ghi đè bằng biến môi trường
// GEMINI_MIN_INTERVAL_MS (đơn vị mili-giây) trên Vercel nếu quota thực tế của bạn khác.
const GEMINI_MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS) || 13000;
async function waitForGeminiSlot() {
  const mySlot = await reserveGeminiSlot(GEMINI_MIN_INTERVAL_MS);
  const waitMs = mySlot.getTime() - Date.now();
  if (waitMs > 0) await sleep(waitMs);
}

// Gemini thường trả kèm số giây cụ thể cần đợi khi hết quota, dạng "...Please retry in 40.67s."
// hoặc "retryDelay":"41s" — trích số giây này ra (làm tròn lên, cộng thêm 1s cho chắc) để biết
// CHÍNH XÁC cần đợi bao lâu, thay vì đoán mò.
function extractRetryDelayMs(msg) {
  if (!msg) return null;
  let m = msg.match(/retry in\s+([\d.]+)\s*s/i);
  if (!m) m = msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
  if (!m) return null;
  const seconds = parseFloat(m[1]);
  if (!Number.isFinite(seconds)) return null;
  return Math.ceil(seconds + 1) * 1000;
}

// Nhận diện lỗi HẾT QUOTA (429 / "quota exceeded" / "resource exhausted") — khác lỗi tạm thời ở dưới,
// vì lỗi quota thì thử lại ngay lập tức chắc chắn vẫn lỗi, phải đẩy lùi HÀNG ĐỢI CHUNG ra xa hơn.
function isQuotaGeminiError(msg) {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return m.includes('quota') || m.includes('resource_exhausted') || m.includes('429');
}

// Nhận diện các lỗi TẠM THỜI từ Gemini (model đang quá tải/high demand, lỗi 503, lỗi nội bộ...) —
// khác với lỗi quota (429) là loại lỗi này Google khuyên "thử lại sau" và thường chỉ cần đợi vài giây
// là qua ngay, nên có thể tự động thử lại thay vì bắt người dùng bấm lại.
function isTransientGeminiError(msg) {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return m.includes('overloaded') || m.includes('high demand') || m.includes('unavailable')
    || m.includes('try again later') || m.includes('internal error') || m.includes('503');
}

// Gọi hàm gemini thực tế (doFn):
// - Lỗi HẾT QUOTA (429): không có ích gì khi thử lại ngay (chắc chắn vẫn lỗi) — đẩy lùi HÀNG ĐỢI
//   CHUNG ra đúng khoảng thời gian Google yêu cầu đợi (đọc được từ nội dung lỗi), rồi báo lỗi luôn để
//   vòng lặp xử lý lô tiếp theo (hoặc lượt cron kế tiếp) tự động tôn trọng khoảng đợi đó.
// - Lỗi TẠM THỜI khác (quá tải, 503...): thử lại tối đa 2 lần, đợi 3s rồi 6s giữa các lần thử — vẫn
//   tôn trọng giãn cách quota (waitForGeminiSlot) ở mỗi lần gọi.
async function callWithRetry(doFn) {
  const MAX_RETRIES = 2;
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await waitForGeminiSlot();
    try {
      return await doFn();
    } catch (e) {
      lastErr = e;
      if (isQuotaGeminiError(e.message)) {
        const delayMs = extractRetryDelayMs(e.message) || GEMINI_MIN_INTERVAL_MS * 4;
        await bumpGeminiRateLimit(delayMs).catch(() => {});
        throw e;
      }
      if (attempt < MAX_RETRIES && isTransientGeminiError(e.message)) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function callGemini(prompt) {
  return callWithRetry(() => doCallGemini(prompt));
}
function doCallGemini(prompt) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return reject(new Error('Chưa cấu hình GEMINI_API_KEY trên server'));
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
      },
    });
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${GEMINI_MODEL}:generateContent`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-goog-api-key': apiKey,
      },
    };
    const reqq = https.request(options, (resp) => {
      let body = '';
      resp.on('data', (chunk) => (body += chunk));
      resp.on('end', () => {
        if (!body || !body.trim()) {
          return reject(new Error(`Không nhận được phản hồi từ Gemini (HTTP ${resp.statusCode}).`));
        }
        try {
          const json = JSON.parse(body);
          if (resp.statusCode >= 400) {
            return reject(new Error(json?.error?.message || `Gemini lỗi HTTP ${resp.statusCode}`));
          }
          const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
          if (!text) {
            const reason = json?.candidates?.[0]?.finishReason;
            return reject(new Error(`Gemini không trả về nội dung (finishReason: ${reason || 'không rõ'})`));
          }
          resolve(text);
        } catch (e) {
          reject(new Error(`Phản hồi từ Gemini không hợp lệ (HTTP ${resp.statusCode}): ${e.message}`));
        }
      });
    });
    reqq.on('error', (e) => reject(new Error('Không kết nối được tới Gemini API: ' + e.message)));
    reqq.setTimeout(20000, () => { reqq.destroy(new Error('Gemini API timeout sau 20s')); });
    reqq.write(payload);
    reqq.end();
  });
}

// Giống callGemini() nhưng gửi kèm file âm thanh (multimodal) — dùng để chấm phát âm.
// Dùng chung "hàng đợi" thời gian với callGemini() ở trên vì cùng chia sẻ 1 quota API key.
function callGeminiWithAudio(prompt, audioBase64, mimeType) {
  return callWithRetry(() => doCallGeminiWithAudio(prompt, audioBase64, mimeType));
}
function doCallGeminiWithAudio(prompt, audioBase64, mimeType) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return reject(new Error('Chưa cấu hình GEMINI_API_KEY trên server'));
    const payload = JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType || 'audio/webm', data: audioBase64 } },
        ],
      }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 1024,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
      },
    });
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${GEMINI_MODEL}:generateContent`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-goog-api-key': apiKey,
      },
    };
    const reqq = https.request(options, (resp) => {
      let body = '';
      resp.on('data', (chunk) => (body += chunk));
      resp.on('end', () => {
        if (!body || !body.trim()) {
          return reject(new Error(`Không nhận được phản hồi từ Gemini (HTTP ${resp.statusCode}).`));
        }
        try {
          const json = JSON.parse(body);
          if (resp.statusCode >= 400) {
            return reject(new Error(json?.error?.message || `Gemini lỗi HTTP ${resp.statusCode}`));
          }
          const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
          if (!text) {
            const reason = json?.candidates?.[0]?.finishReason;
            return reject(new Error(`Gemini không trả về nội dung (finishReason: ${reason || 'không rõ'})`));
          }
          resolve(text);
        } catch (e) {
          reject(new Error(`Phản hồi từ Gemini không hợp lệ (HTTP ${resp.statusCode}): ${e.message}`));
        }
      });
    });
    reqq.on('error', (e) => reject(new Error('Không kết nối được tới Gemini API: ' + e.message)));
    reqq.setTimeout(25000, () => { reqq.destroy(new Error('Gemini API timeout sau 25s')); });
    reqq.write(payload);
    reqq.end();
  });
}

function parseAiJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// Logic sinh ví dụ THEO TỪNG TỪ CỤ THỂ — đảm bảo mỗi từ có sẵn TARGET_EXAMPLES_PER_WORD câu ví dụ,
// mỗi câu được kiểm tra chắc chắn có chứa đúng chữ Hán của từ đó (nếu AI trả sai, câu đó bị loại,
// từ vẫn coi là "chưa xong" và sẽ được thử lại ở lượt chạy sau).
const TARGET_EXAMPLES_PER_WORD = 3;
const WORD_BATCH_SIZE = 12;
// Logic sinh CHIẾT TỰ BỘ THỦ cho từng chữ Hán đơn lẻ (khác word_examples — đây là phân tích cấu tạo
// mặt chữ, không phải câu ví dụ). Chữ nào không tách được rõ ràng thì AI chỉ ghi 1 ghi chú ngắn.
const HANZI_BATCH_SIZE = 20;
function extractUniqueChars(words) {
  const set = new Set();
  const cjk = /[\u4e00-\u9fff]/;
  for (const w of words) for (const ch of [...w.hz]) if (cjk.test(ch)) set.add(ch);
  return set;
}
// Gom các lỗi mẫu lại, coi 2 lỗi là "giống nhau" nếu bỏ hết số đi mà văn bản còn lại khớp nhau
// (vd lỗi "quota exceeded... Please retry in 34.1s" và "...retry in 21.7s" chỉ khác số giây đếm ngược,
// nên chỉ cần giữ 1 mẫu là đủ, tránh log bị lặp lại y hệt nhau hàng chục lần).
const MAX_ERROR_SAMPLES = 5;
// Bỏ bớt các URL dài dòng trong thông báo lỗi Gemini (vd link docs/rate-limits) — chúng chiếm rất
// nhiều ký tự nhưng không có giá trị chẩn đoán, khiến phần quan trọng nhất (limit, tên model...)
// bị cắt mất khi giới hạn độ dài hiển thị.
function cleanErrorMsg(msg) {
  return msg.replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();
}
function addErrorSample(errorSamples, msg) {
  if (errorSamples.length >= MAX_ERROR_SAMPLES) return;
  const cleaned = cleanErrorMsg(msg);
  const normalize = (s) => s.replace(/[\d.]+/g, '#');
  const key = normalize(cleaned);
  if (errorSamples.some(s => normalize(s) === key)) return;
  errorSamples.push(cleaned.length > 400 ? cleaned.slice(0, 400) + '…' : cleaned);
}

// Logic sinh NGHĨA HÁN VIỆT cho từng từ (âm Hán Việt ghép lại theo từng chữ, vd 学习 → "Học tập") —
// khác với "vi" (nghĩa thuần Việt, do người nhập sẵn) — hanviet là cách đọc/nghĩa Hán Việt truyền
// thống, giúp người học liên hệ từ Hán Việt đã biết trong tiếng Việt để nhớ nghĩa nhanh hơn.
const HANVIET_BATCH_SIZE = 20;

async function runHanVietGeneration(timeBudgetMs) {
  const startedAt = Date.now();
  const TIME_BUDGET_MS = timeBudgetMs || 50000;
  const allWords = await getAllVocabWords();
  // "Chưa xong" = chưa có hanviet, hoặc rỗng. Dùng key hz+l vì cùng chữ có thể ở nhiều bài.
  const pending = allWords.filter(w => !w.hanviet || !String(w.hanviet).trim());
  let batches = 0, done = 0, errors = 0;
  const errorSamples = [];

  for (let i = 0; i < pending.length; i += HANVIET_BATCH_SIZE) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    const batch = pending.slice(i, i + HANVIET_BATCH_SIZE);
    try {
      const wordList = batch.map((w, idx) => `${idx + 1}. ${w.hz} (${w.py}) = ${w.vi}`).join('\n');
      const prompt = `Bạn là chuyên gia Hán Nôm, thông thạo Từ điển Hán Nôm/Thiều Chửu, dạy tiếng Trung cho người Việt. Với MỖI từ tiếng Trung sau, hãy cho biết ÂM HÁN VIỆT CHUẨN, ĐÚNG VÀ PHỔ BIẾN NHẤT của từ đó — viết hoa chữ cái đầu, các chữ còn lại viết thường, cách nhau bằng dấu cách.

QUY TẮC BẮT BUỘC (rất quan trọng, nhiều lỗi xảy ra vì bỏ qua các quy tắc này):
1. ƯU TIÊN CAO NHẤT: nếu CẢ TỪ (không phải từng chữ riêng lẻ) đã có sẵn 1 cách đọc Hán Việt chuẩn, quen thuộc, được ghi nhận rộng rãi trong từ điển Hán Việt/Hán Nôm (vd trên hvdic.thivien.net, Thiều Chửu) hoặc trong tiếng Việt hàng ngày, thì PHẢI dùng đúng cách đọc đó của cả từ, TUYỆT ĐỐI KHÔNG tự ghép âm phổ biến của từng chữ riêng lẻ lại. Ví dụ kinh điển: chữ 你 tự nó có 2 âm (nhĩ, nễ), nhưng từ "你好" đã có sẵn cách đọc chuẩn ghi trong từ điển là "Nhĩ hảo" — PHẢI trả lời "Nhĩ hảo", KHÔNG được trả lời "Nễ hảo" dù "nễ" cũng là 1 âm hợp lệ của chữ 你 khi đứng riêng.
2. Khi 1 chữ Hán có NHIỀU âm Hán Việt khác nhau và từ ghép đó KHÔNG có sẵn cách đọc chuẩn quen thuộc, hãy chọn âm được dùng NHIỀU NHẤT, PHỔ BIẾN NHẤT trong tiếng Việt hiện đại (âm xuất hiện trong các từ Hán Việt quen thuộc hàng ngày) — TUYỆT ĐỐI tránh âm cổ, âm hiếm, âm địa phương, âm ít người biết đến.
3. Ví dụ khác cho chuẩn xác: "学习"→"Học tập", "老师"→"Lão sư", "中国"→"Trung Quốc" (viết hoa cả 2 vì là danh từ riêng), "谢谢"→"Tạ tạ", "什么"→"Thập ma".
4. Nếu thực sự không tìm được âm Hán Việt hợp lý cho 1 chữ trong từ (rất hiếm gặp, thường chỉ với chữ giản thể/phương ngữ đặc biệt), vẫn cố gắng cho âm gần đúng nhất theo bộ thủ/thành phần biểu âm của chữ đó, không được bỏ trống.
5. Trước khi trả lời mỗi từ, tự kiểm tra lại trong đầu: "Đây có phải cách đọc mà người học tiếng Trung/Hán Nôm ở Việt Nam thường thấy nhất không?" — nếu không chắc, chọn phương án phổ biến, an toàn hơn.

Danh sách từ (giữ đúng số thứ tự):
${wordList}
Trả lời CHỈ bằng JSON hợp lệ, đúng thứ tự, đúng định dạng, không thêm chữ nào khác:
{"items":[{"n":1,"hv":"âm Hán Việt"}]}`;
      const text = await callGemini(prompt);
      const data = parseAiJson(text);
      if (!Array.isArray(data.items)) {
        errors++;
        addErrorSample(errorSamples, 'Phản hồi AI không đúng định dạng JSON mong đợi (thiếu mảng "items")');
        continue;
      }
      const toUpdate = [];
      for (const item of data.items) {
        const idx = (item.n | 0) - 1;
        const w = batch[idx];
        if (!w || !item.hv || !String(item.hv).trim()) continue;
        toUpdate.push({ hz: w.hz, l: w.l, hanviet: String(item.hv).trim() });
      }
      if (toUpdate.length) {
        const updated = await updateVocabHanviet(toUpdate);
        done += updated;
      }
      batches++;
    } catch (e) {
      errors++;
      addErrorSample(errorSamples, (e && e.message) || 'Lỗi không rõ');
    }
  }
  return { batches, done, errors, totalPending: pending.length, errorSamples };
}

async function runHanziPartsGeneration(timeBudgetMs) {
  const startedAt = Date.now();
  const TIME_BUDGET_MS = timeBudgetMs || 50000;
  const allWords = await getAllVocabWords();
  const charSet = extractUniqueChars(allWords);
  const existing = await getHanziPartsKeys();
  const pending = [...charSet].filter(ch => !existing.has(ch)).sort();
  let batches = 0, done = 0, errors = 0;
  const errorSamples = []; // vài lỗi mẫu (không lặp lại thông điệp) để hiện chi tiết cho admin xem

  for (let i = 0; i < pending.length; i += HANZI_BATCH_SIZE) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    const batch = pending.slice(i, i + HANZI_BATCH_SIZE);
    try {
      const prompt = `Bạn là chuyên gia chữ Hán dạy người Việt. Với MỖI chữ Hán sau, hãy phân tích thành các bộ phận cấu tạo (bộ thủ/thành phần) nếu tách được rõ ràng, giải thích ngắn gọn bằng tiếng Việt ý nghĩa/gợi nhớ từng phần để giúp ghi nhớ mặt chữ. Nếu chữ là nét/hình cơ bản không tách được, chỉ viết 1 ghi chú ngắn.
Danh sách chữ: ${batch.join(' ')}
Trả lời CHỈ bằng JSON hợp lệ, đúng thứ tự các chữ đã cho, đúng định dạng:
{"chars":[{"hz":"chữ","type":"parts","items":[{"c":"thành phần","m":"ý nghĩa/gợi nhớ ngắn"}]}, {"hz":"chữ khác","type":"note","text":"ghi chú ngắn"}]}`;
      const text = await callGemini(prompt);
      const data = parseAiJson(text);
      if (!Array.isArray(data.chars)) {
        errors++;
        addErrorSample(errorSamples, 'Phản hồi AI không đúng định dạng JSON mong đợi (thiếu mảng "chars")');
        continue;
      }
      const toInsert = [];
      for (const item of data.chars) {
        if (!item.hz || !batch.includes(item.hz)) continue;
        if (item.type === 'parts' && Array.isArray(item.items) && item.items.length) {
          const items = item.items.filter(x => x && x.c && x.m);
          if (items.length) toInsert.push({ hz: item.hz, parts: { type: 'parts', items } });
        } else if (item.type === 'note' && item.text) {
          toInsert.push({ hz: item.hz, parts: { type: 'note', text: item.text } });
        }
      }
      if (toInsert.length) { await insertHanziParts(toInsert); done += toInsert.length; }
      batches++;
    } catch (e) {
      errors++;
      addErrorSample(errorSamples, (e && e.message) || 'Lỗi không rõ');
    }
  }
  return { batches, done, errors, totalPending: pending.length, errorSamples };
}

async function runWordExampleGeneration(timeBudgetMs) {
  const startedAt = Date.now();
  const TIME_BUDGET_MS = timeBudgetMs || 50000;
  const allWords = await getAllVocabWords();
  const existing = await getWordExampleCounts();
  // Bỏ qua từ đã đủ ví dụ, xử lý theo đúng thứ tự bài rồi tới thứ tự từ trong bài
  const pending = allWords.filter(w => (existing[w.hz + '-' + w.l] || 0) < TARGET_EXAMPLES_PER_WORD);
  let batches = 0, wordsDone = 0, wordsRetried = 0, errors = 0;
  const errorSamples = []; // vài lỗi mẫu (không lặp lại thông điệp) để hiện chi tiết cho admin xem

  for (let i = 0; i < pending.length; i += WORD_BATCH_SIZE) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    const batch = pending.slice(i, i + WORD_BATCH_SIZE);
    try {
      const wordList = batch.map(w => `${w.hz} (${w.py}) = ${w.vi}`).join('; ');
      const prompt = `Bạn là giáo viên tiếng Trung cho người Việt mới học. Với MỖI từ trong danh sách sau, hãy soạn ${TARGET_EXAMPLES_PER_WORD} câu ví dụ tiếng Trung khác nhau, đơn giản, ngắn gọn — mỗi câu BẮT BUỘC phải chứa đúng chữ Hán của từ đó (không được bỏ sót), kèm nghĩa tiếng Việt của câu ví dụ đó.
Danh sách từ (giữ đúng thứ tự): ${wordList}
Trả lời CHỈ bằng JSON hợp lệ, đúng định dạng, đúng thứ tự các từ đã cho, không thêm chữ nào khác:
{"words":[{"hz":"chữ Hán của từ","examples":[{"zh":"câu ví dụ tiếng Trung","vi":"nghĩa câu ví dụ"}]}]}`;
      const text = await callGemini(prompt);
      const data = parseAiJson(text);
      if (!Array.isArray(data.words)) {
        errors++;
        addErrorSample(errorSamples, 'Phản hồi AI không đúng định dạng JSON mong đợi (thiếu mảng "words")');
        continue;
      }
      for (const item of data.words) {
        const w = batch.find(b => b.hz === item.hz);
        if (!w || !Array.isArray(item.examples)) continue;
        // Chỉ giữ lại câu THỰC SỰ chứa đúng chữ Hán — đảm bảo tính đúng đắn, không tin mù AI
        const valid = item.examples.filter(e => e && e.zh && e.vi && e.zh.includes(w.hz)).slice(0, TARGET_EXAMPLES_PER_WORD);
        if (valid.length > 0) {
          await insertWordExamples(w.hz, w.l, valid);
          if (valid.length >= TARGET_EXAMPLES_PER_WORD) wordsDone++; else wordsRetried++;
        } else {
          wordsRetried++;
        }
      }
      batches++;
    } catch (e) {
      errors++;
      addErrorSample(errorSamples, (e && e.message) || 'Lỗi không rõ');
    }
  }
  return { batches, wordsDone, wordsRetried, errors, totalPending: pending.length, errorSamples };
}

// ── [AI] Chấm điểm phát âm — người dùng ghi âm đọc 1 từ, AI nghe và đánh giá thanh điệu/phát âm ──
app.post('/api/pronunciation/grade', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  try {
    const { hz, py, vi, audio, mimeType } = req.body || {};
    if (!hz || !audio) return res.json({ ok: false, error: 'Thiếu dữ liệu ghi âm' });
    if (audio.length > 4 * 1024 * 1024) return res.json({ ok: false, error: 'File ghi âm quá dài' });
    const prompt = `Bạn là giáo viên tiếng Trung chấm phát âm cho người Việt mới học.
Từ cần đọc: ${hz} (pinyin chuẩn: ${py || 'không rõ'}, nghĩa: ${vi || 'không rõ'}).
Hãy nghe đoạn ghi âm đính kèm và đánh giá:
- Người học có đọc đúng chữ Hán trên không (âm đầu, âm cuối)?
- Thanh điệu (dấu giọng) có đúng không? Nếu sai, sai thành thanh mấy?
- Cho điểm 0-10.
- Viết 1 nhận xét ngắn gọn, khích lệ, bằng tiếng Việt, chỉ rõ cụ thể cần sửa gì (nếu có).
Trả lời CHỈ bằng JSON hợp lệ, không thêm chữ nào khác, đúng định dạng:
{"score": 8, "toneOk": true, "heardAs": "mô tả ngắn âm nghe được (có thể để trống nếu nghe rõ đúng)", "comment": "nhận xét ngắn gọn"}`;
    const text = await callGeminiWithAudio(prompt, audio, mimeType || 'audio/webm');
    const data = parseAiJson(text);
    res.json({ ok: true, result: data });
  } catch (e) {
    res.json({ ok: false, error: 'Không chấm được phát âm: ' + e.message });
  }
});

// ── [ADMIN] Tiến độ sinh nghĩa Hán Việt ──
app.get('/api/admin/hanviet/progress', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireAdmin(authed.db.users[authed.username], res)) return;
  try {
    const allWords = await getAllVocabWords();
    const total = allWords.length;
    const done = allWords.filter(w => w.hanviet && String(w.hanviet).trim()).length;
    res.json({ ok: true, total, done });
  } catch (e) { fail(res, e); }
});

// ── [ADMIN] Kích hoạt thủ công việc sinh nghĩa Hán Việt ──
app.post('/api/admin/generate-hanviet', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireAdmin(authed.db.users[authed.username], res)) return;
  try {
    const result = await runHanVietGeneration(50000);
    const actingUser = authed.db.users[authed.username];
    const errText = result.errorSamples && result.errorSamples.length ? ` — Lỗi mẫu: ${result.errorSamples.join(' | ')}` : '';
    logActivity(authed.username, actingUser.role, 'vocab',
      `Chạy sinh nghĩa Hán Việt: ${result.done} từ xong${result.errors ? `, ${result.errors} lỗi` : ''}${errText}`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Lấy toàn bộ chiết tự bộ thủ đã có (dữ liệu nhỏ gọn, gửi hết 1 lần, không cần lọc theo bài) ──
app.get('/api/hanzi-parts', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  try {
    const rows = await getAllHanziParts();
    res.set('Cache-Control', 'private, max-age=120');
    res.json({ ok: true, parts: rows });
  } catch (e) { fail(res, e); }
});

// ── [ADMIN] Tiến độ sinh chiết tự bộ thủ ──
app.get('/api/admin/hanzi-parts/progress', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireAdmin(authed.db.users[authed.username], res)) return;
  try {
    const allWords = await getAllVocabWords();
    const charSet = extractUniqueChars(allWords);
    const existing = await getHanziPartsKeys();
    const done = [...charSet].filter(c => existing.has(c)).length;
    res.json({ ok: true, total: charSet.size, done });
  } catch (e) { fail(res, e); }
});

// ── [ADMIN] Kích hoạt thủ công việc sinh chiết tự bộ thủ ──
app.post('/api/admin/generate-hanzi-parts', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireAdmin(authed.db.users[authed.username], res)) return;
  try {
    const result = await runHanziPartsGeneration(50000);
    const actingUser = authed.db.users[authed.username];
    const errText = result.errorSamples && result.errorSamples.length ? ` — Lỗi mẫu: ${result.errorSamples.join(' | ')}` : '';
    logActivity(authed.username, actingUser.role, 'vocab',
      `Chạy sinh chiết tự bộ thủ: ${result.done} chữ xong${result.errors ? `, ${result.errors} lỗi` : ''}${errText}`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Lấy toàn bộ ví dụ theo từ cho các bài đang học — dùng để minh hoạ từng câu hỏi trong Trắc nghiệm
//     (mỗi từ có thể có vài ví dụ, client tự chọn ngẫu nhiên 1 câu để hiện) ──
app.get('/api/word-examples', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  try {
    const raw = String(req.query.lessons || '').trim();
    if (!raw) return res.json({ ok: true, examples: [] });
    const lessons = raw.split(',').map(s => parseInt(s, 10)).filter(Number.isFinite);
    const examples = await getWordExamplesForLessons(lessons);
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ ok: true, examples });
  } catch (e) { fail(res, e); }
});

// ── [ADMIN] Tiến độ sinh ví dụ theo từ — bao nhiêu từ đã đủ ví dụ / tổng số từ ──
app.get('/api/admin/word-examples/progress', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireAdmin(authed.db.users[authed.username], res)) return;
  try {
    const allWords = await getAllVocabWords();
    const counts = await getWordExampleCounts();
    const total = allWords.length;
    const done = allWords.filter(w => (counts[w.hz + '-' + w.l] || 0) >= TARGET_EXAMPLES_PER_WORD).length;
    res.json({ ok: true, total, done });
  } catch (e) { fail(res, e); }
});

// ── [ADMIN] Kích hoạt thủ công việc sinh ví dụ theo từ (giống nút "Chạy ngay" của câu luyện dịch) ──
app.post('/api/admin/generate-word-examples', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireAdmin(authed.db.users[authed.username], res)) return;
  try {
    const result = await runWordExampleGeneration(50000);
    const actingUser = authed.db.users[authed.username];
    const errText = result.errorSamples && result.errorSamples.length ? ` — Lỗi mẫu: ${result.errorSamples.join(' | ')}` : '';
    logActivity(authed.username, actingUser.role, 'vocab',
      `Chạy sinh ví dụ theo từ: ${result.wordsDone} từ xong, ${result.wordsRetried} cần thử lại${result.errors ? `, ${result.errors} lỗi` : ''}${errText}`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── [CRON — Vercel TỰ ĐỘNG gọi nhiều lần/ngày] Chạy GỘP cả 2 việc trong cùng 1 lượt: ưu tiên sinh
//     ví dụ theo từ trước (quan trọng hơn, đảm bảo phủ hết từng từ), phần thời gian còn lại mới
//     dùng cho câu luyện dịch theo bài. Đây là endpoint mà vercel.json trỏ lịch chạy tới. ──
app.get('/api/cron/generate-daily', async (req, res) => {
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }
  const overallStart = Date.now();
  const TOTAL_BUDGET_MS = 50000;
  try {
    // Thứ tự ưu tiên: (1) NGHĨA HÁN VIỆT trước (rẻ, nhanh, nhiều người cần nhất), rồi tới (2) CHIẾT TỰ
    // BỘ THỦ, cuối cùng mới (3) VÍ DỤ THEO TỪ — mỗi việc chạy cho tới khi xong hẳn (có thể mất nhiều
    // lượt cron liên tiếp) rồi mới sang việc tiếp theo, không chạy xen kẽ nhiều việc cùng lúc.
    const hanvietResult = await runHanVietGeneration(TOTAL_BUDGET_MS);
    const hanvietStillPending = hanvietResult.totalPending - hanvietResult.done;
    let hanziResult = { batches: 0, done: 0, errors: 0, totalPending: 0, errorSamples: [] };
    let wordResult = { batches: 0, wordsDone: 0, wordsRetried: 0, errors: 0, totalPending: 0, errorSamples: [] };
    let remaining = TOTAL_BUDGET_MS - (Date.now() - overallStart);
    if (hanvietStillPending <= 0 && remaining > 5000) {
      hanziResult = await runHanziPartsGeneration(remaining);
      const hanziStillPending = hanziResult.totalPending - hanziResult.done;
      remaining = TOTAL_BUDGET_MS - (Date.now() - overallStart);
      // Chỉ đụng tới ví dụ theo từ khi chiết tự đã KHÔNG CÒN chữ nào cần xử lý
      if (hanziStillPending <= 0 && remaining > 5000) {
        wordResult = await runWordExampleGeneration(remaining);
      }
    }
    const allErrSamples = [...(hanvietResult.errorSamples || []), ...(wordResult.errorSamples || []), ...(hanziResult.errorSamples || [])];
    const errText = allErrSamples.length ? ` — Lỗi mẫu: ${allErrSamples.join(' | ')}` : '';
    logActivity(null, 'system', 'system',
      `[Tự động - cron] Hán Việt: ${hanvietResult.done} từ xong; Sinh ví dụ: ${wordResult.wordsDone} từ xong, ${wordResult.wordsRetried} cần thử lại; Chiết tự: ${hanziResult.done} chữ xong${errText}`);
    res.json({ ok: true, hanviet: hanvietResult, wordExamples: wordResult, hanziParts: hanziResult });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Bắt lỗi chung ──
app.use((err, req, res, next) => {
  if (err && (err.type === 'request.aborted' || err.message === 'request aborted')) {
    console.error('⚠️  Request bị ngắt giữa chừng — bỏ qua.');
    return;
  }
  console.error('⚠️  Lỗi server:', err && err.message);
  if (!res.headersSent) res.status(500).json({ ok: false, error: 'Lỗi server nội bộ' });
});

// Chạy độc lập khi phát triển ở máy local (KHÔNG chạy khi ở trên Vercel)
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ Server đang chạy tại http://localhost:${PORT}`);
    if (!process.env.DATABASE_URL) console.log('   ⚠️  Chưa đặt DATABASE_URL');
    if (!process.env.GEMINI_API_KEY) console.log('   ⚠️  Chưa đặt GEMINI_API_KEY');
  });
}

module.exports = app;
