#!/usr/bin/env node
'use strict';

/**
 * حارس أسماء الوصول (‏OBS-166 · OBS-167 · OBS-176) — ساكن بلا Electron.
 *
 * العلّة المقيسة: كل زر أيقوني في القشرة واللوحات كان يعتمد `title` وحده، فاسمه
 * المحسوب هو الإيموجي نفسه (‏`button "📁"` في لقطة الوصولية). و`title` سمة تلميح لا
 * اسم: الاسم المحسوب يأخذها آخر المصادر وحدها، والقارئ قد ينطق «زر» فقط.
 *
 * يمشي هذا الحارس على `src/index.html` و`src/ui/components/*.js` (نصّاً — فيشمل
 * قوالب Shadow DOM النصية التي لا تراها أي لقطة بنيوية) ويفرض ثلاث قواعد:
 *
 *   ١. كل `<button …>…</button>` نصّه المرئي **رمزيّ** (بلا حرف عربي ولا لاتيني)
 *      يجب أن يحمل `aria-label` غير فارغ.
 *   ٢. كل `<select>` و`<input>` في `index.html` (عدا المخفي) يملك `<label for>`
 *      يشير إلى `id` موجود، أو `aria-label`. وكل `<label for>` يشير إلى `id` موجود.
 *   ٣. كل `div`/`span` يحمل `aria-label` يملك `role` (وإلّا أسقط محرّك الوصولية
 *      السمة عن عنصر `generic`).
 *
 * ⚠️ **حدود مُصرَّح بها — تُذكر ولا يُدّعى خلافها**:
 *   - الفحص ساكن على النصّ: زرٌّ يُبنى بـ`createElement` ويُملأ نصّه من متغيّر لا
 *     يراه هذا الحارس أصلاً، وكذلك زرّ في القالب نصّه كلّه `${…}` (يُعدّ ويُطبع في
 *     الخاتمة تحت «غير مفحوصة» فلا يُقرأ الصمت نجاحاً).
 *   - `aria-label="${…}"` يُقبل بوجوده لا بقيمته — القيمة تُحسب وقت التشغيل.
 *   - القاعدة ٢ محصورة بـ`index.html` بقرار الدفعة؛ حقول المكوّنات خارج نطاقها.
 *   - هذا حارس **بنية** لا حارس نطق: أنّ قارئ شاشة حقيقياً (‏Narrator) ينطق الاسم
 *     المضاف لم يُختبر هنا ولا يُدّعى.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML_FILE = path.join(ROOT, 'src', 'index.html');
const COMPONENTS_DIR = path.join(ROOT, 'src', 'ui', 'components');

// الحرف العربي بنطاقاته الأربعة (كما في مسبار القياس) والحرف اللاتيني
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN_RE = /[A-Za-z]/;

const BUTTON_RE = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
const GENERIC_RE = /<(div|span)\b([^>]*)>/gi;
const FIELD_RE = /<(select|input)\b([^>]*)>/gi;
const LABEL_FOR_RE = /<label\b[^>]*\bfor\s*=\s*"([^"]*)"/gi;
const ID_RE = /\bid\s*=\s*"([^"]*)"/gi;

const problems = [];
const stats = { buttons: 0, symbolic: 0, textual: 0, unchecked: 0, fields: 0, generics: 0 };
// الأزرار التي لم يرها الفحص (نصّها ديناميكي أو فارغ) — تُطبع لا تُبتلع
const unchecked = [];

function relOf(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === '\n') line += 1;
  return line;
}

/** قيمة سمة من نصّ وسم الفتح — تقبل التنصيص المزدوج والمفرد. */
function attrValue(attrs, name) {
  const re = new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i');
  const match = attrs.match(re);
  if (!match) return null;
  return match[2] != null ? match[2] : match[3];
}

function hasAttr(attrs, name) {
  return new RegExp('\\b' + name + '\\b', 'i').test(attrs);
}

/**
 * النصّ المرئي الثابت داخل الزر: بلا وسوم داخلية، ولا تعليقات، ولا تعابير `${…}`.
 * ما يبقى هو ما يراه المستخدم فعلاً في كل الحالات.
 */
function staticText(inner) {
  return inner
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\$\{[^}]*\}/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .trim();
}

