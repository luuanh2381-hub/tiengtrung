// js/distractor-engine.js — V86: HEAVY DISTRACTOR ENGINE dùng CHUNG cho MỌI mode có
// multiple-choice (Chọn đáp án/Review, Trắc nghiệm, Nghe — và bất kỳ mode tương lai nào có
// target → nhiều options). Gõ chữ (type.js) và Flashcard thuần (flashcard.js) không có options
// nên không dùng file này.
//
// NGUYÊN TẮC:
//   - KHÔNG random đáp án sai. 100% ưu tiên ứng viên "khó phân biệt nhất" với target theo
//     scoreDistractor() bên dưới, sort giảm dần, lấy top N — CHỈ shuffle VỊ TRÍ sau khi đã chọn
//     xong (KHÔNG shuffle rồi mới lọc — thứ tự chọn luôn ưu tiên điểm cao nhất trước).
//   - HARD ≠ AMBIGUOUS: không bao giờ chọn 1 ứng viên có thể bị hiểu là "cũng đúng" theo đúng
//     field đang dùng để chấm đáp án (xem `answerField` + guard chống mơ hồ trong
//     pickHeavyDistractors). Cùng nghĩa hệt câu hỏi (đồng nghĩa hoàn toàn) bị LOẠI HẲN khỏi pool
//     khi field chấm là "vi" — không chỉ hạ điểm.
//   - KHÔNG gọi API/mạng, KHÔNG query DB riêng cho từng câu — chỉ dùng dữ liệu đã có sẵn ở client
//     (WORDS, CONFUSE_GROUPS/SEMANTIC_GROUPS đã kiểm chứng thủ công, dbHanziParts/HANZI_PARTS đã
//     tải sẵn 1 lần lúc mở app). Với vài nghìn từ vựng, quét thẳng (O(pool)) mỗi câu là đủ nhanh
//     (không cần thêm chỉ mục phụ) — xem ghi chú PERFORMANCE trong yêu cầu V86.
//   - KHÔNG đụng tới FSRS: file này chỉ quyết định QUESTION → OPTIONS. Sau khi user chọn, toàn bộ
//     flow rating/reviewService/FSRS ở các file gọi vào đây giữ nguyên 100% như trước.
// ════════════════════════════════════════════════════

// ────────────────────────────────────────────────────
// 1) NHÓM DỄ NHẦM ĐÃ KIỂM CHỨNG THỦ CÔNG — tín hiệu tin cậy nhất (đưa lên hàng đầu khi chấm điểm)
// ────────────────────────────────────────────────────

// Nhóm từ theo chủ đề ngữ nghĩa (cùng phạm trù dễ gây nhầm lẫn khi học, dù chữ Hán không liên quan)
// (chuyển từ quiz.js sang đây vì giờ dùng chung cho cả Nghe — trước đây chỉ Trắc nghiệm/Review dùng)
const SEMANTIC_GROUPS = [
  ['白','白色','黑','红','绿','蓝'],
  ['东边','西边','南边','北边','里边','外边','上边','下边','前边','后边','左边','右边','中间','里'],
  ['星期一','星期二','星期三','星期四','星期五','星期六','星期天','星期'],
  ['爸爸','妈妈','哥哥','姐姐','弟弟','妹妹'],
  ['一','二','三','四','五','六','七','八','九','十','百','千','万','零'],
  ['人民币','美元','港币','日元','欧元'],
  ['早上','上午','中午','下午','晚上','早','晚'],
  ['今天','明天','昨天','今年','去年','明年','后年'],
  ['中国','中文','英国','英文','美国','法国','法文','德国','德语','韩国','韩文','日本（国）','日文','俄国','俄文','西班牙语','西班牙文','阿拉伯语','日语','英语','法语','俄语','韩国语'],
  ['个','位','本','张','支','辆','件','条','层','座','道','遍','片','斤','公斤','瓶','块'],
];
let _semanticMap = null;
function getSemanticMap() {
  if (_semanticMap) return _semanticMap;
  _semanticMap = {};
  SEMANTIC_GROUPS.forEach(g => {
    g.forEach(h => {
      if (!_semanticMap[h]) _semanticMap[h] = new Set();
      g.forEach(h2 => { if (h2 !== h) _semanticMap[h].add(h2); });
    });
  });
  return _semanticMap;
}

