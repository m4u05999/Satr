#!/usr/bin/env node
'use strict';

/**
 * استيراد مهارة مجتمع إلى `.agents/skills` داخل مشروع — مستهلك سطر الأوامر لعقد
 * `skills.importSkill`، ومعاينة فهرس `.claude-plugin/marketplace.json`.
 *
 * وجوده متعمَّد: لولاه لبقي عقد الاستيراد حقلاً مجمَّداً بلا مستهلك إلى أن تصله
 * الواجهة، وحقلٌ بلا مستهلك عيبٌ لا ميزة. وهو كذلك المسبار اليدوي للعقد.
 *
 *   node scripts/skills-import.js anthropics/skills --skill skill-creator
 *       يطبع الأمر الخارجي الذي *سيُشغَّل* ثم يتوقف — بلا شبكة وبلا تنفيذ.
 *   node scripts/skills-import.js anthropics/skills --skill skill-creator --yes
 *       يُشغّله فعلاً، ثم يعيد الفهرسة ويطبع ما دخل وما رفضه المدقّق.
 *   node scripts/skills-import.js --marketplace <path/to/marketplace.json>
 *       يقرأ فهرساً على القرص ويسرد مدخلاته (بلا شبكة — الجلب ليس من عمل هذه الأداة).
 *
 * التأكيد ليس تشريفة: الاستيراد يشغّل أداة npm خارجية تجلب شيفرة من الإنترنت، وتحذير
 * الأداة نفسها عند انتهائها صريح: «Review skills before use; they run with full agent
 * permissions». لذلك `--yes` إقرارٌ بشري لا افتراض.
 */

const path = require('path');
const skills = require('../electron/skills');

function usage() {
  console.log([
    'الاستعمال:',
    '  node scripts/skills-import.js <owner/repo> [--skill <name>] [--cwd <dir>] [--yes]',
    '  node scripts/skills-import.js --marketplace <file>',
    '',
    'بلا ‎--yes‎ تُطبع الخطة فقط ولا يُشغَّل شيء.',
  ].join('\n'));
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : '';
}

function showMarketplace(file) {
  const result = skills.readMarketplace(path.resolve(file));
  if (!result.ok) {
    console.error('تعذّرت قراءة الفهرس: ' + result.error + ' — ' + result.message);
    process.exitCode = 1;
    return;
  }
  console.log('الفهرس: ' + (result.name || '(بلا اسم)') + (result.owner ? ' — ' + result.owner : ''));
  console.log('مدخلات مقروءة: ' + result.plugins.length + (result.skipped ? ' · متخطّاة: ' + result.skipped : ''));
  for (const plugin of result.plugins) {
    const extra = plugin.skills ? ' [' + plugin.skills.length + ' مهارة]' : '';
    console.log('  - ' + plugin.name + extra + ' · ' + plugin.source);
    if (plugin.description) console.log('      ' + plugin.description.slice(0, 140));
  }
  if (result.skipped) {
    console.log('\nالمتخطّى مدخلٌ بلا اسم، أو بمصدر ليس مساراً نسبياً داخل المستودع');
    console.log('(الفهارس الحقيقية تحمل مصادر git بعيدة — لا جالب لها هنا فتُرفض).');
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) return usage();

  const marketplace = argValue(argv, '--marketplace');
  if (marketplace) return showMarketplace(marketplace);

  const repo = argv.find((value) => !value.startsWith('-')) || '';
  const skill = argValue(argv, '--skill');
  const cwd = path.resolve(argValue(argv, '--cwd') || process.cwd());
  const confirmed = argv.includes('--yes');

  const plan = skills.importArgv(repo, skill);
  console.log('المشروع: ' + cwd);
  console.log('سيُشغَّل: ' + plan.command + ' ' + plan.args.join(' '));
  if (!confirmed) {
    console.log('\nلم يُشغَّل شيء. أضف ‎--yes‎ للتنفيذ.');
    console.log('تنبيه: يجلب هذا شيفرةً من الإنترنت، ومهارات المجتمع تعمل بصلاحيات الوكيل كاملة.');
    return;
  }

  const result = skills.importSkill({ cwd, repo, skill, confirmed: true });
  if (!result.ok) {
    console.error('\nفشل: ' + result.error + ' — ' + result.message);
    if (result.detail) console.error('التفصيل: ' + result.detail);
    process.exitCode = 1;
    return;
  }
  console.log('\nأُضيفت ' + result.added.length + ' مهارة:');
  for (const added of result.added) console.log('  ✓ ' + added.name + ' · ' + (added.description || '').slice(0, 120));
  if (result.rejected.length) {
    console.log('\nرفضها مدقّق المواصفة (' + result.rejected.length + ') — لم تدخل الفهرس ولا يمكن تحميلها:');
    for (const bad of result.rejected) console.log('  ✗ ' + bad.error + ' — ' + bad.message);
  }
  if (!result.added.length && !result.rejected.length) console.log('  (لم تتغيّر مهارات المشروع)');
}

main();
