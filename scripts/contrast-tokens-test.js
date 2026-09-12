#!/usr/bin/env node
'use strict';

/**
 * حارس ساكن لتباين الرموز اللونية (‏WCAG 2.x) — بلا Electron وبلا رسم.
 *
 * يقرأ `src/styles/base.css`، يستخرج كتلة `:root` (الوضع الداكن) وكتلة
 * `html[data-theme="light"]` (الوضع الفاتح — ترث ما لم تُعِد تعريفه)، يحلّ
 * `var(--x)` داخل الوضع، ثم يحسب لمعان WCAG ونسبة التباين لجدول أزواج
 * **معلن أدناه** لكل وضع. يطبع كل زوج بقيمته وحكمه، ويسقط بعد طباعة الجميع
 * إن هبط زوج تحت عتبته.
 *
 * لماذا حارسان: هذا يحرس **قيم الرموز** في ثوانٍ داخل `SUITE` وعلى CI لينكس،
 * و`npm run ui:audit` (‏Electron، خارج الطقم) يحرس **ما يُرسم فعلاً** بعد مزج
 * الطبقات. الاثنان معاً يغلقان الفجوة التي سمحت لـOBS-169 بالبقاء.
 *
 * حدّان مُصرَّح بهما:
 *  1. لا يرى ألواناً محسوبة وقت التشغيل (‏`color-mix`، شفافية عنصر، تدرّجات)
 *     ولا مزج أكثر من طبقة واحدة فوق السطح — ذاك عمل `ui:audit`.
 *  2. لا يعرف أين يُرسم كل رمز فعلاً؛ يحرس العقد المعلن للرمز لا كل استعمال.
 *     (الرموز ذات `rgba` تُمزج فوق السطح بدالة `over` قبل القياس.)
 *
 * الاستثناءات في `EXCEPTIONS` أدناه — **لا استثناء بلا سبب مكتوب**، ولا عتبة
 * عائمة: العتبة 4.5 للنصّ العادي دائماً، و1.5 للحدود (فصل بصري لا قراءة).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CSS = path.join(ROOT, 'src', 'styles', 'base.css');

// ---------- جدول الأزواج المعلن (يُطبَّق على الوضعين) ----------
// min = 4.5 عتبة WCAG AA للنصّ العادي (كل هذه الرموز نصّية الاستعمال).
// الحدّ 1.5 للحدود: فصل طبقات لا قراءة — الأساس المعلن، لا عتبة عائمة.
const PAIRS = [
  { fg: '--text', bgs: ['--bg', '--surface', '--surface-2'], min: 4.5, note: 'نصّ أساسي' },
  { fg: '--text-dim', bgs: ['--bg', '--surface', '--surface-2'], min: 4.5, note: 'نصّ ثانوي' },
  { fg: '--text-faint', bgs: ['--bg', '--surface', '--surface-2'], min: 4.5, note: 'نصّ خافت يُقرأ (طوابع/ميتا)' },
  { fg: '--gold', bgs: ['--surface', '--surface-2', '--surface-3'], min: 4.5, note: 'ذهب نصّي (رؤوس اللوحات وأزرار الفعل)' },
  { fg: '--gold-strong', bgs: ['--surface', '--surface-2', '--surface-3'], min: 4.5, note: 'ذهب التحويم/الإبراز نصّياً' },
  { fg: '--on-gold', bgs: ['--gold', '--gold-strong'], min: 4.5, note: 'نصّ فوق سطح ذهبي (#send وأخواته)' },
  { fg: '--on-green', bgs: ['--green'], min: 4.5, note: 'نصّ فوق سطح أخضر' },
  { fg: '--ops-review-title', bgs: ['--surface-2'], min: 4.5, note: 'عنوان بطاقة المراجعة' },
  { fg: '--ops-review-alert', bgs: ['--surface-2'], min: 4.5, note: 'تنبيه بطاقة المراجعة' },
  { fg: '--border', bgs: ['--surface'], min: 1.5, note: 'حدّ — فصل بصري لا قراءة' },
];

// ---------- الاستثناءات: كل سطر بسبب مكتوب ومقيس ----------
// أي استثناء بلا سبب (أو بسبب أقصر من 20 محرفاً) يُسقط الحارس، وأي استثناء
// لا يطابق زوجاً في الجدول يُسقطه أيضاً (استثناء متعفّن).
const EXCEPTIONS = [
  {
    mode: 'light', fg: '--text-faint', bg: '--surface-2',
    reason: 'مقيس: رفع --text-faint الفاتح ليجتاز surface-2 يلزمه #66645e فيصير 1.06:1 من '
      + '--text-dim (#63605b) — أي إلغاء الدرجة الثالثة كلها. مستعملو الرمز مقيسون على --bg '
      + 'و--surface (‏4.73:1 و5.16:1)؛ الاستعمالان على surface-2 (‏#pvTaskTrace/#traceList في '
      + 'preview-panel.js و.memory:hover في memory-panel.js) عيب موضعي يُصلَح بنقلهما إلى '
      + '--text-dim في المكوّن لا برفع الرمز — مذكور كملاحظة للمالك لا منفَّذاً هنا.',
  },
];

// ---------- أدوات اللون (منسوخة من scripts/ui-audit.js عمداً) ----------
// النسخ لا الاستيراد: ui-audit.js يحمّل Electron عند require فيسقط الحارس على
// CI لينكس بلا شاشة. الدوال أربع أسطر ومعادلتها من WCAG — التكرار أرخص من التبعية.
function parseColor(str) {
  str = String(str || '').trim();
  let m = str.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = str.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}
function lum(c) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function over(fg, bg) {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  };
}
function contrast(x, y) {
  const lx = lum(x), ly = lum(y);
  return (Math.max(lx, ly) + 0.05) / (Math.min(lx, ly) + 0.05);
}
const fmt = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// ---------- استخراج كتل الرموز ----------
// مسح بعدّ الأقواس من مطلع المحدّد: الكتل في base.css متداخلة الشكل (تعليقات
// فيها أقواس) — تُنزع التعليقات أولاً كي لا تُربك العدّ.
function blockAfter(css, selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, 'تعذّر العثور على المحدّد ' + selector + ' في base.css');
  let i = css.indexOf('{', start);
  assert.ok(i >= 0, 'المحدّد ' + selector + ' بلا كتلة');
  let depth = 0;
  for (let j = i; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}') {
      depth--;
      if (depth === 0) return css.slice(i + 1, j);
    }
  }
  throw new Error('كتلة ' + selector + ' غير مغلقة');
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// تصريحات --x: value داخل كتلة (بعد نزع التعليقات)
function readTokens(block) {
  const tokens = new Map();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(block)) !== null) tokens.set(m[1], m[2].trim());
  return tokens;
}

// حلّ var(--x) داخل الوضع مع السقوط إلى الداكن (كتلة الفاتح تعيد تعريف بعض الرموز فقط)
function resolve(name, mode, base, seen) {
  seen = seen || new Set();
  assert.ok(!seen.has(name), 'دورة var() عند ' + name);
  seen.add(name);
  const raw = mode.get(name) !== undefined ? mode.get(name) : base.get(name);
  assert.ok(raw !== undefined, 'الرمز ' + name + ' غير معرَّف في base.css');
  const ref = raw.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (ref) return resolve(ref[1], mode, base, seen);
  const color = parseColor(raw);
  assert.ok(color, 'قيمة الرمز ' + name + ' ليست لوناً مفهوماً: ' + raw);
  return color;
}

function main() {
  const css = stripComments(fs.readFileSync(CSS, 'utf8'));
  const dark = readTokens(blockAfter(css, ':root'));
  const light = readTokens(blockAfter(css, 'html[data-theme="light"]'));
  const MODES = [
    { id: 'dark', label: 'الوضع الداكن (:root)', map: new Map() },
    { id: 'light', label: 'الوضع الفاتح ([data-theme=light])', map: light },
  ];

  const problems = [];

  // 1. صحّة الاستثناءات نفسها: سبب مكتوب، وزوج قائم في الجدول
  const declared = new Set();
  for (const pair of PAIRS) for (const bg of pair.bgs) declared.add(pair.fg + '|' + bg);
  const excepted = new Set();
  for (const ex of EXCEPTIONS) {
    const key = ex.mode + '|' + ex.fg + '|' + ex.bg;
    if (!ex.reason || String(ex.reason).trim().length < 20) {
      problems.push('استثناء بلا تعليل: ' + key + ' — كل استثناء يلزمه سبب مكتوب ومقيس في EXCEPTIONS.');
      continue;
    }
    if (!declared.has(ex.fg + '|' + ex.bg)) {
      problems.push('استثناء متعفّن: ' + key + ' لا يطابق زوجاً في PAIRS — احذفه أو أعد الزوج.');
      continue;
    }
    excepted.add(key);
    console.log('⊘ مستثنى [' + ex.mode + '] ' + ex.fg + ' على ' + ex.bg + ' — ' + ex.reason.split('؛')[0]);
  }

  // 2. الأزواج
  for (const mode of MODES) {
    console.log('\n' + mode.label);
    for (const pair of PAIRS) {
      for (const bgName of pair.bgs) {
        const key = mode.id + '|' + pair.fg + '|' + bgName;
        if (excepted.has(key)) continue;
        const bg = resolve(bgName, mode.map, dark);
        let fg = resolve(pair.fg, mode.map, dark);
        if (fg.a < 1) fg = over(fg, bg);
        const ratio = contrast(fg, bg);
        const ok = ratio >= pair.min;
        console.log('  ' + (ok ? '✓' : '✗') + ' ' + pair.fg + ' ' + fmt(fg) + ' على ' + bgName + ' ' + fmt(bg)
          + ' = ' + ratio.toFixed(2) + ':1 (العتبة ' + pair.min.toFixed(1) + ') — ' + pair.note);
        if (!ok) {
          problems.push('[' + mode.id + '] ' + pair.fg + ' على ' + bgName + ' = ' + ratio.toFixed(2)
            + ':1 دون العتبة ' + pair.min.toFixed(1) + ':1 — عمّق/افتح الرمز في base.css أو وثّق استثناءً بسبب.');
        }
      }
    }
  }

  if (problems.length) {
    console.error('');
    for (const problem of problems) console.error('✗ ' + problem);
    throw new Error('contrast-tokens: ' + problems.length + ' زوج/استثناء مخالف');
  }
  console.log('\ncontrast-tokens: نجح — كل أزواج الرموز المعلنة فوق عتباتها في الوضعين.');
}

try { main(); } catch (error) {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
}