// Bản đồ tra nhanh: chữ Hán -> tập các chữ Hán "dễ nhầm" cùng nhóm (từ CONFUSE_GROUPS ở data.js —
// hình dạng gần nhau hoặc đồng âm, đã do người kiểm tra thủ công từng cặp)
let _confuseMap = null;
function getConfuseMap() {
  if (_confuseMap) return _confuseMap;
  _confuseMap = {};
  CONFUSE_GROUPS.forEach(g => {
    const hzs = g.chars.map(c => c.hz);
    hzs.forEach(h => {
      if (!_confuseMap[h]) _confuseMap[h] = new Set();
      hzs.forEach(h2 => { if (h2 !== h) _confuseMap[h].add(h2); });
    });
  });
  return _confuseMap;
}

// Từ nối/hư từ tiếng Việt hay lặp lại trong bản dịch — bỏ qua để so khớp ngữ nghĩa chính xác hơn
const VI_STOPWORDS = new Set(['và','là','có','của','một','rất','này','đó','với','hay','cũng','cần','cho','khi','ra','lên','xuống','trong','ngoài','trước','sau','gì','nào','thế','làm','đi','đến','ở','ạ','thì','còn','sẽ','đã','đang','bị','được','như','các','những','vì','nên','mà','nếu','nữa','chỉ','vẫn','phải','không','hoặc']);
function viTokens(vi) {
  return (vi || '').toLowerCase()
    .replace(/[()]/g, '')
    .split(/[,\/;]|\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 1 && !VI_STOPWORDS.has(t));
}
// Chuẩn hoá nghĩa tiếng Việt để so khớp ĐỒNG NHẤT (dùng cho guard chống ambiguity, không phải
// scoring) — khác viTokens() ở chỗ giữ nguyên cả cụm, chỉ chuẩn hoá khoảng trắng/hoa-thường.
function normVi(vi) {
  return (vi || '').toLowerCase().replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
}

