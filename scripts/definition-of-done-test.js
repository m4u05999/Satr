#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const path = require('path');

const DOC_PATH = path.resolve(__dirname, '..', 'docs', 'DEFINITION-OF-DONE.md');

async function main() {
  const doc = await fsp.readFile(DOC_PATH, 'utf8');

  assert(doc.length > 0, 'الوثيقة فارغة.');

  const requiredHeadings = [
    '## 1. الهدف والنطاق',
    '## 2. التمييز بين المصطلحات',
    '## 3. الحقول المطلوبة لكل تذكرة',
    '## 4. مستويات التحقق',
    '## 5. متطلبات تغييرات IPC',
    '## 6. متطلبات تغييرات الواجهة',
    '## 7. متطلبات الأدلة',
    '## 8. سياسة الشجرة المتسخة',
    '## 9. تصنيف النتائج',
    '## 10. قواعد إغلاق المهمة',
    '## 11. سياسة الفشل',
    '## 12. قائمة تحقق قابلة للنسخ',
  ];

  for (const heading of requiredHeadings) {
    assert(doc.includes(heading), `يفتقد الوثيقة العنوان: ${heading}`);
  }

  const terms = [
    'Acceptance Criteria',
    'Definition of Done',
    'Verification Evidence',
    'Reported Result',
    'Verified Evidence',
    'Reported Pass',
    'Not Run',
    'Blocked',
  ];

  for (const term of terms) {
    assert(doc.includes(term), `يفتقد الوثيقة المصطلح: ${term}`);
  }

  assert(doc.includes('Verified Evidence'), 'لا يذكر الوثيقة Verified Evidence.');
  assert(doc.includes('Reported Pass'), 'لا يذكر الوثيقة Reported Pass.');
  assert(
    doc.includes('Verified Evidence') && doc.includes('Reported Pass') && doc.includes('## 9. تصنيف النتائج'),
    'الفصل بين Verified Evidence و Reported Pass غير واضح.'
  );

  assert(doc.includes('base_commit'), 'لا يذكر الوثيقة base_commit.');
  assert(doc.includes('working_tree_dirty'), 'لا يذكر الوثيقة حالة الشجرة المتسخة.');
  assert(doc.includes('git status'), 'لا يذكر الوثيقة git status.');
  assert(doc.includes('لا يجوز الادعاء'), 'لا يذكر الوثيقة تحذير الادعاء بـ commit وحده.');

  assert(doc.includes('IPC'), 'لا يذكر الوثيقة IPC.');
  assert(doc.includes('CSP'), 'لا يذكر الوثيقة CSP.');
  assert(doc.includes('RTL'), 'لا يذكر الوثيقة RTL.');
  assert(doc.includes('contextIsolation'), 'لا يذكر الوثيقة contextIsolation.');
  assert(doc.includes('sandbox'), 'لا يذكر الوثيقة sandbox.');
  assert(doc.includes('nodeIntegration'), 'لا يذكر الوثيقة nodeIntegration.');
  assert(doc.includes('ipcRenderer'), 'لا يذكر الوثيقة ipcRenderer.');

  const dangerousPatterns = [
    'git reset --hard',
    'git checkout --',
    'git clean',
    'rm -rf',
    'del /f /s /q',
  ];

  const lines = doc.split(/\r?\n/);
  for (const pattern of dangerousPatterns) {
    const lowerPattern = pattern.toLowerCase();
    for (const line of lines) {
      if (line.toLowerCase().includes(lowerPattern)) {
        const isProhibited = /(لا|ممنوع|خطير|يمنع|يحظر|يحتوي على)/u.test(line);
        assert(isProhibited, `الوثيقة تحتوي على أمر خطير بدون نهي واضح: ${pattern}\n${line}`);
      }
    }
  }

  assert(doc.includes('test:full'), 'لا تربط الوثيقة الإنجاز بـ test:full.');
  assert(doc.includes('12. قائمة تحقق'), 'لا توجد قائمة تحقق قابلة للنسخ.');

  console.log('✓ document exists and contains required structure');
  console.log('✓ distinguishes Verified Evidence from Reported Pass');
  console.log('✓ covers dirty tree policy');
  console.log('✓ covers IPC, CSP, and RTL requirements');
  console.log('✓ contains no dangerous command suggestions');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