/** القاعدة ١: زر نصّه رمزي يجب أن يحمل aria-label غير فارغ. */
function checkButtons(source, rel) {
  let match;
  BUTTON_RE.lastIndex = 0;
  while ((match = BUTTON_RE.exec(source)) !== null) {
    stats.buttons += 1;
    const attrs = match[1];
    const text = staticText(match[2]);
    const line = lineOf(source, match.index);
    if (!text) {
      stats.unchecked += 1;
      unchecked.push(rel + ':' + line);
      continue;
    }
    if (ARABIC_RE.test(text) || LATIN_RE.test(text)) { stats.textual += 1; continue; }
    stats.symbolic += 1;
    const label = attrValue(attrs, 'aria-label');
    if (label == null || !label.trim()) {
      problems.push(rel + ':' + line + ' — زر رمزي «' + text + '» بلا aria-label عربي. '
        + 'سمة title تلميح لا اسم؛ أضف aria-label بالمعنى لا بترجمة الرمز.');
    }
  }
}

/** القاعدة ٢: حقول index.html لها تسمية، وكل label for يشير إلى id موجود. */
function checkFields(source, rel) {
  const ids = new Set();
  let match;
  ID_RE.lastIndex = 0;
  while ((match = ID_RE.exec(source)) !== null) ids.add(match[1]);

  const labelled = new Set();
  LABEL_FOR_RE.lastIndex = 0;
  while ((match = LABEL_FOR_RE.exec(source)) !== null) {
    const target = match[1];
    labelled.add(target);
    if (!ids.has(target)) {
      problems.push(rel + ':' + lineOf(source, match.index) + ' — <label for="' + target
        + '"> يشير إلى معرّف غير موجود في الملف.');
    }
  }

  FIELD_RE.lastIndex = 0;
  while ((match = FIELD_RE.exec(source)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    // المخفي لا يُعرض للمستخدم ولا لشجرة الوصولية
    if (hasAttr(attrs, 'hidden') || (attrValue(attrs, 'type') || '').toLowerCase() === 'hidden') continue;
    stats.fields += 1;
    const id = attrValue(attrs, 'id');
    const label = attrValue(attrs, 'aria-label');
    const labelledBy = attrValue(attrs, 'aria-labelledby');
    if ((label && label.trim()) || (labelledBy && labelledBy.trim())) continue;
    if (id && labelled.has(id)) continue;
    problems.push(rel + ':' + lineOf(source, match.index) + ' — <' + tag + (id ? ' id="' + id + '"' : '')
      + '> بلا <label for> ولا aria-label.');
  }
}

/** القاعدة ٣: aria-label على div/span بلا role يسقطه محرّك الوصولية. */
function checkGenerics(source, rel) {
  let match;
  GENERIC_RE.lastIndex = 0;
  while ((match = GENERIC_RE.exec(source)) !== null) {
    const attrs = match[2];
    const label = attrValue(attrs, 'aria-label');
    if (label == null || !label.trim()) continue;
    stats.generics += 1;
    const role = attrValue(attrs, 'role');
    if (role == null || !role.trim()) {
      problems.push(rel + ':' + lineOf(source, match.index) + ' — <' + match[1] + ' aria-label="'
        + label + '"> بلا role؛ العنصر generic فتُسقط السمة.');
    }
  }
}

function main() {
  const files = [HTML_FILE];
  for (const entry of fs.readdirSync(COMPONENTS_DIR)) {
    if (entry.endsWith('.js')) files.push(path.join(COMPONENTS_DIR, entry));
  }

  for (const file of files) {
    const rel = relOf(file);
    const source = fs.readFileSync(file, 'utf8');
    checkButtons(source, rel);
    checkGenerics(source, rel);
    if (file === HTML_FILE) checkFields(source, rel);
  }

  if (problems.length) {
    for (const problem of problems) console.error('✗ ' + problem);
    throw new Error('a11y-names: ' + problems.length + ' عنصر بلا اسم وصولي');
  }

  console.log('✓ ' + stats.symbolic + ' زراً رمزياً يحمل aria-label عربياً (من ' + stats.buttons
    + ' زراً في ' + files.length + ' ملفاً؛ ' + stats.textual + ' اسمها نصّها المرئي)');
  console.log('✓ ' + stats.fields + ' حقلاً في index.html له <label for> أو aria-label، ولا label يتيم');
  console.log('✓ ' + stats.generics + ' عنصر div/span يحمل aria-label ومعه role');
  console.log('ℹ غير مفحوصة (نصّها ديناميكي أو يُملأ وقت التشغيل): ' + stats.unchecked
    + (unchecked.length ? ' — ' + unchecked.slice(0, 6).join('، ')
      + (unchecked.length > 6 ? ' و' + (unchecked.length - 6) + ' غيرها' : '') : ''));
  console.log('a11y-names: نجح — لا زر رمزي ولا حقل ولا حاوية موسومة بلا اسم وصولي.');
}

try { main(); } catch (error) {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
}