// ────────────────────────────────────────────────────
// 2) PINYIN / THANH ĐIỆU — không cần thư viện ngoài, không gọi mạng. Vì dữ liệu `py` trong project
//    không tách âm tiết nhất quán (vd. "nǐ hǎo" có dấu cách nhưng "xièxie"/"shuìjiào" thì không —
//    xem admin.js), ta KHÔNG cố tách theo từng chữ Hán mà so cả CHUỖI pinyin sau khi bỏ dấu thanh
//    (Levenshtein) + so chuỗi thanh điệu theo đúng vị trí — đơn giản, không giả dữ liệu, tận dụng
//    đúng những gì project đã có.
// ────────────────────────────────────────────────────
const _TONE_MAP = {
  'ā':['a',1],'á':['a',2],'ǎ':['a',3],'à':['a',4],
  'ē':['e',1],'é':['e',2],'ě':['e',3],'è':['e',4],
  'ī':['i',1],'í':['i',2],'ǐ':['i',3],'ì':['i',4],
  'ō':['o',1],'ó':['o',2],'ǒ':['o',3],'ò':['o',4],
  'ū':['u',1],'ú':['u',2],'ǔ':['u',3],'ù':['u',4],
  'ǖ':['ü',1],'ǘ':['ü',2],'ǚ':['ü',3],'ǜ':['ü',4],
};
// Trả về { base: chuỗi pinyin đã bỏ dấu thanh (chỉ còn chữ cái), tones: mảng số thanh theo đúng
// thứ tự nguyên âm có dấu xuất hiện trong chuỗi }
function pyBaseAndTones(py) {
  const s = String(py || '').toLowerCase().trim();
  let base = ''; const tones = [];
  for (const ch of s) {
    const t = _TONE_MAP[ch];
    if (t) { base += t[0]; tones.push(t[1]); }
    else base += ch;
  }
  base = base.replace(/[^a-zü\s]/g, '').replace(/\s+/g, ' ').trim();
  return { base, tones };
}
function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  let prev = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    const cur = [i];
    for (let j = 1; j <= bl; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[bl];
}
// 0..1 — 1 nghĩa là phát âm giống hệt nhau khi bỏ qua thanh điệu (vd. qīng vs qíng vs qǐng)
function pinyinBaseSimilarity(pyA, pyB) {
  const a = pyBaseAndTones(pyA).base.replace(/\s+/g, '');
  const b = pyBaseAndTones(pyB).base.replace(/\s+/g, '');
  if (!a || !b) return 0;
  if (a === b) return 1;
  const dist = levenshtein(a, b);
  return Math.max(0, 1 - dist / Math.max(a.length, b.length));
}
// 0..1 — so khớp CHUỖI THANH ĐIỆU theo đúng vị trí; chỉ có ý nghĩa khi 2 từ cùng số âm tiết có dấu
function toneSequenceSimilarity(pyA, pyB) {
  const ta = pyBaseAndTones(pyA).tones, tb = pyBaseAndTones(pyB).tones;
  if (!ta.length || !tb.length || ta.length !== tb.length) return 0;
  let match = 0;
  for (let i = 0; i < ta.length; i++) if (ta[i] === tb[i]) match++;
  return match / ta.length;
}
// Các cặp thanh điệu người học hay NGHE NHẦM nhất (thanh 2 ↔ 3, thanh 1 ↔ 4) — chỉ cộng điểm khi
// 2 từ cùng số âm tiết có dấu, so theo đúng vị trí. Dùng riêng cho mode 'listening'.
const _CONFUSABLE_TONE_PAIRS = { '1': ['4'], '4': ['1'], '2': ['3'], '3': ['2'] };
function toneConfusionBonus(pyA, pyB) {
  const ta = pyBaseAndTones(pyA).tones, tb = pyBaseAndTones(pyB).tones;
  if (!ta.length || ta.length !== tb.length) return 0;
  let n = 0;
  for (let i = 0; i < ta.length; i++) {
    const a = String(ta[i]), b = String(tb[i]);
    if (a !== b && _CONFUSABLE_TONE_PAIRS[a] && _CONFUSABLE_TONE_PAIRS[a].includes(b)) n++;
  }
  return n / ta.length;
}

// ────────────────────────────────────────────────────
// 3) BỘ THỦ / COMPONENT — ưu tiên dbHanziParts (bảng hanzi_parts, AI sinh, phủ toàn bộ từ vựng,
//    đã tải 1 lần lúc mở app ở flashcard.js), fallback HANZI_PARTS tĩnh (data.js). KHÔNG gọi
//    mạng/DB ở đây — chỉ đọc lại dữ liệu đã có sẵn trong bộ nhớ.
// ────────────────────────────────────────────────────
function hanziComponentsOf(ch) {
  const dbEntry = (typeof dbHanziParts !== 'undefined') ? dbHanziParts[ch] : null;
  if (dbEntry && dbEntry.type === 'parts' && Array.isArray(dbEntry.items)) {
    return dbEntry.items.map(x => x.c).filter(Boolean);
  }
  const entry = (typeof HANZI_PARTS !== 'undefined') ? HANZI_PARTS[ch] : null;
  if (Array.isArray(entry)) return entry.map(([c]) => c).filter(Boolean);
  return [];
}
// Tập hợp toàn bộ component của mọi chữ Hán trong 1 từ (từ có thể nhiều chữ ghép lại)
function wordComponentSet(hz) {
  const set = new Set();
  for (const ch of String(hz || '')) hanziComponentsOf(ch).forEach(c => set.add(c));
  return set;
}
// Số chữ Hán NGUYÊN VẸN trùng nhau giữa 2 từ (vd. 学习 vs 学生 chung chữ 学) — không tính component
function sharedCharCount(hzA, hzB) {
  const setB = new Set([...String(hzB || '')]);
  let n = 0;
  for (const c of new Set([...String(hzA || '')])) if (setB.has(c)) n++;
  return n;
}
// Độ gần "bộ thủ/component/hình dạng" giữa 2 từ, tính theo 3 chiều:
//   a) 2 chữ cùng chứa 1 component (vd. 情/晴 cùng có 青)
//   b) 1 component của A CHÍNH LÀ 1 chữ nguyên trong B (vd. target 清 có component 青, candidate
//      chính là chữ 青 — 青 là gốc âm/hình của 清)
//   c) ngược lại (component của B là chữ nguyên trong A)
function sharedComponentCount(hzA, hzB) {
  const compA = wordComponentSet(hzA), compB = wordComponentSet(hzB);
  const charsA = new Set([...String(hzA || '')]), charsB = new Set([...String(hzB || '')]);
  let n = 0;
  for (const c of compA) { if (compB.has(c)) n++; if (charsB.has(c)) n++; }
  for (const c of charsA) if (compB.has(c)) n++;
  return n;
}

