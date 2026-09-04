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

console.log(`radar-graveyard: نجح — ${blocklist.length} حزمة محظورة، ${graveyard.length} مدخل مقبرة بسبب وتاريخ، ولا تبعية محظورة في package.json.`);
