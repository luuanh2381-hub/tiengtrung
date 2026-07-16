// ════════════════════════════════════════════════════
// SERVER — App học từ vựng tiếng Trung (bản deploy Vercel)
// Đăng ký / đăng nhập / lưu tiến độ theo tài khoản.
// Dữ liệu lưu trong Postgres (xem lib/db.js) thay vì file JSON,
// vì Vercel không giữ file lâu dài giữa các lần chạy.
// ════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { readDB, updateDB, getVocabByLessons, getVocabCounts, importVocab, clearVocab, deleteVocabLesson,
  replaceLessonSentences, getPracticeSentences, getPracticeSentenceById, getPracticeSentenceCounts,
  getAllVocabWords, getWordExampleCounts, insertWordExamples, getWordExamplesForLessons } = require('../lib/db');

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

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function fail(res, e, fallbackMsg) {
  console.error('⚠️  Lỗi:', e && e.message);
  res.status(500).json({ ok: false, error: fallbackMsg || ('Lỗi server: ' + (e && e.message)) });
}

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
    if (!user) return res.json({ ok: false, error: 'Tài khoản không tồn tại' });
    const match = await bcrypt.compare(String(password), user.passwordHash);
    if (!match) return res.json({ ok: false, error: 'Sai mật khẩu' });
    const token = makeToken();
    const result = await updateDB((db2) => {
      const u = db2.users[key];
      if (!u.role) u.role = 'user';
      db2.tokens[token] = key;
      const progress = u.progress || emptyProgress();
      const known = countKnown(progress);
      return { ok: true, token, username: u.username, role: u.role, progress, rank: getRank(known) };
    });
    res.json(result);
  } catch (e) { fail(res, e); }
});

// ── Đăng xuất ──
app.post('/api/logout', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  try {
    await updateDB((db) => { delete db.tokens[authed.token]; });
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
      } : { lastTab: 'home', selectedBookIds: [1], selectedLessons: [], lessonsAllMode: true };
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
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
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
    res.json({ ok: true, vocab });
  } catch (e) { fail(res, e); }
});

// ── Đếm nhanh số từ theo từng bài (payload rất nhỏ, không chứa dữ liệu nhạy cảm) — để hiện số từ
//     ở màn chọn Quyển/level mà không cần tải cả nội dung. Công khai, không cần đăng nhập. ──
app.get('/api/vocab/counts', async (req, res) => {
  try {
    const counts = await getVocabCounts();
    res.json({ ok: true, counts });
  } catch (e) { fail(res, e); }
});

// ── [ADMIN] Đếm số câu luyện dịch đã được AI sinh sẵn theo từng bài — để theo dõi tiến độ ──
app.get('/api/admin/practice-sentences/counts', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireAdmin(authed.db.users[authed.username], res)) return;
  try {
    const counts = await getPracticeSentenceCounts();
    res.json({ ok: true, counts });
  } catch (e) { fail(res, e); }
});