// ────────────────────────────────────────────────────
// 4) SCORING — điểm càng cao càng "khó phân biệt" với target. Thứ tự trọng số bám theo đúng
//    HEAVY DISTRACTOR RANKING trong yêu cầu V86 (cùng chữ/component > cùng bộ thủ > hình
//    dạng/component gần > pinyin/thanh điệu > cấu trúc từ > nghĩa gần nhưng không ambiguous).
//    mode: 'text' (mặc định — Chọn đáp án/Review/Trắc nghiệm) | 'listening' (tab Nghe + hướng
//    Âm→漢 của Trắc nghiệm, vì đầu bài LÀ âm thanh/pinyin nên phải ưu tiên âm đọc nặng hơn hẳn).
// ────────────────────────────────────────────────────
function scoreDistractor(target, candidate, opts = {}) {
  const mode = opts.mode || 'text';
  const thz = target.hz || '', chz = candidate.hz || '';
  let s = 0;

  // (1) Cặp dễ nhầm đã được người kiểm tra xác nhận thủ công (CONFUSE_GROUPS) — tín hiệu mạnh và
  // đáng tin nhất, luôn đẩy lên đầu bất kể mode.
  const confuseSet = getConfuseMap()[thz];
  if (confuseSet && confuseSet.has(chz)) s += 30;

  // (2) Cùng Hán tự thành phần trong từ ghép (vd. 学习 vs 学生 chung chữ 学)
  s += sharedCharCount(thz, chz) * 14;

  // (3) Cùng bộ thủ/component cấu tạo — suy ra độ gần hình dạng khi không có dữ liệu nét vẽ
  s += Math.min(sharedComponentCount(thz, chz), 4) * 6;

  // (4) Cấu trúc từ tương tự (từ đơn với từ đơn, từ ghép cùng độ dài...)
  if (chz.length === thz.length) s += 2;

  // (5) Âm đọc: pinyin gần nhau (bỏ dấu) + thanh điệu gần nhau. Mode 'listening' (Nghe, và hướng
  // Âm→漢 vì đầu bài là pinyin) ưu tiên NẶNG HƠN HẲN nhóm này — đúng yêu cầu "LISTENING ĐẶC BIỆT".
  const pySim = pinyinBaseSimilarity(target.py, candidate.py);
  const toneSim = toneSequenceSimilarity(target.py, candidate.py);
  if (mode === 'listening') {
    s += pySim * 26;
    s += toneSim * 12;
    s += toneConfusionBonus(target.py, candidate.py) * 4;
  } else {
    s += pySim * 6;
    s += toneSim * 2;
  }

  // (6) Nhóm chủ đề/ngữ nghĩa đã kiểm chứng thủ công (SEMANTIC_GROUPS)
  const semSet = getSemanticMap()[thz];
  if (semSet && semSet.has(chz)) s += 16;

  // (7) Trùng từ khoá trong nghĩa tiếng Việt — trọng số vừa phải, KHÔNG được lấn át các tín hiệu
  // hình/âm ở trên (đồng nghĩa hoàn toàn đã bị loại thẳng khỏi pool ở bước lọc, xem
  // pickHeavyDistractors — ở đây chỉ còn các cặp "gần nghĩa nhưng không trùng hệt")
  const wTokens = viTokens(target.vi), xTokens = viTokens(candidate.vi);
  const sharedTok = xTokens.filter(t => wTokens.includes(t)).length;
  s += Math.min(sharedTok, 3) * 4;

  // (8) Tín hiệu cấu trúc phụ đã có sẵn trong dữ liệu: cùng thẻ phân loại / cùng bài học
  if (target.tag && candidate.tag && target.tag === candidate.tag) s += 3;
  if (target.l != null && target.l === candidate.l) s += 1;

  return s;
}

