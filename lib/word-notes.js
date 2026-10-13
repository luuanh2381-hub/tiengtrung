// lib/word-notes.js — "Mẹo nhớ của bạn": ghi chú liên tưởng RIÊNG của từng người học cho từng từ (V105).
// Khoá: user_id TEXT (username) + word_id INT (vocab_words.id) — kiểu đã xác minh từ schema thật.
// Đây là NỘI DUNG do người học tự viết, không phải tiến độ học: "Reset tiến độ" KHÔNG xoá ghi chú;
// chỉ XOÁ TÀI KHOẢN mới xoá (xem db.js, nhánh alsoDeleteAnalytics). Xoá từ vựng → CASCADE.
'use strict';

const MAX_NOTE_LEN = 200;
const MAX_NOTES_PER_LIST = 5000;
let notesReady = null;

function getPool() { return require('./db').getPool(); } // lazy: tránh vòng require

async function ensureNotesTable(client) {
  if (notesReady) return notesReady;
  notesReady = (async () => {
    try {
      const dbm = require('./db');
      await dbm.ensureVocabTable(client);
      await client.query(`
        CREATE TABLE IF NOT EXISTS word_notes (
          user_id TEXT NOT NULL,
          word_id INT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
          note TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, word_id)
        )`);
      return true;
    } catch (e) { notesReady = null; throw e; }
  })();
  return notesReady;
}

// Trả về { ok:true, note } (note '' = xoá) hoặc { ok:false, error }.
function sanitizeNote(raw) {
  if (raw == null) return { ok: true, note: '' };
  if (typeof raw !== 'string') return { ok: false, error: 'Ghi chú phải là văn bản' };
  const note = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if ([...note].length > MAX_NOTE_LEN) return { ok: false, error: `Ghi chú tối đa ${MAX_NOTE_LEN} ký tự` };
  return { ok: true, note };
}

async function listNotes(userId) {
  const client = await getPool().connect();
  try {
    await ensureNotesTable(client);
    const r = await client.query(
      `SELECT v.hz, n.note FROM word_notes n JOIN vocab_words v ON v.id = n.word_id
        WHERE n.user_id = $1 ORDER BY n.updated_at DESC LIMIT $2`,
      [userId, MAX_NOTES_PER_LIST]
    );
    return r.rows;
  } finally { client.release(); }
}

async function setNote(userId, hz, rawNote) {
  const s = sanitizeNote(rawNote);
  if (!s.ok) return s;
  if (typeof hz !== 'string' || !hz || hz.length > 40) return { ok: false, error: 'Thiếu từ vựng hợp lệ' };
  const { resolveCanonicalWordId } = require('./db');
  const client = await getPool().connect();
  try {
    await ensureNotesTable(client);
    const wordId = await resolveCanonicalWordId(client, hz);
    if (wordId == null) return { ok: false, error: 'Không tìm thấy từ vựng' };
    if (s.note === '') {
      await client.query('DELETE FROM word_notes WHERE user_id = $1 AND word_id = $2', [userId, wordId]);
    } else {
      await client.query(
        `INSERT INTO word_notes (user_id, word_id, note) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, word_id) DO UPDATE SET note = EXCLUDED.note, updated_at = now()`,
        [userId, wordId, s.note]
      );
    }
    return { ok: true, note: s.note };
  } finally { client.release(); }
}

async function deleteUserNotesTx(client, userId) {
  await ensureNotesTable(client);
  await client.query('DELETE FROM word_notes WHERE user_id = $1', [userId]);
}

module.exports = { MAX_NOTE_LEN, sanitizeNote, ensureNotesTable, listNotes, setNote, deleteUserNotesTx };
