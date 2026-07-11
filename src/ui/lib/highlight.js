// تظليل كود بسيط (الدفعة 4.3) — وحدة مشتركة منذ تفكيك ت-5 (قُدّم استخراجها من ت-7
// لأن بطاقة الفرق diff.js تحتاج قائمة امتدادات الكود لقرار الاتجاه).
// مميّز رموز يدوي صغير بلا اعتماديات (قاعدة 5): تعليقات/نصوص/كلمات مفتاحية/أرقام.
// الهدف وضوح القراءة لا دقة مُصرّف — الحالات النادرة (regex literals، نصوص
// متعددة الأسطر…) تتدهور لنص عادي بأمان. البناء بعناصر DOM لا innerHTML (CSP وأمان).
const HL_KEYWORDS = {
  clike: new Set(('abstract async await break case catch class const continue debugger default delete do else enum export extends extern false finally for from function get if implements import in instanceof interface let new null of package private protected public return set static struct super switch this throw true try typeof undefined var void while with yield').split(' ')),
  py: new Set(('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self').split(' ')),
};
// إعداد لكل لغة: k مجموعة كلمات، lc تعليق سطري، bo/bc تعليق كتلي، str محارف الاقتباس
const HL_CLIKE = { k: 'clike', lc: '//', bo: '/*', bc: '*/', str: '"\'`' };
const HL_HASH = { lc: '#', str: '"\'' };
export const HL_CFG = {
  js: HL_CLIKE, mjs: HL_CLIKE, cjs: HL_CLIKE, ts: HL_CLIKE, jsx: HL_CLIKE, tsx: HL_CLIKE,
  c: HL_CLIKE, h: HL_CLIKE, cpp: HL_CLIKE, hpp: HL_CLIKE, cs: HL_CLIKE, java: HL_CLIKE,
  go: HL_CLIKE, rs: HL_CLIKE, kt: HL_CLIKE, swift: HL_CLIKE,
  json: { k: 'clike', str: '"' }, // true/false/null من مجموعة clike
  py: { k: 'py', lc: '#', str: '"\'' }, rb: { k: 'py', lc: '#', str: '"\'' },
  sh: HL_HASH, bash: HL_HASH, zsh: HL_HASH,
  yml: HL_HASH, yaml: HL_HASH, toml: HL_HASH, ini: HL_HASH, conf: HL_HASH, env: HL_HASH,
  ps1: { lc: '#', bo: '<#', bc: '#>', str: '"\'' },
  css: { bo: '/*', bc: '*/', str: '"\'' },
  html: { bo: '<!--', bc: '-->', str: '"\'' }, htm: { bo: '<!--', bc: '-->', str: '"\'' },
  xml: { bo: '<!--', bc: '-->', str: '"\'' }, svg: { bo: '<!--', bc: '-->', str: '"\'' },
  sql: { lc: '--', bo: '/*', bc: '*/', str: "'" },
};
function hlSpan(cls, text) { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; }
// مقطع كود عادي: تلوين الكلمات المفتاحية والأرقام فقط، والباقي نص خام
function hlCode(el, text, kw) {
  const re = /[A-Za-z_$][\w$]*|\d[\w.]*/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const w = m[0];
    if (/^\d/.test(w)) el.appendChild(hlSpan('hl-n', w));
    else if (kw && kw.has(w)) el.appendChild(hlSpan('hl-k', w));
    else el.appendChild(document.createTextNode(w));
    last = m.index + w.length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}
// سطر واحد؛ st.block يحمل تعليقاً كتلياً مفتوحاً عبر الأسطر
export function hlLine(el, line, cfg, st) {
  if (line.length > 2000) { el.textContent = line; return; } // سطر عملاق (minified) — بلا تظليل
  const kw = cfg.k ? HL_KEYWORDS[cfg.k] : null;
  let i = 0;
  while (i < line.length) {
    if (st.block) {
      const end = line.indexOf(cfg.bc, i);
      if (end === -1) { el.appendChild(hlSpan('hl-c', line.slice(i))); return; }
      el.appendChild(hlSpan('hl-c', line.slice(i, end + cfg.bc.length)));
      i = end + cfg.bc.length; st.block = false; continue;
    }
    // أقرب حدث خاص بعد i: تعليق سطري / تعليق كتلي / بداية نص مقتبس
    const cand = [];
    if (cfg.lc) { const p = line.indexOf(cfg.lc, i); if (p !== -1) cand.push([p, 'lc']); }
    if (cfg.bo) { const p = line.indexOf(cfg.bo, i); if (p !== -1) cand.push([p, 'bo']); }
    if (cfg.str) for (const q of cfg.str) { const p = line.indexOf(q, i); if (p !== -1) cand.push([p, q]); }
    if (!cand.length) { hlCode(el, line.slice(i), kw); return; }
    cand.sort((a, b) => a[0] - b[0]);
    const next = cand[0][0], kind = cand[0][1];
    if (next > i) hlCode(el, line.slice(i, next), kw);
    if (kind === 'lc') { el.appendChild(hlSpan('hl-c', line.slice(next))); return; }
    if (kind === 'bo') {
      const end = line.indexOf(cfg.bc, next + cfg.bo.length);
      if (end === -1) { el.appendChild(hlSpan('hl-c', line.slice(next))); st.block = true; return; }
      el.appendChild(hlSpan('hl-c', line.slice(next, end + cfg.bc.length)));
      i = end + cfg.bc.length; continue;
    }
    // نص مقتبس: القفل نفس المحرف مع تجاوز \ الهروب؛ بلا قفل ⇐ لنهاية السطر
    let j = next + 1;
    while (j < line.length && line[j] !== kind) j += (line[j] === '\\' ? 2 : 1);
    const end = j < line.length ? j + 1 : line.length;
    el.appendChild(hlSpan('hl-s', line.slice(next, end)));
    i = end;
  }
}
