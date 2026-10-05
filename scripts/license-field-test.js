#!/usr/bin/env node
'use strict';

/**
 * سطر — حارس حقل الرخصة: **package.json لا يكذب على LICENSE**.
 *
 * العلّة (رادار سطر، البند ب-٧ / العدد ٠٢٢): بقي `"license": "MIT"` في package.json خمسة
 * أعداد بعد قرار المالك (2026-08-06) الانتقال إلى FSL-1.1-MIT في LICENSE وREADME
 * وEDITION-MATRIX. والخطأ في الاتجاه الأخطر: فحصٌ آلي (مثل شرط رخصة OSI عند SignPath)
 * يقرأ الحقل لا الملف، فيُمرِّر مشروعاً يجب أن يرفضه.
 *
 * مصدر الحقيقة واحد: الاختصار تحت `## Abbreviation` في LICENSE — بالتعبير نفسه الذي
 * يستعمله scripts/skills-test.js لرخص المهارات، فلا تتباعد النسختان.
 *
 * ما يعضّ عليه: (١) package.json.license يساوي اختصار LICENSE حرفياً؛ (٢) شارة README
 * وقسم «الرخصة» فيه يذكران الاختصار نفسه؛ (٣) الاختصار معرّف SPDX الشكل لا نصّاً حرّاً.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let checks = 0;
function ok(condition, message) { assert.ok(condition, message); checks += 1; }

const licenseText = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
const abbreviation = licenseText.match(/##\s*Abbreviation\s*\r?\n\s*\r?\n(.+)/);
ok(abbreviation && abbreviation[1].trim(), 'تعذّرت قراءة اختصار الرخصة من LICENSE (## Abbreviation)');
const declared = abbreviation[1].trim();
ok(/^[A-Za-z0-9.+-]+$/.test(declared), 'اختصار LICENSE ليس معرّف SPDX الشكل: ' + JSON.stringify(declared));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
ok(typeof pkg.license === 'string' && pkg.license.trim(), 'package.json بلا حقل license');
assert.strictEqual(pkg.license, declared,
  'حقل license في package.json يخالف LICENSE: ' + JSON.stringify(pkg.license) + ' ≠ ' + declared
  + ' — الفحص الآلي (SignPath/OSI) يقرأ الحقل لا الملف، فلا يجوز أن يكذب على الرخصة الفعلية');
checks += 1;

const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const badge = declared.replace(/-/g, '--'); // shields.io يهرب الشرطة بشرطتين
ok(readme.includes('License-' + badge), 'شارة README لا تحمل ' + declared);
const escaped = declared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
ok(new RegExp('## الرخصة[\\s\\S]{0,400}' + escaped).test(readme), 'قسم «الرخصة» في README لا يذكر ' + declared);

console.log('license-field: نجح — ' + checks + ' فحوص: package.json وREADME على ' + declared + ' كما في LICENSE.');