// ── Lấy 1 lô câu đã sinh sẵn (kèm đáp án tiếng Trung) cho các bài đang học — dùng để tìm câu ví dụ
//     chứa đúng từ đang được hỏi trong phần Trắc nghiệm, không cần gọi AI ──
app.get('/api/practice-sentences', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  try {
    const raw = String(req.query.lessons || '').trim();
    if (!raw) return res.json({ ok: true, sentences: [] });
    const lessons = raw.split(',').map(s => parseInt(s, 10)).filter(Number.isFinite);
    const sentences = await getPracticeSentences(lessons, 200);
    res.json({ ok: true, sentences: sentences.map(s => ({ vi: s.vi, answer: s.answer })) });
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
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ════════════════════════════════════════════════════
// AI DỊCH — Sinh câu luyện dịch & chấm bài bằng Google Gemini (free tier)
// Cần đặt biến môi trường GEMINI_API_KEY (lấy tại https://aistudio.google.com/apikey)
// ════════════════════════════════════════════════════
const https = require('https');
// 'gemini-flash-latest' luôn trỏ tới bản Gemini Flash mới nhất còn được hỗ trợ,
// tránh phải sửa code mỗi khi Google đổi/khai tử model.
const GEMINI_MODEL = 'gemini-flash-latest';

function callGemini(prompt) {
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

function parseAiJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// ── [AI] Sinh bài tập dịch câu — ƯU TIÊN lấy câu đã sinh sẵn hàng ngày (nhanh, không tốn quota AI),
//     chỉ gọi AI trực tiếp khi bài học đó chưa có câu nào được sinh sẵn (vd Quyển 1/2) ──
app.post('/api/ai/exercise', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  try {
    const { words, count, lessons } = req.body || {};
    const n = Math.min(Math.max(parseInt(count) || 5, 1), 10);

    if (Array.isArray(lessons) && lessons.length) {
      const cleanLessons = lessons.map(l => parseInt(l, 10)).filter(Number.isFinite);
      const cached = await getPracticeSentences(cleanLessons, n);
      if (cached.length > 0) {
        return res.json({
          ok: true,
          source: 'cached',
          sentences: cached.map(s => ({ id: s.id, vi: s.vi, hint: s.hint })),
        });
      }
    }

    // Không có câu sinh sẵn (thường là Quyển 1/2, hoặc bài mới chưa tới lượt sinh) -> sinh trực tiếp như trước
    if (!Array.isArray(words) || words.length === 0) {
      return res.json({ ok: false, error: 'Thiếu danh sách từ vựng' });
    }
    const vocabList = words.slice(0, 60).map(w => `${w.hz} (${w.py}) = ${w.vi}`).join('; ');
    const prompt = `Bạn là giáo viên tiếng Trung cho người Việt mới học. Đây là danh sách từ vựng học viên ĐÃ HỌC: ${vocabList}.
Hãy soạn ${n} câu tiếng Việt đơn giản, tự nhiên, chỉ dùng ngữ pháp cơ bản (câu ngắn, không dùng thành ngữ khó), để học viên dịch sang tiếng Trung. Mỗi câu CHỈ được dùng các từ trong danh sách trên (có thể thêm số từ, đại từ, trợ từ ngữ pháp cơ bản như 的/吗/了 nếu cần diễn đạt đúng).
Trả lời CHỈ bằng JSON hợp lệ, không thêm chữ nào khác, đúng định dạng:
{"sentences":[{"vi":"câu tiếng Việt","hint":"gợi ý ngắn gọn 3-5 chữ Hán then chốt nên dùng"}]}`;
    const text = await callGemini(prompt);
    const data = parseAiJson(text);
    if (!Array.isArray(data.sentences)) throw new Error('Định dạng AI trả về không hợp lệ');
    res.json({ ok: true, source: 'live', sentences: data.sentences });
  } catch (e) {
    res.json({ ok: false, error: 'Không sinh được bài tập: ' + e.message });
  }
});

// So khớp câu dịch của học viên với đáp án mẫu theo ký tự (không gọi AI) — dùng thuật toán
// "chuỗi con chung dài nhất" (LCS) để vẫn tính điểm hợp lý ngay cả khi sai thứ tự 1 phần.
function selfGradeAnswer(refAnswer, studentAnswer) {
  const strip = (s) => String(s || '').replace(/[，。！？、,.!?\s]/g, '');
  const ref = strip(refAnswer);
  const stu = strip(studentAnswer);
  const m = ref.length, n = stu.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = ref[i-1] === stu[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }
  const lcs = dp[m][n];
  const similarity = (m + n) === 0 ? 1 : (2 * lcs) / (m + n);
  const score = Math.max(0, Math.min(10, Math.round(similarity * 10)));

  const refSet = new Set(ref.split(''));
  const stuSet = new Set(stu.split(''));
  const missing = [...refSet].filter(c => !stuSet.has(c));
  const extra = [...stuSet].filter(c => !refSet.has(c));
  const errors = [];
  if (stu !== ref) {
    if (missing.length) errors.push(`Thiếu chữ: ${missing.join('、')}`);
    if (extra.length) errors.push(`Có chữ chưa đúng/thừa: ${extra.join('、')}`);
    if (!missing.length && !extra.length) errors.push('Dùng đúng các chữ nhưng có thể sai thứ tự — kiểm tra lại trật tự từ trong câu.');
  }
  let comment;
  if (stu === ref) comment = 'Chính xác tuyệt đối! 🎉';
  else if (score >= 8) comment = 'Rất tốt, chỉ còn vài chỗ nhỏ cần chỉnh lại.';
  else if (score >= 5) comment = 'Đã đúng hướng, xem lại các chữ còn thiếu/sai nhé.';
  else comment = 'Cần luyện tập thêm — so sánh kỹ với câu đáp án mẫu bên dưới.';
  return { score, correction: refAnswer, errors, comment };
}

// ── [AI] Chấm bài dịch của học viên ──
// Nếu câu hỏi lấy từ kho câu sinh sẵn (có sentenceId) -> tự chấm bằng so khớp ký tự, không gọi AI (nhanh, miễn phí).
// Nếu là câu sinh trực tiếp (không có sentenceId) -> vẫn nhờ AI chấm như trước (hiểu ngữ nghĩa linh hoạt hơn).
app.post('/api/ai/grade', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  try {
    const { vietnamese, answer, sentenceId } = req.body || {};
    if (!answer) return res.json({ ok: false, error: 'Thiếu bài làm' });
    if (String(answer).length > 300) return res.json({ ok: false, error: 'Bài làm quá dài' });

    if (sentenceId) {
      const sentence = await getPracticeSentenceById(parseInt(sentenceId, 10));
      if (!sentence) return res.json({ ok: false, error: 'Không tìm thấy câu hỏi này (có thể đã được sinh lại)' });
      const result = selfGradeAnswer(sentence.answer, answer);
      return res.json({ ok: true, result, source: 'self' });
    }

    if (!vietnamese) return res.json({ ok: false, error: 'Thiếu câu đề' });
    const prompt = `Bạn là giáo viên tiếng Trung chấm bài cho người Việt mới học (trình độ sơ cấp).
Câu tiếng Việt cần dịch: "${vietnamese}"
Bài dịch tiếng Trung của học viên: "${answer}"
Hãy chấm điểm trên thang 0-10, chỉ ra lỗi cụ thể (sai từ, sai ngữ pháp, thiếu/thừa chữ, sai thứ tự), đưa ra 1 câu dịch đúng tham khảo, và 1 lời nhận xét ngắn gọn khích lệ bằng tiếng Việt.
Trả lời CHỈ bằng JSON hợp lệ, không thêm chữ nào khác, đúng định dạng:
{"score": 8, "correction": "câu tiếng Trung đúng", "errors": ["mô tả lỗi 1", "mô tả lỗi 2"], "comment": "nhận xét ngắn gọn"}
Nếu bài làm đã đúng hoàn toàn thì "errors" là mảng rỗng [].`;
    const text = await callGemini(prompt);
    const data = parseAiJson(text);
    res.json({ ok: true, result: data, source: 'live' });
  } catch (e) {
    res.json({ ok: false, error: 'Không chấm được bài: ' + e.message });
  }
});

// ── [CRON — Vercel tự gọi hàng ngày] Sinh sẵn câu luyện dịch cho các bài có từ vựng trong database ──
// Bảo vệ bằng CRON_SECRET: đặt biến môi trường CRON_SECRET trên Vercel, Vercel sẽ tự đính kèm
// header Authorization: Bearer <CRON_SECRET> khi gọi endpoint này theo lịch trong vercel.json.
// Logic dùng chung: sinh câu luyện dịch cho các bài đang thiếu câu nhất — gọi từ cron TỰ ĐỘNG
// hàng ngày lẫn nút "Chạy ngay" thủ công trong trang Quản trị.
async function runSentenceGeneration(timeBudgetMs) {
  const startedAt = Date.now();
  const TIME_BUDGET_MS = timeBudgetMs || 50000; // dừng an toàn trước khi Vercel timeout, phần còn lại sẽ được xử lý ở lượt chạy kế tiếp
  const SENTENCES_PER_LESSON = 8;
  const results = [];
  const counts = await getVocabCounts();
  const existingCounts = await getPracticeSentenceCounts();
  // Xử lý theo ĐÚNG THỨ TỰ SỐ BÀI tăng dần (Bài 1, 2, 3...), bỏ qua bài đã có câu sẵn rồi
  // (để không sinh lại tốn quota AI vô ích) — chạy nhiều lần sẽ tự tiếp tục từ bài còn thiếu tiếp theo.
  const lessons = Object.keys(counts)
    .map(k => parseInt(k, 10))
    .filter(l => (counts[l] || 0) >= 5) // cần tối thiểu vài từ mới soạn được câu có nghĩa
    .filter(l => !((existingCounts[l] || 0) > 0)) // bỏ qua bài đã có câu rồi
    .sort((a, b) => a - b);

  for (const lesson of lessons) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { results.push({ lesson: null, note: 'Hết thời gian, các bài còn lại sẽ được xử lý ở lần chạy sau' }); break; }
    try {
      const words = await getVocabByLessons([lesson]);
      if (words.length < 5) continue;
      const vocabList = words.slice(0, 60).map(w => `${w.hz} (${w.py}) = ${w.vi}`).join('; ');
      const prompt = `Bạn là giáo viên tiếng Trung cho người Việt mới học. Đây là từ vựng của 1 bài học: ${vocabList}.
Hãy soạn ${SENTENCES_PER_LESSON} câu tiếng Việt đơn giản, tự nhiên, chỉ dùng ngữ pháp cơ bản, để học viên dịch sang tiếng Trung. Mỗi câu CHỈ dùng các từ trong danh sách trên (có thể thêm số từ, đại từ, trợ từ ngữ pháp cơ bản như 的/吗/了 nếu cần). Kèm theo đáp án mẫu chuẩn bằng tiếng Trung cho mỗi câu.
Trả lời CHỈ bằng JSON hợp lệ, đúng định dạng:
{"sentences":[{"vi":"câu tiếng Việt","hint":"gợi ý ngắn 3-5 chữ Hán then chốt","answer":"câu dịch tiếng Trung chuẩn"}]}`;
      const text = await callGemini(prompt);
      const data = parseAiJson(text);
      if (Array.isArray(data.sentences) && data.sentences.length) {
        const saved = await replaceLessonSentences(lesson, data.sentences);
        results.push({ lesson, saved });
      } else {
        results.push({ lesson, error: 'AI không trả về câu hợp lệ' });
      }
    } catch (e) {
      results.push({ lesson, error: e.message });
    }
  }
  return results;
}

