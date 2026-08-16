// js/audio.js — Text-to-speech (đọc chữ Hán) + hiệu ứng âm thanh đúng/sai + chấm phát âm bằng AI
// TTS / AUDIO
// ════════════════════════════════════════════════════
let ttsVoice = null;
let ttsRate = 0.65;

function initTTS() {
  const load = () => {
    const voices = speechSynthesis.getVoices();
    // Priority: female zh-CN voices
    const femaleKeywords = ['female','woman','girl','Xiaoyi','Xiaoxiao','HuiHui','Yaoyao','Tracy','Meijia','Tingting','Hanhan'];
    const zhVoices = voices.filter(v => v.lang.startsWith('zh'));
    // Try to find a female voice
    let pick = null;
    for (const kw of femaleKeywords) {
      pick = zhVoices.find(v => v.name.toLowerCase().includes(kw.toLowerCase()));
      if (pick) break;
    }
    // Fallback: any zh voice, prefer name containing 'CN'
    if (!pick) pick = zhVoices.find(v => v.lang === 'zh-CN') || zhVoices[0] || null;
    ttsVoice = pick;
    console.log('[TTS] selected voice:', ttsVoice ? ttsVoice.name : 'none', '| all zh voices:', zhVoices.map(v=>v.name));
  };
  speechSynthesis.onvoiceschanged = load;
  load();
}
initTTS();

function updateSpeed(val) {
  ttsRate = parseFloat(val);
  const el = document.getElementById('speed-val');
  if (el) el.textContent = ttsRate.toFixed(2);
  progressState.ui.ttsRate = ttsRate;
  cacheProgressLocally();
  scheduleSync(); // scheduleSync tự debounce ~700ms nên kéo thanh trượt liên tục vẫn không gửi dồn dập
}

// Split text into natural phrase chunks at Chinese punctuation + commas
function splitPhrases(text) {
  // Split at：，。！？、；— keep delimiter with preceding chunk
  const parts = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    buf += text[i];
    if ('，。！？、；…—,!?;'.includes(text[i])) {
      parts.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.filter(Boolean);
}

// Speak with natural phrasing: queue utterances with micro-pauses between chunks
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();

  const phrases = splitPhrases(text);

  // If single short word, just speak directly
  if (phrases.length <= 1) {
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = 'zh-CN';
    utt.rate = ttsRate;
    utt.pitch = 1.05;
    if (ttsVoice) utt.voice = ttsVoice;
    speechSynthesis.speak(utt);
    return;
  }

  // Queue each phrase; insert a tiny silent utterance as pause between phrases
  phrases.forEach((phrase, i) => {
    const utt = new SpeechSynthesisUtterance(phrase);
    utt.lang = 'zh-CN';
    utt.rate = ttsRate;
    utt.pitch = 1.05;
    if (ttsVoice) utt.voice = ttsVoice;
    speechSynthesis.speak(utt);

    // Insert micro-pause after each phrase except last
    if (i < phrases.length - 1) {
      const pause = new SpeechSynthesisUtterance(' ');
      pause.lang = 'zh-CN';
      pause.rate = ttsRate;
      pause.volume = 0;
      if (ttsVoice) pause.voice = ttsVoice;
      speechSynthesis.speak(pause);
    }
  });
}

const AC = new (window.AudioContext || window.webkitAudioContext || function(){})();
function playDing() {
  try {
    const o = AC.createOscillator(), g = AC.createGain();
    o.connect(g); g.connect(AC.destination);
    o.type='sine'; o.frequency.value=880;
    g.gain.setValueAtTime(.3,AC.currentTime);
    g.gain.exponentialRampToValueAtTime(.001,AC.currentTime+.4);
    o.start(); o.stop(AC.currentTime+.4);
  } catch {}
}
function playBuzz() {
  try {
    const o = AC.createOscillator(), g = AC.createGain();
    o.connect(g); g.connect(AC.destination);
    o.type='sawtooth'; o.frequency.value=140;
    g.gain.setValueAtTime(.25,AC.currentTime);
    g.gain.exponentialRampToValueAtTime(.001,AC.currentTime+.35);
    o.start(); o.stop(AC.currentTime+.35);
  } catch {}
}

// ════════════════════════════════════════════════════