// ────────────────────────────────────────────────────
// 5) SINH DISTRACTOR — target → pool ứng viên → lọc invalid/duplicate/ambiguous → chấm điểm →
//    sort giảm dần → lấy top N. KHÔNG shuffle ở bước này (caller tự shuffle sau khi ghép với đáp
//    án đúng — xem makeQuizOpts()/listen.js). Nếu pool không đủ N ứng viên hợp lệ, trả về ít hơn
//    (KHÔNG bịa/duplicate) — caller quyết định có mở rộng phạm vi pool hay không.
//
// opts.mode: 'text' | 'listening' (xem scoreDistractor)
// opts.answerField: 'hz' | 'vi' — field THỰC SỰ dùng để hiển thị/chấm đáp án ở UI gọi hàm này.
//   'vi' → loại các ứng viên có NGHĨA TRÙNG HỆT target (chuẩn hoá qua normVi) để tránh 2 lựa chọn
//   trông như "đều đúng" (HARD ≠ AMBIGUOUS). 'hz' → không cần chặn trùng nghĩa (nhiều từ khác nhau
//   hoàn toàn có thể cùng nghĩa tiếng Việt, không gây mơ hồ khi đáp án đang chấm là mặt chữ Hán).
// ────────────────────────────────────────────────────
function pickHeavyDistractors(target, pool, count, opts = {}) {
  const mode = opts.mode || 'text';
  const answerField = opts.answerField || 'hz';
  const targetViNorm = normVi(target.vi);

  const seenHz = new Set([target.hz]);
  const candidates = (pool || []).filter(x => {
    if (!x || !x.hz || x.hz === target.hz) return false;
    if (seenHz.has(x.hz)) return false; // khử trùng lặp CÙNG hz trong pool (vd. cùng chữ xuất hiện ở nhiều bài)
    seenHz.add(x.hz);
    if (answerField === 'vi' && normVi(x.vi) === targetViNorm) return false; // chặn ambiguous
    return true;
  });

  const scored = candidates.map(x => ({ x, s: scoreDistractor(target, x, { mode }) }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, count).map(p => p.x);
}

// ────────────────────────────────────────────────────
// 6) WRAPPER dùng chung cho quiz.js (tab Trắc nghiệm) VÀ review.js (tab "Hôm nay học" — luôn hỏi
//    hz→nghĩa, xem RV_QUIZ_TYPE trong review.js). Trước V86, 2 nơi này gọi chung `rvMakeOpts(w)`
//    không tham số và NGẦM dựa vào biến toàn cục `qzType` của quiz.js để suy đáp án đúng field
//    nào — sai khi review.js gọi (review không hề đổi qzType, chỉ ĐÚNG NHỜ TRÙNG HỢP giá trị mặc
//    định). Giờ mỗi nơi gọi truyền THẲNG answerField/mode của chính nó — không còn phụ thuộc
//    ngầm giữa 2 file.
// ────────────────────────────────────────────────────
function makeQuizOpts(w, pool, opts = {}) {
  const distractors = pickHeavyDistractors(w, pool, 3, opts);
  return shuffle([w, ...distractors]);
}
function rvMakeOpts(w, opts = {}) {
  return makeQuizOpts(w, WORDS.filter(x => isLoggedIn() || x.l <= GUEST_MAX_LESSON), opts);
}
