// ════════════════════════════════════════════════════
// SERVER — App học từ vựng tiếng Trung (bản deploy Vercel)
// Đăng ký / đăng nhập / lưu tiến độ theo tài khoản.
// Dữ liệu lưu trong Postgres (xem lib/db.js) thay vì file JSON,
// vì Vercel không giữ file lâu dài giữa các lần chạy.
// ════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { readDB, updateDB } = require('../lib/db');

const app = express();

process.on('uncaughtException', (err) => {
  console.error('⚠️  [uncaughtException]:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('⚠️  [unhandledRejection]:', err && err.message);
});

function emptyProgress() {
  return { srs: {}, streak: 0, lastDate: null };
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

app.use(express.json({ limit: '3mb' }));

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
  const { srs, streak, lastDate } = req.body || {};
  try {
    const rank = await updateDB((db) => {
      db.users[authed.username].progress = {
        srs: (srs && typeof srs === 'object') ? srs : {},
        streak: typeof streak === 'number' ? streak : 0,
        lastDate: lastDate || null,
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

// ── Lấy danh sách từ vựng được admin thêm thêm (ngoài bộ từ có sẵn) ──
app.get('/api/vocab', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  res.json({ ok: true, vocab: authed.db.vocab || [] });
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
    const result = await updateDB((db) => {
      const index = new Map();
      for (const w of db.vocab) index.set(w.hz + '-' + w.l, w);
      let added = 0, updated = 0, skipped = 0, invalid = 0;
      for (const raw of words) {
        const hz = String(raw.hz || '').trim();
        const py = String(raw.py || '').trim();
        const vi = String(raw.vi || '').trim();
        const l = parseInt(raw.l, 10);
        if (!hz || !vi || !Number.isFinite(l) || l < 1) { invalid++; continue; }
        const key = hz + '-' + l;
        const existing = index.get(key);
        if (existing) {
          if (overwrite) { existing.py = py; existing.vi = vi; updated++; }
          else { skipped++; }
          continue;
        }
        const entry = { hz, py, vi, l };
        db.vocab.push(entry);
        index.set(key, entry);
        added++;
      }
      return { added, updated, skipped, invalid, total: db.vocab.length };
    });
    res.json({ ok: true, ...result });
  } catch (e) { fail(res, e); }
});

// ── [ADMIN] Xoá toàn bộ từ vựng đã thêm qua Excel/thủ công (không đụng tới 781 từ có sẵn của app) ──
app.post('/api/admin/vocab/clear', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  if (!requireAdmin(authed.db.users[authed.username], res)) return;
  try {
    const result = await updateDB((db) => {
      const removed = db.vocab.length;
      db.vocab = [];
      return { removed };
    });
    res.json({ ok: true, ...result });
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

// ── [AI] Sinh bài tập dịch câu ──
app.post('/api/ai/exercise', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  try {
    const { words, count } = req.body || {};
    if (!Array.isArray(words) || words.length === 0) {
      return res.json({ ok: false, error: 'Thiếu danh sách từ vựng' });
    }
    const n = Math.min(Math.max(parseInt(count) || 5, 1), 10);
    const vocabList = words.slice(0, 60).map(w => `${w.hz} (${w.py}) = ${w.vi}`).join('; ');
    const prompt = `Bạn là giáo viên tiếng Trung cho người Việt mới học. Đây là danh sách từ vựng học viên ĐÃ HỌC: ${vocabList}.
Hãy soạn ${n} câu tiếng Việt đơn giản, tự nhiên, chỉ dùng ngữ pháp cơ bản (câu ngắn, không dùng thành ngữ khó), để học viên dịch sang tiếng Trung. Mỗi câu CHỈ được dùng các từ trong danh sách trên (có thể thêm số từ, đại từ, trợ từ ngữ pháp cơ bản như 的/吗/了 nếu cần diễn đạt đúng).
Trả lời CHỈ bằng JSON hợp lệ, không thêm chữ nào khác, đúng định dạng:
{"sentences":[{"vi":"câu tiếng Việt","hint":"gợi ý ngắn gọn 3-5 chữ Hán then chốt nên dùng"}]}`;
    const text = await callGemini(prompt);
    const data = parseAiJson(text);
    if (!Array.isArray(data.sentences)) throw new Error('Định dạng AI trả về không hợp lệ');
    res.json({ ok: true, sentences: data.sentences });
  } catch (e) {
    res.json({ ok: false, error: 'Không sinh được bài tập: ' + e.message });
  }
});

// ── [AI] Chấm bài dịch của học viên ──
app.post('/api/ai/grade', async (req, res) => {
  const authed = await requireAuth(req, res);
  if (!authed) return;
  try {
    const { vietnamese, answer } = req.body || {};
    if (!vietnamese || !answer) return res.json({ ok: false, error: 'Thiếu câu đề hoặc bài làm' });
    if (String(answer).length > 300) return res.json({ ok: false, error: 'Bài làm quá dài' });
    const prompt = `Bạn là giáo viên tiếng Trung chấm bài cho người Việt mới học (trình độ sơ cấp).
Câu tiếng Việt cần dịch: "${vietnamese}"
Bài dịch tiếng Trung của học viên: "${answer}"
Hãy chấm điểm trên thang 0-10, chỉ ra lỗi cụ thể (sai từ, sai ngữ pháp, thiếu/thừa chữ, sai thứ tự), đưa ra 1 câu dịch đúng tham khảo, và 1 lời nhận xét ngắn gọn khích lệ bằng tiếng Việt.
Trả lời CHỈ bằng JSON hợp lệ, không thêm chữ nào khác, đúng định dạng:
{"score": 8, "correction": "câu tiếng Trung đúng", "errors": ["mô tả lỗi 1", "mô tả lỗi 2"], "comment": "nhận xét ngắn gọn"}
Nếu bài làm đã đúng hoàn toàn thì "errors" là mảng rỗng [].`;
    const text = await callGemini(prompt);
    const data = parseAiJson(text);
    res.json({ ok: true, result: data });
  } catch (e) {
    res.json({ ok: false, error: 'Không chấm được bài: ' + e.message });
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
