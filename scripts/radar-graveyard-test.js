#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس مقبرة الرادار (قطعي بلا شبكة).
 *
 * ما يحرسه: ألّا تدخل إلى `package.json` تبعيةٌ رفضها «رادار سطر» بسبب مكتوب
 * (‏docs/radar/state.json ← tech_watch.npm_blocklist). الرفض قرارٌ موثّق بتاريخه؛
 * دخول الحزمة بعده صامتاً يعيد فتح نقاش محسوم — والحارس يجعل الفتح صريحاً:
 * احذف الاسم من القائمة (بالتزام يشرح لماذا) قبل أن تضيف الحزمة.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'radar', 'state.json'), 'utf8'));

const blocklist = (state.tech_watch && state.tech_watch.npm_blocklist) || [];
assert(Array.isArray(blocklist) && blocklist.length > 0, 'قائمة الحظر موجودة وغير فارغة');

const declared = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {}, pkg.optionalDependencies || {});
const hits = Object.keys(declared).filter((name) => blocklist.includes(name));
assert.deepStrictEqual(hits, [], `تبعية من مقبرة الرادار دخلت package.json: ${hits.join(', ')} — احذفها من tech_watch.npm_blocklist أولاً بالتزام يشرح لماذا عاد القرار`);

const graveyard = (state.tech_watch && state.tech_watch.graveyard) || [];
for (const entry of graveyard) {
  assert(entry.name && entry.reason && entry.date, `مدخل مقبرة بلا اسم أو سبب أو تاريخ: ${JSON.stringify(entry)}`);
}

// ── حالة الأساس: العمودان اللذان يقرأهما الرادار من عندنا ─────────────────────
// الملف يحرس «حالة الرادار» لا المقبرة وحدها (اسمه أضيق من دوره — أُبقي كما هو لأنه
// معرّف فحص مسجَّل في package.json وSUITE، وتغييره يفكّ البوابة صامتاً).
//
// **لماذا هذان الفحصان**: الرادار يقرأ npm registry ولا يرى `codex --version` على جهاز
// المالك، فحقل `engines_on_owner_machine` هو العمود الوحيد الذي نملؤه نحن — وحقلٌ
// يتقادم بصمت أسوأ من غيابه لأنه يُقرأ حقيقةً. و`baseline.satr` تقادم فعلاً إلى
// إصدارين كاملين (‏2.16.15 بينما المنشور 2.16.17) قبل أن يُكتشف بالصدفة.
const baseline = state.baseline || {};
assert.strictEqual(baseline.satr, pkg.version,
  `baseline.satr في state.json (${baseline.satr}) لا يطابق package.json (${pkg.version}) — ` +
  'الرادار يقارن بهذا الرقم، فتقادمه يجعل كل مقارناته خاطئة. حدّثه في التزام الإصدار.');

const machine = baseline.engines_on_owner_machine;
assert(machine && typeof machine === 'object',
  'baseline.engines_on_owner_machine غائب — شغّل `npm run radar:baseline -- --write`.');
assert(/^\d{4}-\d{2}-\d{2}$/.test(String(machine._updated || '')),
  `engines_on_owner_machine._updated ليس تاريخاً بصيغة YYYY-MM-DD: ${machine._updated}`);
for (const key of ['codex', 'kimi-code', 'claude-code', 'node', 'npm']) {
  assert(key in machine, `engines_on_owner_machine ينقصه المفتاح ${key} — أعد تشغيل radar:baseline.`);
  const value = machine[key];
  assert(value === null || /^\d+\.\d+/.test(String(value)),
    `engines_on_owner_machine.${key} ليس رقم إصدار ولا null: ${JSON.stringify(value)}`);
}

console.log(`radar-graveyard: نجح — ${blocklist.length} حزمة محظورة، ${graveyard.length} مدخل مقبرة بسبب وتاريخ، ` +
  `ولا تبعية محظورة في package.json؛ وbaseline.satr=${baseline.satr} يطابق الحزمة، ` +
  `وإصدارات جهاز المالك الخمسة مقروءة (‏${machine._updated}).`);
