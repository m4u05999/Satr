/**
 * حارس نظام التصميم (docs/DESIGN-SYSTEM.md) — يمنع انتهاكات جديدة دون كسر القائم الموثّق.
 *
 * يفحص أوراق مكوّنات الواجهة (src/ui) وindex.html:
 * 1. ألوان صلبة (hex/rgb/rgba) خارج tokens — القاعدة الحاكمة: كل لون عبر var(--…)
 *    (شرط عمل الوضعين الفاتح/الداكن معاً).
 * 2. z-index رقمية خارج سلّم --z-* في المكوّنات وbase.css.
 * 3. سمات style=/on*= المضمّنة في index.html (محظورة بـ CSP).
 *
 * baseline صريح بالأسباب: الانتهاكات القائمة الموثّقة مثبّتة بالملف والعدد؛ أي زيادة
 * تفشل (انتهاك جديد)، وأي نقص يفشل أيضاً برسالة «حدّث baseline» (تشديد تدريجي يمنع
 * عودة ما أُصلح). حدّ موثّق: base.css نفسه خارج فحص الألوان — كتل تعريف tokens فيه
 * هي مصدر القيم الصلبة الشرعي الوحيد.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ملفات معفاة من فحص الألوان كلياً — بقرار موثّق في CLAUDE.md
const COLOR_FILE_EXEMPT = new Map([
  // لوحة ANSI/xterm صلبة عمداً: سطحا الكود يبقيان داكنين دائماً والثيمة لا تقلبهما
  ['src/ui/components/terminal-panel.js', 'ANSI/xterm palette — قرار موثّق'],
]);

// baseline الألوان الصلبة القائمة: ملف → عدد الأسطر المطابقة المسموح (لا زيادة ولا نقص صامت)
const COLOR_BASELINE = new Map([
  // سطر 518: مقارنة قيمة getComputedStyle وقت التشغيل — ليست تنسيقاً
  ['src/ui/components/preview-panel.js', 1],
]);

// baseline قيم z-index الرقمية القائمة (خارج var(--z-*)): ملف → عدد
const ZINDEX_BASELINE = new Map([
  // termResizer (5) وطبقة BiDi (2): تراتب محلي دقيق داخل الطرفية — لا يُرحَّل عمياء
  ['src/styles/base.css', 2],
]);

// hex بأطوال CSS الشرعية فقط (3/8/6/4) — يستبعد أرقام مثل ‎#31873 في التعليقات
const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-fA-F])/;
const RGB_RE = /rgba?\(/;
const ZINDEX_RE = /z-index:\s*\d/;
// التصريح كاملاً ثم عدّ قيم px داخله — ملاحظة مراجعة Codex: فحص بداية القيمة وحدها
// يُمرّر خطأً shorthand مثل «var(--radius-md) 11px». قيمتا 0 و50% مشروعتان (محايد/دائرة)
const RADIUS_DECL_RE = /border-radius:\s*([^;}{]*)/g;
const RADIUS_PX_RE = /\d+(?:\.\d+)?px/g;

// baseline قيم px المتبقية داخل تصريحات border-radius (بعد المرحلتين أ+ب من دفعة
// «سلّم الزوايا»): زوايا هوية فقاعتَي المحادثة وحدها — قرار مالك لا تُقرَّب
// (لمسها يغيّر شخصية الفقاعة). النقص يطالب بتحديث baseline
const RADIUS_BASELINE = new Map([
  // فقاعة المساعد 3px 14px 14px 3px (أربع قيم) + فقاعة المستخدم 3px (قيمة واحدة)
  ['src/styles/base.css', 5],
]);

// عدّ قيم px داخل كل تصريحات border-radius في الملف (تعليقات // منزوعة سلفاً)
function countRadiusPx(file) {
  const hits = [];
  for (const { line, number } of codeLines(file)) {
    let match;
    RADIUS_DECL_RE.lastIndex = 0;
    while ((match = RADIUS_DECL_RE.exec(line)) !== null) {
      const values = match[1].match(RADIUS_PX_RE) || [];
      for (let i = 0; i < values.length; i++) hits.push(number);
    }
  }
  return hits;
}

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function relOf(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

// أسطر الملف بلا تعليقات // — تمنع مطابقة أرقام إصدار أو أمثلة داخل الشرح
function codeLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((line, index) => ({ line: line.replace(/\/\/.*$/, ''), number: index + 1 }));
}

// الفحص على المطابقة نفسها لا السطر: سطر يجمع z-index صلباً وvar() لخاصية أخرى
// يبقى انتهاكاً (ZINDEX_RE يطابق الرقم مباشرة؛ z-index: var(--z-…) لا يطابقه أصلاً)
function countMatches(file, regex) {
  const hits = [];
  for (const { line, number } of codeLines(file)) {
    if (regex.test(line)) hits.push(number);
  }
  return hits;
}

// يجمع كل الانتهاكات ثم يفشل دفعة واحدة — إصلاح جولة واحدة لا جولات متتالية
const problems = [];
function checkBaseline(kind, rel, hits, baseline) {
  const allowed = baseline.get(rel) || 0;
  if (hits.length > allowed) {
    problems.push(`انتهاك ${kind} جديد في ${rel} (الأسطر ${hits.join(', ')}) — استخدم tokens بدل `
      + 'القيم الصلبة، أو وثّق الاستثناء بسبب صريح في baseline هذا الحارس.');
  } else if (hits.length < allowed) {
    problems.push(`تحسّن ${kind} في ${rel}: العدد ${hits.length} أقل من baseline (${allowed}) — `
      + 'حدّث baseline في scripts/design-guard-test.js ليمنع عودة ما أُصلح.');
  }
}

function main() {
  const uiFiles = listJsFiles(path.join(ROOT, 'src', 'ui'));

  // 1. الألوان الصلبة في مكوّنات الواجهة
  for (const file of uiFiles) {
    const rel = relOf(file);
    if (COLOR_FILE_EXEMPT.has(rel)) continue;
    const hits = [];
    for (const { line, number } of codeLines(file)) {
      // rgba(var(--…)) مبنية على token فمشروعة؛ ما عداها مطابقة صلبة ولو جاور السطر var()
      const hardRgb = RGB_RE.test(line) && !/rgba?\(\s*var\(--/.test(line);
      if (HEX_RE.test(line) || hardRgb) hits.push(number);
    }
    checkBaseline('لون صلب', rel, hits, COLOR_BASELINE);
  }

  // 2. z-index الرقمية في المكوّنات وbase.css
  for (const file of [...uiFiles, path.join(ROOT, 'src', 'styles', 'base.css')]) {
    const rel = relOf(file);
    const hits = countMatches(file, ZINDEX_RE);
    checkBaseline('z-index رقمي', rel, hits, ZINDEX_BASELINE);
  }

  // 2ب. قيم px داخل تصريحات border-radius خارج سلّم --radius-* (نفس نطاق z-index)
  for (const file of [...uiFiles, path.join(ROOT, 'src', 'styles', 'base.css')]) {
    const rel = relOf(file);
    const hits = countRadiusPx(file);
    checkBaseline('border-radius رقمي', rel, hits, RADIUS_BASELINE);
  }

  // 3. السمات المضمّنة في index.html (محظورة بـ CSP — القاعدة في CLAUDE.md)
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const inline = html.match(/\s(?:style|on[a-z]+)\s*=\s*["']/gi) || [];
  if (inline.length) {
    problems.push('سمات style=/on*= مضمّنة في index.html محظورة بـ CSP — استخدم CSSOM وaddEventListener.');
  }

  if (problems.length) {
    for (const problem of problems) console.error('✗ ' + problem);
    throw new Error('design-guard: ' + problems.length + ' انتهاك/انحراف baseline');
  }
  console.log('✓ لا ألوان صلبة جديدة خارج tokens في src/ui');
  console.log('✓ لا z-index رقمية جديدة خارج سلّم --z-*');
  console.log('✓ لا border-radius رقمية جديدة خارج سلّم --radius-*');
  console.log('✓ لا سمات مضمّنة في index.html');
  console.log('design-guard: نجح — tokens وسلّم z-index وCSP بلا انتهاكات جديدة.');
}

try { main(); } catch (error) {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
}