// Logic sinh ví dụ THEO TỪNG TỪ CỤ THỂ — đảm bảo mỗi từ có sẵn TARGET_EXAMPLES_PER_WORD câu ví dụ,
// mỗi câu được kiểm tra chắc chắn có chứa đúng chữ Hán của từ đó (nếu AI trả sai, câu đó bị loại,
// từ vẫn coi là "chưa xong" và sẽ được thử lại ở lượt chạy sau).
const TARGET_EXAMPLES_PER_WORD = 3;
const WORD_BATCH_SIZE = 12;
async function runWordExampleGeneration(timeBudgetMs) {
  const startedAt = Date.now();
  const TIME_BUDGET_MS = timeBudgetMs || 50000;
  const allWords = await getAllVocabWords();
  const existing = await getWordExampleCounts();
  // Bỏ qua từ đã đủ ví dụ, xử lý theo đúng thứ tự bài rồi tới thứ tự từ trong bài
  const pending = allWords.filter(w => (existing[w.hz + '-' + w.l] || 0) < TARGET_EXAMPLES_PER_WORD);
  let batches = 0, wordsDone = 0, wordsRetried = 0, errors = 0;

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
      if (!Array.isArray(data.words)) { errors++; continue; }
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
    }
  }
  return { batches, wordsDone, wordsRetried, errors, totalPending: pending.length };
}

