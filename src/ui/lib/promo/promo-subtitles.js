// الترجمة على الشاشة من نص التعليق نفسه، بلا تعرّف على الكلام. دوال نقية تُختبر بـnode.
// النص يُقسَّم إلى مقاطع قصيرة، ويُوزَّع الزمن عليها بنسبة عدد حروفها بعد استبعاد التشكيل.

export const MAX_VOICEOVER = 2000;
export const SAFE_AREAS = Object.freeze({
  '9:16': Object.freeze({ top: 0.14, bottom: 0.20 }),   // سناب / تيك توك / ريلز
  '1:1': Object.freeze({ top: 0.06, bottom: 0.06 }),    // إنستقرام مربع
  '16:9': Object.freeze({ top: 0.06, bottom: 0.08 }),   // يوتيوب / X عرضي
});

export function safeArea(aspect) {
  return SAFE_AREAS[aspect] || SAFE_AREAS['16:9'];
}

// التشكيل والتطويل وعلامات الاتجاه لا تُنطق، فلا تدخل في وزن المقطع.
const SILENT = /[ؐ-ًؚ-ٰٟۖ-ۭـ‌-‏‪-‮⁦-⁩]/g;

export function spokenLength(text) {
  return String(text || '').replace(SILENT, '').replace(/[\s.,،؛:!?؟\-—–()«»"']/g, '').length;
}

// يقسم النص إلى مقاطع عرض: عند علامات الوقف أولاً، ثم كل maxWords كلمة.
export function splitCues(text, maxWords = 7) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_VOICEOVER);
  if (!clean) return [];
  const cues = [];
  for (const sentence of clean.split(/(?<=[.!?؟؛،,])\s+/)) {
    const words = sentence.split(' ').filter(Boolean);
    for (let i = 0; i < words.length; i += maxWords) {
      // لا نترك كلمة يتيمة في آخر مقطع: تُلحق بما قبلها.
      const end = words.length - (i + maxWords) === 1 ? words.length : i + maxWords;
      cues.push(words.slice(i, end).join(' '));
      if (end === words.length) break;
    }
  }
  return cues;
}

// [{ start_ms, end_ms, text }] تغطي [0, durationMs] بلا فجوات.
export function subtitleCues(text, durationMs, maxWords = 7) {
  const parts = splitCues(text, maxWords);
  if (!parts.length || !(durationMs > 0)) return [];
  const weights = parts.map((part) => Math.max(1, spokenLength(part)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const cues = [];
  let cursor = 0, accumulated = 0;
  parts.forEach((part, index) => {
    accumulated += weights[index];
    const end = index === parts.length - 1 ? durationMs : Math.round(durationMs * accumulated / total);
    cues.push({ start_ms: cursor, end_ms: end, text: part });
    cursor = end;
  });
  return cues;
}

export function cueAt(cues, tMs) {
  if (!Array.isArray(cues)) return null;
  for (const cue of cues) if (tMs >= cue.start_ms && tMs < cue.end_ms) return cue;
  return null;
}