// ── [CRON — Vercel TỰ ĐỘNG gọi hàng ngày] (endpoint cũ, chỉ sinh câu luyện dịch — giữ lại để tương thích ngược) ──
// Bảo vệ bằng CRON_SECRET: đặt biến môi trường CRON_SECRET trên Vercel, Vercel sẽ tự đính kèm
// header Authorization: Bearer <CRON_SECRET> khi gọi endpoint này theo lịch trong vercel.json.
app.get('/api/cron/generate-sentences', async (req, res) => {
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }
  try {
    const results = await runSentenceGeneration();
    res.json({ ok: true, processed: results.length, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── [ADMIN] Kích hoạt THỦ CÔNG y hệt logic cron — dùng nút "Chạy ngay" trong trang Quản trị,
//     không thay thế lịch tự động, chỉ để admin không phải đợi tới giờ cron hoặc tự gọi API tay ──
app.post('/api/admin/generate-sentences', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireAdmin(authed.db.users[authed.username], res)) return;
  try {
    const results = await runSentenceGeneration();
    res.json({ ok: true, processed: results.length, results });
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
    const wordResult = await runWordExampleGeneration(TOTAL_BUDGET_MS - 5000);
    const remaining = TOTAL_BUDGET_MS - (Date.now() - overallStart);
    let sentenceResults = [];
    if (remaining > 5000) {
      sentenceResults = await runSentenceGeneration(remaining);
    }
    res.json({
      ok: true,
      wordExamples: wordResult,
      sentences: { processed: sentenceResults.length, results: sentenceResults },
    });
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
